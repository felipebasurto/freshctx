import assert from "node:assert/strict";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { FreshCtxError } from "../src/errors.mjs";
import { digestFromRevision, revisionFor, stableId } from "../src/hash.mjs";
import { decodeProjectionUnits } from "../src/projection.mjs";
import { FreshCtxSession, MAX_PENDING_PLANS, PENDING_PLAN_TTL_MS } from "../src/session.mjs";
import { openWorkspace } from "../src/workspace.mjs";
import { openSessionStore } from "../src/store.mjs";
import { content, decodedProjection, sessionFor, workspaceFor } from "./helpers.mjs";

function sessionFile(root, sessionId = "session") {
  const key = stableId("session", { sessionId }).slice("session_".length);
  return path.join(root, ".freshctx", "sessions", `${key}.json`);
}

function blobDirectory(root) {
  return path.join(root, ".freshctx", "blobs", "sha256");
}

async function blobNames(root) {
  return readdir(blobDirectory(root));
}

async function blobExists(root, revision) {
  const names = await blobNames(root);
  return names.includes(digestFromRevision(revision));
}

async function blobStoreBytes(root) {
  const directory = blobDirectory(root);
  let total = 0;
  for (const name of await readdir(directory)) {
    total += (await stat(path.join(directory, name))).size;
  }
  return total;
}

test("a partial read projects the current Tree-sitter symbol, never its historical body", async (t) => {
  const before = "def greet():\n    return 'old'\n\ndef other():\n    return 2\n";
  const after = "def greet():\n    return 'new'\n\ndef other():\n    return 2\n";
  const root = await workspaceFor(t, { "src/a.py": before });
  const session = await sessionFor(t, root);
  const symbol = before.slice(0, before.indexOf("\n\ndef other"));
  const observation = await session.observe({
    resultId: "native-1",
    path: "src/a.py",
    content: content(symbol),
    range: { startByte: 0, endByte: Buffer.byteLength(symbol) },
    turn: 1,
  });
  await writeFile(path.join(root, "src/a.py"), after);
  const plan = await session.prepare({ requestId: "provider-1", resultIds: ["native-1"], budgetBytes: 4096 });
  const units = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(plan.selected[0], observation.unit_id);
  assert.equal(units[0].kind, "symbol");
  assert.match(units[0].content, /'new'/u);
  assert.doesNotMatch(units[0].content, /'old'/u);
  assert.equal(plan.replacements[0].expected_sha256, revisionFor(symbol));
  await writeFile(path.join(root, "src/a.py"), "def renamed():\n    return 'latest'\n");
  const renamed = await session.prepare({ requestId: "provider-rename", resultIds: ["native-1"], budgetBytes: 4096 });
  const renamedUnits = decodeProjectionUnits(decodedProjection(renamed));
  assert.equal(renamedUnits[0].kind, "file");
  assert.equal(renamed.selected[0], observation.unit_id);
  assert.match(renamed.replacements[0].marker, new RegExp(`\\[${observation.unit_id}`, "u"));
  assert.match(renamedUnits[0].content, /renamed/u);
});

test("newer active symbols win over an older active file and overlapping bytes are rendered once", async (t) => {
  const source = "def chosen():\n    return 1\n\ndef other():\n    return 2\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "full", path: "a.py", content: content(source), range: null, turn: 1 });
  const symbol = source.slice(0, source.indexOf("\n\ndef other"));
  await session.observe({
    resultId: "part",
    path: "a.py",
    content: content(symbol),
    range: { startByte: 0, endByte: Buffer.byteLength(symbol) },
    turn: 2,
  });
  const plan = await session.prepare({ requestId: "provider-2", resultIds: ["full", "part"], budgetBytes: 4096 });
  const units = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "symbol");
  assert.equal(plan.omitted[0].reason, "overlap");
});

