import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { checkAnnouncement } from "../bench/check-announcement.mjs";
import { loadPriceCard } from "../bench/ledger/cache.mjs";
import {
  ADDON_HOSTS,
  COMPOSE_ORDER,
  composePairViews,
  HOST_TURN_BYTES,
} from "../bench/transformers/compose.mjs";
import { loadLongSession, loadMultiAgent } from "../bench/run-horizon.mjs";
import { runAddon, runAddonLongSession, runAddonMultiAgentStory } from "../bench/run-addon.mjs";

function bulkyObservations(count) {
  return Array.from({ length: count }, (_, index) => ({
    resultId: `r${index}`,
    path: `f${index % 8}.py`,
    text: `stale-body-${index}\n${"y".repeat(8000)}`,
  }));
}

describe("addon compose", () => {
test("compose order is FreshCtx first, then host compact/prune", () => {
  assert.equal(COMPOSE_ORDER, "freshctx_then_host");
  assert.equal(HOST_TURN_BYTES, 512);
  const observations = bulkyObservations(40);
  const snapshot = {
    history: observations.map((obs) => ({
      kind: "marker",
      resultId: obs.resultId,
      path: obs.path,
      text: `[freshctx:${obs.path}]`,
    })),
    liveBlock: "CURRENT-DISK",
    selected: [{ path: "f0.py", kind: "file", content: "CURRENT-DISK" }],
    workingSetSize: 1,
  };
  const corvusView = {
    history: snapshot.history.map((item) => ({ ...item, text: `sync: ${item.path}` })),
    liveBlock: "CORVUS-FILE",
    selected: [{ path: "f0.py", kind: "file", content: "CORVUS-FILE" }],
    workingSetSize: 8,
  };
  const views = composePairViews({ observations, snapshot, corvusView });
  assert.equal(views.compose_order, "freshctx_then_host");
  const withPi = views.with.pi_compact;
  const withHermes = views.with.hermes_prune;
  const withoutToday = views.without.today_tool_history;
  assert.equal(withPi.liveBlock, "CURRENT-DISK");
  assert.equal(withHermes.liveBlock, "CURRENT-DISK");
  assert.ok(withPi.compact_calls >= 1);
  assert.ok(withHermes.prune_commits >= 1);
  assert.equal(withPi.history.some((item) => item.text.includes("stale-body-")), false);
  assert.equal(withHermes.history.some((item) => item.text.includes("stale-body-")), false);
  assert.ok(withoutToday.history.some((item) => item.kind === "body" && item.text.includes("stale-body-")));
  assert.equal(views.addons.corvus.arm, "today+corvus");
  assert.equal(views.addons.freshctx.arm, "today_tool_history+freshctx");
});
});

describe("addon slice", { concurrency: false }, () => {
test("long session: FreshCtx stops today's leak and restores compact/prune exactness; engines still fire", { timeout: 120000 }, async () => {
  const priceCard = await loadPriceCard();
  const spec = await loadLongSession();
  const run = await runAddonLongSession(spec, priceCard);
  assert.equal(run.slice, "freshctx-addon-v1");
  assert.equal(run.compose_order, "freshctx_then_host");
  assert.equal(spec.cycle_count, 64);
  assert.ok(spec.drop_result_ids);
  for (const host of ADDON_HOSTS) {
    const pair = run.pairs.find((row) => row.host === host);
    assert.ok(pair, `missing pair for ${host}`);
    assert.ok(
      pair.with.freshness_exact || pair.with.freshness_exact === pair.without.freshness_exact,
      `${host}+freshctx freshness should beat or equal without`,
    );
    assert.ok(pair.with.freshness_exact >= pair.without.freshness_exact || pair.with.freshness_exact === true);
    if (pair.without.freshness_exact === false) {
      assert.equal(pair.with.freshness_exact, true, `${host}+freshctx should restore freshness_exact`);
    }
  }
  const today = run.pairs.find((row) => row.host === "today_tool_history");
  assert.equal(today.without.stale_leakage, true);
  assert.equal(today.with.stale_leakage, false);
  assert.equal(today.delta.stopped_stale_leakage, true);
  const pi = run.pairs.find((row) => row.host === "pi_compact");
  const hermes = run.pairs.find((row) => row.host === "hermes_prune");
  assert.equal(pi.without.freshness_exact, false);
  assert.equal(pi.with.freshness_exact, true);
  assert.ok(pi.with.compact_calls >= 2, "pi_compact+freshctx must still compact");
  assert.equal(hermes.without.freshness_exact, false);
  assert.equal(hermes.with.freshness_exact, true);
  assert.ok(hermes.with.prune_commits >= 2, "hermes_prune+freshctx must still prune");
  assert.equal(run.addons.corvus.freshness_exact, true);
  assert.equal(run.addons.freshctx.freshness_exact, true);
});

test("multi-agent: today leaks across agents, FreshCtx does not, B-only file stays out", async () => {
  const priceCard = await loadPriceCard();
  const bundle = await loadMultiAgent();
  const byId = Object.fromEntries(bundle.stories.map((story) => [story.id, story]));

  const edit = await runAddonMultiAgentStory(bundle, byId["b-edits-a-read"], priceCard);
  const today = edit.pairs.find((row) => row.host === "today_tool_history");
  assert.equal(today.without.cross_agent_stale, true);
  assert.equal(today.with.cross_agent_stale, false);
  for (const host of ["pi_compact", "hermes_prune"]) {
    const pair = edit.pairs.find((row) => row.host === host);
    assert.equal(pair.with.freshness_exact, true, `${host}+freshctx should be exact after B edits`);
    assert.ok(pair.with.freshness_exact || pair.without.freshness_exact === false);
    assert.ok(pair.with.freshness_exact >= Number(pair.without.freshness_exact));
  }

  const only = await runAddonMultiAgentStory(bundle, byId["b-only-file"], priceCard);
  for (const host of ADDON_HOSTS) {
    const pair = only.pairs.find((row) => row.host === host);
    assert.equal(pair.with.selected_paths.includes("b.py"), false);
    assert.ok(pair.with.selected_paths.includes("a.py"));
  }

  const drop = await runAddonMultiAgentStory(bundle, byId["a-drops-result-id"], priceCard);
  for (const host of ADDON_HOSTS) {
    const pair = drop.pairs.find((row) => row.host === host);
    assert.equal(pair.with.selected_paths.includes("drop.py"), false);
    assert.ok(pair.with.selected_paths.includes("keep.py"));
  }
});

test("addon report is deterministic across two runs", { timeout: 180000 }, async () => {
  const first = await runAddon();
  const second = await runAddon();
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
  assert.equal(first.report.slice, "freshctx-addon-v1");
  assert.equal(first.report.compose_order, "freshctx_then_host");
});

test("a hand-bumped addon USD fails the announcement checker", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "freshctx-addon-announce-"));
  const source = await readFile(new URL("../bench/ANNOUNCEMENT.md", import.meta.url), "utf8");
  const mutatedPath = path.join(tmp, "ANNOUNCEMENT.md");
  const needle = source.match(/\b\d{6,}\b/u)?.[0];
  assert.ok(needle, "announcement should cite a USD integer");
  await writeFile(mutatedPath, source.replace(needle, String(Number(needle) + 1)));
  const result = await checkAnnouncement({ announcementPath: mutatedPath });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes(String(Number(needle) + 1))));
});
});
