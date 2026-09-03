import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { revisionFor } from "../../src/hash.mjs";
import { uniqueUnitForRange } from "../../src/treesitter.mjs";
import { rangeFor } from "./serialize.mjs";

export async function materialize(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
      await writeFile(target, content);
    } else {
      await writeFile(target, content);
    }
  }
}

export async function replayEvents(root, events, { onRead } = {}) {
  const observations = [];
  for (const event of events) {
    if (event.op === "read") {
      const abs = path.join(root, event.path);
      const bytes = await readFile(abs);
      const text = bytes.toString("utf8");
      let range = event.range ?? null;
      let slice = bytes;
      if (event.match) {
        range = rangeFor(text, event.match);
        if (!range) throw new Error(`match not found in ${event.path}: ${event.match}`);
      }
      if (range) slice = bytes.subarray(range.startByte, range.endByte);
      const observation = {
        resultId: event.resultId,
        path: event.path,
        bytes: Buffer.from(slice),
        text: slice.toString("utf8"),
        range,
        observedRevision: revisionFor(slice),
      };
      observations.push(observation);
      await onRead?.(observation);
      continue;
    }
    if (event.op === "edit" || event.op === "human_edit") {
      const abs = path.join(root, event.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, event.content);
      continue;
    }
    if (event.op === "delete") {
      await rm(path.join(root, event.path));
      continue;
    }
    if (event.op === "write_binary") {
      await writeFile(path.join(root, event.path), Buffer.from(event.bytesHex, "hex"));
      continue;
    }
    throw new Error(`unknown event op: ${event.op}`);
  }
  return observations;
}

export async function resolveGold(root, fixture) {
  const out = new Map();
  for (const [rel, spec] of Object.entries(fixture.gold ?? {})) {
    if (spec.omit) {
      out.set(rel, { omit: true });
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(path.join(root, rel));
    } catch {
      out.set(rel, { omit: true, missing: true });
      continue;
    }
    if (bytes.includes(0)) {
      out.set(rel, { omit: true, binary: true });
      continue;
    }
    const text = bytes.toString("utf8");
    if (spec.kind === "symbol") {
      const match = spec.matchAfter ?? spec.match;
      const range = rangeFor(text, match) ?? { startByte: 0, endByte: bytes.length };
      const parsed = await uniqueUnitForRange({ path: rel, text, range });
      if (parsed.unit) {
        const slice = bytes.subarray(parsed.unit.startByte, parsed.unit.endByte);
        out.set(rel, { kind: "symbol", text: slice.toString("utf8"), bytes: slice });
        continue;
      }
    }
    out.set(rel, { kind: "file", text, bytes });
  }
  return out;
}

export async function currentFiles(root, paths) {
  const out = new Map();
  for (const rel of paths) {
    try {
      const bytes = await readFile(path.join(root, rel));
      if (bytes.includes(0)) continue;
      out.set(rel, bytes.toString("utf8"));
    } catch {
      // missing
    }
  }
  return out;
}