test("projection bytes are identical when membership and disk stay the same and only recency changes", async (t) => {
  const files = {
    "src/a.py": "def a():\n    return 1\n",
    "src/m.py": "def m():\n    return 2\n",
    "src/z.py": "def z():\n    return 3\n",
  };
  const root = await workspaceFor(t, files);
  const session = await sessionFor(t, root);
  let turn = 0;
  for (const [filePath, body] of Object.entries(files)) {
    turn += 1;
    await session.observe({
      resultId: `first-${filePath}`,
      path: filePath,
      content: content(body),
      range: null,
      turn,
    });
  }
  const firstIds = Object.keys(files).map((filePath) => `first-${filePath}`);
  const first = decodedProjection(
    await session.prepare({ requestId: "stable-1", resultIds: firstIds, budgetBytes: 16_384 }),
  );
  for (const filePath of [...Object.keys(files)].reverse()) {
    turn += 1;
    await session.observe({
      resultId: `second-${filePath}`,
      path: filePath,
      content: content(files[filePath]),
      range: null,
      turn,
    });
  }
  const secondIds = [...Object.keys(files)].reverse().map((filePath) => `second-${filePath}`);
  const second = decodedProjection(
    await session.prepare({ requestId: "stable-2", resultIds: secondIds, budgetBytes: 16_384 }),
  );
  assert.equal(second, first);
  assert.deepEqual(
    decodeProjectionUnits(first).map((unit) => unit.path),
    Object.keys(files).sort((left, right) => left.localeCompare(right)),
  );
});

test("a stale plan is rejected and commit is otherwise idempotent", async (t) => {
  const source = "def top():\n    return 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const plan = await session.prepare({ requestId: "provider-3", resultIds: ["r"], budgetBytes: 4096 });
  assert.deepEqual(await session.prepare({ requestId: "provider-3", resultIds: ["r"], budgetBytes: 4096 }), plan);
  await writeFile(path.join(root, "a.py"), "def top():\n    return 2\n");
  await assert.rejects(() => session.commit({ planId: plan.plan_id }), (error) => error instanceof FreshCtxError && error.code === "stale_plan");
  const retry = await session.prepare({ requestId: "provider-4", resultIds: ["r"], budgetBytes: 4096 });
  assert.equal((await session.commit({ planId: retry.plan_id })).idempotent, false);
  assert.equal((await session.commit({ planId: retry.plan_id })).idempotent, true);
});

test("archive recovery survives a process restart and returns exact UTF-8 bytes", async (t) => {
  const source = "def café():\n    return 'é'\n";
  const root = await workspaceFor(t, { "a.py": source });
  const workspace = await openWorkspace(root);
  const firstStore = await openSessionStore(workspace, "restart");
  const first = new FreshCtxSession({ workspace, store: firstStore, sessionId: "restart" });
  const observed = await first.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const revision = revisionFor(source);
  await firstStore.close();
  const secondStore = await openSessionStore(workspace, "restart");
  t.after(async () => secondStore.close());
  const second = new FreshCtxSession({ workspace, store: secondStore, sessionId: "restart" });
  const recovered = await second.recover({ unitId: observed.unit_id, revision });
  assert.deepEqual(Buffer.from(recovered.content_utf8_base64, "base64"), Buffer.from(source));
});

test("a partial fragment is never recoverable as if it were the whole symbol", async (t) => {
  const source = "def top():\n    return 'current'\n";
  const fragment = "return 'current'";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  const startByte = Buffer.byteLength(source.slice(0, source.indexOf(fragment)), "utf8");
  const observed = await session.observe({
    resultId: "fragment",
    path: "a.py",
    content: content(fragment),
    range: { startByte, endByte: startByte + Buffer.byteLength(fragment) },
    turn: 1,
  });
  await assert.rejects(
    () => session.recover({ unitId: observed.unit_id, revision: revisionFor(fragment) }),
    (error) => error instanceof FreshCtxError && error.code === "unknown_revision",
  );
  const plan = await session.prepare({ requestId: "fragment-plan", resultIds: ["fragment"], budgetBytes: 4096 });
  const [projected] = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(projected.kind, "symbol");
  assert.match(projected.content, /def top/u);
  assert.notEqual(projected.content, fragment);
  const recovered = await session.recover({ unitId: observed.unit_id, revision: revisionFor(projected.content) });
  assert.equal(Buffer.from(recovered.content_utf8_base64, "base64").toString("utf8"), projected.content);
});

