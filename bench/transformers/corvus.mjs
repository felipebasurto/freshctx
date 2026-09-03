import { currentFiles } from "../lib/replay.mjs";

// Algorithm 1 line 1: S0 <- empty. Reads union paths into St (lines 6-7).
// Line 8: ot <- "sync:" fj. Line 3: Ct is current files in St at prepare.

export async function transformCorvus({ root, observations }) {
  const registered = [];
  const seen = new Set();
  for (const obs of observations) {
    if (seen.has(obs.path)) continue;
    seen.add(obs.path);
    registered.push(obs.path);
  }
  const history = observations.map((obs) => ({
    kind: "marker",
    resultId: obs.resultId,
    path: obs.path,
    text: `sync: ${obs.path}`,
  }));
  const files = await currentFiles(root, registered);
  const liveParts = [];
  const selected = [];
  for (const rel of registered) {
    const content = files.get(rel);
    if (content === undefined) continue;
    liveParts.push(`"${rel}":`);
    liveParts.push(content);
    selected.push({ path: rel, kind: "file", content });
  }
  const liveBlock = liveParts.join("\n");
  return {
    arm: "corvus_full_file",
    history,
    liveBlock,
    selected,
    workingSetSize: registered.length,
  };
}
