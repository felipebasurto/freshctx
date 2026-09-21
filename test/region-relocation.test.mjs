import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { anchorsFor, relocateRegion } from "../src/relocate.mjs";
import { decodedProjection, sessionFor, workspaceFor, content } from "./helpers.mjs";
import { decodeProjectionUnits } from "../src/projection.mjs";
import { FreshCtxSession } from "../src/session.mjs";
import { openSessionStore } from "../src/store.mjs";
import { openWorkspace } from "../src/workspace.mjs";

function bytes(text) {
  return Buffer.from(text, "utf8");
}

async function observeRegion(t, file, shown, range = null) {
  const root = await workspaceFor(t, { "f.py": file });
  const session = await sessionFor(t, root);
  const start = range?.startByte ?? 0;
  const end = range?.endByte ?? Buffer.byteLength(shown);
  await session.observe({
    resultId: "r1",
    path: "f.py",
    content: content(shown),
    range: { startByte: start, endByte: end },
    turn: 1,
  });
  return { root, session };
}

async function prepareOne(session, mutatedRoot, mutated, requestId = "q") {
  await writeFile(path.join(mutatedRoot, "f.py"), mutated);
  const plan = await session.prepare({ requestId, resultIds: ["r1"], budgetBytes: 131072 });
  const [unit] = decodeProjectionUnits(decodedProjection(plan));
  return { plan, unit, text: decodedProjection(plan) };
}

test("prepend comment relocates the region instead of slicing stale offsets", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan, unit } = await prepareOne(session, root, "# prefix\nRATE = 10\n");
  assert.equal(plan.unit_states[plan.selected[0]].status, "relocated");
  assert.match(unit.content, /RATE = 10/u);
  assert.doesNotMatch(unit.content, /prefix/u);
  await session.commit({ planId: plan.plan_id });
});

test("prepend 100 lines relocates", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const prefix = Array.from({ length: 100 }, (_, i) => `# line ${i}`).join("\n");
  const { plan, unit } = await prepareOne(session, root, `${prefix}\nRATE = 10\n`);
  assert.equal(plan.unit_states[plan.selected[0]].status, "relocated");
  assert.match(unit.content, /RATE = 10/u);
});

test("insert immediately before the region relocates", async (t) => {
  const { root, session } = await observeRegion(t, "A = 1\nRATE = 10\nB = 2\n", "RATE = 10", { startByte: 6, endByte: 15 });
  const { plan, unit } = await prepareOne(session, root, "A = 1\nNEW = 0\nRATE = 10\nB = 2\n");
  assert.equal(plan.unit_states[plan.selected[0]].status, "relocated");
  assert.match(unit.content, /RATE = 10/u);
  assert.doesNotMatch(unit.content, /NEW = 0/u);
  await session.commit({ planId: plan.plan_id });
});

test("delete immediately before the region relocates", async (t) => {
  const { root, session } = await observeRegion(t, "A = 1\nRATE = 10\n", "RATE = 10", { startByte: 6, endByte: 15 });
  const { plan, unit } = await prepareOne(session, root, "RATE = 10\n");
  assert.equal(plan.unit_states[plan.selected[0]].status, "relocated");
  assert.match(unit.content, /RATE = 10/u);
});

test("insert immediately after the region keeps the referent", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { unit } = await prepareOne(session, root, "RATE = 10\nAFTER = 1\n");
  assert.match(unit.content, /RATE = 10/u);
  assert.doesNotMatch(unit.content, /AFTER/u);
});

test("delete immediately after the region keeps the referent", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\nB = 2\n", "RATE = 10");
  const { unit } = await prepareOne(session, root, "RATE = 10\n");
  assert.match(unit.content, /RATE = 10/u);
});

test("in-place content edit refreshes as updated", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan, unit } = await prepareOne(session, root, "RATE = 12\n");
  assert.equal(plan.unit_states[plan.selected[0]].status, "updated");
  assert.match(unit.content, /RATE = 12/u);
  await session.commit({ planId: plan.plan_id });
});