test("reserved JavaScript property names remain stable host result and request identities", async (t) => {
  const source = "def top():\n    return 1\n";
  const identities = ["toString", "constructor", "__proto__"];
  const root = await workspaceFor(t, { "a.py": source });
  const workspace = await openWorkspace(root);
  const firstStore = await openSessionStore(workspace, "reserved-identities");
  const first = new FreshCtxSession({ workspace, store: firstStore, sessionId: "reserved-identities" });
  const plans = new Map();

  for (const identity of identities) {
    const observed = await first.observe({ resultId: identity, path: "a.py", content: content(source), range: null, turn: 1 });
    assert.equal(observed.idempotent, false, identity);
    assert.equal((await first.observe({ resultId: identity, path: "a.py", content: content(source), range: null, turn: 1 })).idempotent, true, identity);
    const plan = await first.prepare({ requestId: identity, resultIds: [identity], budgetBytes: 4096 });
    assert.equal(plan.replacements[0].result_id, identity);
    assert.deepEqual(await first.prepare({ requestId: identity, resultIds: [identity], budgetBytes: 4096 }), plan);
    assert.equal((await first.commit({ planId: plan.plan_id })).idempotent, false);
    assert.equal((await first.commit({ planId: plan.plan_id })).idempotent, true);
    plans.set(identity, plan);
  }
  assert.equal((await first.status()).counts.observations, identities.length);
  assert.equal((await first.status()).counts.committed_plans, identities.length);
  await firstStore.close();

  const secondStore = await openSessionStore(workspace, "reserved-identities");
  t.after(async () => secondStore.close());
  const second = new FreshCtxSession({ workspace, store: secondStore, sessionId: "reserved-identities" });
  for (const record of [secondStore.state.observations, secondStore.state.units, secondStore.state.pendingPlans, secondStore.state.committedPlans]) {
    assert.equal(Object.getPrototypeOf(record), null);
  }
  assert.equal(Object.hasOwn(secondStore.state.observations, "__proto__"), true);
  assert.equal((await second.observe({ resultId: "__proto__", path: "a.py", content: content(source), range: null, turn: 1 })).idempotent, true);
  for (const identity of identities) {
    assert.deepEqual(await second.prepare({ requestId: identity, resultIds: [identity], budgetBytes: 4096 }), plans.get(identity));
  }
});

test("deleted, binary, and parser-broken sources cannot revive stale code", async (t) => {
  const source = "def top():\n    return 'old'\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  await rm(path.join(root, "a.py"));
  const deleted = await session.prepare({ requestId: "deleted", resultIds: ["r"], budgetBytes: 4096 });
  assert.equal(deleted.selected.length, 0);
  assert.equal(deleted.unresolved[0].reason, "deleted");
  await writeFile(path.join(root, "a.py"), "def broken(\n");
  const broken = await session.prepare({ requestId: "broken", resultIds: ["r"], budgetBytes: 4096 });
  const brokenUnits = decodeProjectionUnits(decodedProjection(broken));
  assert.equal(brokenUnits[0].kind, "file");
  assert.match(brokenUnits[0].content, /def broken/u);
  await writeFile(path.join(root, "a.py"), Buffer.from([0, 1, 2]));
  const binary = await session.prepare({ requestId: "binary", resultIds: ["r"], budgetBytes: 4096 });
  assert.equal(binary.selected.length, 0);
  assert.equal(binary.unresolved[0].reason, "binary_file");
});

test("unsupported languages fall back to the current complete file", async (t) => {
  const before = "plain old text\n";
  const after = "plain current text\n";
  const root = await workspaceFor(t, { "note.txt": before });
  const session = await sessionFor(t, root);
  await session.observe({
    resultId: "txt",
    path: "note.txt",
    content: content("old"),
    range: { startByte: Buffer.byteLength("plain "), endByte: Buffer.byteLength("plain old") },
    turn: 1,
  });
  await writeFile(path.join(root, "note.txt"), after);
  const plan = await session.prepare({ requestId: "txt-current", resultIds: ["txt"], budgetBytes: 4096 });
  const [unit] = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(unit.kind, "file");
  assert.equal(unit.content, after);
});

test("re-observing a result_id with different bytes is an idempotency conflict", async (t) => {
  const source = "def top():\n    return 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  await assert.rejects(
    () => session.observe({ resultId: "r", path: "a.py", content: content("def top():\n    return 2\n"), range: null, turn: 2 }),
    (error) => error instanceof FreshCtxError && error.code === "idempotency_conflict",
  );
});

