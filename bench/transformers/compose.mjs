import { estTokens } from "../ledger/cache.mjs";
import { HERMES_PROTECT_LAST_N, HERMES_PRUNE_TOKENS } from "./hermes-prune.mjs";
import { PI_KEEP_RECENT_TOKENS } from "./pi-compact.mjs";

// Frozen compose order for slice freshctx-addon-v1:
// 1. Host builds native history (conversation turns + tool-read bodies).
// 2. FreshCtx prepare/apply rewrites still-present tool results to markers
//    and attaches the live projection. Host compact/prune have not run yet.
// 3. Host compact/prune may still rewrite history (turns, stubs, markers).
//    The live block is not compacted.
export const COMPOSE_ORDER = "freshctx_then_host";
export const HOST_TURN_BYTES = 512;
export const ADDON_HOSTS = ["today_tool_history", "pi_compact", "hermes_prune"];

function itemTokens(item) {
  return estTokens(Buffer.byteLength(item.text, "utf8"));
}

function isToolItem(item) {
  return item.kind === "body" || item.kind === "marker";
}

export function hostTurn(index) {
  const prefix = `[host-turn ${String(index).padStart(4, "0")}]\n`;
  const prefixLen = Buffer.byteLength(prefix, "utf8");
  const padLen = Math.max(0, HOST_TURN_BYTES - prefixLen);
  const text = `${prefix}${"x".repeat(padLen)}`;
  return {
    kind: "turn",
    resultId: `turn-${index}`,
    path: "",
    text,
  };
}

export function hostTurnsFor(observations) {
  return observations.map((_, index) => hostTurn(index));
}

export function bodiesFrom(observations) {
  return observations.map((obs) => ({
    kind: "body",
    resultId: obs.resultId,
    path: obs.path,
    text: obs.text,
  }));
}

export function compactHistory(history) {
  const total = history.reduce((sum, item) => sum + itemTokens(item), 0);
  if (total <= PI_KEEP_RECENT_TOKENS) {
    return { history, compact_calls: 0 };
  }
  let keptTokens = 0;
  let cut = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    keptTokens += itemTokens(history[i]);
    if (keptTokens >= PI_KEEP_RECENT_TOKENS) {
      cut = i;
      break;
    }
    cut = i;
  }
  const dropped = history.slice(0, cut);
  const kept = history.slice(cut);
  if (dropped.length === 0) return { history, compact_calls: 0 };
  const stub = {
    kind: "body",
    resultId: "pi-compact",
    path: dropped[0].path,
    text: `[pi-compact] summarized ${dropped.length} reads`,
  };
  return { history: [stub, ...kept], compact_calls: 1 };
}

export function pruneHistory(history) {
  const total = history.reduce((sum, item) => sum + itemTokens(item), 0);
  if (total <= HERMES_PRUNE_TOKENS) {
    return { history, prune_commits: 0 };
  }
  const toolIndexes = [];
  for (let i = 0; i < history.length; i += 1) {
    if (isToolItem(history[i])) toolIndexes.push(i);
  }
  const protectFrom = Math.max(0, toolIndexes.length - HERMES_PROTECT_LAST_N);
  const protectedTools = new Set(toolIndexes.slice(protectFrom));
  let pruned = false;
  const next = history.map((item, index) => {
    if (!isToolItem(item) || protectedTools.has(index)) return item;
    pruned = true;
    return {
      kind: "body",
      resultId: item.resultId,
      path: item.path,
      text: `[hermes-prune] elided ${item.path}`,
    };
  });
  return { history: next, prune_commits: pruned ? 1 : 0 };
}

function selectedFromTools(history) {
  return history.filter(isToolItem).map((item) => ({
    path: item.path,
    kind: "file",
    content: item.text,
  }));
}

export function applyHostEngine(host, {
  turns,
  toolHistory,
  liveBlock = "",
  selected,
  workingSetSize,
  withFreshctx = false,
  arm,
}) {
  let history = [...turns, ...toolHistory];
  let compact_calls = 0;
  let prune_commits = 0;
  switch (host) {
    case "today_tool_history":
      break;
    case "pi_compact": {
      const compacted = compactHistory(history);
      history = compacted.history;
      compact_calls = compacted.compact_calls;
      break;
    }
    case "hermes_prune": {
      const pruned = pruneHistory(history);
      history = pruned.history;
      prune_commits = pruned.prune_commits;
      break;
    }
    default: {
      const _exhaustive = host;
      throw new Error(`unknown host engine: ${_exhaustive}`);
    }
  }
  let nextSelected = selected;
  let nextWorking = workingSetSize;
  if (!withFreshctx) {
    nextSelected = selectedFromTools(history);
    nextWorking = nextSelected.length;
  }
  return {
    arm: arm ?? (withFreshctx ? `${host}+freshctx` : host),
    history,
    liveBlock,
    selected: nextSelected,
    workingSetSize: nextWorking,
    compact_calls,
    prune_commits,
    compose_order: COMPOSE_ORDER,
  };
}

export function composePairViews({ observations, snapshot, corvusView }) {
  const turns = hostTurnsFor(observations);
  const bodies = bodiesFrom(observations);
  const without = {};
  const withFreshctx = {};
  for (const host of ADDON_HOSTS) {
    without[host] = applyHostEngine(host, {
      turns,
      toolHistory: bodies,
      liveBlock: "",
      withFreshctx: false,
    });
    withFreshctx[host] = applyHostEngine(host, {
      turns,
      toolHistory: snapshot.history,
      liveBlock: snapshot.liveBlock ?? "",
      selected: snapshot.selected ?? [],
      workingSetSize: snapshot.workingSetSize ?? (snapshot.selected ?? []).length,
      withFreshctx: true,
    });
  }
  const todayCorvus = applyHostEngine("today_tool_history", {
    turns,
    toolHistory: corvusView?.history ?? [],
    liveBlock: corvusView?.liveBlock ?? "",
    selected: corvusView?.selected ?? [],
    workingSetSize: corvusView?.workingSetSize ?? (corvusView?.selected ?? []).length,
    withFreshctx: true,
    arm: "today+corvus",
  });
  return {
    compose_order: COMPOSE_ORDER,
    without,
    with: withFreshctx,
    addons: {
      corvus: todayCorvus,
      freshctx: withFreshctx.today_tool_history,
    },
  };
}
