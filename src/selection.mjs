function comparison(left, right) {
  return right.observedAt - left.observedAt || left.id.localeCompare(right.id);
}

export class UnitSelection {
  static overlap(left, right) {
    if (left.path !== right.path) return false;
    if (left.kind === "file" || right.kind === "file") return true;
    return left.startByte < right.endByte && right.startByte < left.endByte;
  }

  static rankActive(units) {
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
      candidates.push(unit);
    }
    return { candidates, omitted };
  }
}

export function rankActiveUnits(units) {
  return UnitSelection.rankActive(units);
}
