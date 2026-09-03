import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runFixture } from "./lib/engine.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDir = path.join(root, "fixtures");
const reportPath = path.join(root, "results", "layer-a.json");

export async function loadFixtures() {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json")).sort();
  const fixtures = [];
  for (const name of names) {
    fixtures.push(JSON.parse(await readFile(path.join(fixtureDir, name), "utf8")));
  }
  return fixtures;
}

export async function runLayerA() {
  const fixtures = await loadFixtures();
  const runs = [];
  const failures = [];
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    for (const run of result.runs) {
      runs.push({
        schema: run.schema,
        slice: run.slice,
        arm: run.arm,
        fixtureId: run.fixtureId,
        scores: run.scores,
      });
      if (run.failures.length > 0) {
        failures.push({ fixtureId: run.fixtureId, arm: run.arm, failures: run.failures });
      }
    }
  }
  const summary = summarize(runs);
  const report = {
    schema: 1,
    slice: "freshctx-layer-a-v1",
    fixture_count: fixtures.length,
    summary,
    runs,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, encoded);
  return { report, failures, reportPath };
}

function summarize(runs) {
  const byArm = {};
  for (const run of runs) {
    const bucket = byArm[run.arm] ?? {
      freshness_exact: 0,
      stale_leakage: 0,
      last_known_in_request: 0,
      budget_ok: 0,
      prompt_bytes: 0,
      live_block_bytes: 0,
      payload_bytes: 0,
      envelope_bytes: 0,
    };
    if (run.scores.freshness_exact) bucket.freshness_exact += 1;
    if (run.scores.stale_leakage) bucket.stale_leakage += 1;
    if (run.scores.last_known_in_request) bucket.last_known_in_request += 1;
    if (run.scores.budget_ok) bucket.budget_ok += 1;
    bucket.prompt_bytes += run.scores.prompt_bytes;
    bucket.live_block_bytes += run.scores.live_block_bytes;
    bucket.payload_bytes += run.scores.payload_bytes;
    bucket.envelope_bytes += run.scores.envelope_bytes;
    byArm[run.arm] = bucket;
  }
  return {
    fixture_count: new Set(runs.map((run) => run.fixtureId)).size,
    arms: byArm,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { report, failures, reportPath } = await runLayerA();
  process.stdout.write(`${JSON.stringify({ reportPath, summary: report.summary, failure_count: failures.length }, null, 2)}\n`);
  if (failures.length > 0) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}
