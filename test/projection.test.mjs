import assert from "node:assert/strict";
import test from "node:test";

import { buildProjection, renderUnit } from "../src/projection.mjs";
import { decodeUnits } from "./helpers.mjs";

function unit(fields) {
  return {
    observedAt: 1,
    startByte: 0,
    endByte: Buffer.byteLength(fields.content, "utf8"),
    ...fields,
  };
}

test("length-prefixed frames keep payload that looks like another header", () => {
  const content = "a.py:12\nfake-header\n";
  const [decoded] = decodeUnits(renderUnit(unit({ id: "u1", path: "a.py", kind: "file", content })));
  assert.deepEqual(decoded, { path: "a.py", kind: "file", contentBytes: Buffer.byteLength(content), content });
});

test("Pi loop cue headers are not trailing bare integers (bytes, not line offsets)", () => {
  const symbolBody = "def tax_base(amount):\n    return amount * 2\n#\n";
  assert.equal(Buffer.byteLength(symbolBody, "utf8"), 46);
  const fileBody = `${symbolBody}${"#".repeat(76)}`;
  assert.equal(Buffer.byteLength(fileBody, "utf8"), 122);

  const symbol = renderUnit(unit({ id: "moved", path: "moved.py", kind: "symbol", content: symbolBody }));
  const file = renderUnit(unit({ id: "tax", path: "tax.py", kind: "file", content: fileBody }));
  assert.match(symbol.slice(0, symbol.indexOf("\n")), /^moved\.py:symbol:46bytes$/u);
  assert.match(file.slice(0, file.indexOf("\n")), /^tax\.py:122bytes$/u);
  assert.deepEqual(decodeUnits(symbol + file).map((item) => item.contentBytes), [46, 122]);
});

test("paths that contain colons stay file units unless the last label is symbol or region", () => {
  const content = "ok\n";
  const [decoded] = decodeUnits(`foo:bar.py:${Buffer.byteLength(content)}bytes\n${content}`);
  assert.equal(decoded.path, "foo:bar.py");
  assert.equal(decoded.kind, "file");
  assert.equal(decoded.content, content);
});

test("recency fills the budget and render order is path then id", () => {
  const first = unit({ id: "uz", path: "z.py", kind: "file", content: "z\n", observedAt: 1 });
  const second = unit({ id: "ua", path: "a.py", kind: "file", content: "a\n", observedAt: 2 });
  const projection = buildProjection([first, second], 4096);
  assert.deepEqual(decodeUnits(projection.text).map((item) => item.path), ["a.py", "z.py"]);
  assert.equal(projection.text, renderUnit(second) + renderUnit(first));
});

test("a recent oversized file does not overlap-drop a smaller unit that fits the budget", () => {
  const smallContent = "def top():\n    return 1\n";
  const small = unit({ id: "symbol", path: "a.py", kind: "symbol", content: smallContent, observedAt: 1 });
  const large = unit({ id: "file", path: "a.py", kind: "file", content: `${smallContent}\n${"x".repeat(400)}`, observedAt: 2 });
  const projection = buildProjection([large, small], Buffer.byteLength(renderUnit(small)));
  assert.equal(projection.text, renderUnit(small));
  assert.deepEqual(projection.selected.map((item) => item.id), ["symbol"]);
  assert.deepEqual(projection.omitted, [{ unitId: "file", reason: "budget" }]);
});

test("UTF-8 frame budgets admit exact fits and skip an oversized recent unit", () => {
  const small = unit({ id: "a", path: "café.py", kind: "file", content: "🙂\r\n", observedAt: 1 });
  const large = unit({ id: "b", path: "large.py", kind: "file", content: "x".repeat(100), observedAt: 2 });
  const exact = Buffer.byteLength(renderUnit(small));
  const projection = buildProjection([large, small], exact);
  assert.equal(projection.text, renderUnit(small));
  assert.equal(projection.bytes, exact);
  assert.deepEqual(projection.omitted, [{ unitId: "b", reason: "budget" }]);
  assert.deepEqual(buildProjection([small], exact - 1), {
    text: "",
    bytes: 0,
    selected: [],
    omitted: [{ unitId: "a", reason: "budget" }],
  });
});

test("a unit inside an older wider unit ranks after it; partial overlaps keep both", () => {
  const body = "a\n".repeat(50);
  const file = unit({ id: "file", path: "a.py", kind: "file", content: body, observedAt: 1 });
  const tail = unit({ id: "tail", path: "a.py", kind: "symbol", content: body.slice(90), startByte: 90, endByte: 100, observedAt: 2 });
  const inside = buildProjection([file, tail], 4096);
  assert.deepEqual(inside.selected.map((item) => item.id), ["file"]);
  assert.deepEqual(inside.omitted, [{ unitId: "tail", reason: "overlap" }]);

  const head = unit({ id: "head", path: "a.py", kind: "region", content: body.slice(0, 60), startByte: 0, endByte: 60, observedAt: 1 });
  const middle = unit({ id: "middle", path: "a.py", kind: "region", content: body.slice(58, 80), startByte: 58, endByte: 80, observedAt: 2 });
  const partial = buildProjection([head, middle], 4096);
  assert.deepEqual(partial.selected.map((item) => item.id).sort(), ["head", "middle"]);
  assert.deepEqual(partial.omitted, []);

  const spanned = unit({ id: "spanned", path: "a.py", kind: "region", content: body.slice(50, 70), startByte: 50, endByte: 70, observedAt: 0 });
  const union = buildProjection([head, middle, spanned], 4096);
  assert.deepEqual(union.omitted, [{ unitId: "spanned", reason: "overlap" }]);
});
