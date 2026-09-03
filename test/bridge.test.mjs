import assert from "node:assert/strict";
import test from "node:test";

import { revisionFor } from "../src/hash.mjs";

function applyPlanAtomically(nativeRequest, plan) {
  const copy = structuredClone(nativeRequest);
  for (const replacement of plan.replacements) {
    const result = copy.results[replacement.result_id];
    if (!result || revisionFor(result.content) !== replacement.expected_sha256) return nativeRequest;
    result.content = replacement.marker;
  }
  if (!copy.insertionAllowed) return nativeRequest;
  copy.projection = Buffer.from(plan.projection_utf8_base64, "base64").toString("utf8");
  return copy;
}

test("a generic bridge applies all replacements and the projection, or uses the original request", () => {
  const original = {
    insertionAllowed: true,
    results: {
      a: { content: "old A" },
      b: { content: "old B" },
    },
  };
  const plan = {
    replacements: [
      { result_id: "a", expected_sha256: revisionFor("old A"), marker: "marker A" },
      { result_id: "b", expected_sha256: revisionFor("old B"), marker: "marker B" },
    ],
    projection_utf8_base64: Buffer.from("current code").toString("base64"),
  };
  const applied = applyPlanAtomically(original, plan);
  assert.notEqual(applied, original);
  assert.equal(applied.results.a.content, "marker A");
  assert.equal(applied.projection, "current code");
  const failed = applyPlanAtomically({ ...original, results: { ...original.results, b: { content: "changed" } } }, plan);
  assert.equal(failed.results.b.content, "changed");
  assert.equal(failed.projection, undefined);
});
