import { FreshCtxError, fail } from "./errors.mjs";
import {
  compactUnitId,
  equalBytes,
  fileUnitIdentity,
  regionUnitIdentity,
  revisionFor,
  stableId,
  symbolUnitIdentity,
} from "./hash.mjs";
import { buildProjection, stableMarker, unavailableMarker } from "./projection.mjs";
import { VERSION } from "./protocol.mjs";
import { anchorsFor, enclosingParsedUnit, findByteOccurrences, relocateRegion } from "./relocate.mjs";
import { parseUnits, supportedLanguages, uniqueUnitForRange } from "./treesitter.mjs";
import { DEFAULT_MAX_SOURCE_BYTES, normalizeRelativePath, readStableText } from "./workspace.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setRecordValue(record, key, value) {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function deleteRecordValue(record, key) {
  if (Object.hasOwn(record, key)) delete record[key];
}

function sameRange(left, right) {
  return (left?.startByte ?? null) === (right?.startByte ?? null)
    && (left?.endByte ?? null) === (right?.endByte ?? null);
}

function fileUnitId(sourcePath) {
  return compactUnitId(fileUnitIdentity(sourcePath));
}

function regionOccurrence(snapshotBytes, range, anchors, parentSelector, parsedUnits = []) {
  const referent = snapshotBytes.subarray(range.startByte, range.endByte);
  if (referent.length === 0) return 0;
  let index = 0;
  for (const at of findByteOccurrences(snapshotBytes, referent)) {
    if (at === range.startByte) return index;
    const end = at + referent.length;
    const atAnchors = anchorsFor(snapshotBytes, at, end);
    if (atAnchors.prefixAnchor !== anchors.prefixAnchor || atAnchors.suffixAnchor !== anchors.suffixAnchor) continue;
    const parent = enclosingParsedUnit(parsedUnits, at, end);
    if ((parent?.selector ?? null) !== (parentSelector ?? null)) continue;
    index += 1;
  }
  return 0;
}

function lineRangeForText(text) {
  const count = text.length === 0 ? 1 : text.split("\n").length;
  return { startLine: 1, endLine: count };
}

function linesUpTo(bytes, offset) {
  if (offset <= 0) return 1;
  let lines = 1;
  const limit = Math.min(offset, bytes.length);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0x0a) lines += 1;
  }
  return lines;
}

function lineRangeForByteSpan(bytes, startByte, endByte) {
  const startLine = linesUpTo(bytes, startByte);
  const last = Math.max(startByte, endByte - 1);
  return { startLine, endLine: linesUpTo(bytes, last) };
}

function utf8Slice(bytes, startByte, endByte) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(startByte, endByte));
}

function reasonFor(error) {
  return error instanceof FreshCtxError ? error.code : "resolution_failed";
}

function appendRevision(unit, revision) {
  unit.revisions ??= [];
  if (!unit.revisions.includes(revision)) unit.revisions.push(revision);
}

function unresolvedUnit({ id, sourcePath, kind, selector = null, observedAt, reason }) {
  return {
    id,
    ...(kind === "file" ? { identity: fileUnitIdentity(sourcePath) } : {}),
    path: sourcePath,
    kind,
    selector,
    observedAt,
    state: "unresolved",
    reason,
    revisions: [],
  };
}

function resolvedFile({ sourcePath, observedAt, snapshot, resolution = "file" }) {
  const revision = revisionFor(snapshot.bytes);
  const lines = lineRangeForText(snapshot.text);
  const identity = fileUnitIdentity(sourcePath);
  return {
    id: compactUnitId(identity),
    identity,
    path: sourcePath,
    kind: "file",
    selector: null,
    observedAt,
    state: "resolved",
    resolution,
    sourceRevision: revision,
    revision,
    startByte: 0,
    endByte: snapshot.bytes.length,
    ...lines,
    content: snapshot.text,
  };
}

