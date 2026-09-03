import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkAnnouncement } from "../bench/check-announcement.mjs";

test("announcement integers come from the frozen reports", async () => {
  const result = await checkAnnouncement();
  assert.equal(result.ok, true, result.problems.join("; "));
  assert.ok(result.words <= 1200);
});

test("a hand-bumped horizon USD fails the announcement checker", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "freshctx-announce-"));
  const source = await readFile(new URL("../bench/ANNOUNCEMENT.md", import.meta.url), "utf8");
  const mutatedPath = path.join(tmp, "ANNOUNCEMENT.md");
  await writeFile(mutatedPath, source.replace("16371159", "16371160"));
  const result = await checkAnnouncement({ announcementPath: mutatedPath });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("16371160")));
});
