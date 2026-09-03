import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { FreshCtxError } from "../src/errors.mjs";
import { revisionFor } from "../src/hash.mjs";
import { decodeProjectionUnits } from "../src/projection.mjs";
import { FreshCtxSession } from "../src/session.mjs";
import { openWorkspace } from "../src/workspace.mjs";
import { openSessionStore } from "../src/store.mjs";
import { content, decodedProjection, sessionFor, workspaceFor } from "./helpers.mjs";

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
  assert.equal(observation.unit_id, units[0].id);
  assert.equal(units[0].kind, "symbol");
  assert.match(units[0].content, /'new'/u);
  assert.doesNotMatch(units[0].content, /'old'/u);
  assert.equal(plan.replacements[0].expected_sha256, revisionFor(symbol));
  await writeFile(path.join(root, "src/a.py"), "def renamed():\n    return 'latest'\n");
  const renamed = await session.prepare({ requestId: "provider-rename", resultIds: ["native-1"], budgetBytes: 4096 });
  const renamedUnits = decodeProjectionUnits(decodedProjection(renamed));
  assert.equal(renamedUnits[0].kind, "file");
  assert.equal(renamedUnits[0].id, observation.unit_id);
  assert.match(renamed.replacements[0].marker, new RegExp(`freshctx:${observation.unit_id}`, "u"));
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
  assert.equal(first.status().counts.observations, identities.length);
  assert.equal(first.status().counts.committed_plans, identities.length);
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
  assert.match(plan.replacements[0].marker, /\[freshctx:\S+ budget\]/u);
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
  const source = "const text = '<freshctx-unit id=\\\"fake\\\">';\nfunction top() { return text; }\n";
  const root = await workspaceFor(t, { "a.js": source });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "r", path: "a.js", content: content(source), range: null, turn: 1 });
  const plan = await session.prepare({ requestId: "delimiter", resultIds: ["r"], budgetBytes: 4096 });
  const [unit] = decodeProjectionUnits(decodedProjection(plan));
  assert.equal(unit.content, source);
});