function resolvedRegion({
  sourcePath,
  observedAt,
  snapshot,
  range,
  resolution = "region",
  parent = null,
  fingerprint = null,
  occurrence = 0,
  parsedUnits = [],
}) {
  const bytes = snapshot.bytes.subarray(range.startByte, range.endByte);
  const revision = revisionFor(bytes);
  const observedText = utf8Slice(snapshot.bytes, range.startByte, range.endByte);
  const anchors = fingerprint ?? anchorsFor(snapshot.bytes, range.startByte, range.endByte);
  const identity = regionUnitIdentity(
    sourcePath,
    revision,
    anchors.prefixAnchor,
    anchors.suffixAnchor,
    parent?.selector ?? null,
  );
  const occurrences = findByteOccurrences(snapshot.bytes, bytes);
  const repeatedFingerprint = occurrences.filter(start => {
    const candidate = anchorsFor(snapshot.bytes, start, start + bytes.length);
    return candidate.prefixAnchor === anchors.prefixAnchor && candidate.suffixAnchor === anchors.suffixAnchor;
  }).length > 1;
  if (repeatedFingerprint) identity.occurrenceStart = range.startByte;
  const occurrenceIndex = fingerprint
    ? occurrence
    : regionOccurrence(snapshot.bytes, range, anchors, parent?.selector ?? null, parsedUnits);
  return {
    id: compactUnitId(identity),
    identity,
    path: sourcePath,
    kind: "region",
    selector: null,
    observedAt,
    state: "resolved",
    resolution,
    sourceRevision: revisionFor(snapshot.bytes),
    revision,
    referentRevision: revision,
    referentOccurrences: occurrences.length,
    startByte: range.startByte,
    endByte: range.endByte,
    ...lineRangeForByteSpan(snapshot.bytes, range.startByte, range.endByte),
    content: observedText,
    prefixAnchor: anchors.prefixAnchor,
    suffixAnchor: anchors.suffixAnchor,
    parentSelector: parent?.selector ?? null,
    occurrence: occurrenceIndex,
    observedLength: bytes.length,
    ...(parent
      ? { relativeStart: range.startByte - parent.startByte, relativeEnd: range.endByte - parent.startByte }
      : {}),
  };
}

function parentForRange(parsed, startByte, endByte) {
  if (!parsed || parsed.status !== "ok") return null;
  return enclosingParsedUnit(parsed.units, startByte, endByte);
}

function resolvedSymbol({ sourcePath, observedAt, snapshot, parsed }) {
  const bytes = snapshot.bytes.subarray(parsed.startByte, parsed.endByte);
  const revision = revisionFor(bytes);
  const identity = symbolUnitIdentity(sourcePath, parsed.selector);
  return {
    id: compactUnitId(identity),
    identity,
    path: sourcePath,
    kind: "symbol",
    selector: parsed.selector,
    language: parsed.language,
    symbolKind: parsed.symbolKind,
    observedAt,
    state: "resolved",
    resolution: "symbol",
    sourceRevision: revisionFor(snapshot.bytes),
    revision,
    startByte: parsed.startByte,
    endByte: parsed.endByte,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
    content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  };
}

function persistable(unit) {
  const { content, ...stored } = unit;
  return stored;
}

export const SELECTION_GRANULARITY_REGION = "region";
export const SELECTION_GRANULARITY_FILE = "file";

function normalizeGranularity(value) {
  if (value === undefined) return SELECTION_GRANULARITY_REGION;
  if (value === SELECTION_GRANULARITY_REGION || value === SELECTION_GRANULARITY_FILE) return value;
  fail("invalid_request", "selection_granularity must be region or file");
}

function planFingerprint(request) {
  return JSON.stringify({
    resultIds: [...request.resultIds].sort(),
    budgetBytes: request.budgetBytes,
    granularity: normalizeGranularity(request.granularity),
  });
}

export const PENDING_PLAN_TTL_MS = 30 * 60 * 1000;
export const MAX_PENDING_PLANS = 16;

