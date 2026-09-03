import { rankActiveUnits } from "./selection.mjs";

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function unescapeAttribute(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function projectionBytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function markerPath(value) {
  return encodeURIComponent(String(value)).replaceAll("%2F", "/");
}

export function stableMarker(unit) {
  return `[freshctx:${unit.id} path=${markerPath(unit.path)}] Current content is supplied in the live projection.`;
}

export function unavailableMarker(unit, reason) {
  const safeReason = String(reason ?? "unresolved").replaceAll("\n", " ").replaceAll("\r", " ");
  return `[freshctx:${unit.id} path=${markerPath(unit.path)}] Current content was not supplied (${safeReason}); reread this file before relying on it.`;
}

export function renderUnit(unit) {
  const contentBytes = projectionBytes(unit.content);
  const attributes = [
    `id="${escapeAttribute(unit.id)}"`,
    `path="${escapeAttribute(unit.path)}"`,
    `kind="${escapeAttribute(unit.kind)}"`,
    `lines="${unit.startLine}-${unit.endLine}"`,
    `revision="${escapeAttribute(unit.revision)}"`,
    `resolution="${escapeAttribute(unit.resolution)}"`,
    `content-bytes="${contentBytes}"`,
  ].join(" ");
  return `<freshctx-unit ${attributes}>\n${unit.content}\n</freshctx-unit>`;
}

function renderEnvelope({ selected, omitted }) {
  const units = selected.map(renderUnit);
  const preamble = selected.length > 0
    ? "The following code is the current workspace state. Historical read markers refer here."
    : "";
  return [
    `<freshctx selected="${selected.length}" omitted="${omitted.length}">${preamble}`,
    ...units,
    "</freshctx>",
  ].join("\n");
}

export function buildProjection(units, budgetBytes) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
    throw new TypeError("budgetBytes must be a non-negative safe integer");
  }
  const ranked = rankActiveUnits(units);
  const selected = [];
  const omitted = [...ranked.omitted];
  if (projectionBytes(renderEnvelope({ selected, omitted: [] })) > budgetBytes) {
    return { text: "", bytes: 0, selected, omitted: [...omitted, ...ranked.candidates.map((unit) => ({ unitId: unit.id, reason: "budget" }))] };
  }
  for (const unit of ranked.candidates) {
    const trial = renderEnvelope({ selected: [...selected, unit], omitted });
    if (projectionBytes(trial) <= budgetBytes) {
      selected.push(unit);
    } else {
      omitted.push({ unitId: unit.id, reason: "budget" });
    }
  }
  let text = renderEnvelope({ selected, omitted });
  while (selected.length > 0 && projectionBytes(text) > budgetBytes) {
    const removed = selected.pop();
    omitted.push({ unitId: removed.id, reason: "budget" });
    text = renderEnvelope({ selected, omitted });
  }
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

function parseAttributes(header) {
  const attributes = {};
  for (const match of header.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/giu)) {
    attributes[match[1]] = unescapeAttribute(match[2]);
  }
  return attributes;
}

export function decodeProjectionUnits(text) {
  const source = Buffer.from(String(text), "utf8");
  const opening = Buffer.from("<freshctx-unit ");
  const headerEndMarker = Buffer.from(">\n");
  const closing = Buffer.from("\n</freshctx-unit>");
  const decoded = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(opening, cursor);
    if (start === -1) break;
    const headerEnd = source.indexOf(headerEndMarker, start + opening.length);
    if (headerEnd === -1) throw new Error("unterminated FreshCtx unit header");
    const attributes = parseAttributes(source.subarray(start, headerEnd + 1).toString("utf8"));
    const contentBytes = Number(attributes["content-bytes"]);
    if (!Number.isSafeInteger(contentBytes) || contentBytes < 0) {
      throw new Error("invalid FreshCtx content-bytes attribute");
    }
    const contentStart = headerEnd + headerEndMarker.length;
    const contentEnd = contentStart + contentBytes;
    if (contentEnd > source.length || !source.subarray(contentEnd, contentEnd + closing.length).equals(closing)) {
      throw new Error("FreshCtx unit length does not align with its closing frame");
    }
    decoded.push({
      ...attributes,
      contentBytes,
      content: source.subarray(contentStart, contentEnd).toString("utf8"),
    });
    cursor = contentEnd + closing.length;
  }
  return decoded;
}