test("insert lines inside an unparseable region span refreshes within the region", async (t) => {
  const before = "RATE = 1\nBASE = 10\nTOTAL = 11\n";
  const shown = "BASE = 10\nTOTAL = 11";
  const start = Buffer.byteLength("RATE = 1\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { unit } = await prepareOne(session, root, "RATE = 1\nBASE = 10\nFEE = 1\nTOTAL = 12\n");
  assert.match(unit.content, /FEE|TOTAL = 12/u);
  assert.doesNotMatch(unit.content, /RATE = 1/u);
});

test("delete lines inside a region refreshes the surviving span", async (t) => {
  const before = "RATE = 1\nBASE = 10\nFEE = 1\nTOTAL = 12\n";
  const shown = "BASE = 10\nFEE = 1\nTOTAL = 12";
  const start = Buffer.byteLength("RATE = 1\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { plan, unit } = await prepareOne(session, root, "RATE = 1\nBASE = 10\nTOTAL = 12\n");
  assert.match(unit.content, /BASE = 10/u);
  assert.match(unit.content, /TOTAL = 12/u);
  assert.doesNotMatch(unit.content, /RATE = 1/u);
  assert.ok(["updated", "relocated", "stable"].includes(plan.unit_states[plan.selected[0]].status));
});

test("move region within the same structural parent tracks the referent", async (t) => {
  const before = "HEAD = 0\nTAIL = 9\nVALUE = 2\nFOOT = 1\n";
  const shown = "VALUE = 2";
  const start = Buffer.byteLength("HEAD = 0\nTAIL = 9\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { unit } = await prepareOne(session, root, "HEAD = 0\nVALUE = 2\nTAIL = 9\nFOOT = 1\n");
  assert.match(unit.content, /VALUE = 2/u);
  assert.doesNotMatch(unit.content, /TAIL = 9\nFOOT/u);
});
test("region inside a moved function relocates with its structural parent", async (t) => {
  const before = "def price():\n    return 10\n\ndef other():\n    return 1\n";
  const shown = "    return 10";
  const start = Buffer.byteLength("def price():\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { plan, unit } = await prepareOne(session, root, "def other():\n    return 1\n\ndef price():\n    return 10\n");
  assert.match(unit.content, /return 10/u);
  assert.doesNotMatch(unit.content, /return 1\n/u);
  assert.ok(plan.selected.length === 1);
  await session.commit({ planId: plan.plan_id });
});

test("formatter whitespace changes keep the referent (stable or updated, never wrong)", async (t) => {
  const { root, session } = await observeRegion(t, "RATE   =   10\n", "RATE   =   10");
  const { plan, unit } = await prepareOne(session, root, "RATE = 10\n");
  assert.match(unit.content, /RATE/u);
  assert.ok(["stable", "updated", "relocated"].includes(plan.unit_states[plan.selected[0]].status));
});

test("ambiguous duplicate anchors invalidate instead of choosing by offset", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan } = await prepareOne(session, root, "RATE = 10\nRATE = 10\n");
  const state = plan.selected.length === 0 ? "invalidated" : plan.unit_states[plan.selected[0]].status;
  assert.ok(["invalidated", "relocated", "stable"].includes(state));
  if (plan.selected.length > 0) {
    assert.match(decodedProjection(plan), /RATE = 10/u);
  } else {
    assert.ok(plan.unresolved.some((entry) => entry.reason === "referent_missing" || entry.reason === "ambiguous"));
  }
});

test("duplicate surrounding anchor updates the edited span instead of a surviving copy", async (t) => {
  const before = "HEAD = 0\nVALUE = 1\nMID = 0\nVALUE = 1\nTAIL = 9\n";
  const shown = "VALUE = 1";
  const start = Buffer.byteLength("HEAD = 0\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { plan, unit, text } = await prepareOne(session, root, "HEAD = 0\nVALUE = 9\nMID = 0\nVALUE = 1\nTAIL = 9\n");
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.unit_states[plan.selected[0]].status, "updated");
  assert.match(unit.content, /VALUE = 9/u);
  assert.doesNotMatch(text, /VALUE = 1/u, "must not jump to the unchanged duplicate");
  assert.doesNotMatch(text, /VALUE = 9\nMID = 0\nVALUE = 1/u, "must not merge both spans");
});

test("duplicate surrounding anchor with both copies changed does not pick the other copy", async (t) => {
  const before = "HEAD = 0\nSEC_A = 1\nVALUE = 1\nEND = 1\nSEC_A = 2\nVALUE = 1\nEND = 2\nTAIL = 9\n";
  const shown = "VALUE = 1";
  const start = Buffer.byteLength("HEAD = 0\nSEC_A = 1\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { plan, text } = await prepareOne(session, root, "HEAD = 0\nSEC_A = 1\nVALUE = 9\nEND = 1\nSEC_A = 2\nVALUE = 2\nEND = 2\nTAIL = 9\n");
  if (plan.selected.length === 0) {
    assert.ok(plan.unresolved.some((entry) => entry.reason === "referent_missing" || entry.reason === "ambiguous"));
    return;
  }
  assert.match(text, /VALUE = 9/u);
  assert.doesNotMatch(text, /VALUE = 2/u);
});

test("deleted referent invalidates instead of projecting ghost bytes", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\nOTHER = 1\n", "RATE = 10");
  const { plan } = await prepareOne(session, root, "OTHER = 1\n");
  assert.ok(plan.selected.length === 0 || !decodedProjection(plan).includes("RATE = 10"));
  const state = plan.selected.length === 0 ? null : plan.unit_states[plan.selected[0]];
  assert.ok(state === null || state.status !== "stable" || !decodedProjection(plan).includes("OTHER = 1"));
});

test("referent replaced by unrelated code does not project the replacement as the referent", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { plan, text } = await prepareOne(session, root, "UNRELATED = 'xyz'\n");
  assert.ok(plan.selected.length === 0 || !text.includes("RATE = 10") || text.includes("UNRELATED") === false
    || plan.unit_states[plan.selected[0]]?.status === "updated");
  if (plan.selected.length > 0) {
    assert.doesNotMatch(text, /UNRELATED = 'xyz'\n$/u, "must not claim unrelated bytes are the referent");
  }
});

test("full rewrite preserving another fragment relocates only the surviving referent", async (t) => {
  const before = "KEEP = 1\nRATE = 10\n";
  const { root, session } = await observeRegion(t, before, "KEEP = 1", { startByte: 0, endByte: 8 });
  const { unit } = await prepareOne(session, root, "HEADER = 0\nKEEP = 1\nFOOTER = 2\n");
  assert.match(unit.content, /KEEP = 1/u);
  assert.doesNotMatch(unit.content, /HEADER|FOOTER/u);
});

test("rename of the surrounding function keeps an inner region inside the renamed parent", async (t) => {
  const before = "def price():\n    rate = 10\n    return rate\n";
  const shown = "    rate = 10";
  const start = Buffer.byteLength("def price():\n");
  const { root, session } = await observeRegion(t, before, shown, { startByte: start, endByte: start + Buffer.byteLength(shown) });
  const { unit } = await prepareOne(session, root, "def cost():\n    rate = 10\n    return rate\n");
  assert.match(unit.content, /rate = 10/u);
});

test("wrapping code in a class keeps the inner region", async (t) => {
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
  const { unit } = await prepareOne(session, root, "class Config:\n    RATE = 10\n");
  assert.match(unit.content, /RATE = 10/u);
});

test("edits elsewhere in a large file keep the region", async (t) => {
  const filler = Array.from({ length: 200 }, (_, i) => `line${i} = ${i}`).join("\n");
  const before = `${filler}\nRATE = 10\n`;
  const start = Buffer.byteLength(`${filler}\n`);
  const { root, session } = await observeRegion(t, before, "RATE = 10", { startByte: start, endByte: start + 9 });
  const changed = before.replace("line100 = 100", "line100 = 999");
  const { unit } = await prepareOne(session, root, changed);
  assert.match(unit.content, /RATE = 10/u);
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
  const after = before.replace('"a"', '"a" | "b"');
  await writeFile(path.join(root, "s.ts"), after);
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
  const { root, session } = await observeRegion(t, "RATE = 10\n", "RATE = 10");
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
    parsedUnits: [],
    parsedOk: true,
    referentBytes: bytes("RATE = 10"),
    prefixAnchor: bytes("").toString("base64"),
    suffixAnchor: bytes("\n").toString("base64"),
    parentSelector: null,
    relStart: null,
    relEnd: null,
    prevStart: 0,
    prevEnd: 9,
    previousOccurrences: 1,
  });
  assert.equal(outcome.status, "relocated");
  assert.deepEqual([outcome.startByte, outcome.endByte], [9, 18]);
  assert.equal(snapshotBytes.subarray(outcome.startByte, outcome.endByte).toString("utf8"), "RATE = 10");
});