class PrepareSourceCache {
  constructor() {
    this.byPath = new Map();
  }

  static async snapshot(cache, workspace, sourcePath) {
    const existing = cache.byPath.get(sourcePath);
    if (existing) return existing.snapshot;
    const snapshot = await readStableText(workspace, sourcePath);
    cache.byPath.set(sourcePath, { snapshot, parsed: undefined });
    return snapshot;
  }

  static async parsed(cache, sourcePath) {
    const entry = cache.byPath.get(sourcePath);
    if (entry.parsed === undefined) {
      entry.parsed = await parseUnits({ path: sourcePath, text: entry.snapshot.text });
    }
    return entry.parsed;
  }
}

class StoredPlan {
  static compact(response) {
    const { projection_utf8_base64: _omit, ...compact } = response;
    return compact;
  }

  static async hydrate(store, record) {
    const response = clone(record.response);
    if (Object.hasOwn(response, "projection_utf8_base64")) return response;
    const bytes = await store.getBlob(response.projection_sha256);
    if (!bytes) fail("missing_blob", "archived projection is unavailable");
    response.projection_utf8_base64 = bytes.toString("base64");
    return response;
  }

  static dropExpiredPending(state, now = Date.now()) {
    let changed = false;
    for (const [requestId, plan] of Object.entries(state.pendingPlans)) {
      if (!Number.isSafeInteger(plan.preparedAt) || now - plan.preparedAt <= PENDING_PLAN_TTL_MS) continue;
      deleteRecordValue(state.pendingPlans, requestId);
      changed = true;
    }
    return changed;
  }

  static boundPending(state) {
    const entries = Object.entries(state.pendingPlans);
    if (entries.length <= MAX_PENDING_PLANS) return;
    const ranked = entries
      .map(([requestId, plan], index) => ({ requestId, plan, index }))
      .sort((left, right) => {
        const byTime = (left.plan.preparedAt ?? 0) - (right.plan.preparedAt ?? 0);
        if (byTime !== 0) return byTime;
        return left.index - right.index;
      });
    for (const { requestId } of ranked.slice(0, entries.length - MAX_PENDING_PLANS)) {
      deleteRecordValue(state.pendingPlans, requestId);
    }
  }
}

export class FreshCtxSession {
  constructor({ workspace, store, sessionId, adapter = "unknown" }) {
    this.workspace = workspace;
    this.store = store;
    this.sessionId = sessionId;
    this.adapter = adapter;
  }

