import { estTokens } from "../ledger/cache.mjs";
import { transformAppendOnly } from "./append-only.mjs";

// Hermes _prune_old_tool_results. SHA 63279301bcbdc185c1b07b98a9312eb0c862f26d
// NousResearch/hermes-agent agent/context_compressor.py
// When est tokens exceed PRUNE_TOKENS, stub bodies except the last PROTECT_LAST_N.

export const HERMES_PRUNE_TOKENS = 4096;
export const HERMES_PROTECT_LAST_N = 1;
export const HERMES_ENGINE_SHA = "63279301bcbdc185c1b07b98a9312eb0c862f26d";

function bodyTokens(obs) {
  return estTokens(Buffer.byteLength(obs.text, "utf8"));
}

export function transformHermesPrune({ observations }) {
  const baseline = transformAppendOnly({ observations, arm: "hermes_prune" });
  const total = observations.reduce((sum, obs) => sum + bodyTokens(obs), 0);
  if (total <= HERMES_PRUNE_TOKENS) {
    return baseline;
  }
  const protectFrom = Math.max(0, observations.length - HERMES_PROTECT_LAST_N);
  const history = observations.map((obs, index) => {
    if (index >= protectFrom) {
      return {
        kind: "body",
        resultId: obs.resultId,
        path: obs.path,
        text: obs.text,
      };
    }
    return {
      kind: "body",
      resultId: obs.resultId,
      path: obs.path,
      text: `[hermes-prune] elided ${obs.path}`,
    };
  });
  const pruned = history.some((item, index) => item.text !== observations[index].text);
  return {
    arm: "hermes_prune",
    history,
    liveBlock: "",
    selected: history.map((item) => ({ path: item.path, kind: "file", content: item.text })),
    workingSetSize: history.length,
    compact_calls: 0,
    prune_commits: pruned ? 1 : 0,
  };
}
