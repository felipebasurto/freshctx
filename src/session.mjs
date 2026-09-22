import { FreshCtxError, fail } from "./errors.mjs";
import {
  compactUnitId,
  fileUnitIdentity,
  isRevision,
  regionUnitIdentity,
  revisionFor,
  stableId,
  symbolUnitIdentity,
} from "./hash.mjs";
import { buildProjection, stableMarker, unavailableMarker } from "./projection.mjs";
import { PROTOCOL, VERSION } from "./protocol.mjs";
import { anchorsFor, enclosingParsedUnit, findByteOccurrences, relocateRegion } from "./relocate.mjs";
import { parseUnits, supportedLanguages } from "./treesitter.mjs";
import { DEFAULT_MAX_SOURCE_BYTES, normalizeRelativePath, readStableText } from "./workspace.mjs";

export const PENDING_PLAN_TTL_MS = 30 * 60 * 1000;
export const MAX_PENDING_PLANS = 16;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sameRange(left, right) {
  return (left?.startByte ?? null) === (right?.startByte ?? null)
    && (left?.endByte ?? null) === (right?.endByte ?? null);
}

function reasonFor(error) {
  return error instanceof FreshCtxError ? error.code : "resolution_failed";
}

function unresolved(reason) {
  return { state: "unresolved", reason };
}

function appendRevision(unit, revision) {
  unit.revisions ??= [];
  if (!unit.revisions.includes(revision)) unit.revisions.push(revision);
}

function persistable(unit) {
  const { content, relocation, previousRange, ...stored } = unit;
  return stored;
}

function normalizeGranularity(value) {
  if (value === undefined) return "region";
  if (value === "region" || value === "file") return value;
  fail("invalid_request", "selection_granularity must be region or file");
}

async function readSnapshot(workspace, sourcePath) {
  const snapshot = await readStableText(workspace, sourcePath);
  return { ...snapshot, revision: revisionFor(snapshot.bytes) };
}

function fileUnit(sourcePath, observedAt) {
  const identity = fileUnitIdentity(sourcePath);
  return { id: compactUnitId(identity), identity, path: sourcePath, kind: "file", selector: null, observedAt };
}

function resolvedFile({ sourcePath, observedAt, snapshot, resolution = "file" }) {
  return {
    ...fileUnit(sourcePath, observedAt),
    state: "resolved",
    resolution,
    sourceRevision: snapshot.revision,
    revision: snapshot.revision,
    startByte: 0,
    endByte: snapshot.bytes.length,
    content: snapshot.text,
  };
}

function resolvedSymbol({ sourcePath, observedAt, snapshot, symbol }) {
  const identity = symbolUnitIdentity(sourcePath, symbol.selector);
  const bytes = snapshot.bytes.subarray(symbol.startByte, symbol.endByte);
  return {
    id: compactUnitId(identity),
    identity,
    path: sourcePath,
    kind: "symbol",
    selector: symbol.selector,
    observedAt,
    state: "resolved",
    resolution: "symbol",
    sourceRevision: snapshot.revision,
    revision: revisionFor(bytes),
    startByte: symbol.startByte,
    endByte: symbol.endByte,
    content: utf8.decode(bytes),
  };
}

function observedRegionIdentity({ sourcePath, snapshot, range, anchors, revision, occurrences }) {
  const identity = regionUnitIdentity(sourcePath, revision, anchors.prefixAnchor, anchors.suffixAnchor, null);
  const length = range.endByte - range.startByte;
  const twins = occurrences.filter((at) => {
    const candidate = anchorsFor(snapshot.bytes, at, at + length);
    return candidate.prefixAnchor === anchors.prefixAnchor && candidate.suffixAnchor === anchors.suffixAnchor;
  });
  if (twins.length > 1) identity.occurrenceStart = range.startByte;
  return identity;
}

