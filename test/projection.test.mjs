import assert from "node:assert/strict";
import test from "node:test";

import { buildProjection, decodeProjectionUnits, renderUnit } from "../src/projection.mjs";

function unit(fields) {
  return {
    observedAt: 1,
    state: "resolved",
    resolution: "file",
    startLine: 1,
    endLine: 1,
    startByte: 0,
    endByte: Buffer.byteLength(fields.content, "utf8"),
    ...fields,
  };
}

test("length-prefixed frames keep payload that looks like another header", () => {
  const content = "a.py:12\nfake-header\n";
  const framed = renderUnit(unit({
    id: "u1",
    path: "a.py",
    kind: "file",
    content,
  }));
  const [decoded] = decodeProjectionUnits(framed);
  assert.equal(decoded.kind, "file");
  assert.equal(decoded.path, "a.py");
  assert.equal(decoded.content, content);
  assert.equal(decoded.contentBytes, Buffer.byteLength(content));
});

function lineOffsetCue(header) {
  return /:\d+$/u.test(header);
}

test("Pi loop cue headers are not trailing bare integers (bytes, not line offsets)", () => {
  const symbolBody = "def tax_base(amount):\n    return amount * 2\n#\n";
  assert.equal(Buffer.byteLength(symbolBody, "utf8"), 46);
  const fileBody = `${symbolBody}${"#".repeat(76)}`;
  assert.equal(Buffer.byteLength(fileBody, "utf8"), 122);

  const symbol = renderUnit(unit({
    id: "moved",
    path: "moved.py",
    kind: "symbol",
    content: symbolBody,
  }));
  const file = renderUnit(unit({
    id: "tax",
    path: "tax.py",
    kind: "file",
    content: fileBody,
  }));
  const symbolHeader = symbol.slice(0, symbol.indexOf("\n"));
  const fileHeader = file.slice(0, file.indexOf("\n"));

  assert.equal(lineOffsetCue(symbolHeader), false, `symbol header still looks like a line offset: ${symbolHeader}`);
  assert.equal(lineOffsetCue(fileHeader), false, `file header still looks like a line offset: ${fileHeader}`);
  assert.match(symbolHeader, /^moved\.py:symbol:46bytes$/u);
  assert.match(fileHeader, /^tax\.py:122bytes$/u);
  assert.deepEqual(decodeProjectionUnits(symbol + file).map((item) => item.contentBytes), [46, 122]);

  assert.throws(() => decodeProjectionUnits("moved.py:symbol:46\n"), /content-bytes header/u);
  assert.throws(() => decodeProjectionUnits("tax.py:122\n"), /content-bytes header/u);
});

test("paths that contain colons stay file units unless the last label is symbol or region", () => {
  const content = "ok\n";
  const framed = `foo:bar.py:${Buffer.byteLength(content)}bytes\n${content}`;
  const [decoded] = decodeProjectionUnits(framed);
  assert.equal(decoded.path, "foo:bar.py");
  assert.equal(decoded.kind, "file");
  assert.equal(decoded.content, content);
});

test("an empty selected set renders zero bytes even when units were omitted", () => {
  const projection = buildProjection([
    unit({ id: "u1", path: "a.py", kind: "file", content: "def top():\n    return 1\n", state: "unresolved", reason: "deleted" }),
  ], 4096);
  assert.equal(projection.text, "");
  assert.equal(projection.bytes, 0);
  assert.equal(projection.selected.length, 0);
});

test("recency fills the budget and render order is path then id", () => {
  const first = unit({
    id: "uz",
    path: "z.py",
    kind: "file",
    content: "z\n",
    observedAt: 1,
  });
  const second = unit({
    id: "ua",
    path: "a.py",
    kind: "file",
    content: "a\n",
    observedAt: 2,
  });
  const projection = buildProjection([first, second], 4096);
  assert.deepEqual(decodeProjectionUnits(projection.text).map((item) => item.path), ["a.py", "z.py"]);
  assert.equal(projection.text, renderUnit({ ...second }) + renderUnit({ ...first }));
});

test("a recent oversized file does not overlap-drop a smaller unit that fits the budget", () => {
  const smallContent = "def top():\n    return 1\n";
  const largeContent = `${smallContent}\n${"x".repeat(400)}`;
  const small = unit({
    id: "symbol",
    path: "a.py",
    kind: "symbol",
    content: smallContent,
    observedAt: 1,
    startByte: 0,
    endByte: Buffer.byteLength(smallContent, "utf8"),
  });
  const large = unit({
    id: "file",
    path: "a.py",
    kind: "file",
    content: largeContent,
    observedAt: 2,
    startByte: 0,
    endByte: Buffer.byteLength(largeContent, "utf8"),
  });
  const budget = Buffer.byteLength(renderUnit(small));
  const projection = buildProjection([large, small], budget);
  assert.equal(projection.text, renderUnit(small));
  assert.deepEqual(projection.selected.map((item) => item.id), ["symbol"]);
  assert.deepEqual(projection.omitted, [{ unitId: "file", reason: "budget" }]);
});

test("UTF-8 frame budgets admit exact fits and skip an oversized recent unit", () => {
  const small = unit({ id: 'a', path: 'café.py', kind: 'file', content: '🙂\r\n', observedAt: 1 });
  const large = unit({ id: 'b', path: 'large.py', kind: 'file', content: 'x'.repeat(100), observedAt: 2 });
  const exact = Buffer.byteLength(renderUnit(small));
  const projection = buildProjection([large, small], exact);
  assert.equal(projection.text, renderUnit(small));
  assert.equal(projection.bytes, exact);
  assert.deepEqual(projection.omitted, [{ unitId: 'b', reason: 'budget' }]);
  assert.equal(buildProjection([small], exact - 1).text, '');
});
