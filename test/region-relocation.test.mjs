import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { relocateRegion } from "../src/relocate.mjs";
import { content, decodedProjection, projectedUnits, sessionFor, workspaceFor } from "./helpers.mjs";

async function observeRegion(t, file, shown) {
  const root = await workspaceFor(t, { "f.py": file });
  const session = await sessionFor(t, root);
  const startByte = Buffer.from(file).indexOf(shown);
  await session.observe({
    resultId: "r1",
    path: "f.py",
    content: content(shown),
    range: { startByte, endByte: startByte + Buffer.byteLength(shown) },
    turn: 1,
  });
  return { root, session };
}

async function prepareOne(session, root, mutated) {
  await writeFile(path.join(root, "f.py"), mutated);
  const plan = await session.prepare({ requestId: "q", resultIds: ["r1"], budgetBytes: 131072 });
  const [unit] = projectedUnits(plan);
  return { plan, unit, status: plan.unit_states[plan.selected[0]]?.status };
}

async function assertInvalidated(session, root, mutated) {
  const { plan } = await prepareOne(session, root, mutated);
  assert.deepEqual(plan.selected, []);
  assert.equal(decodedProjection(plan), "");
  assert.deepEqual(plan.unresolved.map((entry) => entry.reason), ["referent_missing"]);
}

test("prepend comment relocates the region instead of slicing stale offsets", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan, unit, status } = await prepareOne(session, root, "# prefix\nRATE = 10\n");
  assert.equal(status, "relocated");
  assert.equal(unit.content, "RATE = 10");
  await session.commit({ planId: plan.plan_id });
});

test("prepend 100 lines relocates", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const prefix = Array.from({ length: 100 }, (_, i) => `# line ${i}`).join("\n");
  const { unit, status } = await prepareOne(session, root, `${prefix}\nRATE = 10\n`);
  assert.equal(status, "relocated");
  assert.equal(unit.content, "RATE = 10");
});

test("insert immediately before the region relocates", async (t) => {
  const { root, session } = await observeRegion(t, "A = 1\nRATE = 10\nB = 2\n", "RATE = 10");
  const { plan, unit, status } = await prepareOne(session, root, "A = 1\nNEW = 0\nRATE = 10\nB = 2\n");
  assert.equal(status, "relocated");
  assert.equal(unit.content, "RATE = 10");
  await session.commit({ planId: plan.plan_id });
});

test("delete immediately before the region relocates", async (t) => {
  const { root, session } = await observeRegion(t, "A = 1\nRATE = 10\n", "RATE = 10");
  const { unit, status } = await prepareOne(session, root, "RATE = 10\n");
  assert.equal(status, "relocated");
  assert.equal(unit.content, "RATE = 10");
});

test("insert or delete immediately after the region keeps the referent stable", async (t) => {
  for (const [before, after] of [["RATE = 10\n", "RATE = 10\nAFTER = 1\n"], ["RATE = 10\nB = 2\n", "RATE = 10\n"]]) {
    const { root, session } = await observeRegion(t, before, "RATE = 10");
    const { unit, status } = await prepareOne(session, root, after);
    assert.equal(status, "stable");
    assert.equal(unit.content, "RATE = 10");
  }
});

test("in-place content edit refreshes as updated", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan, unit, status } = await prepareOne(session, root, "RATE = 12\n");
  assert.equal(status, "updated");
  assert.equal(unit.content, "RATE = 12");
  await session.commit({ planId: plan.plan_id });
});

test("insert lines inside an unparseable region span refreshes within the region", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 1\nBASE = 10\nTOTAL = 11\n", "BASE = 10\nTOTAL = 11");
  const { unit, status } = await prepareOne(session, root, "RATE = 1\nBASE = 10\nFEE = 1\nTOTAL = 12\n");
  assert.equal(status, "updated");
  assert.equal(unit.content, "BASE = 10\nFEE = 1\nTOTAL = 12");
});

test("delete lines inside a region refreshes the surviving span", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 1\nBASE = 10\nFEE = 1\nTOTAL = 12\n", "BASE = 10\nFEE = 1\nTOTAL = 12");
  const { unit, status } = await prepareOne(session, root, "RATE = 1\nBASE = 10\nTOTAL = 12\n");
  assert.equal(status, "updated");
  assert.equal(unit.content, "BASE = 10\nTOTAL = 12");
});

test("move region within the same structural parent tracks the referent", async (t) => {
  const { root, session } = await observeRegion(t, "HEAD = 0\nTAIL = 9\nVALUE = 2\nFOOT = 1\n", "VALUE = 2");
  const { unit, status } = await prepareOne(session, root, "HEAD = 0\nVALUE = 2\nTAIL = 9\nFOOT = 1\n");
  assert.equal(status, "relocated");
  assert.equal(unit.content, "VALUE = 2");
});