function resolvedRegion({ sourcePath, observedAt, snapshot, range, anchors, parent = null, identity = null }) {
  const bytes = snapshot.bytes.subarray(range.startByte, range.endByte);
  const revision = revisionFor(bytes);
  const occurrences = findByteOccurrences(snapshot.bytes, bytes);
  identity ??= observedRegionIdentity({ sourcePath, snapshot, range, anchors, revision, occurrences });
  return {
    id: compactUnitId(identity),
    identity,
    path: sourcePath,
    kind: "region",
    selector: null,
    observedAt,
    state: "resolved",
    resolution: "region",
    sourceRevision: snapshot.revision,
    revision,
    referentRevision: revision,
    referentOccurrences: occurrences.length,
    startByte: range.startByte,
    endByte: range.endByte,
    content: utf8.decode(bytes),
    prefixAnchor: anchors.prefixAnchor,
    suffixAnchor: anchors.suffixAnchor,
    parentSelector: parent?.selector ?? null,
    ...(parent
      ? { relativeStart: range.startByte - parent.startByte, relativeEnd: range.endByte - parent.startByte }
      : {}),
  };
}

class SourceCache {
  constructor(workspace) {
    this.workspace = workspace;
    this.entries = new Map();
  }

  async snapshot(sourcePath) {
    if (!this.entries.has(sourcePath)) {
      this.entries.set(sourcePath, { snapshot: await readSnapshot(this.workspace, sourcePath), parsed: null });
    }
    return this.entries.get(sourcePath).snapshot;
  }

  async parsed(sourcePath) {
    const entry = this.entries.get(sourcePath);
    entry.parsed ??= await parseUnits({ path: sourcePath, text: entry.snapshot.text });
    return entry.parsed;
  }
}

function compactResponse(response) {
  const { projection_utf8_base64: _omit, ...compact } = response;
  return structuredClone(compact);
}

function dropExpiredPending(pendingPlans) {
  const now = Date.now();
  let changed = false;
  for (const [requestId, plan] of Object.entries(pendingPlans)) {
    if (Number.isSafeInteger(plan.preparedAt) && now - plan.preparedAt > PENDING_PLAN_TTL_MS) {
      delete pendingPlans[requestId];
      changed = true;
    }
  }
  return changed;
}

function boundPending(pendingPlans) {
  const entries = Object.entries(pendingPlans);
  const excess = entries.length - MAX_PENDING_PLANS;
  if (excess <= 0) return;
  entries.sort(([, left], [, right]) => (left.preparedAt ?? 0) - (right.preparedAt ?? 0));
  for (const [requestId] of entries.slice(0, excess)) delete pendingPlans[requestId];
}

function unitState(unit) {
  return {
    status: unit.kind === "region" ? unit.relocation : unit.resolution === "file-fallback" ? "updated" : "stable",
    previousRange: unit.previousRange ?? null,
    currentRange: { startByte: unit.startByte, endByte: unit.endByte },
  };
}

async function wholeFileEquivalent(sources, selected) {
  const files = [];
  for (const filePath of [...new Set(selected.map((unit) => unit.path))].sort((left, right) => left.localeCompare(right))) {
    files.push({ path: filePath, bytes: (await sources.snapshot(filePath)).bytes.length });
  }
  return { files, whole_file_bytes: files.reduce((total, file) => total + file.bytes, 0) };
}

export class FreshCtxSession {
  constructor({ workspace, store, sessionId }) {
    this.workspace = workspace;
    this.store = store;
    this.sessionId = sessionId;
  }

