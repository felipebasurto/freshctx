import { estTokens } from "../ledger/cache.mjs";
import { transformAppendOnly } from "./append-only.mjs";

// Pi keepRecentTokens cut. SHA 1d9787c11fb91ecf7c892050f4c0607a995dd15b
// earendil-works/pi packages/coding-agent/docs/compaction.md
// Walk newest-first until KEEP_RECENT_TOKENS. Suffix stays. Prefix becomes one stub.

export const PI_KEEP_RECENT_TOKENS = 4096;
export const PI_ENGINE_SHA = "1d9787c11fb91ecf7c892050f4c0607a995dd15b";

function bodyTokens(obs) {
  return estTokens(Buffer.byteLength(obs.text, "utf8"));
}

export function transformPiCompact({ observations }) {
  const baseline = transformAppendOnly({ observations, arm: "pi_compact" });
  const total = observations.reduce((sum, obs) => sum + bodyTokens(obs), 0);
  if (total <= PI_KEEP_RECENT_TOKENS) {
    return baseline;
  }
  let keptTokens = 0;
  let cut = observations.length;
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    keptTokens += bodyTokens(observations[i]);
    if (keptTokens >= PI_KEEP_RECENT_TOKENS) {
      cut = i;
      break;
    }
    cut = i;
  }
  const dropped = observations.slice(0, cut);
  const kept = observations.slice(cut);
  if (dropped.length === 0) return baseline;
  const stub = {
    kind: "body",
    resultId: "pi-compact",
    path: dropped[0].path,
    text: `[pi-compact] summarized ${dropped.length} reads`,
  };
  const keptHistory = kept.map((obs) => ({
    kind: "body",
    resultId: obs.resultId,
    path: obs.path,
    text: obs.text,
  }));
  const history = [stub, ...keptHistory];
  return {
    arm: "pi_compact",
    history,
    liveBlock: "",
    selected: history.map((item) => ({ path: item.path, kind: "file", content: item.text })),
    workingSetSize: history.length,
    compact_calls: 1,
    prune_commits: 0,
  };
}