test("a zero byte budget produces no projection bytes", async (t) => {
  const source = "def top():\n    return 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const plan = await session.prepare({ requestId: "tiny", resultIds: ["r"], budgetBytes: 0 });
  assert.equal(Buffer.from(plan.projection_utf8_base64, "base64").length, 0);
  assert.equal(plan.selected.length, 0);
  assert.match(plan.replacements[0].marker, /\[\S+ budget\]/u);
});

test("selection is idempotent for a reordered set of active host results and exact at its byte budget", async (t) => {
  const alpha = "def alpha():\n    return 1\n";
  const beta = "def beta():\n    return 2\n";
  const root = await workspaceFor(t, { "a.py": alpha, "b.py": beta });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "a", path: "a.py", content: content(alpha), range: null, turn: 1 });
  await session.observe({ resultId: "b", path: "b.py", content: content(beta), range: null, turn: 2 });
  const wide = await session.prepare({ requestId: "wide", resultIds: ["a", "b"], budgetBytes: 4096 });
  const exactBudget = Buffer.from(wide.projection_utf8_base64, "base64").length;
  const exact = await session.prepare({ requestId: "exact", resultIds: ["a", "b"], budgetBytes: exactBudget });
  assert.equal(Buffer.from(exact.projection_utf8_base64, "base64").length, exactBudget);
  assert.deepEqual(
    await session.prepare({ requestId: "exact", resultIds: ["b", "a"], budgetBytes: exactBudget }),
    exact,
  );
  const tooSmall = await session.prepare({ requestId: "too-small", resultIds: ["a", "b"], budgetBytes: exactBudget - 1 });
  assert.ok(Buffer.from(tooSmall.projection_utf8_base64, "base64").length <= exactBudget - 1);
});

test("current symbols resolve from every vendored Tree-sitter grammar", async (t) => {
  const cases = [
    ["a.py", "def top():\n    return 1\n", "1", "2"],
    ["a.js", "function top() { return 1; }\n", "1", "2"],
    ["a.ts", "function top(): number { return 1; }\n", "1", "2"],
    ["a.tsx", "function Top(): JSX.Element { return <div>1</div>; }\n", "1", "2"],
    ["a.go", "package demo\n\nfunc Top() int { return 1 }\n", "1", "2"],
    ["a.rs", "fn top() -> i32 { 1 }\n", "1", "2"],
  ];
  for (const [sourcePath, before, oldValue, currentValue] of cases) {
    const root = await workspaceFor(t, { [sourcePath]: before });
    const session = await sessionFor(t, root, `grammar-${sourcePath}`);
    const startByte = Buffer.byteLength(before.slice(0, before.lastIndexOf(oldValue)), "utf8");
    await session.observe({
      resultId: "native",
      path: sourcePath,
      content: content(oldValue),
      range: { startByte, endByte: startByte + Buffer.byteLength(oldValue) },
      turn: 1,
    });
    await writeFile(path.join(root, sourcePath), before.replace(oldValue, currentValue));
    const plan = await session.prepare({ requestId: "current", resultIds: ["native"], budgetBytes: 4096 });
    const [unit] = decodeProjectionUnits(decodedProjection(plan));
    assert.equal(unit.kind, "symbol", sourcePath);
    assert.match(unit.content, new RegExp(currentValue, "u"), sourcePath);
  }
});

