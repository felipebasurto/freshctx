import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { capabilities } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = await mkdtemp(path.join(tmpdir(), "freshctx-pack-cache-"));
const packDir = await mkdtemp(path.join(tmpdir(), "freshctx-pack-out-"));
let raw;
try {
  raw = execFileSync("npm", ["pack", "--json", "--cache", cache, "--pack-destination", packDir], {
    cwd: root,
    encoding: "utf8",
  });
} finally {
  await rm(cache, { recursive: true, force: true });
}

function parsePackJson(text) {
  const start = text.indexOf("[");
  assert.ok(start >= 0, "npm pack did not emit JSON");
  return JSON.parse(text.slice(start));
}

const packed = parsePackJson(raw);
const files = packed[0].files.map((entry) => entry.path).sort();
const binEntry = packed[0].files.find((entry) => entry.path === "bin/freshctx.mjs");
const manifestPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(Boolean(manifestPkg.scripts["bench:addon"]), false, "product package must not ship bench scripts");
assert.equal(manifestPkg.exports, undefined);
assert.equal(manifestPkg.scripts.verify, undefined);

const forbidden = /^(test|adapters|bridges|bench|autoresearch|capture|papers|examples|scripts|docs)\//u;
assert.equal(files.some((entry) => forbidden.test(entry)), false, `unexpected package file: ${files.find((entry) => forbidden.test(entry))}`);
const allowedRoots = new Set(["bin", "src", "schema", "vendor", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "package.json"]);
assert.ok(files.every((entry) => allowedRoots.has(entry.split("/")[0])), "product tarball contains a file outside the fixed allowlist");
assert.equal(manifestPkg.private, true, "npm publication remains disabled");
for (const required of ["bin/freshctx.mjs", "src/server.mjs", "schema/freshctx-v1.json", "vendor/treesitter/tree-sitter.wasm", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"]) {
  assert.ok(files.includes(required), `missing package file: ${required}`);
}
assert.equal(binEntry.mode, 0o755, "CLI binary must be executable in the npm tarball");

const manifest = JSON.parse(await readFile(path.join(root, "vendor/treesitter/manifest.json"), "utf8"));
assert.equal(manifest.license, "MIT");
for (const asset of manifest.assets) {
  const bytes = await readFile(path.join(root, "vendor/treesitter", asset.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, asset.sha256, `asset hash mismatch: ${asset.file}`);
  assert.match(asset.source, /^https:\/\/www\.npmjs\.com\/package\//u);
}

const extractDir = path.join(packDir, "extract");
try {
  await mkdir(extractDir);
  execFileSync("tar", ["-xzf", path.join(packDir, packed[0].filename), "-C", extractDir]);
  const extracted = path.join(extractDir, "package");
  const bin = path.join(extracted, "bin/freshctx.mjs");

  const diagnosed = execFileSync(process.execPath, [bin, "doctor"], { encoding: "utf8" });
  assert.equal(JSON.parse(diagnosed).healthy, true);

  const source = "def top():\n    return 1\n";
  const edited = "def top():\n    return 2\n";
  const work = await mkdtemp(path.join(tmpdir(), "freshctx-packed-cli-"));
  try {
    await writeFile(path.join(work, "a.py"), source);
    execFileSync(process.execPath, [bin, "init", "--root", work], { encoding: "utf8" });

    const child = spawn(process.execPath, [bin, "serve", "--stdio", "--root", work], { stdio: ["pipe", "pipe", "pipe"] });
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
    try {
      const hello = await call({ id: "h", op: "hello", session_id: "packed", capabilities });
      assert.equal(hello.ok, true);
      const observed = await call({
        id: "o",
        op: "observe",
        result_id: "read-1",
        path: "a.py",
        content_utf8_base64: Buffer.from(source).toString("base64"),
      });
      assert.equal(observed.ok, true);
      await writeFile(path.join(work, "a.py"), edited);
      const plan = await call({
        id: "p",
        op: "prepare",
        request_id: "req-1",
        result_ids: ["read-1"],
        budget_bytes: 4096,
      });
      assert.equal(plan.ok, true, JSON.stringify(plan));
      const projection = Buffer.from(plan.result.projection_utf8_base64, "base64").toString("utf8");
      assert.match(projection, /return 2/u);
      assert.doesNotMatch(projection, /return 1/u);
      const committed = await call({ id: "c", op: "commit", plan_id: plan.result.plan_id });
      assert.equal(committed.ok, true);
      assert.equal(committed.result.applied, true);
    } finally {
      child.stdin.end();
      if (!child.killed) child.kill();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
} finally {
  await rm(packDir, { recursive: true, force: true });
}

process.stdout.write(`package contains ${files.length} allowlisted files; ${manifest.assets.length} Tree-sitter assets verified\n`);