  async observe(request) {
    const sourcePath = normalizeRelativePath(request.path);
    if (request.content.bytes.length > DEFAULT_MAX_SOURCE_BYTES) {
      fail("file_too_large", "observed source exceeds the configured limit");
    }
    if (request.content.bytes.includes(0)) {
      fail("binary_file", "observed source appears to be binary");
    }
    const observedRevision = revisionFor(request.content.bytes);
    const existing = recordValue(this.store.state.observations, request.resultId);
    if (existing) {
      if (existing.path !== sourcePath || existing.observedRevision !== observedRevision || !sameRange(existing.range, request.range)) {
        fail("idempotency_conflict", "result_id was already observed with different content");
      }
      if (existing.unavailable) {
        const unit = {
          id: existing.unavailable.legacyUnitId,
          path: sourcePath,
        };
        return {
          result_id: request.resultId,
          unit_id: unit.id,
          marker: unavailableMarker(unit, existing.unavailable.reason),
          idempotent: true,
        };
      }
      const unit = recordValue(this.store.state.units, existing.unitId);
      return {
        result_id: request.resultId,
        unit_id: existing.unitId,
        marker: stableMarker(unit ?? { id: existing.unitId, path: sourcePath }),
        idempotent: true,
      };
    }
    await this.store.putBlob(request.content.bytes);

    const observedAt = ++this.store.state.sequence;
    let unit;
    try {
      const snapshot = await readStableText(this.workspace, sourcePath);
      const snapshotRevision = revisionFor(snapshot.bytes);
      const rangeMatchesCurrent = request.range
        && request.range.endByte <= snapshot.bytes.length
        && (snapshotRevision === observedRevision
          || equalBytes(snapshot.bytes.subarray(request.range.startByte, request.range.endByte), request.content.bytes));
      if (rangeMatchesCurrent) {
        const resolved = await uniqueUnitForRange({ path: sourcePath, text: snapshot.text, range: request.range });
        if (resolved.unit) unit = resolvedSymbol({ sourcePath, observedAt, snapshot, parsed: resolved.unit });
        else if (resolved.status === "ok" || resolved.status === "ambiguous") {
          const parent = parentForRange(
            resolved.status === "ok" ? resolved : { status: "ok", units: [] },
            request.range.startByte,
            request.range.endByte,
          );
          unit = resolvedRegion({
            sourcePath,
            observedAt,
            snapshot,
            range: request.range,
            parent,
            parsedUnits: Array.isArray(resolved.units) ? resolved.units : [],
          });
        }
      }
      if (!unit) unit = resolvedFile({ sourcePath, observedAt, snapshot, resolution: request.range ? "file-fallback" : "file" });
    } catch (error) {
      const id = fileUnitId(sourcePath);
      unit = unresolvedUnit({
        id,
        sourcePath,
        kind: "file",
        observedAt,
        reason: reasonFor(error),
      });
    }

    const stored = persistable(unit);
    const previous = recordValue(this.store.state.units, unit.id);
    if (previous?.revisions) stored.revisions = [...previous.revisions];
    const observedIsWholeUnit = unit.state === "resolved"
      ? equalBytes(Buffer.from(unit.content, "utf8"), request.content.bytes)
      : !request.range;
    if (observedIsWholeUnit) appendRevision(stored, observedRevision);
    if (unit.state === "resolved") {
      await this.store.putBlob(Buffer.from(unit.content, "utf8"));
      appendRevision(stored, unit.revision);
    }
    setRecordValue(this.store.state.units, unit.id, stored);
    setRecordValue(this.store.state.observations, request.resultId, {
      resultId: request.resultId,
      path: sourcePath,
      range: request.range,
      observedRevision,
      unitId: unit.id,
      observedAt,
      turn: request.turn,
    });
    await this.store.save();
    return {
      result_id: request.resultId,
      unit_id: unit.id,
      marker: stableMarker(unit),
      idempotent: false,
    };
  }

  async updateStoredUnit(unit) {
    const stored = persistable(unit);
    const previous = recordValue(this.store.state.units, unit.id);
    stored.identity = previous?.identity ?? stored.identity;
    stored.revisions = [...(previous?.revisions ?? [])];
    appendRevision(stored, unit.revision);
    await this.store.putBlob(Buffer.from(unit.content, "utf8"));
    setRecordValue(this.store.state.units, unit.id, stored);
    return unit;
  }

  async fileFallbackForSymbol(unit, snapshot, observedAt) {
    const file = resolvedFile({ sourcePath: unit.path, observedAt, snapshot, resolution: "file-fallback" });
    const original = recordValue(this.store.state.units, unit.id);
    if (original) appendRevision(original, file.revision);
    await this.store.putBlob(Buffer.from(file.content, "utf8"));
    return { ...file, id: unit.id, identity: unit.identity };
  }

