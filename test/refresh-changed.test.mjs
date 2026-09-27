import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { FreshCtxError } from "../src/errors.mjs";
import { content, decodedProjection, projectedUnits, sessionFor, workspaceFor } from "./helpers.mjs";

const A = "def a():\n    return 1\n";
const B = "def b():\n    return 2\n\n\ndef tail():\n    return 3\n";

async function observed(t) {
  const root = await workspaceFor(t, { "a.py": A, "b.py": B });
  const session = await sessionFor(t, root);
  await session.observe({ resultId: "read-a", path: "a.py", content: content(A), range: null, turn: 1 });
  const head = B.slice(0, B.indexOf("\n\n\ndef tail"));
  await session.observe({ resultId: "read-b", path: "b.py", content: content(head), range: { startByte: 0, endByte: Buffer.byteLength(head) }, turn: 2 });
  return { root, session };
}

const prepare = (session, requestId, refresh = "changed") =>
  session.prepare({ requestId, resultIds: ["read-a", "read-b"], budgetBytes: 4096, refresh });

test("refresh changed keeps current reads native and projects only the changed unit", async (t) => {
  const { root, session } = await observed(t);
  // Appending to the last line read leaves the observed bytes intact; the line boundary check catches it.
  await writeFile(path.join(root, "b.py"), B.replace("return 2", "return 20"));
  const plan = await prepare(session, "p1");
  const [keepA, markB] = plan.replacements;
  assert.equal(plan.refresh, "changed");
  assert.equal(keepA.keep, true);
  assert.equal(markB.keep, undefined);
  const units = projectedUnits(plan);
  assert.deepEqual(units.map((unit) => unit.path), ["b.py"]);
  assert.match(units[0].content, /return 20/u);
  assert.deepEqual((await session.commit({ planId: plan.plan_id })).applied, true);
});

test("with nothing changed the plan keeps every read and projects nothing", async (t) => {
  const { session } = await observed(t);
  const plan = await prepare(session, "p1");
  assert.deepEqual(plan.replacements.map((replacement) => replacement.keep), [true, true]);
  assert.equal(decodedProjection(plan), "");
  assert.deepEqual(plan.selected, []);
});

test("an edit outside the read range keeps the read; one that shifts it refreshes it", async (t) => {
  const { root, session } = await observed(t);
  await writeFile(path.join(root, "b.py"), B.replace("return 3", "return 30"));
  assert.equal((await prepare(session, "below")).replacements[1].keep, true);
  await writeFile(path.join(root, "b.py"), `import os\n${B}`);
  const shifted = await prepare(session, "above");
  assert.equal(shifted.replacements[1].keep, undefined);
  assert.match(projectedUnits(shifted)[0].content, /def b\(\):\n    return 2/u);
});

test("commit rejects a plan when a kept read's file changed after prepare", async (t) => {
  const { root, session } = await observed(t);
  const plan = await prepare(session, "p1");
  await writeFile(path.join(root, "a.py"), A.replace("return 1", "return 9"));
  await assert.rejects(session.commit({ planId: plan.plan_id }), (error) => error instanceof FreshCtxError && error.code === "stale_plan");
});

test("refresh is part of the request fingerprint and defaults to all", async (t) => {
  const { session } = await observed(t);
  const all = await session.prepare({ requestId: "p1", resultIds: ["read-a", "read-b"], budgetBytes: 4096 });
  assert.equal(all.refresh, "all");
  assert.ok(all.replacements.every((replacement) => replacement.keep === undefined));
  await assert.rejects(prepare(session, "p1"), (error) => error.code === "idempotency_conflict");
  await assert.rejects(prepare(session, "p2", "some"), (error) => error.code === "invalid_request");
});