  async observe(request) {
    const sourcePath = normalizeRelativePath(request.path);
    if (request.content.bytes.length > DEFAULT_MAX_SOURCE_BYTES) {
      fail("file_too_large", "observed source exceeds the configured limit");
    }
    if (request.content.bytes.includes(0)) {
      fail("binary_file", "observed source appears to be binary");
    }
    const { observations, units } = this.store.state;
    const observedRevision = revisionFor(request.content.bytes);
    const existing = observations[request.resultId];
    if (existing) {
      if (existing.path !== sourcePath || existing.observedRevision !== observedRevision || !sameRange(existing.range, request.range)) {
        fail("idempotency_conflict", "result_id was already observed with different content");
      }
      const { unavailable } = existing;
      return {
        result_id: request.resultId,
        unit_id: unavailable ? unavailable.legacyUnitId : existing.unitId,
        marker: unavailable ? unavailableMarker(unavailable.legacyUnitId, unavailable.reason) : stableMarker(existing.unitId),
        idempotent: true,
      };
    }

    const observedAt = ++this.store.state.sequence;
    const { range } = request;
    let unit;
    try {
      const snapshot = await readSnapshot(this.workspace, sourcePath);
      const rangeMatchesCurrent = range
        && range.endByte <= snapshot.bytes.length
        && (snapshot.revision === observedRevision
          || snapshot.bytes.subarray(range.startByte, range.endByte).equals(request.content.bytes));
      if (rangeMatchesCurrent) {
        const parsed = await parseUnits({ path: sourcePath, text: snapshot.text });
        if (parsed.status === "ok") {
          const symbol = enclosingParsedUnit(parsed.units, range.startByte, range.endByte);
          unit = symbol
            ? resolvedSymbol({ sourcePath, observedAt, snapshot, symbol })
            : resolvedRegion({ sourcePath, observedAt, snapshot, range, anchors: anchorsFor(snapshot.bytes, range.startByte, range.endByte) });
        }
      }
      unit ??= resolvedFile({ sourcePath, observedAt, snapshot, resolution: range ? "file-fallback" : "file" });
    } catch (error) {
      unit = { ...fileUnit(sourcePath, observedAt), state: "unresolved", reason: reasonFor(error), revisions: [] };
    }

    const stored = persistable(unit);
    if (units[unit.id]?.revisions) stored.revisions = [...units[unit.id].revisions];
    if (unit.state === "resolved") {
      await this.store.putBlob(Buffer.from(unit.content, "utf8"));
      appendRevision(stored, unit.revision);
    } else if (!range) {
      await this.store.putBlob(request.content.bytes);
      appendRevision(stored, observedRevision);
    }
    units[unit.id] = stored;
    observations[request.resultId] = {
      resultId: request.resultId,
      path: sourcePath,
      range,
      observedRevision,
      unitId: unit.id,
      observedAt,
      turn: request.turn,
    };
    await this.store.save();
    return {
      result_id: request.resultId,
      unit_id: unit.id,
      marker: stableMarker(unit.id),
      idempotent: false,
    };
  }

  async updateStoredUnit(unit) {
    const stored = persistable(unit);
    stored.revisions = [...(this.store.state.units[unit.id]?.revisions ?? [])];
    appendRevision(stored, unit.revision);
    await this.store.putBlob(Buffer.from(unit.content, "utf8"));
    this.store.state.units[unit.id] = stored;
    return unit;
  }

  async fileFallbackForSymbol(unit, snapshot, observedAt) {
    const file = resolvedFile({ sourcePath: unit.path, observedAt, snapshot, resolution: "file-fallback" });
    appendRevision(unit, file.revision);
    await this.store.putBlob(snapshot.bytes);
    return { ...file, id: unit.id };
  }

  async currentRegion(unit, snapshot, observedAt, parsed) {
    const { prefixAnchor = "", suffixAnchor = "" } = unit;
    if (typeof prefixAnchor !== "string" || typeof suffixAnchor !== "string") return unresolved("resolution_failed");
    if (!isRevision(unit.referentRevision)) return unresolved("unknown_revision");
    try {
      const referentBytes = await this.store.getBlob(unit.referentRevision);
      if (!referentBytes) return unresolved("unknown_revision");
      const parsedOk = parsed.status === "ok";
      const outcome = relocateRegion({
        snapshotBytes: snapshot.bytes,
        parsedUnits: parsed.units,
        parsedOk,
        referentBytes,
        prefixAnchor,
        suffixAnchor,
        parentSelector: unit.parentSelector ?? null,
        relStart: unit.relativeStart ?? null,
        relEnd: unit.relativeEnd ?? null,
        prevStart: unit.startByte,
        prevEnd: unit.endByte,
        snapshotUnchanged: unit.sourceRevision === snapshot.revision,
        previousOccurrences: unit.referentOccurrences ?? null,
      });
      if (outcome.status === "ambiguous") return unresolved("ambiguous");
      if (outcome.status === "invalidated") return unresolved("referent_missing");
      const range = { startByte: outcome.startByte, endByte: outcome.endByte };
      const candidate = resolvedRegion({
        sourcePath: unit.path,
        observedAt,
        snapshot,
        range,
        anchors: { prefixAnchor, suffixAnchor },
        parent: parsedOk ? enclosingParsedUnit(parsed.units, range.startByte, range.endByte) : null,
        identity: unit.identity,
      });
      candidate.relocation = outcome.status;
      candidate.previousRange = { startByte: unit.startByte, endByte: unit.endByte };
      return await this.updateStoredUnit(candidate);
    } catch (error) {
      return unresolved(reasonFor(error));
    }
  }