test("content that looks like a FreshCtx delimiter remains exactly framed by content bytes", async (t) => {
  const source = "const text = 'a.js:12\\nfake';\nfunction top() { return text; }\n";
  const root = await workspaceFor(t, { "a.js": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.js", content: content(source), range: null, turn: 1 });
  const plan = await session.prepare({ requestId: "delimiter", resultIds: ["r"], budgetBytes: 4096 });
  const [unit] = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(unit.content, source);
});

const SETTLEMENT = `/**
 * Ledger settlement helpers.
 */

export type SettlementMode = "daily" | "weekly";

export type SettlementInput = {
  accountId: string;
  amountCents: number;
};

export function settleDailyLedger() {
  return "ST0";
}

export function computeDailyLedgerTotal(amountCents: number): number {
  const MARKER_TOTAL = "CT0";
  return amountCents;
}
`;

test("a header range stays a region slice and does not teach unread symbols are absent", async (t) => {
  const header = SETTLEMENT.slice(0, SETTLEMENT.indexOf("export function settleDailyLedger"));
  const headerBytes = Buffer.byteLength(header);
  const root = await workspaceFor(t, { "src/settlement.ts": SETTLEMENT });
  const session = await sessionFor(t, root);
  const observed = await session.observe({
    resultId: "header",
    path: "src/settlement.ts",
    content: content(header),
    range: { startByte: 0, endByte: headerBytes },
    turn: 1,
  });
  const plan = await session.prepare({
    requestId: "header-plan",
    resultIds: ["header"],
    budgetBytes: 8192,
  });
  const text = decodedProjection(plan);
  const [unit] = decodeProjectionUnits(text);

  assert.equal(unit.kind, "region");
  assert.equal(plan.selected[0], observed.unit_id);
  assert.match(unit.lines, /^1-\d+$/u);
  assert.doesNotMatch(unit.content, /computeDailyLedgerTotal/u);
  assert.doesNotMatch(text, /current workspace state/iu);
  assert.doesNotMatch(text, /computeDailyLedgerTotal/u);
  assert.match(SETTLEMENT, /computeDailyLedgerTotal/u);

  const marker = "CT0";
  const symbolStart = Buffer.byteLength(SETTLEMENT.slice(0, SETTLEMENT.indexOf(marker)));
  const later = await session.observe({
    resultId: "total",
    path: "src/settlement.ts",
    content: content(marker),
    range: { startByte: symbolStart, endByte: symbolStart + Buffer.byteLength(marker) },
    turn: 2,
  });
  assert.notEqual(later.unit_id, observed.unit_id);
  const both = await session.prepare({
    requestId: "header-and-total",
    resultIds: ["header", "total"],
    budgetBytes: 8192,
  });
  const units = decodeProjectionUnits(decodedProjection(both));
  const symbol = units.find((item) => item.kind === "symbol");
  assert.ok(both.selected.includes(later.unit_id));
  assert.equal(symbol.kind, "symbol");
  assert.match(symbol.content, /computeDailyLedgerTotal/u);
  assert.match(symbol.content, /MARKER_TOTAL = "CT0"/u);
});

test("prepare after a store reopen refreshes current disk bytes for a new request", async (t) => {
  const before = "function top() { return 1; }\n";
  const after = "function top() { return 2; }\n";
  const root = await workspaceFor(t, { "a.js": before });
  const workspace = await openWorkspace(root);
  const firstStore = await openSessionStore(workspace, "live-restart");
  const first = new FreshCtxSession({ workspace, store: firstStore, sessionId: "live-restart" });
  await first.observe({ resultId: "r", path: "a.js", content: content(before), range: null, turn: 1 });
  await firstStore.close();
  await writeFile(path.join(root, "a.js"), after);
  const secondStore = await openSessionStore(workspace, "live-restart");
  t.after(async () => secondStore.close());
  const second = new FreshCtxSession({ workspace, store: secondStore, sessionId: "live-restart" });
  const plan = await second.prepare({ requestId: "after-restart", resultIds: ["r"], budgetBytes: 4096 });
  const [unit] = decodeProjectionUnits(decodedProjection(plan));
  assert.match(unit.content, /return 2/u);
  assert.doesNotMatch(unit.content, /return 1/u);
});

test("symbol file-fallback does not clobber a sibling file unit or forget the selector", async (t) => {
  const before = "def greet():\n    return 1\n\ndef other():\n    return 2\n";
  const renamed = "def hello():\n    return 1\n\ndef other():\n    return 2\n";
  const restored = "def greet():\n    return 3\n\ndef other():\n    return 2\n";
  const root = await workspaceFor(t, { "a.py": before });
  const session = await sessionFor(t, root);
  const fileObs = await session.observe({
    resultId: "full",
    path: "a.py",
    content: content(before),
    range: null,
    turn: 1,
  });
  const greet = before.slice(0, before.indexOf("\n\ndef other"));
  const symbolObs = await session.observe({
    resultId: "part",
    path: "a.py",
    content: content(greet),
    range: { startByte: 0, endByte: Buffer.byteLength(greet) },
    turn: 2,
  });
  assert.notEqual(fileObs.unit_id, symbolObs.unit_id);
  await writeFile(path.join(root, "a.py"), renamed);
  const fallback = await session.prepare({
    requestId: "renamed",
    resultIds: ["full", "part"],
    budgetBytes: 4096,
  });
  const fallbackUnits = decodeProjectionUnits(decodedProjection(fallback));
  assert.equal(fallbackUnits.length, 1);
  assert.equal(fallbackUnits[0].kind, "file");
  assert.equal(fallbackUnits[0].content, renamed);
  const recovered = await session.recover({ unitId: fileObs.unit_id, revision: revisionFor(before) });
  assert.equal(Buffer.from(recovered.content_utf8_base64, "base64").toString("utf8"), before);
  await writeFile(path.join(root, "a.py"), restored);
  const again = await session.prepare({
    requestId: "restored",
    resultIds: ["part"],
    budgetBytes: 4096,
  });
  const [unit] = decodeProjectionUnits(decodedProjection(again));
  assert.equal(unit.kind, "symbol");
  assert.match(unit.content, /return 3/u);
  assert.doesNotMatch(unit.content, /def other/u);
});

test("repeated identical prepares and commits do not rewrite full projections into session state", async (t) => {
  const source = `${"x".repeat(60 * 1024)}\n`;
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const first = await session.prepare({ requestId: "same", resultIds: ["r"], budgetBytes: source.length + 4096 });
  assert.equal((await session.commit({ planId: first.plan_id })).idempotent, false);
  const afterFirst = Buffer.byteLength(await readFile(sessionFile(root), "utf8"));
  for (let index = 0; index < 20; index += 1) {
    const again = await session.prepare({ requestId: "same", resultIds: ["r"], budgetBytes: source.length + 4096 });
    assert.deepEqual(again, first);
    assert.equal((await session.commit({ planId: first.plan_id })).idempotent, true);
  }
  assert.equal(Buffer.byteLength(await readFile(sessionFile(root), "utf8")), afterFirst);

  for (let index = 0; index < 20; index += 1) {
    const plan = await session.prepare({ requestId: `distinct-${index}`, resultIds: ["r"], budgetBytes: source.length + 4096 });
    assert.equal(plan.projection_sha256, first.projection_sha256);
    assert.equal((await session.commit({ planId: plan.plan_id })).idempotent, false);
  }
  const persisted = await readFile(sessionFile(root), "utf8");
  assert.equal(persisted.includes("projection_utf8_base64"), false);
  assert.ok(Buffer.byteLength(persisted) < afterFirst + 20 * 4096, "compact plan records must not grow like copied projections");
});

test("distinct identical request ids grow session JSON only by compact records", async (t) => {
  const source = `${"x".repeat(60 * 1024)}\n`;
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const first = await session.prepare({ requestId: "growth-0", resultIds: ["r"], budgetBytes: source.length + 4096 });
  assert.equal((await session.commit({ planId: first.plan_id })).idempotent, false);
  const afterFirst = Buffer.byteLength(await readFile(sessionFile(root), "utf8"));
  const blobsAfterFirst = (await blobNames(root)).length;
  const blobBytesAfterFirst = await blobStoreBytes(root);
  const extra = 32;
  for (let index = 1; index <= extra; index += 1) {
    const plan = await session.prepare({ requestId: `growth-${index}`, resultIds: ["r"], budgetBytes: source.length + 4096 });
    assert.equal(plan.projection_sha256, first.projection_sha256);
    assert.equal((await session.commit({ planId: plan.plan_id })).idempotent, false);
  }
  const afterExtra = Buffer.byteLength(await readFile(sessionFile(root), "utf8"));
  const perRecord = (afterExtra - afterFirst) / extra;
  assert.ok(perRecord < 2048, `compact committed records must stay under 2 KiB each, got ${perRecord}`);
  assert.equal((await blobNames(root)).length, blobsAfterFirst);
  assert.equal(await blobStoreBytes(root), blobBytesAfterFirst);
});

test("prepare A then prepare B still allows commit A inside the pending bound", async (t) => {
  const source = "def top():\n    return 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const first = await session.prepare({ requestId: "pending-a", resultIds: ["r"], budgetBytes: 4096 });
  const second = await session.prepare({ requestId: "pending-b", resultIds: ["r"], budgetBytes: 4096 });
  assert.equal((await session.status()).counts.pending_plans, 2);
  assert.equal((await session.commit({ planId: first.plan_id })).idempotent, false);
  assert.equal((await session.commit({ planId: second.plan_id })).idempotent, false);
});

test("pending plans keep the newest MAX_PENDING_PLANS by preparedAt", async (t) => {
  const source = "def top():\n    return 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.py", content: content(source), range: null, turn: 1 });
  const plans = [];
  for (let index = 0; index < MAX_PENDING_PLANS; index += 1) {
    const plan = await session.prepare({ requestId: `bound-${index}`, resultIds: ["r"], budgetBytes: 4096 });
    session.store.state.pendingPlans[`bound-${index}`].preparedAt = 1_000 + index;
    plans.push(plan);
  }
  plans.push(await session.prepare({ requestId: `bound-${MAX_PENDING_PLANS}`, resultIds: ["r"], budgetBytes: 4096 }));
  assert.equal((await session.status()).counts.pending_plans, MAX_PENDING_PLANS);
  await assert.rejects(
    () => session.commit({ planId: plans[0].plan_id }),
    (error) => error instanceof FreshCtxError && error.code === "unknown_plan",
  );
  assert.equal((await session.commit({ planId: plans[1].plan_id })).idempotent, false);
  assert.equal((await session.commit({ planId: plans.at(-1).plan_id })).idempotent, false);
});