test("a read inside a function follows the moved enclosing symbol", async (t) => {
  const { root, session } = await observeRegion(t, "def price():\n    return 10\n\ndef other():\n    return 1\n", "    return 10");
  const { plan, unit } = await prepareOne(session, root, "def other():\n    return 1\n\ndef price():\n    return 10\n");
  assert.equal(unit.kind, "symbol");
  assert.equal(unit.content, "def price():\n    return 10");
  await session.commit({ planId: plan.plan_id });
});

test("formatter whitespace changes update the referent in place", async (t) => {
  const { root, session } = await observeRegion(t, "RATE   =   10\n", "RATE   =   10");
  const { unit, status } = await prepareOne(session, root, "RATE = 10\n");
  assert.equal(status, "updated");
  assert.equal(unit.content, "RATE = 10");
});

test("a duplicated referent stays pinned to its previous offset", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan, unit, status } = await prepareOne(session, root, "RATE = 10\nRATE = 10\n");
  assert.equal(status, "stable");
  assert.deepEqual(plan.unit_states[plan.selected[0]].currentRange, { startByte: 0, endByte: 9 });
  assert.equal(unit.content, "RATE = 10");
});

test("duplicate surrounding anchor updates the edited span instead of a surviving copy", async (t) => {
  const { root, session } = await observeRegion(t, "HEAD = 0\nVALUE = 1\nMID = 0\nVALUE = 1\nTAIL = 9\n", "VALUE = 1");
  const { plan, unit, status } = await prepareOne(session, root, "HEAD = 0\nVALUE = 9\nMID = 0\nVALUE = 1\nTAIL = 9\n");
  assert.equal(plan.selected.length, 1);
  assert.equal(status, "updated");
  assert.equal(unit.content, "VALUE = 9");
});

test("duplicate surrounding anchor with both copies changed does not pick the other copy", async (t) => {
  const before = "HEAD = 0\nSEC_A = 1\nVALUE = 1\nEND = 1\nSEC_A = 2\nVALUE = 1\nEND = 2\nTAIL = 9\n";
  const { root, session } = await observeRegion(t, before, "VALUE = 1");
  await assertInvalidated(session, root, "HEAD = 0\nSEC_A = 1\nVALUE = 9\nEND = 1\nSEC_A = 2\nVALUE = 2\nEND = 2\nTAIL = 9\n");
});

test("deleted referent invalidates instead of projecting ghost bytes", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\nOTHER = 1\n", "RATE = 10");
  await assertInvalidated(session, root, "OTHER = 1\n");
});

test("referent replaced by unrelated code does not project the replacement as the referent", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  await assertInvalidated(session, root, "UNRELATED = 'xyz'\n");
});

test("full rewrite preserving another fragment relocates only the surviving referent", async (t) => {
  const { root, session } = await observeRegion(t, "KEEP = 1\nRATE = 10\n", "KEEP = 1");
  const { unit, status } = await prepareOne(session, root, "HEADER = 0\nKEEP = 1\nFOOTER = 2\n");
  assert.equal(status, "relocated");
  assert.equal(unit.content, "KEEP = 1");
});

test("renaming the enclosing function falls back to the current file", async (t) => {
  const { root, session } = await observeRegion(t, "def price():\n    rate = 10\n    return rate\n", "    rate = 10");
  const after = "def cost():\n    rate = 10\n    return rate\n";
  const { unit, status } = await prepareOne(session, root, after);
  assert.equal(status, "updated");
  assert.equal(unit.kind, "file");
  assert.equal(unit.content, after);
});

test("wrapping code in a class keeps the inner region", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { unit, status } = await prepareOne(session, root, "class Config:\n    RATE = 10\n");
  assert.equal(status, "relocated");
  assert.equal(unit.content, "RATE = 10");
});

test("edits elsewhere in a large file keep the region", async (t) => {
  const filler = Array.from({ length: 200 }, (_, i) => `line${i} = ${i}`).join("\n");
  const before = `${filler}\nRATE = 10\n`;
  const { root, session } = await observeRegion(t, before, "RATE = 10");
  const { unit, status } = await prepareOne(session, root, before.replace("line100 = 100", "line100 = 999"));
  assert.equal(status, "stable");
  assert.equal(unit.content, "RATE = 10");
});

