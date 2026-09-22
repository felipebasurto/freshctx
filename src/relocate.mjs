const ANCHOR_BYTES = 128;
const SIMILARITY_THRESHOLD = 0.6;
const NONE = Object.freeze({ status: "none" });
const AMBIGUOUS = Object.freeze({ status: "ambiguous" });

export function anchorsFor(snapshotBytes, startByte, endByte) {
  const prefix = snapshotBytes.subarray(Math.max(0, startByte - ANCHOR_BYTES), startByte);
  const suffix = snapshotBytes.subarray(endByte, endByte + ANCHOR_BYTES);
  return { prefixAnchor: prefix.toString("base64"), suffixAnchor: suffix.toString("base64") };
}

export function findByteOccurrences(haystack, needle) {
  const offsets = [];
  if (needle.length === 0) return offsets;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) offsets.push(at);
  return offsets;
}

export function enclosingParsedUnit(parsedUnits, startByte, endByte) {
  let best = null;
  for (const unit of parsedUnits) {
    if (unit.startByte > startByte || unit.endByte < endByte) continue;
    const size = unit.endByte - unit.startByte;
    if (best === null || size < best.size || (size === best.size && unit.selector < best.unit.selector)) {
      best = { unit, size };
    }
  }
  return best?.unit ?? null;
}

function bigrams(text) {
  const counts = new Map();
  for (let index = 1; index < text.length; index += 1) {
    const gram = text.charCodeAt(index - 1) * 0x10000 + text.charCodeAt(index);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return { counts, total: Math.max(0, text.length - 1) };
}

function similarity(left, right) {
  if (left.total === 0 || right.total === 0) return left.total === right.total ? 1 : 0;
  let common = 0;
  for (const [gram, count] of left.counts) common += Math.min(count, right.counts.get(gram) ?? 0);
  return (2 * common) / (left.total + right.total);
}

function unique(startByte, endByte) {
  return { status: "unique", startByte, endByte };
}

function bracketSpan(snapshotBytes, prefix, suffix, maxSpanBytes, scoreAt) {
  const fits = (start, end) => end > start && end - start <= maxSpanBytes;
  const only = (start, end) => (fits(start, end) ? unique(start, end) : NONE);
  const starts = findByteOccurrences(snapshotBytes, prefix).map((at) => at + prefix.length);
  const ends = findByteOccurrences(snapshotBytes, suffix);
  if (prefix.length === 0 || suffix.length === 0) {
    if (prefix.length === suffix.length) return only(0, snapshotBytes.length);
    const bounds = prefix.length === 0 ? ends : starts;
    if (bounds.length !== 1) return bounds.length === 0 ? NONE : AMBIGUOUS;
    return prefix.length === 0 ? only(0, ends[0]) : only(starts[0], snapshotBytes.length);
  }
  const bracketed = starts.filter((start) => {
    const end = ends.find((candidate) => candidate > start);
    return end !== undefined && fits(start, end);
  });
  if (bracketed.length !== 1) return bracketed.length === 0 ? NONE : AMBIGUOUS;
  const [start] = bracketed;
  const [nearest, ...longer] = ends.filter((end) => fits(start, end));
  if (longer.length === 0 || scoreAt(start, nearest) >= SIMILARITY_THRESHOLD) return unique(start, nearest);
  const viable = longer
    .map((end) => ({ end, score: scoreAt(start, end) }))
    .filter(({ score }) => score >= SIMILARITY_THRESHOLD)
    .sort((left, right) => right.score - left.score);
  if (viable.length === 0 || (viable.length > 1 && viable[0].score === viable[1].score)) return AMBIGUOUS;
  return unique(start, viable[0].end);
}

function surroundingsMatch(snapshotBytes, position, stored, before) {
  if (stored.length === 0) return true;
  if (before) {
    const actual = snapshotBytes.subarray(Math.max(0, position - stored.length), position);
    return actual.equals(stored.subarray(stored.length - actual.length));
  }
  const actual = snapshotBytes.subarray(position, position + stored.length);
  return actual.equals(stored.subarray(0, actual.length));
}

export function relocateRegion({
  snapshotBytes,
  parsedUnits = [],
  parsedOk = false,
  referentBytes,
  prefixAnchor = "",
  suffixAnchor = "",
  parentSelector = null,
  relStart = null,
  relEnd = null,
  prevStart,
  prevEnd,
  snapshotUnchanged = false,
  previousOccurrences = null,
}) {
  const prefix = Buffer.from(prefixAnchor, "base64");
  const suffix = Buffer.from(suffixAnchor, "base64");
  const referent = bigrams(referentBytes.toString("utf8"));
  const maxSpanBytes = Math.max(512, referentBytes.length * 4);
  const inBounds = (start, end) =>
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= snapshotBytes.length;
  const matchesReferent = (start, end) => inBounds(start, end) && snapshotBytes.subarray(start, end).equals(referentBytes);
  const sameParent = (start, end) =>
    !parsedOk || (enclosingParsedUnit(parsedUnits, start, end)?.selector ?? null) === parentSelector;
  const scoreAt = (start, end) => similarity(bigrams(snapshotBytes.toString("utf8", start, end)), referent);
  const similarEnough = (start, end) => scoreAt(start, end) >= SIMILARITY_THRESHOLD;
  const surroundingsAt = (start, end) =>
    surroundingsMatch(snapshotBytes, start, prefix, true) && surroundingsMatch(snapshotBytes, end, suffix, false);

  if (matchesReferent(prevStart, prevEnd)
    && (snapshotUnchanged || previousOccurrences === 1 || (previousOccurrences === null && sameParent(prevStart, prevEnd)))) {
    return { status: "stable", startByte: prevStart, endByte: prevEnd };
  }

  if (parentSelector !== null && Number.isInteger(relStart) && Number.isInteger(relEnd)) {
    const parent = parsedUnits.find((unit) => unit.selector === parentSelector);
    if (parent && matchesReferent(parent.startByte + relStart, parent.startByte + relEnd)) {
      return { status: "relocated", startByte: parent.startByte + relStart, endByte: parent.startByte + relEnd };
    }
  }

  if (inBounds(prevStart, prevEnd) && surroundingsAt(prevStart, prevEnd) && sameParent(prevStart, prevEnd)) {
    return similarEnough(prevStart, prevEnd)
      ? { status: "updated", startByte: prevStart, endByte: prevEnd }
      : { status: "invalidated" };
  }

  const occurrences = findByteOccurrences(snapshotBytes, referentBytes);
  const anchored = occurrences.length === 1
    ? occurrences
    : occurrences.filter((at) => surroundingsAt(at, at + referentBytes.length));
  if (anchored.length === 1) {
    return { status: "relocated", startByte: anchored[0], endByte: anchored[0] + referentBytes.length };
  }

  const bracketed = bracketSpan(snapshotBytes, prefix, suffix, maxSpanBytes, scoreAt);
  if (bracketed.status === "unique" && sameParent(bracketed.startByte, bracketed.endByte)
    && similarEnough(bracketed.startByte, bracketed.endByte)) {
    return { status: "updated", startByte: bracketed.startByte, endByte: bracketed.endByte };
  }
  return { status: occurrences.length > 1 || bracketed.status === "ambiguous" ? "ambiguous" : "invalidated" };
}