test("expired pending cleanup drops unreferenced projection blobs and keeps shared ones", async (t) => {
  const alpha = "def alpha():\n    return 1\n";
  const beta = "def beta():\n    return 2\n";
  const root = await workspaceFor(t, { "a.py": alpha, "b.py": beta });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "a", path: "a.py", content: content(alpha), range: null, turn: 1 });
  await session.observe({ resultId: "b", path: "b.py", content: content(beta), range: null, turn: 2 });
  const unique = await session.prepare({ requestId: "unique-ttl", resultIds: ["a"], budgetBytes: 4096 });
  const sharedFirst = await session.prepare({ requestId: "shared-ttl-a", resultIds: ["b"], budgetBytes: 4096 });
  const sharedSecond = await session.prepare({ requestId: "shared-ttl-b", resultIds: ["b"], budgetBytes: 4096 });
  assert.equal(sharedFirst.projection_sha256, sharedSecond.projection_sha256);
  assert.notEqual(unique.projection_sha256, sharedFirst.projection_sha256);
  assert.equal(await blobExists(root, unique.projection_sha256), true);
  session.store.state.pendingPlans["unique-ttl"].preparedAt = Date.now() - PENDING_PLAN_TTL_MS - 1;
  session.store.state.pendingPlans["shared-ttl-a"].preparedAt = Date.now() - PENDING_PLAN_TTL_MS - 1;
  assert.equal((await session.status()).counts.pending_plans, 1);
  assert.equal(await blobExists(root, unique.projection_sha256), false);
  assert.equal(await blobExists(root, sharedFirst.projection_sha256), true);
  assert.equal(await blobExists(root, revisionFor(alpha)), true);
  await assert.rejects(
    () => session.commit({ planId: unique.plan_id }),
    (error) => error instanceof FreshCtxError && error.code === "unknown_plan",
  );
  const retried = await session.prepare({ requestId: "pending-ttl-retry", resultIds: ["b"], budgetBytes: 4096 });
  assert.equal((await session.commit({ planId: retried.plan_id })).idempotent, false);
});

test("prepare refreshes several symbols from one file without changing commit freshness", async (t) => {
  const source = "def alpha():\n    return 1\n\ndef beta():\n    return 2\n\ndef gamma():\n    return 3";
  const root = await workspaceFor(t, { "a.py": source });
  const session = await sessionFor(t, root);
  const names = ["alpha", "beta", "gamma"];
  for (const name of names) {
    const start = source.indexOf(`def ${name}`);
    const separator = source.indexOf("\n\n", start);
    const body = source.slice(start, separator === -1 ? source.length : separator);
    const startByte = Buffer.byteLength(source.slice(0, start));
    await session.observe({
      resultId: name,
      path: "a.py",
      content: content(body),
      range: { startByte, endByte: startByte + Buffer.byteLength(body) },
      turn: 1,
    });
  }
  const plan = await session.prepare({ requestId: "shared-parse", resultIds: names, budgetBytes: 4096 });
  const units = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((unit) => unit.kind), ["symbol", "symbol", "symbol"]);
  await writeFile(path.join(root, "a.py"), source.replace("return 1", "return 9"));
  await assert.rejects(
    () => session.commit({ planId: plan.plan_id }),
    (error) => error instanceof FreshCtxError && error.code === "stale_plan",
  );
});
