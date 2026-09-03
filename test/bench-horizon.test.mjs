import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { loadPriceCard } from "../bench/ledger/cache.mjs";
import { ECON_ARMS } from "../bench/lib/engine.mjs";
import {
  loadLongSession,
  loadMultiAgent,
  runHorizon,
  runLongSessionArm,
  runMultiAgentStoryArm,
} from "../bench/run-horizon.mjs";

describe("horizon", { concurrency: false }, () => {
test("long session compact fires twice and today leaks after the first intervening edit", { timeout: 120000 }, async () => {
  const priceCard = await loadPriceCard();
  const spec = await loadLongSession();
  const today = await runLongSessionArm(spec, "today_tool_history", priceCard);
  const pi = await runLongSessionArm(spec, "pi_compact", priceCard);
  const hermes = await runLongSessionArm(spec, "hermes_prune", priceCard);
  const fresh = await runLongSessionArm(spec, "freshctx_prepare", priceCard);
  const corvus = await runLongSessionArm(spec, "corvus_full_file", priceCard);
  assert.equal(spec.cycle_count, 64);
  assert.ok(spec.file_count >= 8);
  assert.ok(pi.scores.compact_calls >= 2);
  assert.ok(hermes.scores.prune_commits >= 2);
  const firstLeak = today.by_cycle.find((row) => row.stale_leakage);
  assert.ok(firstLeak, "today should leak after the first intervening edit");
  assert.ok(firstLeak.cycle >= spec.stale_every);
  assert.equal(today.scores.stale_leakage, true);
  assert.equal(fresh.scores.stale_leakage, false);
  assert.equal(corvus.scores.stale_leakage, false);
  assert.ok(today.scores.stale_leakage !== fresh.scores.stale_leakage || today.by_cycle.filter((row) => row.stale_leakage).length > 0);
  const lastCorvus = corvus.by_cycle[corvus.by_cycle.length - 1];
  const lastFresh = fresh.by_cycle[fresh.by_cycle.length - 1];
  assert.ok(lastCorvus.working_set_size >= spec.file_count);
  assert.ok(lastFresh.working_set_size <= spec.active_window);
  assert.ok(lastCorvus.working_set_size > lastFresh.working_set_size);
});

test("multi-agent stories: today leaks across agents, FreshCtx ignores B-only files, drop-id shrinks the set", async () => {
  const priceCard = await loadPriceCard();
  const bundle = await loadMultiAgent();
  assert.equal(bundle.corvus_registry, "per_agent");
  const byId = Object.fromEntries(bundle.stories.map((story) => [story.id, story]));

  const editToday = await runMultiAgentStoryArm(bundle, byId["b-edits-a-read"], "today_tool_history", priceCard);
  const editFresh = await runMultiAgentStoryArm(bundle, byId["b-edits-a-read"], "freshctx_prepare", priceCard);
  const editCorvus = await runMultiAgentStoryArm(bundle, byId["b-edits-a-read"], "corvus_full_file", priceCard);
  const editPi = await runMultiAgentStoryArm(bundle, byId["b-edits-a-read"], "pi_compact", priceCard);
  assert.equal(editToday.scores.cross_agent_stale, true);
  assert.equal(editFresh.scores.cross_agent_stale, false);
  assert.equal(editCorvus.scores.cross_agent_stale, false);
  assert.equal(editPi.scores.freshness_exact, false);

  const onlyFresh = await runMultiAgentStoryArm(bundle, byId["b-only-file"], "freshctx_prepare", priceCard);
  assert.equal(onlyFresh.scores.selected_paths.includes("b.py"), false);
  assert.ok(onlyFresh.scores.selected_paths.includes("a.py"));

  const dropFresh = await runMultiAgentStoryArm(bundle, byId["a-drops-result-id"], "freshctx_prepare", priceCard);
  const dropCorvus = await runMultiAgentStoryArm(bundle, byId["a-drops-result-id"], "corvus_full_file", priceCard);
  assert.equal(dropFresh.scores.selected_paths.includes("drop.py"), false);
  assert.ok(dropFresh.scores.selected_paths.includes("keep.py"));
  assert.ok(dropCorvus.scores.working_set_size > dropFresh.scores.working_set_size);
});

test("horizon report is deterministic across two runs", { timeout: 180000 }, async () => {
  const first = await runHorizon();
  const second = await runHorizon();
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
  const disk = await readFile(first.reportPath, "utf8");
  assert.equal(disk, `${JSON.stringify(first.report, null, 2)}\n`);
  assert.equal(first.report.slice, "freshctx-horizon-v1");
  assert.equal(first.report.cycle_count, 64);
  for (const arm of ECON_ARMS) {
    assert.equal(typeof first.report.summary.long_session[arm].usd_total_micros, "number");
  }
});
});
