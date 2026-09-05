import { FreshCtxError, fail } from "./errors.mjs";
import { compactUnitId, equalBytes, revisionFor, stableId } from "./hash.mjs";
import { buildProjection, stableMarker, unavailableMarker } from "./projection.mjs";
import { VERSION } from "./protocol.mjs";
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
  return compactUnitId({ kind: "file", path: sourcePath });
}

function symbolUnitId(sourcePath, selector) {
  return compactUnitId({ kind: "symbol", path: sourcePath, selector });
}

function regionUnitId(sourcePath, startByte, endByte) {
  return compactUnitId({ kind: "region", path: sourcePath, startByte, endByte });
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
  return {
    id: fileUnitId(sourcePath),
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

function resolvedRegion({ sourcePath, observedAt, snapshot, range, resolution = "region" }) {
  const bytes = snapshot.bytes.subarray(range.startByte, range.endByte);
  const revision = revisionFor(bytes);
  return {
    id: regionUnitId(sourcePath, range.startByte, range.endByte),
    path: sourcePath,
    kind: "region",
    selector: null,
    observedAt,
    state: "resolved",
    resolution,
    sourceRevision: revisionFor(snapshot.bytes),
    revision,
    startByte: range.startByte,
    endByte: range.endByte,
    ...lineRangeForByteSpan(snapshot.bytes, range.startByte, range.endByte),
    content: utf8Slice(snapshot.bytes, range.startByte, range.endByte),
  };
}

function resolvedSymbol({ sourcePath, observedAt, snapshot, parsed }) {
  const bytes = snapshot.bytes.subarray(parsed.startByte, parsed.endByte);
  const revision = revisionFor(bytes);
  return {
    id: symbolUnitId(sourcePath, parsed.selector),
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

function planFingerprint(request) {
  return JSON.stringify({ resultIds: [...request.resultIds].sort(), budgetBytes: request.budgetBytes });
}

export const PENDING_PLAN_TTL_MS = 30 * 60 * 1000;
// A session keeps at most this many uncommitted plans, newest preparedAt first.
// prepare A → prepare B → commit A succeeds when A is still inside this window.
export const MAX_PENDING_PLANS = 16;

class PrepareSourceCache {
  constructor() {
    // One disk snapshot and Tree-sitter index per path for this prepare.
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

  static projectionRevision(plan) {
    return plan.response?.projection_sha256 ?? null;
  }

  static liveRevisions(state) {
    const live = new Set();
    for (const plan of Object.values(state.pendingPlans)) {
      const revision = StoredPlan.projectionRevision(plan);
      if (revision) live.add(revision);
    }
    for (const plan of Object.values(state.committedPlans)) {
      const revision = StoredPlan.projectionRevision(plan);
      if (revision) live.add(revision);
    }
    for (const unit of Object.values(state.units)) {
      for (const revision of unit.revisions ?? []) live.add(revision);
    }
    for (const observation of Object.values(state.observations)) {
      if (observation.observedRevision) live.add(observation.observedRevision);
    }
    return live;
  }

  static async releaseUnreferenced(store, revisions) {
    if (revisions.length === 0) return;
    const live = StoredPlan.liveRevisions(store.state);
    for (const revision of new Set(revisions)) {
      if (!revision || live.has(revision)) continue;
      await store.deleteBlob(revision);
    }
  }

  static dropExpiredPending(state, now = Date.now()) {
    const dropped = [];
    for (const [requestId, plan] of Object.entries(state.pendingPlans)) {
      if (!Number.isSafeInteger(plan.preparedAt) || now - plan.preparedAt <= PENDING_PLAN_TTL_MS) continue;
      dropped.push(StoredPlan.projectionRevision(plan));
      deleteRecordValue(state.pendingPlans, requestId);
    }
    return dropped;
  }

  static boundPending(state) {
    const entries = Object.entries(state.pendingPlans);
    if (entries.length <= MAX_PENDING_PLANS) return [];
    const ranked = entries
      .map(([requestId, plan], index) => ({ requestId, plan, index }))
      .sort((left, right) => {
        const byTime = (left.plan.preparedAt ?? 0) - (right.plan.preparedAt ?? 0);
        if (byTime !== 0) return byTime;
        return left.index - right.index;
      });
    const dropped = [];
    for (const { requestId, plan } of ranked.slice(0, entries.length - MAX_PENDING_PLANS)) {
      dropped.push(StoredPlan.projectionRevision(plan));
      deleteRecordValue(state.pendingPlans, requestId);
    }
    return dropped;
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
        else if (resolved.status === "ok") {
          unit = resolvedRegion({ sourcePath, observedAt, snapshot, range: request.range });
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
    return { ...file, id: unit.id };
  }

  async currentRegion(unit, snapshot, observedAt) {
    const startByte = unit.startByte;
    const endByte = unit.endByte;
    if (!Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 || endByte <= startByte || endByte > snapshot.bytes.length) {
      return unresolvedUnit({
        id: unit.id,
        sourcePath: unit.path,
        kind: "region",
        observedAt,
        reason: "range_unresolved",
      });
    }
    try {
      const candidate = resolvedRegion({
        sourcePath: unit.path,
        observedAt,
        snapshot,
        range: { startByte, endByte },
      });
      candidate.id = unit.id;
      await this.updateStoredUnit(candidate);
      return candidate;
    } catch {
      return unresolvedUnit({
        id: unit.id,
        sourcePath: unit.path,
        kind: "region",
        observedAt,
        reason: "resolution_failed",
      });
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
      return this.currentRegion(unit, snapshot, observedAt);
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
    const fingerprint = planFingerprint(request);
    const expired = StoredPlan.dropExpiredPending(this.store.state);
    if (expired.length > 0) {
      await this.store.save();
      await StoredPlan.releaseUnreferenced(this.store, expired);
    }
    const known = recordValue(this.store.state.pendingPlans, request.requestId)
      ?? recordValue(this.store.state.committedPlans, request.requestId);
    if (known) {
      if (known.fingerprint !== fingerprint) fail("idempotency_conflict", "request_id was already prepared with different inputs");
      return StoredPlan.hydrate(this.store, known);
    }
    const refresh = new PrepareSourceCache();

    const active = request.resultIds.map((resultId) => recordValue(this.store.state.observations, resultId)).filter(Boolean);
    const unknown = request.resultIds
      .filter((resultId) => !recordValue(this.store.state.observations, resultId))
      .map((resultId) => ({ result_id: resultId, reason: "unknown_result" }));
    const candidates = [];
    const unresolved = [...unknown];
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
      candidates.push(candidate);
    }
    const projection = buildProjection(candidates, request.budgetBytes);
    const selectedIds = new Set(projection.selected.map((unit) => unit.id));
    const omittedReasons = new Map(projection.omitted.map((item) => [item.unitId, item.reason]));
    const replacements = active.map((observation) => {
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
    };
    setRecordValue(this.store.state.pendingPlans, request.requestId, {
      planId,
      fingerprint,
      response: StoredPlan.compact(response),
      references,
      preparedAt: Date.now(),
    });
    const evicted = StoredPlan.boundPending(this.store.state);
    await this.store.save();
    await StoredPlan.releaseUnreferenced(this.store, evicted);
    return clone(response);
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
          await StoredPlan.releaseUnreferenced(this.store, [StoredPlan.projectionRevision(pending)]);
          fail("stale_plan", "a selected source file changed before commit", { path: reference.path });
        }
      } catch (error) {
        if (error instanceof FreshCtxError && error.code === "stale_plan") throw error;
        deleteRecordValue(this.store.state.pendingPlans, requestId);
        await this.store.save();
        await StoredPlan.releaseUnreferenced(this.store, [StoredPlan.projectionRevision(pending)]);
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
    const unit = recordValue(this.store.state.units, request.unitId);
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
    const expired = StoredPlan.dropExpiredPending(this.store.state);
    if (expired.length > 0) {
      await this.store.save();
      await StoredPlan.releaseUnreferenced(this.store, expired);
    }
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
