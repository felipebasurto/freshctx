import assert from "node:assert/strict";
import test from "node:test";

import { runFixture } from "../bench/lib/engine.mjs";
import { loadFixtures } from "../bench/run-layer-a.mjs";
import { transformAppendOnly } from "../bench/transformers/append-only.mjs";
import { transformHermesPrune } from "../bench/transformers/hermes-prune.mjs";
import { transformPiCompact } from "../bench/transformers/pi-compact.mjs";

function obs(resultId, text) {
  return { resultId, path: "a.py", text, bytes: Buffer.from(text) };
}

test("below keepRecentTokens, pi_compact matches today's harness", () => {
  const observations = [obs("r1", "def greet():\n    return 'FRESHCTX_STALE_V1'\n")];
  const today = transformAppendOnly({ observations, arm: "today_tool_history" });
  const pi = transformPiCompact({ observations });
  const hermes = transformHermesPrune({ observations });
  assert.deepEqual(pi.history.map((item) => item.text), today.history.map((item) => item.text));
  assert.deepEqual(hermes.history.map((item) => item.text), today.history.map((item) => item.text));
  assert.equal(pi.compact_calls, 0);
  assert.equal(hermes.prune_commits, 0);
});

test("above threshold, pi_compact stubs the dropped prefix", () => {
  const bulky = "x".repeat(20_000);
  const observations = [obs("r1", bulky), obs("r2", bulky)];
  const pi = transformPiCompact({ observations });
  assert.equal(pi.compact_calls, 1);
  assert.equal(pi.history[0].text.startsWith("[pi-compact]"), true);
  assert.equal(pi.history.at(-1).text, bulky);
});

test("above threshold, hermes_prune stubs old bodies and is not an API call", () => {
  const bulky = "x".repeat(20_000);
  const observations = [obs("r1", bulky), obs("r2", bulky)];
  const hermes = transformHermesPrune({ observations });
  assert.equal(hermes.prune_commits, 1);
  assert.equal(hermes.compact_calls, 0);
  assert.equal(hermes.history[0].text.startsWith("[hermes-prune]"), true);
  assert.equal(hermes.history[1].text, bulky);
});

test("Figure 1 below threshold leaks the same on today and pi_compact", async () => {
  const fixtures = await loadFixtures();
  const figure = fixtures.find((fixture) => fixture.id === "figure-1-stale-write");
  const result = await runFixture(figure, {
    arms: ["today_tool_history", "pi_compact", "hermes_prune", "append_only"],
  });
  const today = result.runs.find((run) => run.arm === "today_tool_history");
  const pi = result.runs.find((run) => run.arm === "pi_compact");
  const append = result.runs.find((run) => run.arm === "append_only");
  assert.equal(today.scores.stale_leakage, true);
  assert.equal(pi.scores.stale_leakage, append.scores.stale_leakage);
  assert.equal(pi.scores.stale_leakage, true);
});
