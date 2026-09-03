import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadTasks, runMva, runTaskArm } from "../bench/run-mva.mjs";

test("scripted stale-edit uses extra cycles on append_only only", async () => {
  const tasks = await loadTasks();
  const task = tasks.find((entry) => entry.id === "stale-edit-python");
  const append = await runTaskArm(task, "append_only");
  const fresh = await runTaskArm(task, "freshctx_prepare");
  const corvus = await runTaskArm(task, "corvus_full_file");
  assert.ok(append.scores.cycles > fresh.scores.cycles);
  assert.equal(fresh.scores.cycles, corvus.scores.cycles);
  assert.ok(append.scores.duplicate_file_reads >= fresh.scores.duplicate_file_reads);
  assert.ok(fresh.scores.payload_bytes >= 30 && fresh.scores.payload_bytes <= 50);
  assert.ok(fresh.scores.envelope_bytes > 0);
  assert.equal(fresh.scores.live_block_bytes, fresh.scores.payload_bytes + fresh.scores.envelope_bytes);
});

test("partial-read live block is smaller for FreshCtx than whole-file CORVUS", async () => {
  const tasks = await loadTasks();
  const task = tasks.find((entry) => entry.id === "partial-read-python");
  const fresh = await runTaskArm(task, "freshctx_prepare");
  const corvus = await runTaskArm(task, "corvus_full_file");
  assert.equal(fresh.scores.freshness_exact, true);
  assert.equal(corvus.scores.freshness_exact, true);
  assert.ok(fresh.scores.live_block_bytes < corvus.scores.live_block_bytes);
  assert.equal(fresh.scores.selected_kind, "symbol");
  assert.equal(corvus.scores.selected_kind, "file");
});

test("mva report is deterministic across two runs", async () => {
  const first = await runMva();
  const second = await runMva();
  const a = JSON.stringify(first.report);
  const b = JSON.stringify(second.report);
  assert.equal(a, b);
  const disk = await readFile(first.reportPath, "utf8");
  assert.equal(disk, `${JSON.stringify(first.report, null, 2)}\n`);
  assert.equal(first.report.task_count, 8);
});
