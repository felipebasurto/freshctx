import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function collectNumbers(value, into) {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, into);
  }
}

function announcementIntegers(text) {
  const stripped = text
    .replaceAll(/arXiv:\d+\.\d+v\d+/gu, " ")
    .replaceAll(/sha256:[a-f0-9]{64}/gu, " ");
  return [...stripped.matchAll(/\b\d+\b/gu)].map((match) => Number(match[0]));
}

export async function checkAnnouncement({ announcementPath, layerAPath, mvaPath, econPath, horizonPath, addonPath } = {}) {
  const resolvedLayerA = layerAPath ?? path.join(root, "results", "layer-a.json");
  const resolvedMva = mvaPath ?? path.join(root, "results", "mva.json");
  const resolvedEcon = econPath ?? path.join(root, "results", "econ.json");
  const resolvedHorizon = horizonPath ?? path.join(root, "results", "horizon.json");
  const resolvedAddon = addonPath ?? path.join(root, "results", "addon.json");
  const announcement = await readFile(announcementPath ?? path.join(root, "ANNOUNCEMENT.md"), "utf8");
  const layerABytes = await readFile(resolvedLayerA);
  const mvaBytes = await readFile(resolvedMva);
  const econBytes = await readFile(resolvedEcon);
  const horizonBytes = await readFile(resolvedHorizon);
  const addonBytes = await readFile(resolvedAddon);
  const layerA = JSON.parse(layerABytes.toString("utf8"));
  const mva = JSON.parse(mvaBytes.toString("utf8"));
  const econ = JSON.parse(econBytes.toString("utf8"));
  const horizon = JSON.parse(horizonBytes.toString("utf8"));
  const addon = JSON.parse(addonBytes.toString("utf8"));
  const allowed = new Set();
  collectNumbers(layerA, allowed);
  collectNumbers(mva, allowed);
  collectNumbers(econ, allowed);
  collectNumbers(horizon, allowed);
  collectNumbers(addon, allowed);
  const words = announcement.trim().split(/\s+/u).filter(Boolean).length;
  const missing = [];
  for (const value of announcementIntegers(announcement)) {
    if (!allowed.has(value)) missing.push(value);
  }
  const problems = [];
  if (words > 1200) problems.push(`word count ${words} exceeds 1200`);
  if (!announcement.includes("measured")) problems.push("announcement must label scores as measured");
  if (!announcement.includes("freshctx-layer-a-v1")) problems.push("missing slice freshctx-layer-a-v1");
  if (!announcement.includes("freshctx-mva-v1")) problems.push("missing slice freshctx-mva-v1");
  if (!announcement.includes("freshctx-econ-v1")) problems.push("missing slice freshctx-econ-v1");
  if (!announcement.includes("freshctx-horizon-v1")) problems.push("missing slice freshctx-horizon-v1");
  if (!announcement.includes("freshctx-addon-v1")) problems.push("missing slice freshctx-addon-v1");
  if (!announcement.includes("freshctx-addon-v2")) problems.push("missing slice freshctx-addon-v2");
  if (!announcement.includes("freshctx_then_host")) problems.push("missing compose order freshctx_then_host");
  if (announcement.includes("pass@1")) {
    problems.push("announcement must not mention pass@1");
  }
  if (/\breproduced\b/iu.test(announcement) && !/not reproduced/iu.test(announcement)) {
    problems.push("do not mark our scores reproduced");
  }
  if (!/there is still no drop-in adapter/iu.test(announcement)) {
    problems.push("announcement must say there is still no drop-in adapter");
  }
  for (const value of missing) problems.push(`number ${value} is not in the frozen reports`);
  const layerHash = createHash("sha256").update(layerABytes).digest("hex");
  const mvaHash = createHash("sha256").update(mvaBytes).digest("hex");
  const econHash = createHash("sha256").update(econBytes).digest("hex");
  const horizonHash = createHash("sha256").update(horizonBytes).digest("hex");
  const addonHash = createHash("sha256").update(addonBytes).digest("hex");
  if (!announcement.includes(`sha256:${layerHash}`)) {
    problems.push("announcement must cite the current layer-a.json sha256");
  }
  if (!announcement.includes(`sha256:${mvaHash}`)) {
    problems.push("announcement must cite the current mva.json sha256");
  }
  if (!announcement.includes(`sha256:${econHash}`)) {
    problems.push("announcement must cite the current econ.json sha256");
  }
  if (!announcement.includes(`sha256:${horizonHash}`)) {
    problems.push("announcement must cite the current horizon.json sha256");
  }
  if (!announcement.includes(`sha256:${addonHash}`)) {
    problems.push("announcement must cite the current addon.json sha256");
  }
  return { ok: problems.length === 0, words, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await checkAnnouncement();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