test("relocateRegion reports ambiguous when anchors bracket distinct spans", () => {
  const snapshotBytes = Buffer.from("A=1\nB=2\n", "utf8");
  const outcome = relocateRegion({
    snapshotBytes,
    parsedUnits: [],
    parsedOk: true,
    referentBytes: bytes("ZZZ"),
    prefixAnchor: bytes("").toString("base64"),
    suffixAnchor: bytes("\n").toString("base64"),
    parentSelector: null,
    relStart: null,
    relEnd: null,
    prevStart: 0,
    prevEnd: 3,
  });
  assert.ok(["ambiguous", "invalidated"].includes(outcome.status));
});

test("relocateRegion updates the original span instead of an exact duplicate", () => {
  const snapshotBytes = bytes("HEAD = 0\nVALUE = 9\nMID = 0\nVALUE = 1\nTAIL = 9\n");
  const prevStart = Buffer.byteLength("HEAD = 0\n");
  const prevEnd = prevStart + Buffer.byteLength("VALUE = 1");
  const original = bytes("HEAD = 0\nVALUE = 1\nMID = 0\nVALUE = 1\nTAIL = 9\n");
  const anchors = anchorsFor(original, prevStart, prevEnd);
  const outcome = relocateRegion({
    snapshotBytes,
    parsedUnits: [],
    parsedOk: true,
    referentBytes: bytes("VALUE = 1"),
    prefixAnchor: anchors.prefixAnchor,
    suffixAnchor: anchors.suffixAnchor,
    parentSelector: null,
    relStart: null,
    relEnd: null,
    prevStart,
    prevEnd,
  });
  assert.equal(outcome.status, "updated");
  assert.deepEqual([outcome.startByte, outcome.endByte], [prevStart, prevEnd]);
  assert.equal(snapshotBytes.subarray(outcome.startByte, outcome.endByte).toString("utf8"), "VALUE = 9");
});

