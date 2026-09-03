import { serializeRequest } from "./lib/serialize.mjs";

function isStaleObservation(obs, disk) {
  const current = disk.get(obs.path);
  if (current === undefined) return true;
  if (obs.text === current) return false;
  if (obs.range && current.includes(obs.text)) return false;
  return true;
}

export function payloadAndEnvelope(view) {
  const liveBlockBytes = Buffer.byteLength(view.liveBlock ?? "", "utf8");
  if (liveBlockBytes === 0) {
    return { payload_bytes: 0, envelope_bytes: 0 };
  }
  const payloadBytes = (view.selected ?? []).reduce(
    (total, unit) => total + Buffer.byteLength(unit.content ?? "", "utf8"),
    0,
  );
  return {
    payload_bytes: payloadBytes,
    envelope_bytes: Math.max(0, liveBlockBytes - payloadBytes),
  };
}

export function score(view, { observations, gold, budgetBytes, disk }) {
  const prompt = serializeRequest(view);
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const liveBlockBytes = Buffer.byteLength(view.liveBlock ?? "", "utf8");
  const selected = view.selected ?? [];
  const { payload_bytes: payloadBytes, envelope_bytes: envelopeBytes } = payloadAndEnvelope(view);

  let staleLeakage = false;
  for (const obs of observations) {
    if (!isStaleObservation(obs, disk)) continue;
    if (view.history.some((item) => item.kind === "body" && item.text === obs.text)) {
      staleLeakage = true;
    }
  }

  let lastKnownInRequest = false;
  for (const obs of observations) {
    if (!isStaleObservation(obs, disk)) continue;
    if (view.history.some((item) => item.kind === "body" && item.text === obs.text)) {
      lastKnownInRequest = true;
    }
    if ((view.selected ?? []).some((unit) => unit.content === obs.text)) {
      lastKnownInRequest = true;
    }
  }

  const freshnessExact = freshness(view, gold);
  const budgetOk = liveBlockBytes <= budgetBytes;

  return {
    stale_leakage: staleLeakage,
    freshness_exact: freshnessExact,
    last_known_in_request: lastKnownInRequest,
    budget_ok: budgetOk,
    prompt_bytes: promptBytes,
    live_block_bytes: liveBlockBytes,
    payload_bytes: payloadBytes,
    envelope_bytes: envelopeBytes,
    selected_count: selected.length,
    selected_kind: selected[0]?.kind ?? null,
  };
}

function freshness(view, gold) {
  const entries = [...gold.entries()];
  if (entries.every(([, spec]) => spec.omit)) {
    return (view.selected ?? []).length === 0;
  }
  if (view.arm === "append_only") {
    for (const [rel, spec] of entries) {
      if (spec.omit) continue;
      const body = view.history.find((item) => item.path === rel && item.kind === "body");
      if (!body || body.text !== spec.text) return false;
    }
    return true;
  }
  if (view.arm === "corvus_full_file") {
    for (const [rel, spec] of entries) {
      if (spec.omit) continue;
      const unit = (view.selected ?? []).find((item) => item.path === rel);
      if (!unit) return false;
      const diskFile = unit.content;
      if (spec.kind === "file" && diskFile !== spec.text) return false;
      if (spec.kind === "symbol" && !diskFile.includes(spec.text)) return false;
    }
    return true;
  }
  for (const [rel, spec] of entries) {
    if (spec.omit) continue;
    const unit = (view.selected ?? []).find((item) => item.path === rel);
    if (!unit || unit.content !== spec.text) return false;
    if (spec.kind && unit.kind !== spec.kind) return false;
  }
  return true;
}

export function checkExpect(scores, expect = {}) {
  const failures = [];
  for (const [key, wanted] of Object.entries(expect)) {
    if (scores[key] !== wanted) failures.push(`${key}: wanted ${wanted}, got ${scores[key]}`);
  }
  return failures;
}
