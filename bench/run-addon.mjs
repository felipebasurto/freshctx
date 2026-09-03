import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPriceCard, priceCycle, priceOutputStubs, splitSerialized } from "./ledger/cache.mjs";
import { serializeRequest } from "./lib/serialize.mjs";
import { currentFiles, materialize } from "./lib/replay.mjs";
import { crossAgentStale, payloadAndEnvelope, score } from "./score.mjs";
import { readPath } from "./mva/policy.mjs";
import { openFreshctxArm } from "./transformers/freshctx.mjs";
import { transformCorvus } from "./transformers/corvus.mjs";
import { ADDON_HOSTS, COMPOSE_ORDER, HOST_TURN_BYTES, composePairViews } from "./transformers/compose.mjs";
import { loadLongSession, loadMultiAgent, padded } from "./run-horizon.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const reportPath = path.join(rootDir, "results", "addon.json");
const rawDir = path.join(rootDir, "results", "raw");

export const ADDON_SLICE = "freshctx-addon-v2";
export const PREPARE_RESULT_IDS = "host_present";

const BUDGET_MS = 60_000;
const BUDGET_RSS_BYTES = 512 * 1024 * 1024;

function fileBody(index, version) {
  return `def fn_${index}():\n    return 'V${version}'\n`;
}

