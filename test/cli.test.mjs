import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { capabilities, workspaceFor } from "./helpers.mjs";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "freshctx.mjs");

function run(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("CLI doctor loads every vendored Tree-sitter grammar", async () => {
  const diagnosed = await run(["doctor"]);
  assert.equal(diagnosed.code, 0, diagnosed.stderr);
  assert.deepEqual(JSON.parse(diagnosed.stdout).languages, [
    "python",
    "javascript",
    "typescript",
    "tsx",
    "go",
    "rust",
  ]);
});

test("CLI initializes, serves JSONL over stdio, and cleans one workspace state", async (t) => {
  const root = await workspaceFor(t);
  const initialized = await run(["init", "--root", root]);
  assert.equal(initialized.code, 0);
  assert.equal(JSON.parse(initialized.stdout).initialized, true);
  assert.equal(JSON.parse(await readFile(path.join(root, ".freshctx", "config.json"), "utf8")).version, 1);
  const hello = {
    protocol: "freshctx/1",
    id: "hello",
    op: "hello",
    session_id: "native-session",
    capabilities,
  };
  const status = { protocol: "freshctx/1", id: "status", op: "status" };
  const served = await run(["serve", "--stdio", "--root", root], `${JSON.stringify(hello)}\n${JSON.stringify(status)}\n`);
  assert.equal(served.code, 0, served.stderr);
  const responses = served.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses[0].result.accepted, true);
  assert.equal(responses[1].result.session_id, "native-session");
  const cleaned = await run(["clean", "--root", root]);
  assert.equal(cleaned.code, 0);
  assert.equal(JSON.parse(cleaned.stdout).cleaned, true);
});

test("a host observes, prepares, substitutes the marker, and commits over stdio", async (t) => {
  const source = "def top():\n    return 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  assert.equal((await run(["init", "--root", root])).code, 0);

  const child = spawn(process.execPath, [bin, "serve", "--stdio", "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (!child.killed) child.kill();
  });
  let buffer = "";
  const waiting = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const next = waiting.shift();
      if (next) next(JSON.parse(line));
    }
  });
  function call(message) {
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      waiting.push(resolve);
      child.stdin.write(`${JSON.stringify({ protocol: "freshctx/1", ...message })}\n`);
    });
  }

  const hello = await call({ id: "h", op: "hello", session_id: "host", capabilities });
  assert.equal(hello.ok, true);
  const observed = await call({
    id: "o",
    op: "observe",
    result_id: "read-1",
    path: "a.py",
    content_utf8_base64: Buffer.from(source).toString("base64"),
  });
  assert.equal(observed.ok, true);
  assert.match(observed.result.marker, /^\[[0-9a-f]{24}\]$/u);

  const plan = await call({
    id: "p",
    op: "prepare",
    request_id: "req-1",
    result_ids: ["read-1"],
    budget_bytes: 4096,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const projection = Buffer.from(plan.result.projection_utf8_base64, "base64").toString("utf8");
  assert.match(projection, /def top/u);
  assert.equal(plan.result.replacements[0].marker, observed.result.marker);

  const committed = await call({ id: "c", op: "commit", plan_id: plan.result.plan_id });
  assert.equal(committed.ok, true);
  assert.equal(committed.result.applied, true);
  child.stdin.end();
});
