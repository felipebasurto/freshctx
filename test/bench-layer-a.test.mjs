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
  assert.equal(runFor(budget, "freshctx_prepare").scores.live_block_bytes, 0);
  assert.ok(runFor(budget, "corvus_full_file").scores.live_block_bytes > 0);
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
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    for (const run of result.runs) {
      assert.deepEqual(run.failures, [], `${fixture.id} ${run.arm}`);
    }
  }
});

test("pack allowlist still excludes bench", async () => {
  const source = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "package-contents.mjs"), "utf8");
  assert.match(source, /\bbench\b/u);
});
