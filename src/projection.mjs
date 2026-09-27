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

function strictlyContains(outer, inner) {
  return outer.path === inner.path
    && outer.startByte <= inner.startByte && inner.endByte <= outer.endByte
    && outer.endByte - outer.startByte > inner.endByte - inner.startByte;
}

function coveredBy(admitted, unit) {
  const spans = admitted
    .filter((entry) => entry.unit.path === unit.path)
    .map((entry) => [entry.unit.startByte, entry.unit.endByte])
    .sort((left, right) => left[0] - right[0]);
  let reach = unit.startByte;
  for (const [start, end] of spans) {
    if (start > reach) break;
    reach = Math.max(reach, end);
    if (reach >= unit.endByte) return true;
  }
  return false;
}

// A unit inside another candidate ranks after it, so a later partial read never
// narrows an earlier whole-file or wider read. A unit is omitted as overlap only
// when admitted units already cover all of its bytes.
export function buildProjection(units, budgetBytes) {
  const byRecency = (left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id);
  const inner = new Set(units.filter((unit) => units.some((other) => strictlyContains(other, unit))));
  const ranked = [
    ...units.filter((unit) => !inner.has(unit)).sort(byRecency),
    ...[...inner].sort(byRecency),
  ];
  const admitted = [];
  const omitted = [];
  let remaining = budgetBytes;
  for (const unit of ranked) {
    if (coveredBy(admitted, unit)) {
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
