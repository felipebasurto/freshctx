function comparison(left, right) {
  return right.observedAt - left.observedAt || left.id.localeCompare(right.id);
}

export function rankActiveUnits(units) {
  const byId = new Map();
  for (const unit of units) {
    const existing = byId.get(unit.id);
    if (!existing || comparison(unit, existing) < 0) byId.set(unit.id, unit);
  }
  const unique = [...byId.values()].sort(comparison);
  const candidates = [];
  const omitted = [];
  for (const unit of unique) {
    if (unit.state !== "resolved") {
      omitted.push({ unitId: unit.id, reason: unit.reason ?? "unresolved" });
      continue;
    }
    const overlaps = candidates.some((selected) => {
      if (selected.path !== unit.path) return false;
      if (selected.kind === "file" || unit.kind === "file") return true;
      return unit.startByte < selected.endByte && selected.startByte < unit.endByte;
    });
    if (overlaps) {
      omitted.push({ unitId: unit.id, reason: "overlap" });
      continue;
    }
    candidates.push(unit);
  }
  return { candidates, omitted };
}
