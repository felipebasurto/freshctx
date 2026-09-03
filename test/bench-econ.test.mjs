import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadEconTasks, runEcon, runEconTaskArm } from "../bench/run-econ.mjs";
import { loadPriceCard } from "../bench/ledger/cache.mjs";
import { ECON_ARMS } from "../bench/lib/engine.mjs";

test("scripted stale-edit uses extra cycles on today's harness", async () => {
  const priceCard = await loadPriceCard();
  const tasks = await loadEconTasks();
  const task = tasks.find((entry) => entry.id === "stale-edit-python");
  const today = await runEconTaskArm(task, "today_tool_history", priceCard);
  const fresh = await runEconTaskArm(task, "freshctx_prepare", priceCard);
  const pi = await runEconTaskArm(task, "pi_compact", priceCard);
  assert.ok(today.scores.cycles > fresh.scores.cycles);
  assert.ok(pi.scores.compact_calls >= 1);
  assert.ok(pi.scores.cache_write_tokens > 0);
});

test("partial-read live block is smaller for FreshCtx than whole-file CORVUS", async () => {
  const priceCard = await loadPriceCard();
  const tasks = await loadEconTasks();
  const task = tasks.find((entry) => entry.id === "partial-read-python");
  const fresh = await runEconTaskArm(task, "freshctx_prepare", priceCard);
  const corvus = await runEconTaskArm(task, "corvus_full_file", priceCard);
  assert.equal(fresh.scores.freshness_exact, true);
  assert.ok(fresh.scores.live_block_bytes < corvus.scores.live_block_bytes);
  assert.equal(fresh.scores.selected_kind, "symbol");
});

test("econ report is deterministic and includes usd_input for every arm", async () => {
  const first = await runEcon();
  const second = await runEcon();
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
  const disk = await readFile(first.reportPath, "utf8");
  assert.equal(disk, `${JSON.stringify(first.report, null, 2)}\n`);
  assert.equal(first.report.task_count, 8);
  for (const arm of ECON_ARMS) {
    assert.equal(typeof first.report.summary.arms[arm].usd_input_micros, "number");
  }
});
