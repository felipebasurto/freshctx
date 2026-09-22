export function stableMarker(unitId) {
  return `[${unitId}]`;
}

export function unavailableMarker(unitId, reason) {
  return `[${unitId} ${reason.replace(/[\r\n]/gu, " ")}]`;
}

export function renderUnit(unit) {
  const kind = unit.kind === "file" ? "" : `${unit.kind}:`;
  return `${unit.path}:${kind}${Buffer.byteLength(unit.content, "utf8")}bytes\n${unit.content}`;
}

function unitsOverlap(left, right) {
  if (left.path !== right.path) return false;
  if (left.kind === "file" || right.kind === "file") return true;
  return left.startByte < right.endByte && right.startByte < left.endByte;
}

export function buildProjection(units, budgetBytes) {
  const ranked = [...units].sort((left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id));
  const admitted = [];
  const omitted = [];
  let remaining = budgetBytes;
  for (const unit of ranked) {
    if (admitted.some((entry) => unitsOverlap(entry.unit, unit))) {
      omitted.push({ unitId: unit.id, reason: "overlap" });
      continue;
    }
    const text = renderUnit(unit);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > remaining) {
      omitted.push({ unitId: unit.id, reason: "budget" });
      continue;
    }
    admitted.push({ unit, text });
    remaining -= bytes;
  }
  admitted.sort((left, right) => left.unit.path.localeCompare(right.unit.path) || left.unit.id.localeCompare(right.unit.id));
  return {
    text: admitted.map((entry) => entry.text).join(""),
    bytes: budgetBytes - remaining,
    selected: admitted.map((entry) => entry.unit),
    omitted,
  };
}
