export function serializeRequest(view) {
  const lines = ["HISTORY"];
  for (const item of view.history) {
    lines.push(`${item.kind}\t${item.resultId}\t${item.path}`);
    lines.push(item.text);
  }
  lines.push("LIVE");
  lines.push(view.liveBlock ?? "");
  return lines.join("\n");
}

export function rangeFor(text, match) {
  if (typeof match !== "string" || match.length === 0) return null;
  const index = text.indexOf(match);
  if (index === -1) return null;
  const startByte = Buffer.byteLength(text.slice(0, index), "utf8");
  const endByte = startByte + Buffer.byteLength(match, "utf8");
  return { startByte, endByte };
}
