import { revisionFor } from "../../src/hash.mjs";
import { decodeProjectionUnits } from "../../src/projection.mjs";
import { FreshCtxSession } from "../../src/session.mjs";
import { openSessionStore } from "../../src/store.mjs";
import { openWorkspace } from "../../src/workspace.mjs";

function applyPlanAtomically(nativeRequest, plan) {
  const copy = structuredClone(nativeRequest);
  for (const replacement of plan.replacements) {
    const result = copy.results[replacement.result_id];
    if (!result || revisionFor(result.content) !== replacement.expected_sha256) return nativeRequest;
    result.content = replacement.marker;
  }
  copy.projection = Buffer.from(plan.projection_utf8_base64, "base64").toString("utf8");
  return copy;
}

export async function openFreshctxArm({ root, fixture, sessionId }) {
  const workspace = await openWorkspace(root);
  const store = await openSessionStore(workspace, sessionId ?? `bench-${fixture.id}`);
  const session = new FreshCtxSession({ workspace, store, sessionId: store.state.sessionId });
  const native = { results: {} };
  const observations = [];

  async function observe(obs) {
    observations.push(obs);
    await session.observe({
      resultId: obs.resultId,
      path: obs.path,
      content: { bytes: obs.bytes, text: obs.text },
      range: obs.range,
      turn: observations.length,
    });
    native.results[obs.resultId] = { content: obs.text };
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await store.close();
  }

  async function snapshot(requestId) {
    const plan = await session.prepare({
      requestId,
      resultIds: fixture.activeResultIds ?? observations.map((obs) => obs.resultId),
      budgetBytes: fixture.budgetBytes,
    });
    const applied = applyPlanAtomically(native, plan);
    const liveBlock = applied.projection ?? "";
    const units = liveBlock ? decodeProjectionUnits(liveBlock) : [];
    const history = plan.replacements.map((replacement) => ({
      kind: "marker",
      resultId: replacement.result_id,
      path: observations.find((obs) => obs.resultId === replacement.result_id)?.path ?? "",
      text: replacement.marker,
    }));
    return {
      arm: "freshctx_prepare",
      history,
      liveBlock,
      selected: units.map((unit) => ({
        id: unit.id,
        path: unit.path,
        kind: unit.kind,
        content: unit.content,
      })),
      workingSetSize: units.length,
      plan,
    };
  }

  async function finish(requestId = `prepare-${fixture.id}`) {
    try {
      return await snapshot(requestId);
    } finally {
      await close();
    }
  }

  return { observe, snapshot, finish, close };
}
