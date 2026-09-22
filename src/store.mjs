import { mkdir, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { fail } from "./errors.mjs";
import {
  compactUnitId,
  digestFromRevision,
  fileUnitIdentity,
  legacyCompactUnitId,
  randomId,
  regionUnitIdentity,
  sha256,
  symbolUnitIdentity,
} from "./hash.mjs";

const STATE_DIRECTORY = ".freshctx";
const STATE_CHILDREN = ["blobs", "blobs/sha256", "sessions", "locks"];
const CONFIG_SCHEMA_VERSION = 1;
const SESSION_SCHEMA_VERSION = 2;
const STATE_PRODUCT = "freshctx";
const LIFECYCLE_LOCK = "lifecycle.lock";
const LIFECYCLE_RECOVERY_PREFIX = `${LIFECYCLE_LOCK}.recovering.`;
const UNSAFE_DIRECTORY = "FreshCtx state path must be a real directory";

function statePath(workspace) {
  return path.join(workspace.root, STATE_DIRECTORY);
}

async function entryAt(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureRealDirectory(target) {
  const entry = await entryAt(target);
  if (!entry) await mkdir(target, { recursive: true, mode: 0o700 });
  else if (!entry.isDirectory()) fail("state_unsafe", UNSAFE_DIRECTORY);
}

async function requireRealDirectory(target) {
  const entry = await entryAt(target);
  if (!entry) fail("state_corrupt", "FreshCtx state is incomplete");
  if (!entry.isDirectory()) fail("state_unsafe", UNSAFE_DIRECTORY);
}

async function writeAtomic(target, value) {
  const temporary = `${target}.${randomId("tmp")}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJson(target) {
  const entry = await entryAt(target);
  if (!entry) return null;
  if (!entry.isFile()) fail("state_unsafe", "FreshCtx state file must be a regular file");
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) fail("state_corrupt", "FreshCtx state is not valid JSON");
    throw error;
  }
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function normalizeRecord(value, field) {
  if (!isRecord(value)) fail("state_corrupt", `FreshCtx ${field} must be an object record`);
  return Object.assign(Object.create(null), value);
}

function validateConfig(config) {
  if (!isRecord(config) || !Object.hasOwn(config, "product") || config.product !== STATE_PRODUCT) {
    fail("state_unsafe", "FreshCtx state does not have an owned configuration");
  }
  if (!Object.hasOwn(config, "version") || config.version !== CONFIG_SCHEMA_VERSION) {
    fail("state_version", "FreshCtx state uses an unsupported schema version");
  }
  if (!Object.hasOwn(config, "maxSourceBytes") || !Number.isSafeInteger(config.maxSourceBytes) || config.maxSourceBytes <= 0) {
    fail("state_corrupt", "FreshCtx state configuration is invalid");
  }
}

function lockMayBeActive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readLockPid(lockPath) {
  const entry = await lstat(lockPath);
  if (!entry.isFile()) fail("state_unsafe", "FreshCtx lock path is unsafe");
  return Number((await readFile(lockPath, "utf8")).trim());
}

async function releaseLock(lock) {
  try {
    await lock.handle.close();
  } finally {
    await rm(lock.path, { force: true });
  }
}

async function createLock(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    return { handle, path: lockPath };
  } catch (error) {
    await handle?.close();
    if (handle) await rm(lockPath, { force: true });
    throw error;
  }
}

async function acquireLock(lockPath, code, subject, clearRecoveries = async () => false) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await clearRecoveries()) continue;
    try {
      return await createLock(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (lockMayBeActive(await readLockPid(lockPath))) fail(code, `${subject} is already active`);
    const recoveryPath = `${lockPath}.recovering.${randomId("lock")}`;
    try {
      await rename(lockPath, recoveryPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (lockMayBeActive(await readLockPid(recoveryPath))) fail(code, `${subject} is already active`);
    await rm(recoveryPath, { force: false });
  }
  fail(code, `${subject} could not be acquired`);
}

function acquireLifecycleLock(root) {
  const lockDirectory = path.join(root, "locks");
  const subject = "FreshCtx state maintenance";
  return acquireLock(path.join(lockDirectory, LIFECYCLE_LOCK), "state_busy", subject, async () => {
    const recoveries = (await readdir(lockDirectory)).filter((name) => name.startsWith(LIFECYCLE_RECOVERY_PREFIX));
    for (const name of recoveries) {
      const recoveryPath = path.join(lockDirectory, name);
      if (lockMayBeActive(await readLockPid(recoveryPath))) fail("state_busy", `${subject} is already active`);
      await rm(recoveryPath, { force: false });
    }
    return recoveries.length > 0;
  });
}

function validateSessionHeader(state, sessionId, version) {
  if (!isRecord(state) || !Object.hasOwn(state, "version") || state.version !== version
    || !Object.hasOwn(state, "sessionId") || state.sessionId !== sessionId
    || !Object.hasOwn(state, "observations") || !Object.hasOwn(state, "units")
    || !Object.hasOwn(state, "pendingPlans") || !Object.hasOwn(state, "committedPlans")
    || !Object.hasOwn(state, "sequence") || !Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    fail("state_corrupt", "FreshCtx session state does not match this session");
  }
  state.observations = normalizeRecord(state.observations, "session observations");
  state.units = normalizeRecord(state.units, "session units");
  state.pendingPlans = normalizeRecord(state.pendingPlans, "session pending plans");
  state.committedPlans = normalizeRecord(state.committedPlans, "session committed plans");
}

function validateSessionV2(state, sessionId) {
  validateSessionHeader(state, sessionId, SESSION_SCHEMA_VERSION);
  state.aliases = normalizeRecord(state.aliases, "session unit aliases");
  for (const [unitId, unit] of Object.entries(state.units)) {
    if (isRecord(unit) && unit.kind === "file" && unit.state === "unresolved"
      && !Object.hasOwn(unit, "identity") && typeof unit.path === "string"
      && compactUnitId(fileUnitIdentity(unit.path)) === unitId) {
      unit.identity = fileUnitIdentity(unit.path);
    }
    if (!/^[a-f0-9]{24}$/u.test(unitId) || !isRecord(unit) || unit.id !== unitId
      || !isRecord(unit.identity) || compactUnitId(unit.identity) !== unitId) {
      fail("state_corrupt", "FreshCtx session unit identity is invalid");
    }
  }
  for (const observation of Object.values(state.observations)) {
    if (!isRecord(observation)) fail("state_corrupt", "FreshCtx session observation is invalid");
    if (observation.unavailable) {
      if (observation.unitId !== null || !isRecord(observation.unavailable)
        || typeof observation.unavailable.reason !== "string"
        || typeof observation.unavailable.legacyUnitId !== "string") {
        fail("state_corrupt", "FreshCtx unavailable observation is invalid");
      }
    } else if (typeof observation.unitId !== "string" || !Object.hasOwn(state.units, observation.unitId)) {
      fail("state_corrupt", "FreshCtx observation references an unknown unit");
    }
  }
  for (const alias of Object.values(state.aliases)) {
    if (!isRecord(alias) || typeof alias.unitId !== "string" || !Object.hasOwn(state.units, alias.unitId)) {
      fail("state_corrupt", "FreshCtx unit alias is invalid");
    }
  }
}

function identityVerdict(oldId, unit, observations) {
  if (!isRecord(unit)) fail("state_corrupt", "FreshCtx session unit is invalid");
  if (observations.some((observation) => observation.path !== unit.path)) {
    return { unavailable: "identity_collision" };
  }
  if (unit.kind !== "file" && observations.some((observation) => observation.range === null)) {
    return { unavailable: "identity_collision" };
  }
  const named = typeof unit.path !== "string" ? null
    : unit.kind === "file" ? fileUnitIdentity(unit.path)
      : unit.kind === "symbol" && typeof unit.selector === "string" ? symbolUnitIdentity(unit.path, unit.selector)
        : null;
  if (named) {
    return legacyCompactUnitId(named) === oldId ? { identity: named, alias: true } : { unavailable: "identity_collision" };
  }
  if (unit.kind !== "region") return { unavailable: "identity_collision" };
  if (typeof unit.path !== "string" || typeof unit.prefixAnchor !== "string" || typeof unit.suffixAnchor !== "string") {
    return { unavailable: "legacy_region" };
  }
  const regionIdentity = (revision, parent) =>
    regionUnitIdentity(unit.path, revision, unit.prefixAnchor, unit.suffixAnchor, parent);
  const revisions = new Set([
    unit.referentRevision,
    unit.revision,
    ...(Array.isArray(unit.revisions) ? unit.revisions : []),
  ].filter((revision) => typeof revision === "string"));
  const matches = new Map();
  for (const revision of revisions) {
    for (const parent of new Set([unit.parentSelector ?? null, null])) {
      const identity = regionIdentity(revision, parent);
      if (legacyCompactUnitId(identity) === oldId) matches.set(compactUnitId(identity), identity);
    }
  }
  if (matches.size > 1) return { unavailable: "identity_collision" };
  if (matches.size === 1) return { identity: [...matches.values()][0], alias: true };
  const revision = unit.referentRevision ?? unit.revision;
  if (typeof revision !== "string") return { unavailable: "legacy_region" };
  return { identity: regionIdentity(revision, unit.parentSelector ?? null), alias: false };
}

function blankSession(sessionId, sequence = 0) {
  return {
    version: SESSION_SCHEMA_VERSION,
    sessionId,
    observations: Object.create(null),
    units: Object.create(null),
    aliases: Object.create(null),
    pendingPlans: Object.create(null),
    committedPlans: Object.create(null),
    sequence,
  };
}

function migrateSessionV1(state) {
  const observationsByUnit = new Map();
  for (const observation of Object.values(state.observations)) {
    if (!isRecord(observation) || typeof observation.unitId !== "string") {
      fail("state_corrupt", "FreshCtx session observation is invalid");
    }
    const bound = observationsByUnit.get(observation.unitId) ?? [];
    bound.push(observation);
    observationsByUnit.set(observation.unitId, bound);
  }
  const migrated = blankSession(state.sessionId, state.sequence);
  const outcomes = new Map();
  for (const [oldId, unit] of Object.entries(state.units)) {
    const verdict = identityVerdict(oldId, unit, observationsByUnit.get(oldId) ?? []);
    if (verdict.unavailable) {
      outcomes.set(oldId, verdict);
      continue;
    }
    const unitId = compactUnitId(verdict.identity);
    migrated.units[unitId] = { ...structuredClone(unit), id: unitId, identity: verdict.identity };
    if (verdict.alias) migrated.aliases[oldId] = { unitId };
    outcomes.set(oldId, { unitId });
  }
  for (const [resultId, observation] of Object.entries(state.observations)) {
    const outcome = outcomes.get(observation.unitId) ?? { unavailable: "identity_collision" };
    migrated.observations[resultId] = outcome.unavailable
      ? {
        ...structuredClone(observation),
        unitId: null,
        unavailable: { reason: outcome.unavailable, legacyUnitId: observation.unitId },
      }
      : { ...structuredClone(observation), unitId: outcome.unitId };
  }
  return migrated;
}

export async function initializeStore(workspace) {
  const root = statePath(workspace);
  const configPath = path.join(root, "config.json");
  let created = true;
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await requireRealDirectory(root);
    created = false;
  }
  if (created) {
    await writeAtomic(configPath, `${JSON.stringify({ product: STATE_PRODUCT, version: CONFIG_SCHEMA_VERSION, maxSourceBytes: 524288 })}\n`);
  } else {
    const current = await readJson(configPath);
    if (current === null) fail("state_unsafe", "refusing to adopt an unowned FreshCtx state directory");
    validateConfig(current);
  }
  for (const child of STATE_CHILDREN) await ensureRealDirectory(path.join(root, child));
  return { root };
}

async function openExistingStore(workspace) {
  const root = statePath(workspace);
  const entry = await entryAt(root);
  if (!entry) return null;
  if (!entry.isDirectory()) fail("state_unsafe", UNSAFE_DIRECTORY);
  const config = await readJson(path.join(root, "config.json"));
  if (config === null) fail("state_unsafe", "FreshCtx state does not have an owned configuration");
  validateConfig(config);
  for (const child of STATE_CHILDREN) await requireRealDirectory(path.join(root, child));
  return { root };
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: false, maxRetries: 1 });
  await mkdir(target, { recursive: true, mode: 0o700 });
}

export async function cleanStore(workspace) {
  const existing = await openExistingStore(workspace);
  if (!existing) return false;
  const lifecycle = await acquireLifecycleLock(existing.root);
  try {
    const lockDirectory = path.join(existing.root, "locks");
    const sessionLocks = [];
    for (const name of await readdir(lockDirectory)) {
      if (name === LIFECYCLE_LOCK) continue;
      const lockPath = path.join(lockDirectory, name);
      sessionLocks.push({ lockPath, pid: await readLockPid(lockPath) });
    }
    if (sessionLocks.some((lock) => lockMayBeActive(lock.pid))) {
      fail("state_active", "refusing to clean while a FreshCtx session is active");
    }
    for (const { lockPath } of sessionLocks) await rm(lockPath, { force: false });
    await resetDirectory(path.join(existing.root, "blobs"));
    await ensureRealDirectory(path.join(existing.root, "blobs", "sha256"));
    await resetDirectory(path.join(existing.root, "sessions"));
    return true;
  } finally {
    await releaseLock(lifecycle);
  }
}

export async function openSessionStore(workspace, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("invalid_session", "session id is required");
  }
  const { root } = await initializeStore(workspace);
  const sessionKey = compactUnitId({ sessionId });
  const sessionPath = path.join(root, "sessions", `${sessionKey}.json`);
  const blobPath = (digest) => path.join(root, "blobs", "sha256", digest);
  const lifecycle = await acquireLifecycleLock(root);
  let lock;
  let state;
  try {
    lock = await acquireLock(path.join(root, "locks", `${sessionKey}.lock`), "session_locked", "this FreshCtx session");
    const stored = await readJson(sessionPath);
    if (stored === null) {
      state = blankSession(sessionId);
    } else if (stored.version === 1) {
      validateSessionHeader(stored, sessionId, 1);
      state = migrateSessionV1(stored);
      validateSessionV2(state, sessionId);
      await writeAtomic(sessionPath, `${JSON.stringify(state)}\n`);
    } else if (stored.version === SESSION_SCHEMA_VERSION) {
      state = stored;
      validateSessionV2(state, sessionId);
    } else {
      fail("state_version", "FreshCtx session state uses an unsupported schema version");
    }
  } catch (error) {
    if (lock) await releaseLock(lock);
    throw error;
  } finally {
    await releaseLock(lifecycle);
  }

  let closed = false;
  function assertOpen() {
    if (closed) fail("session_closed", "FreshCtx session is closed");
  }
  async function save() {
    assertOpen();
    await writeAtomic(sessionPath, `${JSON.stringify(state)}\n`);
  }
  async function putBlob(bytes) {
    assertOpen();
    const digest = sha256(bytes);
    const target = blobPath(digest);
    const entry = await entryAt(target);
    if (!entry) await writeAtomic(target, bytes);
    else if (!entry.isFile()) fail("state_unsafe", "FreshCtx blob path is unsafe");
    else if (entry.size !== bytes.length) fail("blob_corrupt", "FreshCtx blob contents do not match its SHA-256 name");
    return `sha256:${digest}`;
  }
  async function getBlob(revision) {
    const target = blobPath(digestFromRevision(revision));
    const entry = await entryAt(target);
    if (!entry) return null;
    if (!entry.isFile()) fail("state_unsafe", "FreshCtx blob path is unsafe");
    const bytes = await readFile(target);
    if (`sha256:${sha256(bytes)}` !== revision) fail("blob_corrupt", "FreshCtx blob contents do not match its SHA-256 name");
    return bytes;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await releaseLock(lock);
  }
  return { state, save, putBlob, getBlob, close, root };
}
