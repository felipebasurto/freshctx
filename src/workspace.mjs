import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readFile,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { fail } from "./errors.mjs";

export const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024;

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function normalizeRelativePath(input) {
  if (typeof input !== "string" || input.length === 0 || /[\u0000-\u001f\u007f]/u.test(input)) {
    fail("invalid_path", "path must be a non-empty relative path");
  }
  if (path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    fail("outside_workspace", "absolute paths are not accepted");
  }
  const slashPath = input.replaceAll("\\", "/");
  if (slashPath.split("/").includes("..")) {
    fail("outside_workspace", "path traversal is not accepted");
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail("outside_workspace", "path escapes the workspace");
  }
  return normalized;
}

async function assertNoSymlinkSegments(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") fail("deleted", "source file no longer exists");
      throw error;
    }
    if (entry.isSymbolicLink()) fail("symlink_rejected", "symbolic links are not tracked");
  }
  return current;
}

function decodeUtf8(bytes) {
  if (bytes.includes(0)) fail("binary_file", "source file appears to be binary");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("non_utf8", "source file is not valid UTF-8");
  }
}

async function readAtMost(handle, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export async function openWorkspace(root) {
  if (typeof root !== "string" || root.length === 0) {
    fail("invalid_workspace", "workspace root is required");
  }
  const resolvedRoot = await realpath(root);
  if (!(await lstat(resolvedRoot)).isDirectory()) {
    fail("invalid_workspace", "workspace root must be a real directory");
  }
  return Object.freeze({ root: resolvedRoot });
}

export async function readStableText(workspace, clientPath, { maxBytes = DEFAULT_MAX_SOURCE_BYTES } = {}) {
  const relativePath = normalizeRelativePath(clientPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = await assertNoSymlinkSegments(workspace.root, relativePath);
    const resolved = await realpath(candidate);
    if (!pathIsInside(workspace.root, resolved)) {
      fail("outside_workspace", "resolved path escapes the workspace");
    }
    const before = await stat(resolved);
    if (!before.isFile()) fail("not_regular_file", "source path is not a regular file");
    if (before.size > maxBytes) fail("file_too_large", "source file exceeds the configured limit");

    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(resolved, flags);
      const opened = await handle.stat();
      if (!opened.isFile()) fail("not_regular_file", "source path is not a regular file");
      const bytes = await readAtMost(handle, maxBytes);
      if (bytes.length > maxBytes) fail("file_too_large", "source file exceeds the configured limit");
      const after = await stat(resolved);
      const afterCandidate = await assertNoSymlinkSegments(workspace.root, relativePath);
      if (!sameStat(before, after) || !sameStat(opened, after) || await realpath(afterCandidate) !== resolved) {
        if (attempt === 0) continue;
        fail("snapshot_unstable", "source file changed while FreshCtx was reading it");
      }
      return { path: relativePath, text: decodeUtf8(bytes), bytes };
    } catch (error) {
      if (error?.code === "ENOENT") fail("deleted", "source file no longer exists");
      throw error;
    } finally {
      await handle?.close();
    }
  }
  fail("snapshot_unstable", "source file changed while FreshCtx was reading it");
}

async function gitDirectory(workspaceRoot) {
  const dotGit = path.join(workspaceRoot, ".git");
  try {
    const entry = await lstat(dotGit);
    if (entry.isSymbolicLink()) return null;
    if (entry.isDirectory()) {
      const resolved = await realpath(dotGit);
      return pathIsInside(workspaceRoot, resolved) ? resolved : null;
    }
    if (!entry.isFile()) return null;
    const text = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(text);
    if (!match) return null;
    const target = path.resolve(workspaceRoot, match[1]);
    if (!pathIsInside(workspaceRoot, target)) return null;
    if (!(await lstat(target)).isDirectory()) return null;
    const resolved = await realpath(target);
    return pathIsInside(workspaceRoot, resolved) ? resolved : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function addWorkspaceExclude(workspace) {
  const gitDir = await gitDirectory(workspace.root);
  if (!gitDir) return false;
  const infoDir = path.join(gitDir, "info");
  try {
    if (!(await lstat(infoDir)).isDirectory()) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(infoDir, { recursive: true, mode: 0o700 });
  }
  const resolvedInfo = await realpath(infoDir);
  if (!pathIsInside(workspace.root, resolvedInfo)) return false;
  const excludePath = path.join(infoDir, "exclude");
  let existing = "";
  try {
    if (!(await lstat(excludePath)).isFile()) return false;
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const line = "/.freshctx/";
  if (existing.split(/\r?\n/u).includes(line)) return false;
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(excludePath, flags, 0o600);
  try {
    await handle.writeFile(`${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
  } finally {
    await handle.close();
  }
  return true;
}