function longSessionFiles(spec) {
  const files = {};
  for (let i = 0; i < spec.file_count; i += 1) {
    const filePath = `f${i}.py`;
    files[filePath] = padded(filePath, fileBody(i, 0), spec.padBytes);
  }
  return files;
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

function priceView(view, prevSerialized, priceCard, cycle) {
  const serialized = serializeRequest(view);
  const extraCompact = rewriteEvent(serialized, prevSerialized, Boolean(view.compact_calls));
  const extraPrune = rewriteEvent(serialized, prevSerialized, Boolean(view.prune_commits));
  const priced = priceCycle({
    prevSerialized,
    nextSerialized: serialized,
    priceCard,
    extraCompactCalls: extraCompact,
  });
  const apiCalls = cycle + 1 + (view.compact_calls ? extraCompact : 0);
  return { serialized, extraCompact, extraPrune, priced, apiCalls };
}

function lastRowFields(row) {
  return {
    working_set_size: row.working_set_size,
    usd_total_micros: row.usd_total_micros,
    cache_miss_tokens: row.cache_miss_tokens,
    stale_leakage: row.stale_leakage,
    freshness_exact: row.freshness_exact,
    api_calls: row.api_calls,
    compact_calls: row.compact_calls,
    prune_commits: row.prune_commits,
    live_block_bytes: row.live_block_bytes,
    envelope_bytes: row.envelope_bytes,
    prompt_bytes: row.prompt_bytes,
    selected_count: row.selected_count,
    cross_agent_stale: row.cross_agent_stale,
  };
}

function pairDelta(without, withScores) {
  return {
    usd_total_micros: withScores.usd_total_micros - without.usd_total_micros,
    cache_miss_tokens: withScores.cache_miss_tokens - without.cache_miss_tokens,
    working_set_size: withScores.working_set_size - without.working_set_size,
    api_calls: withScores.api_calls - without.api_calls,
    compact_calls: withScores.compact_calls - without.compact_calls,
    prune_commits: withScores.prune_commits - without.prune_commits,
    stopped_stale_leakage: Boolean(without.stale_leakage) && !withScores.stale_leakage,
    restored_freshness_exact: Boolean(withScores.freshness_exact) && !without.freshness_exact,
  };
}

function accumulators() {
  return {
    compactCalls: 0,
    pruneCommits: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    usdInputMicros: 0,
    usdCompactOutputMicros: 0,
    prevSerialized: null,
  };
}

function applyPriced(acc, extraCompact, extraPrune, priced) {
  acc.compactCalls += extraCompact;
  acc.pruneCommits += extraPrune;
  acc.cacheHitTokens += priced.cache_hit_tokens;
  acc.cacheMissTokens += priced.cache_miss_tokens;
  acc.cacheWriteTokens += priced.cache_write_tokens;
  acc.usdInputMicros += priced.usd_input_micros;
  acc.usdCompactOutputMicros += priced.usd_output_micros;
}

function cycleRow({ cycle, view, scored, acc, apiCalls, priceCard, crossAgent }) {
  const output = priceOutputStubs(apiCalls, priceCard);
  const usdOutputMicros = output.usd_output_micros + acc.usdCompactOutputMicros;
  const usdTotalMicros = acc.usdInputMicros + usdOutputMicros;
  const split = payloadAndEnvelope(view);
  return {
    cycle,
    working_set_size: view.workingSetSize ?? (view.selected ?? []).length,
    usd_total_micros: usdTotalMicros,
    cache_miss_tokens: acc.cacheMissTokens,
    stale_leakage: scored.stale_leakage,
    freshness_exact: scored.freshness_exact,
    api_calls: apiCalls,
    live_block_bytes: scored.live_block_bytes,
    payload_bytes: split.payload_bytes,
    envelope_bytes: split.envelope_bytes,
    prompt_bytes: scored.prompt_bytes,
    selected_count: scored.selected_count,
    compact_calls: acc.compactCalls,
    prune_commits: acc.pruneCommits,
    cross_agent_stale: Boolean(crossAgent),
  };
}

export async function runAddonLongSession(spec, priceCard) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "freshctx-addon-long-"));
  const fixture = {
    id: spec.id,
    budgetBytes: spec.budgetBytes,
    activeResultIds: [],
  };
  const observations = [];
  const versions = Array.from({ length: spec.file_count }, () => 0);
  let nextId = 0;
  let snapshotN = 0;
  const distinctPaths = new Set();
  const freshctx = await openFreshctxArm({ root: tmp, fixture });
  const byHost = {};
  for (const host of ADDON_HOSTS) {
    byHost[host] = {
      without: { acc: accumulators(), byCycle: [] },
      with: { acc: accumulators(), byCycle: [] },
    };
  }
  const corvusAcc = { with: { acc: accumulators(), byCycle: [] } };
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
        onRead: freshctx.observe,
      });
      distinctPaths.add(filePath);
      // Host-present result_ids: every observation still in the native request.
      // FreshCtx runs first (compose order freshctx_then_host), so prepare sees
      // this list. Do not apply long-session.json drop_result_ids / active_window;
      // that slice stays the retired five-way bake-off in run-horizon.mjs.
      const hostPresentIds = observations.map((obs) => obs.resultId);
      fixture.activeResultIds = hostPresentIds;
      snapshotN += 1;
      const snapshot = await freshctx.snapshot(`addon-long-${snapshotN}`);
      const corvusView = await transformCorvus({ root: tmp, observations });
      const composed = composePairViews({ observations, snapshot, corvusView });
      const disk = await currentFiles(tmp, [...distinctPaths]);
      const goldHost = goldFromDisk(disk, [...distinctPaths]);
      const goldFresh = goldFromDisk(
        disk,
        [...new Set(
          observations
            .filter((obs) => hostPresentIds.includes(obs.resultId))
            .map((obs) => obs.path),
        )],
      );
      const goldCorvus = goldHost;

      for (const host of ADDON_HOSTS) {
        const withoutView = composed.without[host];
        const withView = composed.with[host];
        const withoutScored = score(withoutView, {
          observations,
          gold: goldHost,
          budgetBytes: spec.budgetBytes,
          disk,
        });
        const withScored = score(withView, {
          observations,
          gold: goldFresh,
          budgetBytes: spec.budgetBytes,
          disk,
        });
        const withoutState = byHost[host].without;
        const withState = byHost[host].with;
        const withoutPriced = priceView(withoutView, withoutState.acc.prevSerialized, priceCard, cycle);
        const withPriced = priceView(withView, withState.acc.prevSerialized, priceCard, cycle);
        applyPriced(withoutState.acc, withoutPriced.extraCompact, withoutPriced.extraPrune, withoutPriced.priced);
        applyPriced(withState.acc, withPriced.extraCompact, withPriced.extraPrune, withPriced.priced);
        const withoutApi = cycle + 1 + withoutState.acc.compactCalls;
        const withApi = cycle + 1 + withState.acc.compactCalls;
        withoutState.byCycle.push(cycleRow({
          cycle,
          view: withoutView,
          scored: withoutScored,
          acc: withoutState.acc,
          apiCalls: withoutApi,
          priceCard,
          crossAgent: false,
        }));
        withState.byCycle.push(cycleRow({
          cycle,
          view: withView,
          scored: withScored,
          acc: withState.acc,
          apiCalls: withApi,
          priceCard,
          crossAgent: false,
        }));
        withoutState.acc.prevSerialized = withoutPriced.serialized;
        withState.acc.prevSerialized = withPriced.serialized;
      }

      const corvusScored = score(composed.addons.corvus, {
        observations,
        gold: goldCorvus,
        budgetBytes: spec.budgetBytes,
        disk,
      });
      const corvusPriced = priceView(
        composed.addons.corvus,
        corvusAcc.with.acc.prevSerialized,
        priceCard,
        cycle,
      );
      applyPriced(corvusAcc.with.acc, corvusPriced.extraCompact, corvusPriced.extraPrune, corvusPriced.priced);
      const corvusApi = cycle + 1 + corvusAcc.with.acc.compactCalls;
      corvusAcc.with.byCycle.push(cycleRow({
        cycle,
        view: composed.addons.corvus,
        scored: corvusScored,
        acc: corvusAcc.with.acc,
        apiCalls: corvusApi,
        priceCard,
        crossAgent: false,
      }));
      corvusAcc.with.acc.prevSerialized = corvusPriced.serialized;
    }

    const pairs = ADDON_HOSTS.map((host) => {
      const withoutLast = lastRowFields(byHost[host].without.byCycle.at(-1));
      const withLast = lastRowFields(byHost[host].with.byCycle.at(-1));
      return {
        host,
        without: withoutLast,
        with: withLast,
        delta: pairDelta(withoutLast, withLast),
        without_by_cycle: byHost[host].without.byCycle,
        with_by_cycle: byHost[host].with.byCycle,
      };
    });
    const corvusLast = lastRowFields(corvusAcc.with.byCycle.at(-1));
    const freshLast = lastRowFields(byHost.today_tool_history.with.byCycle.at(-1));
    return {
      schema: 1,
      slice: ADDON_SLICE,
      story: "long-session",
      compose_order: COMPOSE_ORDER,
      prepare_result_ids: PREPARE_RESULT_IDS,
      fixtureId: spec.id,
      cycle_count: spec.cycle_count,
      file_count: spec.file_count,
      active_window: spec.active_window,
      drop_result_ids: spec.drop_result_ids,
      pairs,
      addons: {
        host: "today_tool_history",
        corvus: corvusLast,
        freshctx: freshLast,
        delta: pairDelta(corvusLast, freshLast),
        corvus_by_cycle: corvusAcc.with.byCycle,
      },
    };
  } finally {
    await freshctx.close();
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

function scoreArmView(view, { observations, gold, budgetBytes, disk, priceCard, observationsA }) {
  const scored = score(view, { observations, gold, budgetBytes, disk });
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
  const split = payloadAndEnvelope(view);
  const selectedPaths = (view.selected ?? []).map((unit) => unit.path);
  return {
    stale_leakage: scored.stale_leakage,
    freshness_exact: scored.freshness_exact,
    last_known_in_request: scored.last_known_in_request,
    cross_agent_stale: crossAgentStale(view, { observations: observationsA, disk }),
    working_set_size: view.workingSetSize ?? (view.selected ?? []).length,
    selected_count: scored.selected_count,
    selected_paths: selectedPaths,
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
  };
}

export async function runAddonMultiAgentStory(bundle, story, priceCard) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `freshctx-addon-ma-${story.id}-`));
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
  const freshA = await openFreshctxArm({ root: tmp, fixture: fixtureA, sessionId: "agent-a" });
  const freshB = await openFreshctxArm({ root: tmp, fixture: fixtureB, sessionId: "agent-b" });
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
    const snapshot = await freshA.snapshot(`addon-ma-${story.id}`);
    const corvusView = await transformCorvus({ root: tmp, observations: observationsA });
    const composed = composePairViews({
      observations: observationsA,
      snapshot,
      corvusView,
    });
    const pathsA = [...new Set(observationsA.map((obs) => obs.path))];
    const goldHost = goldFromDisk(
      await currentFiles(tmp, [
        ...pathsA,
        ...new Set(observationsB.map((obs) => obs.path)),
        ...Object.keys(story.files),
      ]),
      pathsA,
    );
    const disk = await currentFiles(tmp, [
      ...pathsA,
      ...new Set(observationsB.map((obs) => obs.path)),
      ...Object.keys(story.files),
    ]);
    const goldFreshPaths = story.activeResultIdsA
      ? [...new Set(observationsA.filter((obs) => story.activeResultIdsA.includes(obs.resultId)).map((obs) => obs.path))]
      : pathsA;
    const goldFresh = goldFromDisk(disk, goldFreshPaths);
    const pairs = ADDON_HOSTS.map((host) => {
      const without = scoreArmView(composed.without[host], {
        observations: observationsA,
        gold: goldHost,
        budgetBytes: bundle.budgetBytes,
        disk,
        priceCard,
        observationsA,
      });
      const withScores = scoreArmView(composed.with[host], {
        observations: observationsA,
        gold: goldFresh,
        budgetBytes: bundle.budgetBytes,
        disk,
        priceCard,
        observationsA,
      });
      return {
        host,
        without,
        with: withScores,
        delta: pairDelta(without, withScores),
      };
    });
    const corvus = scoreArmView(composed.addons.corvus, {
      observations: observationsA,
      gold: goldHost,
      budgetBytes: bundle.budgetBytes,
      disk,
      priceCard,
      observationsA,
    });
    const freshctx = pairs.find((row) => row.host === "today_tool_history").with;
    return {
      schema: 1,
      slice: ADDON_SLICE,
      story: story.id,
      compose_order: COMPOSE_ORDER,
      prepare_result_ids: PREPARE_RESULT_IDS,
      fixtureId: story.id,
      pairs,
      addons: {
        host: "today_tool_history",
        corvus,
        freshctx,
        delta: pairDelta(corvus, freshctx),
      },
    };
  } finally {
    await freshA.close();
    await freshB.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

function summarizeLong(longRun) {
  const pairs = {};
  for (const pair of longRun.pairs) {
    pairs[pair.host] = {
      without: pair.without,
      with: pair.with,
      delta: pair.delta,
    };
  }
  return {
    pairs,
    addons: {
      corvus: longRun.addons.corvus,
      freshctx: longRun.addons.freshctx,
      delta: longRun.addons.delta,
    },
  };
}

function summarizeMulti(runs) {
  const stories = {};
  for (const run of runs) {
    const pairs = {};
    for (const pair of run.pairs) {
      pairs[pair.host] = {
        without: {
          cross_agent_stale: pair.without.cross_agent_stale,
          stale_leakage: pair.without.stale_leakage,
          freshness_exact: pair.without.freshness_exact,
          working_set_size: pair.without.working_set_size,
          selected_paths: pair.without.selected_paths,
          compact_calls: pair.without.compact_calls,
          prune_commits: pair.without.prune_commits,
          usd_total_micros: pair.without.usd_total_micros,
        },
        with: {
          cross_agent_stale: pair.with.cross_agent_stale,
          stale_leakage: pair.with.stale_leakage,
          freshness_exact: pair.with.freshness_exact,
          working_set_size: pair.with.working_set_size,
          selected_paths: pair.with.selected_paths,
          compact_calls: pair.with.compact_calls,
          prune_commits: pair.with.prune_commits,
          usd_total_micros: pair.with.usd_total_micros,
        },
        delta: pair.delta,
      };
    }
    stories[run.story] = {
      pairs,
      addons: {
        corvus: {
          cross_agent_stale: run.addons.corvus.cross_agent_stale,
          freshness_exact: run.addons.corvus.freshness_exact,
          selected_paths: run.addons.corvus.selected_paths,
          usd_total_micros: run.addons.corvus.usd_total_micros,
        },
        freshctx: {
          cross_agent_stale: run.addons.freshctx.cross_agent_stale,
          freshness_exact: run.addons.freshctx.freshness_exact,
          selected_paths: run.addons.freshctx.selected_paths,
          usd_total_micros: run.addons.freshctx.usd_total_micros,
        },
      },
    };
  }
  return stories;
}

function enforceBudget(startedNs) {
  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  const rss = process.memoryUsage().rss;
  if (elapsedMs > BUDGET_MS) {
    throw new Error(`${ADDON_SLICE} exceeded ${BUDGET_MS}ms (${Math.round(elapsedMs)}ms)`);
  }
  if (rss > BUDGET_RSS_BYTES) {
    throw new Error(`${ADDON_SLICE} exceeded 512MB RSS (${rss} bytes)`);
  }
  return { elapsed_ms: Math.round(elapsedMs), rss_bytes: rss };
}

export async function runAddon() {
  const startedNs = process.hrtime.bigint();
  const priceCard = await loadPriceCard();
  const spec = await loadLongSession();
  const multi = await loadMultiAgent();
  const longRun = await runAddonLongSession(spec, priceCard);
  const multiRuns = [];
  for (const story of multi.stories) {
    multiRuns.push(await runAddonMultiAgentStory(multi, story, priceCard));
  }
  const budget = enforceBudget(startedNs);
  const report = {
    schema: 1,
    slice: ADDON_SLICE,
    compose_order: COMPOSE_ORDER,
    prepare_result_ids: PREPARE_RESULT_IDS,
    cycle_count: spec.cycle_count,
    file_count: spec.file_count,
    price_card: priceCard.id,
    corvus_registry: multi.corvus_registry,
    host_turn_bytes: HOST_TURN_BYTES,
    summary: {
      long_session: summarizeLong(longRun),
      multi_agent: summarizeMulti(multiRuns),
    },
    long_session: {
      id: spec.id,
      cycle_count: spec.cycle_count,
      file_count: spec.file_count,
      active_window: spec.active_window,
      drop_result_ids: spec.drop_result_ids,
      prepare_result_ids: PREPARE_RESULT_IDS,
      pairs: longRun.pairs.map((pair) => ({
        host: pair.host,
        without: pair.without,
        with: pair.with,
        delta: pair.delta,
        without_by_cycle: pair.without_by_cycle,
        with_by_cycle: pair.with_by_cycle,
      })),
      addons: longRun.addons,
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
  return { report, reportPath, budget };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { report, reportPath: out, budget } = await runAddon();
  const summary = {
    reportPath: out,
    slice: report.slice,
    compose_order: report.compose_order,
    prepare_result_ids: report.prepare_result_ids,
    summary: report.summary,
    budget,
  };
  await mkdir(rawDir, { recursive: true });
  await writeFile(path.join(rawDir, "addon-stdout.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