  async currentRegion(unit, snapshot, observedAt, parsed = null) {
    const unresolved = (reason) => unresolvedUnit({
      id: unit.id,
      sourcePath: unit.path,
      kind: "region",
      observedAt,
      reason,
    });
    try {
      const prefixAnchor = unit.prefixAnchor ?? "";
      const suffixAnchor = unit.suffixAnchor ?? "";
      if (typeof prefixAnchor !== "string" || typeof suffixAnchor !== "string") {
        return unresolved("resolution_failed");
      }
      if (typeof unit.referentRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(unit.referentRevision)) {
        return unresolved("unknown_revision");
      }
      const referentBytes = await this.store.getBlob(unit.referentRevision);
      if (!referentBytes) return unresolved("unknown_revision");
      const outcome = relocateRegion({
        snapshotBytes: snapshot.bytes,
        parsedUnits: parsed?.status === "ok" ? parsed.units : [],
        parsedOk: parsed?.status === "ok",
        referentBytes,
        prefixAnchor,
        suffixAnchor,
        parentSelector: unit.parentSelector ?? null,
        relStart: unit.relativeStart ?? null,
        relEnd: unit.relativeEnd ?? null,
        prevStart: unit.startByte,
        prevEnd: unit.endByte,
        snapshotUnchanged: unit.sourceRevision === revisionFor(snapshot.bytes),
        previousOccurrences: unit.referentOccurrences ?? null,
      });
      if (outcome.status === "ambiguous" || outcome.status === "invalidated") {
        return unresolved(outcome.status === "ambiguous" ? "ambiguous" : "referent_missing");
      }
      const parent = parsed?.status === "ok"
        ? parentForRange(parsed, outcome.startByte, outcome.endByte)
        : null;
      const candidate = resolvedRegion({
        sourcePath: unit.path,
        observedAt,
        snapshot,
        range: { startByte: outcome.startByte, endByte: outcome.endByte },
        parent,
        fingerprint: { prefixAnchor, suffixAnchor },
        occurrence: unit.occurrence ?? 0,
      });
      candidate.id = unit.id;
      candidate.occurrence = unit.occurrence ?? candidate.occurrence;
      candidate.identity = unit.identity;
      candidate.relocation = outcome.status;
      candidate.previousRange = { startByte: unit.startByte, endByte: unit.endByte };
      await this.updateStoredUnit(candidate);
      return candidate;
    } catch (error) {
      return unresolved(reasonFor(error));
    }
  }

  async currentCandidate(unit, observedAt, cache = new PrepareSourceCache()) {
    let snapshot;
    try {
      snapshot = await PrepareSourceCache.snapshot(cache, this.workspace, unit.path);
    } catch (error) {
      return unresolvedUnit({
        id: unit.id,
        sourcePath: unit.path,
        kind: unit.kind ?? "file",
        selector: unit.selector,
        observedAt,
        reason: reasonFor(error),
      });
    }
    if (unit.kind === "file") {
      const candidate = resolvedFile({ sourcePath: unit.path, observedAt, snapshot, resolution: "file" });
      await this.updateStoredUnit(candidate);
      return candidate;
    }
    if (unit.kind === "region") {
      const parsed = await PrepareSourceCache.parsed(cache, unit.path);
      return this.currentRegion(unit, snapshot, observedAt, parsed);
    }
    const parsed = await PrepareSourceCache.parsed(cache, unit.path);
    const matches = parsed.status === "ok"
      ? parsed.units.filter((candidate) => candidate.selector === unit.selector)
      : [];
    if (matches.length === 1) {
      const candidate = resolvedSymbol({ sourcePath: unit.path, observedAt, snapshot, parsed: matches[0] });
      await this.updateStoredUnit(candidate);
      return candidate;
    }
    return this.fileFallbackForSymbol(unit, snapshot, observedAt);
  }

