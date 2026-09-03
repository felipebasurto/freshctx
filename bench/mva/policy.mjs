import { rangeFor, serializeRequest } from "../lib/serialize.mjs";
import { revisionFor } from "../../src/hash.mjs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { transformAppendOnly } from "../transformers/append-only.mjs";
import { transformCorvus } from "../transformers/corvus.mjs";
import { transformHermesPrune } from "../transformers/hermes-prune.mjs";
import { transformPiCompact } from "../transformers/pi-compact.mjs";

export function quotedToken(text) {
  const match = /'([^']+)'/u.exec(text);
  return match ? match[1] : null;
}

export function visibleText(view, filePath) {
  const selected = [...(view.selected ?? [])].reverse().find((unit) => unit.path === filePath);
  if (selected) return selected.content;
  const body = [...view.history].reverse().find((item) => item.path === filePath && item.kind === "body");
  return body?.text ?? "";
}

export async function viewForArm(arm, { root, observations, fixture, freshctx, requestId }) {
  if (arm === "append_only" || arm === "today_tool_history") {
    return transformAppendOnly({ observations, arm });
  }
  if (arm === "pi_compact") return transformPiCompact({ observations });
  if (arm === "hermes_prune") return transformHermesPrune({ observations });
  if (arm === "corvus_full_file") return transformCorvus({ root, observations });
  return freshctx.snapshot(requestId);
}

export async function readPath({ root, filePath, resultId, match, observations, onRead }) {
  const abs = path.join(root, filePath);
  const bytes = await readFile(abs);
  const text = bytes.toString("utf8");
  let range = null;
  let slice = bytes;
  if (match) {
    range = rangeFor(text, match);
    if (!range) throw new Error(`match not found in ${filePath}`);
    slice = bytes.subarray(range.startByte, range.endByte);
  }
  const observation = {
    resultId,
    path: filePath,
    bytes: Buffer.from(slice),
    text: slice.toString("utf8"),
    range,
    observedRevision: revisionFor(slice),
  };
  observations.push(observation);
  await onRead?.(observation);
  return observation;
}

export async function tryReplaceToken(root, filePath, fromToken, toToken) {
  const abs = path.join(root, filePath);
  const text = await readFile(abs, "utf8");
  const needle = `'${fromToken}'`;
  if (!text.includes(needle)) return { ok: false };
  await writeFile(abs, text.replace(needle, `'${toToken}'`));
  return { ok: true };
}

export function requestBytes(view) {
  return Buffer.byteLength(serializeRequest(view), "utf8");
}
