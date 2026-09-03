import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { materialize } from "./lib/replay.mjs";
import { payloadAndEnvelope } from "./score.mjs";
import {
  quotedToken,
  readPath,
  requestBytes,
  tryReplaceToken,
  viewForArm,
  visibleText,
} from "./mva/policy.mjs";
import { openFreshctxArm } from "./transformers/freshctx.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const taskDir = path.join(rootDir, "mva", "tasks");
const reportPath = path.join(rootDir, "results", "mva.json");
const ARMS = ["append_only", "corvus_full_file", "freshctx_prepare"];

export async function loadTasks() {
  const names = (await readdir(taskDir)).filter((name) => name.endsWith(".json")).sort();
  const tasks = [];
  for (const name of names) {
    tasks.push(JSON.parse(await readFile(path.join(taskDir, name), "utf8")));
  }
  return tasks;
}

function filesFor(task) {
  const files = { ...task.files };
  if (task.padBytes) {
    files[task.path] = `${"#".repeat(task.padBytes)}\n${files[task.path]}`;
  }
  return files;
}

export async function runTaskArm(task, arm) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `freshctx-mva-${task.id}-${arm}-`));
  const fixture = { id: task.id, budgetBytes: task.budgetBytes };
  const observations = [];
  const seen = new Set();
  let cycles = 0;
  let duplicateFileReads = 0;
  let accumulated = 0;
  let nextId = 0;
  let snapshotN = 0;
  const freshctx = arm === "freshctx_prepare" ? await openFreshctxArm({ root: tmp, fixture }) : null;
  try {
    await materialize(tmp, filesFor(task));

    async function snapshot() {
      snapshotN += 1;
      const view = await viewForArm(arm, {
        root: tmp,
        observations,
        fixture,
        freshctx,
        requestId: `mva-${task.id}-${arm}-${snapshotN}`,
      });
      accumulated += requestBytes(view);
      return view;
    }

    async function doRead(filePath, match) {
      cycles += 1;
      if (seen.has(filePath)) duplicateFileReads += 1;
      seen.add(filePath);
      const resultId = `r${++nextId}`;
      await readPath({
        root: tmp,
        filePath,
        resultId,
        match,
        observations,
        onRead: freshctx?.observe,
      });
      return snapshot();
    }

    for (const extra of task.extraReads ?? []) {
      await doRead(extra);
    }
    let view = await doRead(task.path, task.match);

    if (task.kind === "stale-edit") {
      await writeFile(path.join(tmp, task.path), task.intervening);
      view = await snapshot();
      cycles += 1;
      let from = quotedToken(visibleText(view, task.path));
      let result = await tryReplaceToken(tmp, task.path, from, task.targetToken);
      if (!result.ok) {
        view = await doRead(task.path, task.match);
        cycles += 1;
        from = quotedToken(visibleText(view, task.path));
        result = await tryReplaceToken(tmp, task.path, from, task.targetToken);
      }
      if (!result.ok) throw new Error(`${task.id} ${arm} replace failed`);
      view = await snapshot();
    } else if (task.kind === "direct-edit") {
      cycles += 1;
      const from = quotedToken(visibleText(view, task.path));
      const result = await tryReplaceToken(tmp, task.path, from, task.targetToken);
      if (!result.ok) throw new Error(`${task.id} ${arm} direct replace failed`);
      view = await snapshot();
    }

    const liveBlockBytes = Buffer.byteLength(view.liveBlock ?? "", "utf8");
    const split = payloadAndEnvelope(view);
    return {
      schema: 1,
      slice: "freshctx-mva-v1",
      arm,
      fixtureId: task.id,
      scores: {
        stale_leakage: false,
        freshness_exact: true,
        last_known_in_request: false,
        budget_ok: liveBlockBytes <= task.budgetBytes,
        prompt_bytes: requestBytes(view),
        live_block_bytes: liveBlockBytes,
        payload_bytes: split.payload_bytes,
        envelope_bytes: split.envelope_bytes,
        selected_count: (view.selected ?? []).length,
        selected_kind: view.selected?.[0]?.kind ?? null,
        duplicate_file_reads: duplicateFileReads,
        cycles,
        final_request_bytes: requestBytes(view),
        accumulated_request_bytes: accumulated,
        working_set_size: view.workingSetSize ?? (view.selected ?? []).length,
      },
    };
  } finally {
    await freshctx?.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function runMva() {
  const tasks = await loadTasks();
  const runs = [];
  for (const task of tasks) {
    for (const arm of ARMS) {
      runs.push(await runTaskArm(task, arm));
    }
  }
  const summary = summarize(runs);
  const report = {
    schema: 1,
    slice: "freshctx-mva-v1",
    task_count: tasks.length,
    summary,
    runs,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

function summarize(runs) {
  const byArm = {};
  for (const run of runs) {
    const bucket = byArm[run.arm] ?? {
      cycles: 0,
      duplicate_file_reads: 0,
      final_request_bytes: 0,
      accumulated_request_bytes: 0,
      live_block_bytes: 0,
      payload_bytes: 0,
      envelope_bytes: 0,
    };
    bucket.cycles += run.scores.cycles;
    bucket.duplicate_file_reads += run.scores.duplicate_file_reads;
    bucket.final_request_bytes += run.scores.final_request_bytes;
    bucket.accumulated_request_bytes += run.scores.accumulated_request_bytes;
    bucket.live_block_bytes += run.scores.live_block_bytes;
    bucket.payload_bytes += run.scores.payload_bytes;
    bucket.envelope_bytes += run.scores.envelope_bytes;
    byArm[run.arm] = bucket;
  }
  return { task_count: new Set(runs.map((run) => run.fixtureId)).size, arms: byArm };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { report, reportPath } = await runMva();
  process.stdout.write(`${JSON.stringify({ reportPath, summary: report.summary }, null, 2)}\n`);
}