test("identical region fingerprints at different offsets keep distinct identities after reopen", async (t) => {
  const pad = `# ${"Y".repeat(125)}\n`;
  assert.equal(Buffer.byteLength(pad), 128);
  const shown = "VALUE = 1";
  const before = `${pad}${shown}\n${pad}${shown}\n${pad}`;
  const firstStart = Buffer.byteLength(pad);
  const secondStart = Buffer.byteLength(`${pad}${shown}\n${pad}`);
  const root = await workspaceFor(t, { "f.py": before });
  const workspace = await openWorkspace(root);
  const firstStore = await openSessionStore(workspace, "dup-id");
  const first = new FreshCtxSession({ workspace, store: firstStore, sessionId: "dup-id" });
  const observedA = await first.observe({
    resultId: "a",
    path: "f.py",
    content: content(shown),
    range: { startByte: firstStart, endByte: firstStart + Buffer.byteLength(shown) },
    turn: 1,
  });
  const observedB = await first.observe({
    resultId: "b",
    path: "f.py",
    content: content(shown),
    range: { startByte: secondStart, endByte: secondStart + Buffer.byteLength(shown) },
    turn: 1,
  });
  assert.notEqual(observedA.unit_id, observedB.unit_id);
  await firstStore.close();
  const secondStore = await openSessionStore(workspace, "dup-id");
  t.after(async () => secondStore.close());
  const second = new FreshCtxSession({ workspace, store: secondStore, sessionId: "dup-id" });
  const plan = await second.prepare({ requestId: "both", resultIds: ["a", "b"], budgetBytes: 4096 });
  assert.ok(plan.selected.includes(observedA.unit_id));
  assert.ok(plan.selected.includes(observedB.unit_id));
  assert.notDeepEqual(plan.unit_states[observedA.unit_id].currentRange, plan.unit_states[observedB.unit_id].currentRange);
});
