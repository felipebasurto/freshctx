import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../src/client.mjs";
import { capabilities } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifestPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
assert.equal(Boolean(manifestPkg.scripts["bench:addon"]), false, "product package must not ship bench scripts");
assert.deepEqual(manifestPkg.exports, {
  "./client": "./src/client.mjs",
  "./hash": "./src/hash.mjs",
  "./workspace": "./src/workspace.mjs",
});
assert.deepEqual(manifestPkg.dependencies ?? {}, {}, "product package must not depend on bridges");
assert.equal(manifestPkg.scripts.verify, undefined);
assert.equal(manifestPkg.private, true, "npm publication remains disabled");

const manifest = JSON.parse(await readFile(path.join(root, "vendor/treesitter/manifest.json"), "utf8"));
assert.equal(manifest.license, "MIT");
for (const asset of manifest.assets) {
  const bytes = await readFile(path.join(root, "vendor/treesitter", asset.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `asset hash mismatch: ${asset.file}`);
  assert.match(asset.source, /^https:\/\/www\.npmjs\.com\/package\//u);
}

function parsePackJson(text) {
  const start = text.indexOf("[");
  assert.ok(start >= 0, "npm pack did not emit JSON");
  return JSON.parse(text.slice(start));
}

async function exercisePackedServer(bin) {
  const source = "def top():\n    return 1\n";
  const work = await mkdtemp(path.join(tmpdir(), "freshctx-packed-cli-"));
  let client;
  try {
    await writeFile(path.join(work, "a.py"), source);
    execFileSync(process.execPath, [bin, "init", "--root", work], { encoding: "utf8" });
    client = new Client({ args: [bin, "serve", "--stdio", "--root", work] });
    await client.request("hello", { session_id: "packed", capabilities });
    await client.request("observe", {
      result_id: "read-1",
      path: "a.py",
      content_utf8_base64: Buffer.from(source).toString("base64"),
    });
    await writeFile(path.join(work, "a.py"), source.replace("return 1", "return 2"));
    const plan = await client.request("prepare", { request_id: "req-1", result_ids: ["read-1"], budget_bytes: 4096 });
    const projection = Buffer.from(plan.projection_utf8_base64, "base64").toString("utf8");
    assert.match(projection, /return 2/u);
    assert.doesNotMatch(projection, /return 1/u);
    assert.equal((await client.request("commit", { plan_id: plan.plan_id })).applied, true);
  } finally {
    await client?.close();
    await rm(work, { recursive: true, force: true });
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), "freshctx-pack-"));
try {
  const raw = execFileSync("npm", ["pack", "--json", "--cache", path.join(scratch, "cache"), "--pack-destination", scratch], {
    cwd: root,
    encoding: "utf8",
  });
  const [packed] = parsePackJson(raw);
  const files = packed.files.map((entry) => entry.path).sort();
  const forbidden = /^(test|adapters|bridges|bench|autoresearch|capture|papers|examples|scripts|docs)\//u;
  assert.equal(files.some((entry) => forbidden.test(entry)), false, `unexpected package file: ${files.find((entry) => forbidden.test(entry))}`);
  const allowedRoots = new Set(["bin", "src", "schema", "vendor", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "package.json"]);
  assert.ok(files.every((entry) => allowedRoots.has(entry.split("/")[0])), "product tarball contains a file outside the fixed allowlist");
  for (const required of ["bin/freshctx.mjs", "src/client.mjs", "src/server.mjs", "schema/freshctx-v1.json", "vendor/treesitter/tree-sitter.wasm", "LICENSE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(files.includes(required), `missing package file: ${required}`);
  }
  assert.equal(packed.files.find((entry) => entry.path === "bin/freshctx.mjs").mode, 0o755, "CLI binary must be executable in the npm tarball");
  process.stdout.write(`package contains ${files.length} allowlisted files; ${manifest.assets.length} Tree-sitter assets verified\n`);

  execFileSync("tar", ["-xzf", path.join(scratch, packed.filename), "-C", scratch]);
  const bin = path.join(scratch, "package", "bin", "freshctx.mjs");
  assert.equal(JSON.parse(execFileSync(process.execPath, [bin, "doctor"], { encoding: "utf8" })).healthy, true);
  await exercisePackedServer(bin);
  const demo = JSON.parse(execFileSync(process.execPath, [path.join(root, "examples", "request-copy.mjs"), bin], { encoding: "utf8", timeout: 15000 }));
  assert.equal(demo.historyPreserved, true);
  assert.equal(demo.currentSymbolPresent, true);
  assert.equal(demo.staleBodyRemoved, true);
  process.stdout.write("packed CLI: doctor, init, observe/edit/prepare/commit, and example passed\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
