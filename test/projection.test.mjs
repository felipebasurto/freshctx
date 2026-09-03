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

test("paths that contain colons stay file units unless the last label is symbol or region", () => {
  const content = "ok\n";
  const framed = `foo:bar.py:${Buffer.byteLength(content)}\n${content}`;
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
