import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPriceCard, priceCycle, priceOutputStubs, splitSerialized } from "./ledger/cache.mjs";
import { serializeRequest } from "./lib/serialize.mjs";
import { ECON_ARMS } from "./lib/engine.mjs";
import { currentFiles, materialize } from "./lib/replay.mjs";
import { crossAgentStale, payloadAndEnvelope, score } from "./score.mjs";
import { readPath, requestBytes, viewForArm } from "./mva/policy.mjs";
import { openFreshctxArm } from "./transformers/freshctx.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const longPath = path.join(rootDir, "horizon", "long-session.json");
const multiPath = path.join(rootDir, "horizon", "multi-agent.json");
const reportPath = path.join(rootDir, "results", "horizon.json");

export async function loadLongSession() {
  return JSON.parse(await readFile(longPath, "utf8"));
}

export async function loadMultiAgent() {
  return JSON.parse(await readFile(multiPath, "utf8"));
}

export function padded(filePath, body, padBytes) {
  if (!padBytes) return body;
  const comment = filePath.endsWith(".py") ? "#" : "//";
  const line = `${comment} ${"x".repeat(60)}\n`;
  let out = "";
  while (Buffer.byteLength(out, "utf8") < padBytes) out += line;
  return `${out}${body}`;
}

function longSessionFiles(spec) {
  const files = {};
  for (let i = 0; i < spec.file_count; i += 1) {
    const filePath = `f${i}.py`;
    files[filePath] = padded(filePath, fileBody(i, 0), spec.padBytes);
  }
  return files;
}

function fileBody(index, version) {
  return `def fn_${index}():\n    return 'V${version}'\n`;
}

function paddedStoryFiles(story, padBytes) {
  const files = {};
  for (const [filePath, body] of Object.entries(story.files)) {
    files[filePath] = padded(filePath, body, padBytes);
  }
  return files;
}

function goldFromDisk(disk, paths) {
  const gold = new Map();
  for (const rel of paths) {
    const text = disk.get(rel);
    if (text === undefined) gold.set(rel, { omit: true });
    else gold.set(rel, { kind: "file", text });
  }
  return gold;
}

function rewriteEvent(serialized, prevSerialized, flag) {
  if (!flag) return 0;
  if (!prevSerialized) return 1;
  const prev = splitSerialized(prevSerialized).history;
  const next = splitSerialized(serialized).history;
  return prev === next ? 0 : 1;
}

function lastScores(byCycle, extras = {}) {
  const last = byCycle[byCycle.length - 1];
  return { ...last, ...extras };
}