  async currentCandidate(unit, observedAt, sources) {
    let snapshot;
    try {
      snapshot = await sources.snapshot(unit.path);
    } catch (error) {
      return unresolved(reasonFor(error));
    }
    if (unit.kind === "file") {
      return this.updateStoredUnit(resolvedFile({ sourcePath: unit.path, observedAt, snapshot }));
    }
    const parsed = await sources.parsed(unit.path);
    if (unit.kind === "region") return this.currentRegion(unit, snapshot, observedAt, parsed);
    const symbol = parsed.units.find((candidate) => candidate.selector === unit.selector);
    return symbol
      ? this.updateStoredUnit(resolvedSymbol({ sourcePath: unit.path, observedAt, snapshot, symbol }))
      : this.fileFallbackForSymbol(unit, snapshot, observedAt);
  }

  async hydrate(record) {
    const response = structuredClone(record.response);
    const bytes = await this.store.getBlob(response.projection_sha256);
    if (!bytes) fail("missing_blob", "archived projection is unavailable");
    response.projection_utf8_base64 = bytes.toString("base64");
    return response;
  }

  async prepare(request) {
    const granularity = normalizeGranularity(request.granularity);
    const fingerprint = JSON.stringify({
      resultIds: [...request.resultIds].sort(),
      budgetBytes: request.budgetBytes,
      granularity,
    });
    const { observations, units, pendingPlans, committedPlans } = this.store.state;
    if (dropExpiredPending(pendingPlans)) await this.store.save();
    const known = pendingPlans[request.requestId] ?? committedPlans[request.requestId];
    if (known) {
      if (known.fingerprint !== fingerprint) fail("idempotency_conflict", "request_id was already prepared with different inputs");
      return this.hydrate(known);
    }

    const requested = [];
    const unresolvedResults = [];
    for (const resultId of request.resultIds) {
      const observation = observations[resultId];
      if (observation) requested.push(observation);
      else unresolvedResults.push({ result_id: resultId, reason: "unknown_result" });
    }
    const groups = new Map();
    for (const observation of requested) {
      if (observation.unavailable) {
        unresolvedResults.push({ result_id: observation.resultId, path: observation.path, reason: observation.unavailable.reason });
      } else if (groups.has(observation.unitId)) {
        groups.get(observation.unitId).push(observation);
      } else {
        groups.set(observation.unitId, [observation]);
      }
    }

    const sources = new SourceCache(this.workspace);
    const refreshed = new Map();
    const candidates = [];
    for (const [unitId, group] of groups) {
      const observedAt = group.reduce((latest, observation) => Math.max(latest, observation.observedAt), 0);
      const original = units[unitId];
      const candidate = original ? await this.currentCandidate(original, observedAt, sources) : unresolved("unknown_unit");
      refreshed.set(unitId, candidate);
      if (candidate.state !== "resolved") {
        for (const observation of group) {
          unresolvedResults.push({ result_id: observation.resultId, unit_id: unitId, path: observation.path, reason: candidate.reason });
        }
      } else if (granularity === "file" && candidate.kind !== "file") {
        const snapshot = await sources.snapshot(candidate.path);
        candidates.push({ ...resolvedFile({ sourcePath: candidate.path, observedAt, snapshot }), id: candidate.id });
      } else {
        candidates.push(candidate);
      }
    }

    const projection = buildProjection(candidates, request.budgetBytes);
    const selectedIds = new Set(projection.selected.map((unit) => unit.id));
    const omittedReasons = new Map(projection.omitted.map((item) => [item.unitId, item.reason]));
    const replacements = requested.map(({ resultId, unitId, observedRevision, unavailable }) => {
      let marker;
      if (unavailable) marker = unavailableMarker(unavailable.legacyUnitId, unavailable.reason);
      else if (selectedIds.has(unitId)) marker = stableMarker(unitId);
      else marker = unavailableMarker(unitId, refreshed.get(unitId).reason ?? omittedReasons.get(unitId) ?? "unresolved");
      return { result_id: resultId, expected_sha256: observedRevision, marker };
    });
    const projectionBytes = Buffer.from(projection.text, "utf8");
    const response = {
      plan_id: stableId("fp", {
        sessionId: this.sessionId,
        requestId: request.requestId,
        fingerprint,
        projection: projection.text,
      }),
      replacements,
      projection_utf8_base64: projectionBytes.toString("base64"),
      projection_sha256: await this.store.putBlob(projectionBytes),
      selected: [...selectedIds],
      omitted: projection.omitted,
      unresolved: unresolvedResults,
      unit_states: Object.fromEntries(projection.selected.map((unit) => [unit.id, unitState(unit)])),
      selection_granularity: granularity,
      ...(granularity === "region" ? { whole_file_equivalent: await wholeFileEquivalent(sources, projection.selected) } : {}),
    };
    pendingPlans[request.requestId] = {
      planId: response.plan_id,
      fingerprint,
      response: compactResponse(response),
      references: [...new Map(projection.selected.map((unit) => [unit.path, {
        path: unit.path,
        sourceRevision: unit.sourceRevision,
      }])).values()],
      preparedAt: Date.now(),
    };
    boundPending(pendingPlans);
    await this.store.save();
    return response;
  }