  async prepare(request) {
    const granularity = normalizeGranularity(request.granularity);
    const fingerprint = planFingerprint(request);
    if (StoredPlan.dropExpiredPending(this.store.state)) await this.store.save();
    const known = recordValue(this.store.state.pendingPlans, request.requestId)
      ?? recordValue(this.store.state.committedPlans, request.requestId);
    if (known) {
      if (known.fingerprint !== fingerprint) fail("idempotency_conflict", "request_id was already prepared with different inputs");
      return StoredPlan.hydrate(this.store, known);
    }
    const refresh = new PrepareSourceCache();

    const requested = request.resultIds
      .map((resultId) => recordValue(this.store.state.observations, resultId))
      .filter(Boolean);
    const active = requested.filter((observation) => !observation.unavailable);
    const unknown = request.resultIds
      .filter((resultId) => !recordValue(this.store.state.observations, resultId))
      .map((resultId) => ({ result_id: resultId, reason: "unknown_result" }));
    const unavailable = requested
      .filter((observation) => observation.unavailable)
      .map((observation) => ({
        result_id: observation.resultId,
        path: observation.path,
        reason: observation.unavailable.reason,
      }));
    const candidates = [];
    const unresolved = [...unknown, ...unavailable];
    const refreshed = new Map();
    const latestByUnit = new Map();
    for (const observation of active) {
      const previous = latestByUnit.get(observation.unitId);
      if (!previous || observation.observedAt > previous.observedAt
        || (observation.observedAt === previous.observedAt && observation.resultId.localeCompare(previous.resultId) < 0)) {
        latestByUnit.set(observation.unitId, observation);
      }
    }
    for (const observation of latestByUnit.values()) {
      const original = recordValue(this.store.state.units, observation.unitId);
      if (!original) {
        for (const affected of active.filter((item) => item.unitId === observation.unitId)) {
          unresolved.push({ result_id: affected.resultId, unit_id: affected.unitId, path: affected.path, reason: "unknown_unit" });
        }
        continue;
      }
      let candidate = refreshed.get(original.id);
      if (!candidate) {
        candidate = await this.currentCandidate(original, observation.observedAt, refresh);
        refreshed.set(original.id, candidate);
      }
      if (candidate.state !== "resolved") {
        for (const affected of active.filter((item) => item.unitId === original.id)) {
          unresolved.push({ result_id: affected.resultId, unit_id: original.id, path: original.path, reason: candidate.reason });
        }
        continue;
      }
      if (granularity === SELECTION_GRANULARITY_FILE && candidate.kind !== "file") {
        const filePath = candidate.path ?? original.path;
        const snapshot = await PrepareSourceCache.snapshot(refresh, this.workspace, filePath);
        candidate = {
          ...resolvedFile({ sourcePath: filePath, observedAt: observation.observedAt, snapshot, resolution: "file" }),
          id: candidate.id ?? original.id,
        };
      }
      candidates.push(candidate);
    }
    const projection = buildProjection(candidates, request.budgetBytes);
    const counterfactual = granularity === SELECTION_GRANULARITY_REGION
      ? await this.wholeFileCounterfactual(refresh, projection.selected)
      : null;
    const selectedIds = new Set(projection.selected.map((unit) => unit.id));
    const omittedReasons = new Map(projection.omitted.map((item) => [item.unitId, item.reason]));
    const unitStates = new Map(
      projection.selected.map((unit) => [
        unit.id,
        {
          status: unit.kind === "region" ? (unit.relocation ?? "stable") : unit.resolution === "file-fallback" ? "updated" : "stable",
          previousRange: unit.previousRange ?? null,
          currentRange: { startByte: unit.startByte, endByte: unit.endByte },
        },
      ]),
    );
    const replacements = requested.map((observation) => {
      if (observation.unavailable) {
        const unit = {
          id: observation.unavailable.legacyUnitId,
          path: observation.path,
        };
        return {
          result_id: observation.resultId,
          expected_sha256: observation.observedRevision,
          marker: unavailableMarker(unit, observation.unavailable.reason),
        };
      }
      const unit = recordValue(this.store.state.units, observation.unitId) ?? { id: observation.unitId, path: observation.path };
      const candidate = refreshed.get(observation.unitId);
      const supplied = candidate?.state === "resolved" && selectedIds.has(candidate.id);
      const reason = candidate?.reason ?? omittedReasons.get(candidate?.id) ?? "unresolved";
      return {
        result_id: observation.resultId,
        expected_sha256: observation.observedRevision,
        marker: supplied ? stableMarker(unit) : unavailableMarker(unit, reason),
      };
    });
    const planId = stableId("fp", {
      sessionId: this.sessionId,
      requestId: request.requestId,
      fingerprint,
      projection: projection.text,
    });
    const references = [...new Map(projection.selected.map((unit) => [unit.path, {
      path: unit.path,
      sourceRevision: unit.sourceRevision,
    }])).values()];
    const projectionBytes = Buffer.from(projection.text, "utf8");
    await this.store.putBlob(projectionBytes);
    const response = {
      plan_id: planId,
      replacements,
      projection_utf8_base64: projectionBytes.toString("base64"),
      projection_sha256: revisionFor(projection.text),
      selected: projection.selected.map((unit) => unit.id),
      omitted: projection.omitted,
      unresolved,
      unit_states: Object.fromEntries(unitStates),
      selection_granularity: granularity,
      ...(counterfactual ? { whole_file_equivalent: counterfactual } : {}),
    };
    setRecordValue(this.store.state.pendingPlans, request.requestId, {
      planId,
      fingerprint,
      response: StoredPlan.compact(response),
      references,
      preparedAt: Date.now(),
    });
    StoredPlan.boundPending(this.store.state);
    await this.store.save();
    return clone(response);
  }

