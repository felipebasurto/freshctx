import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runFixture } from "../bench/lib/engine.mjs";
import { loadFixtures } from "../bench/run-layer-a.mjs";

function runFor(result, arm) {
  return result.runs.find((entry) => entry.arm === arm);
}

test("layer A fixtures match frozen expects for Figure 1, symbol, omit, and budget", async () => {
  const fixtures = await loadFixtures();
  const byId = Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture]));

  const figure = await runFixture(byId["figure-1-stale-write"]);
  assert.equal(runFor(figure, "append_only").scores.stale_leakage, true);
  assert.equal(runFor(figure, "append_only").scores.freshness_exact, false);
  assert.equal(runFor(figure, "corvus_full_file").scores.stale_leakage, false);
  assert.equal(runFor(figure, "freshctx_prepare").scores.freshness_exact, true);
  assert.equal(runFor(figure, "freshctx_prepare").failures.length, 0);

  const symbol = await runFixture(byId["symbol-current-not-historical"]);
  assert.equal(runFor(symbol, "freshctx_prepare").scores.selected_kind, "symbol");
  assert.equal(runFor(symbol, "corvus_full_file").scores.selected_kind, "file");
  assert.equal(runFor(symbol, "append_only").scores.stale_leakage, true);

  const deleted = await runFixture(byId["delete-after-observe"]);
  assert.equal(runFor(deleted, "freshctx_prepare").scores.selected_count, 0);
  assert.equal(runFor(deleted, "freshctx_prepare").scores.last_known_in_request, false);
  assert.equal(runFor(deleted, "append_only").scores.last_known_in_request, true);

  const binary = await runFixture(byId["binary-after-observe"]);
  assert.equal(runFor(binary, "freshctx_prepare").scores.last_known_in_request, false);
  assert.equal(runFor(binary, "freshctx_prepare").scores.selected_count, 0);

  const budget = await runFixture(byId["budget-zero"]);
  const freshBudget = runFor(budget, "freshctx_prepare");
  const corvusBudget = runFor(budget, "corvus_full_file");
  assert.equal(freshBudget.scores.live_block_bytes, 0);
  assert.equal(freshBudget.scores.freshness_exact, false);
  assert.equal(freshBudget.scores.selected_count, 0);
  assert.ok(corvusBudget.scores.live_block_bytes > 0);
  assert.equal(corvusBudget.scores.budget_ok, false);
});

test("layer A overlap, delimiter, and fragment fixtures hold gold", async () => {
  const fixtures = await loadFixtures();
  const byId = Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture]));

  const overlap = await runFixture(byId["overlap-file-then-symbol"]);
  assert.equal(runFor(overlap, "freshctx_prepare").scores.selected_count, 1);
  assert.equal(runFor(overlap, "freshctx_prepare").scores.selected_kind, "symbol");

  const delimiter = await runFixture(byId["delimiter-framing"]);
  assert.equal(runFor(delimiter, "freshctx_prepare").scores.freshness_exact, true);

  const fragment = await runFixture(byId["fragment-not-whole-symbol"]);
  assert.equal(runFor(fragment, "freshctx_prepare").scores.selected_kind, "symbol");
  assert.equal(runFor(fragment, "append_only").scores.freshness_exact, false);
});

test("every layer A fixture has zero expect failures", async () => {
  const fixtures = await loadFixtures();
  assert.equal(fixtures.length, 12);
  const tally = {
    freshctx_prepare: { freshness_exact: 0, budget_ok: 0, prompt_bytes: 0, payload_bytes: 0 },
    corvus_full_file: { freshness_exact: 0, budget_ok: 0, prompt_bytes: 0, payload_bytes: 0 },
  };
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    for (const run of result.runs) {
      assert.deepEqual(run.failures, [], `${fixture.id} ${run.arm}`);
      if (run.arm === "freshctx_prepare" || run.arm === "corvus_full_file") {
        if (run.scores.freshness_exact) tally[run.arm].freshness_exact += 1;
        if (run.scores.budget_ok) tally[run.arm].budget_ok += 1;
        tally[run.arm].prompt_bytes += run.scores.prompt_bytes;
        tally[run.arm].payload_bytes += run.scores.payload_bytes;
      }
    }
  }
  assert.equal(tally.freshctx_prepare.budget_ok, 12);
  assert.equal(tally.corvus_full_file.budget_ok, 11);
  assert.equal(tally.freshctx_prepare.freshness_exact, 11);
  assert.equal(tally.corvus_full_file.freshness_exact, 12);
  assert.ok(
    tally.freshctx_prepare.prompt_bytes < tally.corvus_full_file.prompt_bytes,
    `prompt_bytes FreshCtx ${tally.freshctx_prepare.prompt_bytes} vs CORVUS ${tally.corvus_full_file.prompt_bytes}`
  );
  assert.ok(
    tally.freshctx_prepare.payload_bytes < tally.corvus_full_file.payload_bytes,
    `payload_bytes FreshCtx ${tally.freshctx_prepare.payload_bytes} vs CORVUS ${tally.corvus_full_file.payload_bytes}`
  );
});

test("pack allowlist still excludes bench", async () => {
  const source = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "package-contents.mjs"), "utf8");
  assert.match(source, /\bbench\b/u);
});