export async function runLongSessionArm(spec, arm, priceCard) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `freshctx-horizon-long-${arm}-`));
  const fixture = {
    id: spec.id,
    budgetBytes: spec.budgetBytes,
    activeResultIds: [],
  };
  const observations = [];
  const versions = Array.from({ length: spec.file_count }, () => 0);
  let nextId = 0;
  let snapshotN = 0;
  let prevSerialized = null;
  let compactCalls = 0;
  let pruneCommits = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let cacheWriteTokens = 0;
  let usdInputMicros = 0;
  let usdCompactOutputMicros = 0;
  let accumulated = 0;
  const distinctPaths = new Set();
  const freshctx = arm === "freshctx_prepare" ? await openFreshctxArm({ root: tmp, fixture }) : null;
  const byCycle = [];
  try {
    await materialize(tmp, longSessionFiles(spec));
    for (let cycle = 0; cycle < spec.cycle_count; cycle += 1) {
      const fileIndex = cycle % spec.file_count;
      const filePath = `f${fileIndex}.py`;
      if (cycle > 0 && cycle % spec.stale_every === 0) {
        versions[fileIndex] += 1;
        await writeFile(
          path.join(tmp, filePath),
          padded(filePath, fileBody(fileIndex, versions[fileIndex]), spec.padBytes),
        );
      }
      const resultId = `r${++nextId}`;
      await readPath({
        root: tmp,
        filePath,
        resultId,
        observations,
        onRead: freshctx?.observe,
      });
      distinctPaths.add(filePath);
      const active = observations.slice(-spec.active_window).map((obs) => obs.resultId);
      fixture.activeResultIds = spec.drop_result_ids ? active : observations.map((obs) => obs.resultId);
      snapshotN += 1;
      const view = await viewForArm(arm, {
        root: tmp,
        observations,
        fixture,
        freshctx,
        requestId: `horizon-long-${arm}-${snapshotN}`,
      });
      const serialized = serializeRequest(view);
      const extraCompact = rewriteEvent(serialized, prevSerialized, Boolean(view.compact_calls));
      compactCalls += extraCompact;
      pruneCommits += rewriteEvent(serialized, prevSerialized, Boolean(view.prune_commits));
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
      const disk = await currentFiles(tmp, [...distinctPaths]);
      const goldPaths = arm === "freshctx_prepare"
        ? [...new Set(observations.slice(-spec.active_window).map((obs) => obs.path))]
        : [...distinctPaths];
      const gold = goldFromDisk(disk, goldPaths);
      const scored = score(view, { observations, gold, budgetBytes: spec.budgetBytes, disk });
      const apiCalls = cycle + 1 + compactCalls;
      const output = priceOutputStubs(apiCalls, priceCard);
      const usdOutputMicros = output.usd_output_micros + usdCompactOutputMicros;
      const usdTotalMicros = usdInputMicros + usdOutputMicros;
      const split = payloadAndEnvelope(view);
      byCycle.push({
        cycle,
        working_set_size: view.workingSetSize ?? (view.selected ?? []).length,
        usd_total_micros: usdTotalMicros,
        cache_miss_tokens: cacheMissTokens,
        stale_leakage: scored.stale_leakage,
        freshness_exact: scored.freshness_exact,
        api_calls: apiCalls,
        live_block_bytes: scored.live_block_bytes,
        payload_bytes: split.payload_bytes,
        envelope_bytes: split.envelope_bytes,
        prompt_bytes: scored.prompt_bytes,
        selected_count: scored.selected_count,
        compact_calls: compactCalls,
        prune_commits: pruneCommits,
        cross_agent_stale: false,
      });
      prevSerialized = serialized;
    }
    const last = byCycle[byCycle.length - 1];
    const output = priceOutputStubs(last.api_calls, priceCard);
    return {
      schema: 1,
      slice: "freshctx-horizon-v1",
      story: "long-session",
      arm,
      fixtureId: spec.id,
      scores: lastScores(byCycle, {
        cycles: spec.cycle_count,
        tool_calls: spec.cycle_count,
        compact_calls: compactCalls,
        prune_commits: pruneCommits,
        cache_hit_tokens: cacheHitTokens,
        cache_miss_tokens: cacheMissTokens,
        cache_write_tokens: cacheWriteTokens,
        usd_input_micros: usdInputMicros,
        usd_output_micros: output.usd_output_micros + usdCompactOutputMicros,
        usd_total_micros: last.usd_total_micros,
        accumulated_request_bytes: accumulated,
        distinct_paths: distinctPaths.size,
        active_window: spec.active_window,
        drop_result_ids: spec.drop_result_ids,
        cross_agent_stale: false,
      }),
      by_cycle: byCycle,
    };
  } finally {
    await freshctx?.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

async function applyStoryEvents({ root, events, observations, freshctx, padBytes }) {
  for (const event of events) {
    if (event.op === "read") {
      await readPath({
        root,
        filePath: event.path,
        resultId: event.resultId,
        observations,
        onRead: freshctx?.observe,
      });
      continue;
    }
    if (event.op === "edit") {
      await mkdir(path.dirname(path.join(root, event.path)), { recursive: true });
      await writeFile(path.join(root, event.path), padded(event.path, event.content, padBytes));
      continue;
    }
    throw new Error(`unknown multi-agent op: ${event.op}`);
  }
}

export async function runMultiAgentStoryArm(bundle, story, arm, priceCard) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `freshctx-horizon-ma-${story.id}-${arm}-`));
  const padBytes = bundle.padBytes;
  const fixtureA = {
    id: `${story.id}-a`,
    budgetBytes: bundle.budgetBytes,
    activeResultIds: story.activeResultIdsA,
  };
  const fixtureB = {
    id: `${story.id}-b`,
    budgetBytes: bundle.budgetBytes,
  };
  const observationsA = [];
  const observationsB = [];
  const freshA = arm === "freshctx_prepare"
    ? await openFreshctxArm({ root: tmp, fixture: fixtureA, sessionId: "agent-a" })
    : null;
  const freshB = arm === "freshctx_prepare"
    ? await openFreshctxArm({ root: tmp, fixture: fixtureB, sessionId: "agent-b" })
    : null;
  try {
    await materialize(tmp, paddedStoryFiles(story, padBytes));
    await applyStoryEvents({
      root: tmp,
      events: story.agentA,
      observations: observationsA,
      freshctx: freshA,
      padBytes,
    });
    await applyStoryEvents({
      root: tmp,
      events: story.agentB,
      observations: observationsB,
      freshctx: freshB,
      padBytes,
    });
    if (story.activeResultIdsA) fixtureA.activeResultIds = story.activeResultIdsA;
    const view = await viewForArm(arm, {
      root: tmp,
      observations: observationsA,
      fixture: fixtureA,
      freshctx: freshA,
      requestId: `horizon-ma-${story.id}-${arm}`,
    });
    const serialized = serializeRequest(view);
    const priced = priceCycle({
      prevSerialized: null,
      nextSerialized: serialized,
      priceCard,
      extraCompactCalls: view.compact_calls ? 1 : 0,
    });
    const apiCalls = 1 + (view.compact_calls ? 1 : 0);
    const output = priceOutputStubs(apiCalls, priceCard);
    const usdOutputMicros = output.usd_output_micros + priced.usd_output_micros;
    const pathsA = [...new Set(observationsA.map((obs) => obs.path))];
    const goldPaths = arm === "freshctx_prepare" && story.activeResultIdsA
      ? [...new Set(observationsA.filter((obs) => story.activeResultIdsA.includes(obs.resultId)).map((obs) => obs.path))]
      : pathsA;
    const disk = await currentFiles(tmp, [
      ...pathsA,
      ...new Set(observationsB.map((obs) => obs.path)),
      ...Object.keys(story.files),
    ]);
    const gold = goldFromDisk(disk, goldPaths);
    const scored = score(view, {
      observations: observationsA,
      gold,
      budgetBytes: bundle.budgetBytes,
      disk,
    });
    const split = payloadAndEnvelope(view);
    const selectedPaths = (view.selected ?? []).map((unit) => unit.path);
    return {
      schema: 1,
      slice: "freshctx-horizon-v1",
      story: story.id,
      arm,
      fixtureId: story.id,
      scores: {
        stale_leakage: scored.stale_leakage,
        freshness_exact: scored.freshness_exact,
        last_known_in_request: scored.last_known_in_request,
        cross_agent_stale: crossAgentStale(view, { observations: observationsA, disk }),
        working_set_size: view.workingSetSize ?? (view.selected ?? []).length,
        selected_count: scored.selected_count,
        selected_paths: selectedPaths,
        selected_kind: scored.selected_kind,
        live_block_bytes: scored.live_block_bytes,
        payload_bytes: split.payload_bytes,
        envelope_bytes: split.envelope_bytes,
        prompt_bytes: scored.prompt_bytes,
        compact_calls: view.compact_calls ? 1 : 0,
        prune_commits: view.prune_commits ? 1 : 0,
        cache_miss_tokens: priced.cache_miss_tokens,
        usd_input_micros: priced.usd_input_micros,
        usd_output_micros: usdOutputMicros,
        usd_total_micros: priced.usd_input_micros + usdOutputMicros,
        api_calls: apiCalls,
        corvus_registry: bundle.corvus_registry,
      },
    };
  } finally {
    await freshA?.close();
    await freshB?.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

function summarizeLong(runs) {
  const arms = {};
  for (const run of runs) {
    const last = run.by_cycle[run.by_cycle.length - 1];
    arms[run.arm] = {
      cycles: run.scores.cycles,
      working_set_size: last.working_set_size,
      usd_total_micros: last.usd_total_micros,
      cache_miss_tokens: last.cache_miss_tokens,
      stale_leakage: last.stale_leakage,
      freshness_exact: last.freshness_exact,
      api_calls: last.api_calls,
      compact_calls: run.scores.compact_calls,
      prune_commits: run.scores.prune_commits,
      live_block_bytes: last.live_block_bytes,
      envelope_bytes: last.envelope_bytes,
      distinct_paths: run.scores.distinct_paths,
      cross_agent_stale: false,
    };
  }
  return arms;
}

function summarizeMulti(runs) {
  const stories = {};
  for (const run of runs) {
    const bucket = stories[run.story] ?? { arms: {} };
    bucket.arms[run.arm] = {
      cross_agent_stale: run.scores.cross_agent_stale,
      stale_leakage: run.scores.stale_leakage,
      freshness_exact: run.scores.freshness_exact,
      working_set_size: run.scores.working_set_size,
      selected_paths: run.scores.selected_paths,
      compact_calls: run.scores.compact_calls,
      prune_commits: run.scores.prune_commits,
      usd_total_micros: run.scores.usd_total_micros,
    };
    stories[run.story] = bucket;
  }
  return stories;
}

export async function runHorizon() {
  const priceCard = await loadPriceCard();
  const spec = await loadLongSession();
  const multi = await loadMultiAgent();
  const longRuns = [];
  for (const arm of ECON_ARMS) {
    longRuns.push(await runLongSessionArm(spec, arm, priceCard));
  }
  const multiRuns = [];
  for (const story of multi.stories) {
    for (const arm of ECON_ARMS) {
      multiRuns.push(await runMultiAgentStoryArm(multi, story, arm, priceCard));
    }
  }
  const report = {
    schema: 1,
    slice: "freshctx-horizon-v1",
    cycle_count: spec.cycle_count,
    file_count: spec.file_count,
    price_card: priceCard.id,
    corvus_registry: multi.corvus_registry,
    summary: {
      long_session: summarizeLong(longRuns),
      multi_agent: summarizeMulti(multiRuns),
    },
    long_session: {
      id: spec.id,
      cycle_count: spec.cycle_count,
      file_count: spec.file_count,
      active_window: spec.active_window,
      drop_result_ids: spec.drop_result_ids,
      runs: longRuns,
    },
    multi_agent: {
      id: multi.id,
      corvus_registry: multi.corvus_registry,
      story_count: multi.stories.length,
      runs: multiRuns,
    },
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { report, reportPath: out } = await runHorizon();
  process.stdout.write(`${JSON.stringify({ reportPath: out, summary: report.summary }, null, 2)}\n`);
}
