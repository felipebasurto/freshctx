import { mkdir, lstat, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { fail } from "./errors.mjs";
import { digestFromRevision, randomId, sha256, stableId } from "./hash.mjs";

const STATE_DIRECTORY = ".freshctx";
const SCHEMA_VERSION = 1;
const STATE_PRODUCT = "freshctx";
const LIFECYCLE_LOCK = "lifecycle.lock";
const LIFECYCLE_RECOVERY_PREFIX = `${LIFECYCLE_LOCK}.recovering.`;

function statePath(workspace) {
  return path.join(workspace.root, STATE_DIRECTORY);
}

async function ensureRealDirectory(target) {
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail("state_unsafe", "FreshCtx state path must be a real directory");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
}

async function requireRealDirectory(target, message = "FreshCtx state path must be a real directory") {
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("state_unsafe", message);
  } catch (error) {
    if (error?.code === "ENOENT") fail("state_corrupt", "FreshCtx state is incomplete");
    throw error;
  }
}

async function createStateDirectory(target) {
  try {
    await mkdir(target, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await requireRealDirectory(target);
    return false;
  }
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
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail("state_unsafe", "FreshCtx state file must be a regular file");
    }
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
  const normalized = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(normalized, key, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return normalized;
}

function validateConfig(config) {
  if (!isRecord(config) || !Object.hasOwn(config, "product") || config.product !== STATE_PRODUCT) {
    fail("state_unsafe", "FreshCtx state does not have an owned configuration");
  }
  if (!Object.hasOwn(config, "version") || config.version !== SCHEMA_VERSION) {
    fail("state_version", "FreshCtx state uses an unsupported schema version");
  }
  if (!Object.hasOwn(config, "maxSourceBytes") || !Number.isSafeInteger(config.maxSourceBytes) || config.maxSourceBytes <= 0) {
    fail("state_corrupt", "FreshCtx state configuration is invalid");
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function lockMayBeActive(pid) {
  return !Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid);
}

async function hasActiveLocks(lockDirectory) {
  const directory = await lstat(lockDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    fail("state_unsafe", "FreshCtx lock directory is unsafe");
  }
  for (const name of await readdir(lockDirectory)) {
    if (name === LIFECYCLE_LOCK) continue;
    const lockPath = path.join(lockDirectory, name);
    const entry = await lstat(lockPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail("state_unsafe", "FreshCtx lock path is unsafe");
    }
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    if (lockMayBeActive(pid)) return true;
  }
  return false;
}

async function readLockPid(lockPath) {
  const entry = await lstat(lockPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail("state_unsafe", "FreshCtx lock path is unsafe");
  }
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

async function recoveryLocks(lockDirectory) {
  return (await readdir(lockDirectory))
    .filter((name) => name.startsWith(LIFECYCLE_RECOVERY_PREFIX))
    .map((name) => path.join(lockDirectory, name));
}

async function clearDeadLifecycleRecoveries(lockDirectory) {
  for (const recoveryPath of await recoveryLocks(lockDirectory)) {
    const pid = await readLockPid(recoveryPath);
    if (lockMayBeActive(pid)) fail("state_busy", "FreshCtx state maintenance is already active");
    await rm(recoveryPath, { force: false });
  }
}

async function acquireLifecycleLock(root, { recoverStale = false } = {}) {
  const lockDirectory = path.join(root, "locks");
  const lockPath = path.join(root, "locks", LIFECYCLE_LOCK);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const recoveries = await recoveryLocks(lockDirectory);
    if (recoveries.length > 0) {
      if (!recoverStale) fail("state_busy", "FreshCtx state maintenance is already active");
      await clearDeadLifecycleRecoveries(lockDirectory);
      continue;
    }
    try {
      return await createLock(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!recoverStale) {
        await readLockPid(lockPath);
        fail("state_busy", "FreshCtx state maintenance is already active");
      }
      const pid = await readLockPid(lockPath);
      if (lockMayBeActive(pid)) fail("state_busy", "FreshCtx state maintenance is already active");
      const recoveryPath = `${lockPath}.recovering.${randomId("lock")}`;
      try {
        await rename(lockPath, recoveryPath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      const movedPid = await readLockPid(recoveryPath);
      if (lockMayBeActive(movedPid)) fail("state_busy", "FreshCtx state maintenance is already active");
      await rm(recoveryPath, { force: false });
    }
  }
  fail("state_busy", "FreshCtx state maintenance could not be acquired");
}

async function acquireSessionLock(lockPath) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createLock(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pid = await readLockPid(lockPath);
      if (lockMayBeActive(pid)) fail("session_locked", "this FreshCtx session is already active");
      const recoveryPath = `${lockPath}.recovering.${randomId("lock")}`;
      try {
        await rename(lockPath, recoveryPath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      const movedPid = await readLockPid(recoveryPath);
      if (lockMayBeActive(movedPid)) fail("session_locked", "this FreshCtx session is already active");
      await rm(recoveryPath, { force: false });
    }
  }
  fail("session_locked", "this FreshCtx session could not be acquired");
}

async function removeInactiveSessionLocks(lockDirectory) {
  for (const name of await readdir(lockDirectory)) {
    if (name === LIFECYCLE_LOCK) continue;
    const lockPath = path.join(lockDirectory, name);
    const pid = await readLockPid(lockPath);
    if (lockMayBeActive(pid)) fail("state_active", "refusing to clean while a FreshCtx session is active");
    await rm(lockPath, { force: false });
  }
}

function validateSessionState(state, sessionId) {
  if (!isRecord(state) || !Object.hasOwn(state, "version") || state.version !== SCHEMA_VERSION
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

function blankSession(sessionId) {
  return {
    version: SCHEMA_VERSION,
    sessionId,
    observations: Object.create(null),
    units: Object.create(null),
    pendingPlans: Object.create(null),
    committedPlans: Object.create(null),
    sequence: 0,
  };
}

export async function initializeStore(workspace) {
  const root = statePath(workspace);
  const created = await createStateDirectory(root);
  const configPath = path.join(root, "config.json");
  if (created) {
    await writeAtomic(configPath, `${JSON.stringify({ product: STATE_PRODUCT, version: SCHEMA_VERSION, maxSourceBytes: 524288 })}\n`);
  } else {
    const current = await readJson(configPath);
    if (current === null) {
      fail("state_unsafe", "refusing to adopt an unowned FreshCtx state directory");
    }
    validateConfig(current);
  }
  for (const child of ["blobs", "blobs/sha256", "sessions", "locks"]) {
    await ensureRealDirectory(path.join(root, child));
  }
  return { root };
}

async function openExistingStore(workspace) {
  const target = statePath(workspace);
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail("state_unsafe", "FreshCtx state path must be a real directory");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const config = await readJson(path.join(target, "config.json"));
  if (config === null) fail("state_unsafe", "FreshCtx state does not have an owned configuration");
  validateConfig(config);
  for (const child of ["blobs", "blobs/sha256", "sessions", "locks"]) {
    await requireRealDirectory(path.join(target, child));
  }
  return { root: target };
}

async function resetDirectory(target) {
  await rm(target, { recursive: true, force: false, maxRetries: 1 });
  await mkdir(target, { recursive: true, mode: 0o700 });
}

export async function cleanStore(workspace) {
  const existing = await openExistingStore(workspace);
  if (!existing) return false;
  const lifecycle = await acquireLifecycleLock(existing.root, { recoverStale: true });
  try {
    const lockDirectory = path.join(existing.root, "locks");
    if (await hasActiveLocks(lockDirectory)) {
      fail("state_active", "refusing to clean while a FreshCtx session is active");
    }
    await removeInactiveSessionLocks(lockDirectory);
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
  const initialized = await initializeStore(workspace);
  const sessionKey = stableId("session", { sessionId }).slice("session_".length);
  const sessionPath = path.join(initialized.root, "sessions", `${sessionKey}.json`);
  const lockPath = path.join(initialized.root, "locks", `${sessionKey}.lock`);
  const lifecycle = await acquireLifecycleLock(initialized.root, { recoverStale: true });
  let lock;
  let state;
  try {
    lock = await acquireSessionLock(lockPath);
    state = await readJson(sessionPath) ?? blankSession(sessionId);
    validateSessionState(state, sessionId);
  } catch (error) {
    if (lock) await releaseLock(lock);
    throw error;
  } finally {
    await releaseLock(lifecycle);
  }

  let closed = false;
  async function save() {
    if (closed) fail("session_closed", "FreshCtx session is closed");
    await writeAtomic(sessionPath, `${JSON.stringify(state)}\n`);
  }
  async function putBlob(bytes) {
    if (closed) fail("session_closed", "FreshCtx session is closed");
    const digest = sha256(bytes);
    const target = path.join(initialized.root, "blobs", "sha256", digest);
    try {
      const entry = await lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink()) fail("state_unsafe", "FreshCtx blob path is unsafe");
      const existing = await readFile(target);
      if (sha256(existing) !== digest) fail("blob_corrupt", "FreshCtx blob contents do not match its SHA-256 name");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeAtomic(target, bytes);
    }
    return `sha256:${digest}`;
  }
  async function getBlob(revision) {
    const digest = digestFromRevision(revision);
    const target = path.join(initialized.root, "blobs", "sha256", digest);
    try {
      const entry = await lstat(target);
      if (!entry.isFile() || entry.isSymbolicLink()) fail("state_unsafe", "FreshCtx blob path is unsafe");
      const bytes = await readFile(target);
      if (sha256(bytes) !== digest) fail("blob_corrupt", "FreshCtx blob contents do not match its SHA-256 name");
      return bytes;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    await releaseLock(lock);
  }
  return { state, save, putBlob, getBlob, close, root: initialized.root };
}
