import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openWorkspace } from "../src/workspace.mjs";
import { FreshCtxSession } from "../src/session.mjs";
import { openSessionStore } from "../src/store.mjs";

export const capabilities = Object.freeze({
  request_rewrite: true,
  stable_result_identity: true,
  projection_insertion: true,
  shared_workspace: true,
});

export async function workspaceFor(test, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "freshctx-test-"));
  test.after(async () => rm(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

export async function sessionFor(test, root, sessionId = "session") {
  const workspace = await openWorkspace(root);
  const store = await openSessionStore(workspace, sessionId);
  test.after(async () => store.close());
  return new FreshCtxSession({ workspace, store, sessionId });
}

export function content(value) {
  const bytes = Buffer.from(value, "utf8");
  return { bytes, text: value };
}

export function decodedProjection(plan) {
  return Buffer.from(plan.projection_utf8_base64, "base64").toString("utf8");
}
