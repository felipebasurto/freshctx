import { rankActiveUnits } from "./selection.mjs";

function projectionBytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function assertKind(kind) {
  switch (kind) {
    case "file":
    case "symbol":
    case "region":
      return kind;
    default: {
      const _exhaustive = kind;
      throw new TypeError(`unknown FreshCtx unit kind: ${_exhaustive}`);
    }
  }
}

export function stableMarker(unit) {
  return `[${unit.id}]`;
}

export function unavailableMarker(unit, reason) {
  const safeReason = String(reason ?? "unresolved").replaceAll("\n", " ").replaceAll("\r", " ");
  return `[${unit.id} ${safeReason}]`;
}

export function renderUnit(unit) {
  const contentBytes = projectionBytes(unit.content);
  const kind = assertKind(unit.kind);
  const header = kind === "file"
    ? `${unit.path}:${contentBytes}`
    : `${unit.path}:${kind}:${contentBytes}`;
  return `${header}\n${unit.content}`;
}

function renderEnvelope(selected) {
  return selected.map(renderUnit).join("");
}

function compareRenderOrder(left, right) {
  const byPath = left.path.localeCompare(right.path);
  if (byPath !== 0) return byPath;
  return left.id.localeCompare(right.id);
}

export function buildProjection(units, budgetBytes) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
    throw new TypeError("budgetBytes must be a non-negative safe integer");
  }
  const ranked = rankActiveUnits(units);
  const selected = [];
  const omitted = [...ranked.omitted];
  if (budgetBytes === 0) {
    return {
      text: "",
      bytes: 0,
      selected,
      omitted: [...omitted, ...ranked.candidates.map((unit) => ({ unitId: unit.id, reason: "budget" }))],
    };
  }
  for (const unit of ranked.candidates) {
    const trial = renderEnvelope([...selected, unit]);
    if (projectionBytes(trial) <= budgetBytes) {
      selected.push(unit);
    } else {
      omitted.push({ unitId: unit.id, reason: "budget" });
    }
  }
  selected.sort(compareRenderOrder);
  const text = renderEnvelope(selected);
  if (projectionBytes(text) > budgetBytes) {
    return {
      text: "",
      bytes: 0,
      selected: [],
      omitted: [...omitted, ...selected.map((unit) => ({ unitId: unit.id, reason: "budget" }))],
    };
  }
  return {
    text,
    bytes: projectionBytes(text),
    selected,
    omitted,
  };
}

function parseHeader(header) {
  const lastColon = header.lastIndexOf(":");
  if (lastColon <= 0) throw new Error("invalid FreshCtx unit header");
  const contentBytes = Number(header.slice(lastColon + 1));
  if (!Number.isSafeInteger(contentBytes) || contentBytes < 0) {
    throw new Error("invalid FreshCtx content-bytes header");
  }
  const prefix = header.slice(0, lastColon);
  const kindColon = prefix.lastIndexOf(":");
  if (kindColon !== -1) {
    const maybeKind = prefix.slice(kindColon + 1);
    if (maybeKind === "symbol" || maybeKind === "region") {
      const sourcePath = prefix.slice(0, kindColon);
      if (!sourcePath) throw new Error("invalid FreshCtx unit path");
      return { path: sourcePath, kind: maybeKind, contentBytes };
    }
  }
  if (!prefix) throw new Error("invalid FreshCtx unit path");
  return { path: prefix, kind: "file", contentBytes };
}

function linesForContent(content) {
  return `1-${content.length === 0 ? 1 : content.split("\n").length}`;
}

export function decodeProjectionUnits(text) {
  const source = Buffer.from(String(text), "utf8");
  const decoded = [];
  let cursor = 0;
  while (cursor < source.length) {
    const headerEnd = source.indexOf(0x0a, cursor);
    if (headerEnd === -1) throw new Error("unterminated FreshCtx unit header");
    const header = source.subarray(cursor, headerEnd).toString("utf8");
    const attributes = parseHeader(header);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + attributes.contentBytes;
    if (contentEnd > source.length) {
      throw new Error("FreshCtx unit length does not align with its content-bytes header");
    }
    const content = source.subarray(contentStart, contentEnd).toString("utf8");
    decoded.push({
      path: attributes.path,
      kind: attributes.kind,
      contentBytes: attributes.contentBytes,
      content,
      lines: linesForContent(content),
    });
    cursor = contentEnd;
  }
  return decoded;
}