test("file granularity widens the same selection to synchronized whole files", async (t) => {
  const before = "/**\n * header\n */\n\nexport type M = \"a\";\n\nexport function f() {\n  return 1;\n}\n";
  const header = before.slice(0, before.indexOf("export function f"));
  const root = await workspaceFor(t, { "s.ts": before });
  const session = await sessionFor(t, root);
  await session.observe({
    resultId: "r1",
    path: "s.ts",
    content: content(header),
    range: { startByte: 0, endByte: Buffer.byteLength(header) },
    turn: 1,
  });
  await writeFile(path.join(root, "s.ts"), before.replace('"a"', '"a" | "b"'));
  const region = await session.prepare({ requestId: "q-region", resultIds: ["r1"], budgetBytes: 8192 });
  const file = await session.prepare({ requestId: "q-file", resultIds: ["r1"], budgetBytes: 8192, granularity: "file" });
  assert.deepEqual(file.selected, region.selected);
  assert.equal(file.selection_granularity, "file");
  assert.equal(region.selection_granularity, "region");
  const regionText = decodedProjection(region);
  const fileText = decodedProjection(file);
  assert.match(regionText, /"a" \| "b"/u);
  assert.doesNotMatch(regionText, /return 1/u);
  assert.match(fileText, /"a" \| "b"/u);
  assert.match(fileText, /return 1/u);
  assert.ok(region.whole_file_equivalent.whole_file_bytes >= Buffer.byteLength(fileText, "utf8") - 64);
  assert.deepEqual(region.whole_file_equivalent.files.map((entry) => entry.path), ["s.ts"]);
  assert.equal(file.whole_file_equivalent, undefined);
  await session.commit({ planId: file.plan_id });
});

test("file granularity defaults to region when absent and rejects unknown modes", async (t) => {
  const { session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const plan = await session.prepare({ requestId: "q-default", resultIds: ["r1"], budgetBytes: 131072 });
  assert.equal(plan.selection_granularity, "region");
  await assert.rejects(
    session.prepare({ requestId: "q-bad", resultIds: ["r1"], budgetBytes: 131072, granularity: "paragraph" }),
    /selection_granularity/u,
  );
  await session.commit({ planId: plan.plan_id });
});

test("relocateRegion never returns stale absolute offsets for shifted bytes", () => {
  const snapshotBytes = Buffer.from("# prefix\nRATE = 10\n", "utf8");
  const outcome = relocateRegion({
    snapshotBytes,
    parsedOk: true,
    referentBytes: Buffer.from("RATE = 10"),
    suffixAnchor: Buffer.from("\n").toString("base64"),
    prevStart: 0,
    prevEnd: 9,
    previousOccurrences: 1,
  });
  assert.deepEqual(outcome, { status: "relocated", startByte: 9, endByte: 18 });
});

test("relocateRegion reports ambiguous when anchors bracket distinct spans", () => {
  const outcome = relocateRegion({
    snapshotBytes: Buffer.from("A=1\nB=2\n", "utf8"),
    parsedOk: true,
    referentBytes: Buffer.from("ZZZ"),
    suffixAnchor: Buffer.from("\n").toString("base64"),
    prevStart: 20,
    prevEnd: 23,
  });
  assert.deepEqual(outcome, { status: "ambiguous" });
});

test("identical region fingerprints at different offsets keep distinct identities across reopen", async (t) => {
  const pad = `# ${"Y".repeat(125)}\n`;
  assert.equal(Buffer.byteLength(pad), 128);
  const shown = "VALUE = 1";
  const before = `${pad}${shown}\n${pad}${shown}\n${pad}`;
  const root = await workspaceFor(t, { "f.py": before });
  const first = await sessionFor(t, root);
  const ids = [];
  for (const startByte of [Buffer.byteLength(pad), Buffer.byteLength(`${pad}${shown}\n${pad}`)]) {
    const observed = await first.observe({
      resultId: String(startByte),
      path: "f.py",
      content: content(shown),
      range: { startByte, endByte: startByte + Buffer.byteLength(shown) },
      turn: 1,
    });
    ids.push(observed.unit_id);
  }
  assert.notEqual(ids[0], ids[1]);
  await first.store.close();

  const second = await sessionFor(t, root);
  const resultIds = Object.keys(second.store.state.observations);
  const plan = await second.prepare({ requestId: "both", resultIds, budgetBytes: 4096 });
  assert.deepEqual([...plan.selected].sort(), [...ids].sort());
  assert.notDeepEqual(plan.unit_states[ids[0]].currentRange, plan.unit_states[ids[1]].currentRange);

  await writeFile(path.join(root, "f.py"), `# changed\n${before}`);
  const moved = await second.prepare({ requestId: "moved", resultIds, budgetBytes: 4096 });
  assert.deepEqual(moved.selected, [], "indistinguishable moved occurrences must be omitted");
  assert.equal(moved.unresolved.length, 2);
});
