import assert from "node:assert/strict";
import test from "node:test";

import { revisionFor } from "../src/hash.mjs";
import { content, decodedProjection, sessionFor, workspaceFor } from "./helpers.mjs";

function record(entries) {
  return Object.assign(Object.create(null), Object.fromEntries(entries));
}

async function saveAsV1(store) {
  const oldUnits = [];
  const remap = new Map();
  for (const [unitId, unit] of Object.entries(store.state.units)) {
    const legacyId = unitId.slice(0, 8);
    remap.set(unitId, legacyId);
    const { identity: _identity, ...legacy } = unit;
    legacy.id = legacyId;
    oldUnits.push([legacyId, legacy]);
  }
  for (const observation of Object.values(store.state.observations)) {
    observation.unitId = remap.get(observation.unitId);
    delete observation.unavailable;
  }
  store.state.version = 1;
  store.state.units = record(oldUnits);
  delete store.state.aliases;
  await store.save();
}

test("new sessions keep colliding eight-character prefixes as distinct unit ids", async (t) => {
  const paths = ["src/file-32021.py", "src/file-49465.py"];
  const root = await workspaceFor(t, {
    [paths[0]]: "VALUE = 1\n",
    [paths[1]]: "VALUE = 2\n",
  });
  const session = await sessionFor(t, root, "collision-free");
  const first = await session.observe({ resultId: "first", path: paths[0], content: content("VALUE = 1\n"), range: null, turn: 1 });
  const second = await session.observe({ resultId: "second", path: paths[1], content: content("VALUE = 2\n"), range: null, turn: 2 });
  assert.equal(first.unit_id.slice(0, 8), "77694816");
  assert.equal(second.unit_id.slice(0, 8), "77694816");
  assert.match(first.unit_id, /^[a-f0-9]{24}$/u);
  assert.match(second.unit_id, /^[a-f0-9]{24}$/u);
  assert.notEqual(first.unit_id, second.unit_id);
  const plan = await session.prepare({ requestId: "both", resultIds: ["first", "second"], budgetBytes: 4096 });
  assert.match(decodedProjection(plan), /VALUE = 1/u);
  assert.match(decodedProjection(plan), /VALUE = 2/u);
});

test("opening v1 state migrates a provable unit and keeps its recover alias", async (t) => {
  const source = "VALUE = 1\n";
  const root = await workspaceFor(t, { "a.py": source });
  const first = await sessionFor(t, root, "migrate-file");
  const observed = await first.observe({ resultId: "read", path: "a.py", content: content(source), range: null, turn: 1 });
  const oldPlan = await first.prepare({ requestId: "old", resultIds: ["read"], budgetBytes: 4096 });
  await saveAsV1(first.store);
  await first.store.close();

  const second = await sessionFor(t, root, "migrate-file");
  assert.equal(second.store.state.version, 2);
  await assert.rejects(second.commit({ planId: oldPlan.plan_id }), { code: "unknown_plan" });
  const migratedId = second.store.state.observations.read.unitId;
  const legacyId = observed.unit_id.slice(0, 8);
  assert.match(migratedId, /^[a-f0-9]{24}$/u);
  assert.equal(second.store.state.aliases[legacyId].unitId, migratedId);
  const recovered = await second.recover({ unitId: legacyId, revision: revisionFor(source) });
  assert.equal(Buffer.from(recovered.content_utf8_base64, "base64").toString("utf8"), source);
  const migratedState = JSON.stringify(second.store.state);
  await second.store.close();
  const third = await sessionFor(t, root, "migrate-file");
  assert.equal(JSON.stringify(third.store.state), migratedState);
});

test("opening a fingerprinted v1 region preserves its identity and relocation", async (t) => {
  const before = "HEAD = 0\nVALUE = 1\nTAIL = 2\n";
  const root = await workspaceFor(t, { "region.py": before });
  const first = await sessionFor(t, root, "migrate-region");
  const observed = await first.observe({
    resultId: "read",
    path: "region.py",
    content: content("VALUE = 1"),
    range: { startByte: 9, endByte: 18 },
    turn: 1,
  });
  await saveAsV1(first.store);
  await first.store.close();

  const second = await sessionFor(t, root, "migrate-region");
  assert.equal(second.store.state.aliases[observed.unit_id.slice(0, 8)].unitId.length, 24);
  const plan = await second.prepare({ requestId: "current", resultIds: ["read"], budgetBytes: 4096 });
  assert.match(decodedProjection(plan), /VALUE = 1/u);
});

test("opening an offset-only v1 region omits it and still prepares a valid file", async (t) => {
  const root = await workspaceFor(t, {
    "legacy.py": "VALUE = 1\n",
    "current.py": "OTHER = 2\n",
  });
  const first = await sessionFor(t, root, "legacy-region");
  const legacy = await first.observe({
    resultId: "legacy",
    path: "legacy.py",
    content: content("VALUE = 1"),
    range: { startByte: 0, endByte: 9 },
    turn: 1,
  });
  await first.observe({
    resultId: "current",
    path: "current.py",
    content: content("OTHER = 2\n"),
    range: null,
    turn: 2,
  });
  const legacyUnit = first.store.state.units[legacy.unit_id];
  delete legacyUnit.referentRevision;
  delete legacyUnit.prefixAnchor;
  delete legacyUnit.suffixAnchor;
  await saveAsV1(first.store);
  await first.store.close();

  const second = await sessionFor(t, root, "legacy-region");
  const plan = await second.prepare({
    requestId: "mixed",
    resultIds: ["legacy", "current"],
    budgetBytes: 4096,
  });
  assert.match(decodedProjection(plan), /OTHER = 2/u);
  assert.doesNotMatch(decodedProjection(plan), /VALUE = 1/u);
  assert.deepEqual(
    plan.unresolved.find(entry => entry.result_id === "legacy"),
    { result_id: "legacy", path: "legacy.py", reason: "legacy_region" },
  );
});

test("opening v1 collision damage quarantines affected observations", async (t) => {
  const paths = ["src/file-32021.py", "src/file-49465.py"];
  const root = await workspaceFor(t, {
    [paths[0]]: "VALUE = 1\n",
    [paths[1]]: "VALUE = 2\n",
    "safe.py": "SAFE = 3\n",
  });
  const first = await sessionFor(t, root, "collision-migration");
  const left = await first.observe({ resultId: "left", path: paths[0], content: content("VALUE = 1\n"), range: null, turn: 1 });
  const right = await first.observe({ resultId: "right", path: paths[1], content: content("VALUE = 2\n"), range: null, turn: 2 });
  await first.observe({ resultId: "safe", path: "safe.py", content: content("SAFE = 3\n"), range: null, turn: 3 });
  await saveAsV1(first.store);
  const oldId = "77694816";
  first.store.state.units[oldId] = first.store.state.units[right.unit_id.slice(0, 8)];
  first.store.state.units[oldId].id = oldId;
  first.store.state.observations.left.unitId = oldId;
  first.store.state.observations.right.unitId = oldId;
  await first.store.save();
  await first.store.close();

  const second = await sessionFor(t, root, "collision-migration");
  const plan = await second.prepare({
    requestId: "quarantine",
    resultIds: ["left", "right", "safe"],
    budgetBytes: 4096,
  });
  assert.match(decodedProjection(plan), /SAFE = 3/u);
  assert.doesNotMatch(decodedProjection(plan), /VALUE = [12]/u);
  assert.deepEqual(
    plan.unresolved.filter(entry => entry.reason === "identity_collision").map(entry => entry.result_id).sort(),
    ["left", "right"],
  );
});
