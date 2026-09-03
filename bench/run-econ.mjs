import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPriceCard, priceCycle, priceOutputStubs } from "./ledger/cache.mjs";
import { serializeRequest } from "./lib/serialize.mjs";
import { ECON_ARMS } from "./lib/engine.mjs";
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
const taskDir = path.join(rootDir, "econ", "tasks");
const reportPath = path.join(rootDir, "results", "econ.json");

export async function loadEconTasks() {
  const names = (await readdir(taskDir)).filter((name) => name.endsWith(".json")).sort();
  const tasks = [];
  for (const name of names) {
    tasks.push(JSON.parse(await readFile(path.join(taskDir, name), "utf8")));
  }
  return tasks;
}

function padded(filePath, body, padBytes) {
  if (!padBytes) return body;
  const comment = filePath.endsWith(".py") ? "#" : "//";
  const line = `${comment} ${"x".repeat(60)}\n`;
  let out = "";
  while (Buffer.byteLength(out, "utf8") < padBytes) out += line;
  return `${out}${body}`;
}

function filesFor(task) {
  const files = { ...task.files };
  if (task.padBytes) {
    files[task.path] = padded(task.path, files[task.path], task.padBytes);
  }
  return files;
}

export async function runEconTaskArm(task, arm, priceCard) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `freshctx-econ-${task.id}-${arm}-`));
  const fixture = { id: task.id, budgetBytes: task.budgetBytes };
  const observations = [];
  const seen = new Set();
  let cycles = 0;
  let toolCalls = 0;
  let duplicateFileReads = 0;
  let accumulated = 0;
  let nextId = 0;
  let snapshotN = 0;
  let prevSerialized = null;
  let seenCompact = 0;
  let compactCalls = 0;
  let pruneCommits = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let cacheWriteTokens = 0;
  let usdInputMicros = 0;
  let usdCompactOutputMicros = 0;
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
        requestId: `econ-${task.id}-${arm}-${snapshotN}`,
      });
      const serialized = serializeRequest(view);
      const extraCompact = Math.max(0, (view.compact_calls ?? 0) - seenCompact);
      seenCompact = view.compact_calls ?? 0;
      compactCalls = seenCompact;
      pruneCommits = Math.max(pruneCommits, view.prune_commits ?? 0);
      const priced = priceCycle({
        prevSerialized,
        nextSerialized: serialized,
        priceCard,
        extraCompactCalls: extraCompact,
      });
      cacheHitTokens += priced.cache_hit_tokens;
      cacheMissTokens += priced.cache_miss_tokens;
      cacheWriteTokens += priced.cache_write_tokens;
      usdInputMicros += priced.usd_input_micros;
      usdCompactOutputMicros += priced.usd_output_micros;
      accumulated += requestBytes(view);
      prevSerialized = serialized;
      return view;
    }

    async function doRead(filePath, match) {
      cycles += 1;
      toolCalls += 1;
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
      await writeFile(path.join(tmp, task.path), padded(task.path, task.intervening, task.padBytes));
      view = await snapshot();
      cycles += 1;
      let from = quotedToken(visibleText(view, task.path));
      let result = from ? await tryReplaceToken(tmp, task.path, from, task.targetToken) : { ok: false };
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

    const apiCalls = cycles + compactCalls;
    const output = priceOutputStubs(apiCalls, priceCard);
    const usdOutputMicros = output.usd_output_micros + usdCompactOutputMicros;
    const usdTotalMicros = usdInputMicros + usdOutputMicros;
    const liveBlockBytes = Buffer.byteLength(view.liveBlock ?? "", "utf8");
    const split = payloadAndEnvelope(view);
    const promptBytes = requestBytes(view);
    return {
      schema: 1,
      slice: "freshctx-econ-v1",
      arm,
      fixtureId: task.id,
      scores: {
        stale_leakage: false,
        freshness_exact: true,
        last_known_in_request: false,
        budget_ok: liveBlockBytes <= task.budgetBytes,
        prompt_bytes: promptBytes,
        live_block_bytes: liveBlockBytes,
        payload_bytes: split.payload_bytes,
        envelope_bytes: split.envelope_bytes,
        selected_count: (view.selected ?? []).length,
        selected_kind: view.selected?.[0]?.kind ?? null,
        duplicate_file_reads: duplicateFileReads,
        cycles,
        final_request_bytes: promptBytes,
        accumulated_request_bytes: accumulated,
        working_set_size: view.workingSetSize ?? (view.selected ?? []).length,
        est_tokens: Math.ceil(promptBytes / priceCard.bytes_per_token),
        cache_hit_tokens: cacheHitTokens,
        cache_miss_tokens: cacheMissTokens,
        cache_write_tokens: cacheWriteTokens,
        usd_input_micros: usdInputMicros,
        usd_output_micros: usdOutputMicros,
        usd_total_micros: usdTotalMicros,
        usd_input: usdInputMicros / 1_000_000,
        api_calls: apiCalls,
        tool_calls: toolCalls,
        compact_calls: compactCalls,
        prune_commits: pruneCommits,
      },
    };
  } finally {
    await freshctx?.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function runEcon() {
  const priceCard = await loadPriceCard();
  const tasks = await loadEconTasks();
  const runs = [];
  for (const task of tasks) {
    for (const arm of ECON_ARMS) {
      runs.push(await runEconTaskArm(task, arm, priceCard));
    }
  }
  const summary = summarize(runs);
  const report = {
    schema: 1,
    slice: "freshctx-econ-v1",
    task_count: tasks.length,
    price_card: priceCard.id,
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
      api_calls: 0,
      tool_calls: 0,
      compact_calls: 0,
      prune_commits: 0,
      cache_hit_tokens: 0,
      cache_miss_tokens: 0,
      usd_input_micros: 0,
      usd_output_micros: 0,
      usd_total_micros: 0,
      live_block_bytes: 0,
      payload_bytes: 0,
      envelope_bytes: 0,
      final_request_bytes: 0,
    };
    bucket.cycles += run.scores.cycles;
    bucket.duplicate_file_reads += run.scores.duplicate_file_reads;
    bucket.api_calls += run.scores.api_calls;
    bucket.tool_calls += run.scores.tool_calls;
    bucket.compact_calls += run.scores.compact_calls;
    bucket.prune_commits += run.scores.prune_commits;
    bucket.cache_hit_tokens += run.scores.cache_hit_tokens;
    bucket.cache_miss_tokens += run.scores.cache_miss_tokens;
    bucket.usd_input_micros += run.scores.usd_input_micros;
    bucket.usd_output_micros += run.scores.usd_output_micros;
    bucket.usd_total_micros += run.scores.usd_total_micros;
    bucket.live_block_bytes += run.scores.live_block_bytes;
    bucket.payload_bytes += run.scores.payload_bytes;
    bucket.envelope_bytes += run.scores.envelope_bytes;
    bucket.final_request_bytes += run.scores.final_request_bytes;
    byArm[run.arm] = bucket;
  }
  return { task_count: new Set(runs.map((run) => run.fixtureId)).size, arms: byArm };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { report, reportPath } = await runEcon();
  process.stdout.write(`${JSON.stringify({ reportPath, summary: report.summary }, null, 2)}\n`);
}