  async commit(request) {
    const { pendingPlans, committedPlans } = this.store.state;
    if (Object.values(committedPlans).some((plan) => plan.planId === request.planId)) {
      return { plan_id: request.planId, applied: true, idempotent: true };
    }
    const pendingEntry = Object.entries(pendingPlans).find(([, plan]) => plan.planId === request.planId);
    if (!pendingEntry) fail("unknown_plan", "plan_id is not pending for this session");
    const [requestId, pending] = pendingEntry;
    for (const reference of pending.references) {
      let stale = null;
      try {
        const current = await readStableText(this.workspace, reference.path);
        if (revisionFor(current.bytes) !== reference.sourceRevision) {
          stale = ["a selected source file changed before commit", { path: reference.path }];
        }
      } catch (error) {
        stale = ["a selected source file cannot be revalidated", { path: reference.path, reason: reasonFor(error) }];
      }
      if (stale) {
        delete pendingPlans[requestId];
        await this.store.save();
        fail("stale_plan", ...stale);
      }
    }
    delete pendingPlans[requestId];
    committedPlans[requestId] = {
      planId: request.planId,
      fingerprint: pending.fingerprint,
      response: pending.response,
      committedAt: ++this.store.state.sequence,
    };
    await this.store.save();
    return { plan_id: request.planId, applied: true, idempotent: false };
  }

  async recover(request) {
    const { aliases, units } = this.store.state;
    const unit = units[aliases[request.unitId]?.unitId ?? request.unitId];
    if (!unit) fail("unknown_unit", "unit_id is not known in this session");
    if (!unit.revisions?.includes(request.revision)) {
      fail("unknown_revision", "revision is not archived for this unit");
    }
    const bytes = await this.store.getBlob(request.revision);
    if (!bytes) fail("missing_blob", "archived revision is unavailable");
    return {
      unit_id: request.unitId,
      revision: request.revision,
      content_utf8_base64: bytes.toString("base64"),
    };
  }

  async status() {
    const { observations, units, pendingPlans, committedPlans } = this.store.state;
    if (dropExpiredPending(pendingPlans)) await this.store.save();
    return {
      healthy: true,
      protocol: PROTOCOL,
      version: VERSION,
      session_id: this.sessionId,
      languages: supportedLanguages,
      counts: {
        observations: Object.keys(observations).length,
        units: Object.keys(units).length,
        pending_plans: Object.keys(pendingPlans).length,
        committed_plans: Object.keys(committedPlans).length,
      },
    };
  }
}