  async wholeFileCounterfactual(cache, selected) {
    const seen = new Map();
    for (const unit of selected) {
      if (seen.has(unit.path)) continue;
      const snapshot = await PrepareSourceCache.snapshot(cache, this.workspace, unit.path);
      seen.set(unit.path, snapshot.bytes.length);
    }
    const files = [...seen.entries()]
      .map(([filePath, bytes]) => ({ path: filePath, bytes }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const wholeFileBytes = files.reduce((total, file) => total + file.bytes, 0);
    return { files, whole_file_bytes: wholeFileBytes };
  }

  async commit(request) {
    const committed = Object.values(this.store.state.committedPlans)
      .find((plan) => plan.planId === request.planId);
    if (committed) return { plan_id: request.planId, applied: true, idempotent: true };
    const pendingEntry = Object.entries(this.store.state.pendingPlans)
      .find(([, plan]) => plan.planId === request.planId);
    if (!pendingEntry) fail("unknown_plan", "plan_id is not pending for this session");
    const [requestId, pending] = pendingEntry;
    for (const reference of pending.references) {
      try {
        const current = await readStableText(this.workspace, reference.path);
        if (revisionFor(current.bytes) !== reference.sourceRevision) {
          deleteRecordValue(this.store.state.pendingPlans, requestId);
          await this.store.save();
          fail("stale_plan", "a selected source file changed before commit", { path: reference.path });
        }
      } catch (error) {
        if (error instanceof FreshCtxError && error.code === "stale_plan") throw error;
        deleteRecordValue(this.store.state.pendingPlans, requestId);
        await this.store.save();
        fail("stale_plan", "a selected source file cannot be revalidated", { path: reference.path, reason: reasonFor(error) });
      }
    }
    deleteRecordValue(this.store.state.pendingPlans, requestId);
    setRecordValue(this.store.state.committedPlans, requestId, {
      planId: request.planId,
      fingerprint: pending.fingerprint,
      response: pending.response,
      committedAt: ++this.store.state.sequence,
    });
    await this.store.save();
    return { plan_id: request.planId, applied: true, idempotent: false };
  }

  async recover(request) {
    const alias = recordValue(this.store.state.aliases, request.unitId);
    const unit = recordValue(this.store.state.units, alias?.unitId ?? request.unitId);
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
    if (StoredPlan.dropExpiredPending(this.store.state)) await this.store.save();
    const state = this.store.state;
    return {
      healthy: true,
      protocol: "freshctx/1",
      version: VERSION,
      session_id: this.sessionId,
      languages: supportedLanguages,
      counts: {
        observations: Object.keys(state.observations).length,
        units: Object.keys(state.units).length,
        pending_plans: Object.keys(state.pendingPlans).length,
        committed_plans: Object.keys(state.committedPlans).length,
      },
    };
  }
}
