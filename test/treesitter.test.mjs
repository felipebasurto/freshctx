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

test("shared UTF-16 to UTF-8 offsets stay aligned for BOM, emoji, and many declarations", async () => {
  const text = `\uFEFF# 🙂\n${Array.from({ length: 48 }, (_, index) => `def f${index}():\n    return ${index}\n`).join("\n")}`;
  const parsed = await parseUnits({ path: "a.py", text });
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.units.length, 48);
  const bytes = Buffer.from(text, "utf8");
  for (const unit of parsed.units) {
    const name = unit.selector.slice("function ".length);
    const prefix = text.slice(0, text.indexOf(`def ${name}(`));
    assert.equal(unit.startByte, Buffer.byteLength(prefix, "utf8"), name);
    assert.equal(bytes.subarray(unit.startByte, unit.endByte).toString("utf8").startsWith(`def ${name}(`), true, name);
  }
  const cafe = "\uFEFFdef café():\n    return '🙂'\n";
  const startByte = Buffer.byteLength("\uFEFF", "utf8");
  const resolved = await uniqueUnitForRange({
    path: "a.py",
    text: cafe,
    range: { startByte, endByte: startByte + 8 },
  });
  assert.equal(resolved.unit?.selector, "function café");
  assert.equal(resolved.unit?.startByte, startByte);
});
