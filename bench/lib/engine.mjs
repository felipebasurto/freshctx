import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentFiles, materialize, replayEvents, resolveGold } from "./replay.mjs";
import { checkExpect, score } from "../score.mjs";
import { transformAppendOnly } from "../transformers/append-only.mjs";
import { transformCorvus } from "../transformers/corvus.mjs";
import { transformHermesPrune } from "../transformers/hermes-prune.mjs";
import { transformPiCompact } from "../transformers/pi-compact.mjs";
import { openFreshctxArm } from "../transformers/freshctx.mjs";

const LAYER_A_ARMS = ["append_only", "corvus_full_file", "freshctx_prepare"];
export const ECON_ARMS = [
  "today_tool_history",
  "pi_compact",
  "hermes_prune",
  "corvus_full_file",
  "freshctx_prepare",
];

export async function runFixture(fixture, { keepRoot = false, arms = LAYER_A_ARMS } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `freshctx-bench-${fixture.id}-`));
  let finished = false;
  try {
    await materialize(root, fixture.files);
    const freshctx = await openFreshctxArm({ root, fixture });
    try {
      const observations = await replayEvents(root, fixture.events, { onRead: freshctx.observe });
      const gold = await resolveGold(root, fixture);
      const disk = await currentFiles(root, [...new Set(observations.map((obs) => obs.path))]);
      const views = {
        append_only: transformAppendOnly({ observations }),
        today_tool_history: transformAppendOnly({ observations, arm: "today_tool_history" }),
        pi_compact: transformPiCompact({ observations }),
        hermes_prune: transformHermesPrune({ observations }),
        corvus_full_file: await transformCorvus({ root, observations }),
        freshctx_prepare: await freshctx.finish(),
      };
      finished = true;
      const runs = [];
      for (const arm of arms) {
        const view = views[arm];
        const scores = score(view, { observations, gold, budgetBytes: fixture.budgetBytes, disk });
        const expect = fixture.expect?.[arm] ?? {};
        const failures = checkExpect(scores, expect);
        runs.push({
          schema: 1,
          slice: "freshctx-layer-a-v1",
          arm,
          fixtureId: fixture.id,
          scores,
          failures,
        });
      }
      return { root: keepRoot ? root : null, runs };
    } finally {
      if (!finished) await freshctx.close();
    }
  } finally {
    if (!keepRoot) await rm(root, { recursive: true, force: true });
  }
}
