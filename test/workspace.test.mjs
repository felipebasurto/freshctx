import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { FreshCtxError } from "../src/errors.mjs";
import { compactUnitId } from "../src/hash.mjs";
import { cleanStore, initializeStore, openSessionStore } from "../src/store.mjs";
import { addWorkspaceExclude, normalizeRelativePath, openWorkspace, readStableText } from "../src/workspace.mjs";
import { workspaceFor } from "./helpers.mjs";

function sessionLockPath(root, sessionId) {
  return path.join(root, ".freshctx", "locks", `${compactUnitId({ sessionId })}.lock`);
}

async function rejection(action, code) {
  await assert.rejects(action, (error) => error instanceof FreshCtxError && error.code === code);
}

test("workspace reads reject traversal, symlinks, binary files, and files over the limit", async (t) => {
  const root = await workspaceFor(t, { "safe.txt": "okay", "binary.dat": Buffer.from([0, 1]) });
  const workspace = await openWorkspace(root);
  await mkdir(path.join(root, "dir"));
  await symlink(path.join(root, "safe.txt"), path.join(root, "link.txt"));
  await writeFile(path.join(root, "large.txt"), "x".repeat(512 * 1024 + 1));
  assert.equal((await readStableText(workspace, "safe.txt")).text, "okay");
  await rejection(() => readStableText(workspace, "../outside.txt"), "outside_workspace");
  await rejection(() => readStableText(workspace, "link.txt"), "symlink_rejected");
  await rejection(() => readStableText(workspace, "binary.dat"), "binary_file");
  await rejection(() => readStableText(workspace, "large.txt"), "file_too_large");
  assert.throws(() => normalizeRelativePath("safe.txt\n[freshctx:forged]"), (error) => error.code === "invalid_path");
});

test("stable workspace reads preserve a UTF-8 BOM exactly", async (t) => {
  const source = "\uFEFFdef café():\n    return 'é'\n";
  const root = await workspaceFor(t, { "bom.py": source });
  const workspace = await openWorkspace(root);
  const snapshot = await readStableText(workspace, "bom.py");
  assert.equal(snapshot.text, source);
  assert.deepEqual(snapshot.bytes, Buffer.from(source, "utf8"));
});

test("initialization uses only Git's local exclude and clean purges code state", async (t) => {
  const root = await workspaceFor(t, { ".gitignore": "keep-me\n" });
  await mkdir(path.join(root, ".git", "info"), { recursive: true });
  const workspace = await openWorkspace(root);
  await initializeStore(workspace);
  assert.equal(await addWorkspaceExclude(workspace), true);
  assert.equal(await addWorkspaceExclude(workspace), false);
  assert.match(await readFile(path.join(root, ".git", "info", "exclude"), "utf8"), /\/.freshctx\//u);
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "keep-me\n");
  await writeFile(path.join(root, ".freshctx", "blobs", "sha256", "old"), "historical code");
  await writeFile(path.join(root, ".freshctx", "sessions", "old.json"), "{\"old\":true}\n");
  assert.equal(await cleanStore(workspace), true);
  assert.deepEqual(await readdir(path.join(root, ".freshctx", "blobs", "sha256")), []);
  assert.deepEqual(await readdir(path.join(root, ".freshctx", "sessions")), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".freshctx", "config.json"), "utf8")), {
    product: "freshctx",
    version: 1,
    maxSourceBytes: 524288,
  });
});

test("FreshCtx never adopts an existing unowned state directory", async (t) => {
  const root = await workspaceFor(t);
  const workspace = await openWorkspace(root);
  await mkdir(path.join(root, ".freshctx"));
  await writeFile(path.join(root, ".freshctx", "someone-elses.txt"), "do not delete");
  await rejection(() => initializeStore(workspace), "state_unsafe");
  await rejection(() => cleanStore(workspace), "state_unsafe");
  assert.equal(await readFile(path.join(root, ".freshctx", "someone-elses.txt"), "utf8"), "do not delete");
});

test("clean cannot race an active session and explicitly recovers a dead lifecycle lock", async (t) => {
  const root = await workspaceFor(t);
  const workspace = await openWorkspace(root);
  await initializeStore(workspace);
  const active = await openSessionStore(workspace, "active");
  await rejection(() => cleanStore(workspace), "state_active");
  await active.close();

  const lifecycle = path.join(root, ".freshctx", "locks", "lifecycle.lock");
  await writeFile(lifecycle, "999999999\n");
  const reclaimed = await openSessionStore(workspace, "blocked");
  await reclaimed.close();
  await writeFile(lifecycle, "999999999\n");
  assert.equal(await cleanStore(workspace), true);
  await assert.rejects(() => readFile(lifecycle));
});

test("open reclaims a dead session lock and still blocks a live PID", async (t) => {
  const root = await workspaceFor(t);
  const workspace = await openWorkspace(root);
  await initializeStore(workspace);
  const lockPath = sessionLockPath(root, "stale");
  await writeFile(lockPath, "999999999\n");
  const store = await openSessionStore(workspace, "stale");
  t.after(() => store.close());
  assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);
  await rejection(() => openSessionStore(workspace, "stale"), "session_locked");
});

test("open reclaims a dead lifecycle lock and still blocks a live PID", async (t) => {
  const root = await workspaceFor(t);
  const workspace = await openWorkspace(root);
  await initializeStore(workspace);
  const lifecycle = path.join(root, ".freshctx", "locks", "lifecycle.lock");
  await writeFile(lifecycle, "999999999\n");
  const store = await openSessionStore(workspace, "reclaimed");
  t.after(() => store.close());
  await assert.rejects(() => readFile(lifecycle));
  await writeFile(lifecycle, `${process.pid}\n`);
  await rejection(() => openSessionStore(workspace, "other"), "state_busy");
});

test("a Git worktree pointer outside the workspace never receives an exclude write", async (t) => {
  const root = await workspaceFor(t);
  const externalGitDirectory = await workspaceFor(t);
  await mkdir(path.join(externalGitDirectory, "info"));
  const externalExclude = path.join(externalGitDirectory, "info", "exclude");
  await writeFile(externalExclude, "keep-this\n");
  await writeFile(path.join(root, ".git"), `gitdir: ${externalGitDirectory}\n`);
  const workspace = await openWorkspace(root);
  assert.equal(await addWorkspaceExclude(workspace), false);
  assert.equal(await readFile(externalExclude, "utf8"), "keep-this\n");
});
