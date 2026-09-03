import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
const packed = JSON.parse(raw);
const files = packed[0].files.map((entry) => entry.path).sort();
const binEntry = packed[0].files.find((entry) => entry.path === "bin/freshctx.mjs");
const forbidden = /^(test|adapters|bench|autoresearch|capture|papers|examples|scripts|docs)\//u;
assert.equal(files.some((entry) => forbidden.test(entry)), false, `unexpected package file: ${files.find((entry) => forbidden.test(entry))}`);
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

process.stdout.write(`package contains ${files.length} allowlisted files; ${manifest.assets.length} Tree-sitter assets verified\n`);
