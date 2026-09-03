import assert from "node:assert/strict";
import test from "node:test";

import { parseUnits, uniqueUnitForRange, verifyTreeSitterAssets } from "../src/treesitter.mjs";

const fixtures = {
  "a.py": "class Box:\n    def run(self):\n        return 1\n\ndef top():\n    return 2\n",
  "a.js": "class Box { run() { return 1; } }\nfunction top() { return 2; }\n",
  "a.ts": "abstract class Box { run(): number { return 1; } }\nfunction top(): number { return 2; }\n",
  "a.tsx": "function Component(): JSX.Element { return <div />; }\n",
  "a.go": "package demo\n\ntype Box struct{}\nfunc (Box) Run() int { return 1 }\n",
  "a.rs": "fn top() -> i32 { 1 }\n",
};

test("Tree-sitter assets load and resolve all supported languages", async () => {
  assert.deepEqual(await verifyTreeSitterAssets(), ["python", "javascript", "typescript", "tsx", "go", "rust"]);
  for (const [sourcePath, text] of Object.entries(fixtures)) {
    const parsed = await parseUnits({ path: sourcePath, text });
    assert.equal(parsed.status, "ok", sourcePath);
    assert.ok(parsed.units.length > 0, sourcePath);
  }
});

test("Tree-sitter reports unsupported and broken files without inventing a symbol", async () => {
  assert.equal((await parseUnits({ path: "a.txt", text: "hello" })).status, "unsupported");
  assert.equal((await parseUnits({ path: "a.py", text: "def broken(\n" })).status, "broken");
});

test("nested functions keep unique qualified selectors", async () => {
  const text = "def outer():\n    def inner():\n        return 1\n    return inner\n";
  const parsed = await parseUnits({ path: "a.py", text });
  assert.deepEqual(parsed.units.map((unit) => unit.selector).sort(), [
    "function outer",
    "function outer::function inner",
  ]);
});

test("ambiguous duplicate selectors are not eligible as a symbol", async () => {
  const text = "def duplicate():\n    return 1\n\ndef duplicate():\n    return 2\n";
  const parsed = await parseUnits({ path: "a.py", text });
  assert.equal(parsed.units.length, 0);
});

test("partial ranges resolve one enclosing symbol with UTF-8 byte offsets", async () => {
  const text = "# é\ndef top():\n    return 1\n";
  const startByte = Buffer.byteLength("# é\n", "utf8");
  const endByte = Buffer.byteLength(text, "utf8") - 1;
  const resolved = await uniqueUnitForRange({ path: "a.py", text, range: { startByte, endByte } });
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.unit?.selector, "function top");
  assert.equal(resolved.unit?.startByte, startByte);
});
