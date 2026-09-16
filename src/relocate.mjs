export const ANCHOR_BYTES = 128;
export const SIMILARITY_THRESHOLD = 0.6;

export function anchorsFor(snapshotBytes, startByte, endByte) {
  const prefix = snapshotBytes.subarray(Math.max(0, startByte - ANCHOR_BYTES), startByte);
  const suffix = snapshotBytes.subarray(endByte, Math.min(snapshotBytes.length, endByte + ANCHOR_BYTES));
  return { prefixAnchor: prefix.toString("base64"), suffixAnchor: suffix.toString("base64") };
}

export function findByteOccurrences(haystack, needle) {
  const offsets = [];
  if (needle.length === 0) return offsets;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return offsets;
    offsets.push(index);
    from = index + 1;
    if (from >= haystack.length) return offsets;
  }
}

export function enclosingParsedUnit(parsedUnits, startByte, endByte) {
  let best = null;
  for (const unit of parsedUnits ?? []) {
    if (unit.startByte <= startByte && unit.endByte >= endByte) {
      const size = unit.endByte - unit.startByte;
      if (best === null || size < best.size || (size === best.size && unit.selector < best.unit.selector)) {
        best = { unit, size };
      }
    }
  }
  return best?.unit ?? null;
}

function bigramCounts(text) {
  const counts = new Map();
  for (let index = 0; index + 1 < text.length; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return { counts, total: Math.max(0, text.length - 1) };
}

export function byteBigramSimilarity(leftText, rightText) {
  const left = bigramCounts(leftText);
  const right = bigramCounts(rightText);
  if (left.total === 0 || right.total === 0) return left.total === 0 && right.total === 0 ? 1 : 0;
  let common = 0;
  for (const [gram, count] of left.counts) {
    common += Math.min(count, right.counts.get(gram) ?? 0);
  }
  return (2 * common) / (left.total + right.total);
}

export function bracketSpan(snapshotBytes, prefixAnchor, suffixAnchor, maxSpanBytes, referentText = null) {
  const prefix = Buffer.from(prefixAnchor ?? "", "base64");
  const suffix = Buffer.from(suffixAnchor ?? "", "base64");
  const starts = prefix.length === 0
    ? null
    : findByteOccurrences(snapshotBytes, prefix).map((index) => index + prefix.length);
  const ends = suffix.length === 0 ? null : findByteOccurrences(snapshotBytes, suffix);
  const spans = [];
  const push = (start, end) => {
    if (end > start && end - start <= maxSpanBytes) spans.push([start, end]);
  };
  if (starts === null && ends === null) {
    push(0, snapshotBytes.length);
  } else if (starts === null) {
    if (ends.length === 0) return { status: "none" };
    if (ends.length === 1) push(0, ends[0]);
    else return { status: "ambiguous" };
  } else if (ends === null) {
    if (starts.length === 0) return { status: "none" };
    if (starts.length === 1) push(starts[0], snapshotBytes.length);
    else return { status: "ambiguous" };
  } else {
    if (starts.length === 0 || ends.length === 0) return { status: "none" };
    // Pair each start with its nearest following end (the relocation
    // hypothesis). When the bracketed content itself changed (inserted or
    // deleted lines), also extend the best-matching start toward later ends
    // so the grown span competes on similarity; section-merging extensions
    // are triaged below and can never win outright.
    for (const start of starts) {
      const end = ends.find((candidate) => candidate > start);
      if (end !== undefined) push(start, end);
    }
    if (referentText !== null) {
      const decodeSpan = (start, end) => snapshotBytes.subarray(start, end).toString("utf8");
      let bestStart = -1;
      let bestScore = -1;
      for (const [start, end] of spans) {
        const score = byteBigramSimilarity(decodeSpan(start, end), referentText);
        if (score > bestScore) {
          bestScore = score;
          bestStart = start;
        }
      }
      if (bestStart >= 0) {
        for (const end of ends) {
          if (end > bestStart) push(bestStart, end);
        }
      }
    }
    if (spans.length === 0) return { status: "none" };
  }
  const unique = [...new Map(spans.map(([start, end]) => [`${start}:${end}`, [start, end]])).values()];
  if (unique.length === 0) return { status: "none" };
  if (new Set(unique.map(([start]) => start)).size > 1) return { status: "ambiguous" };
  const contents = unique.map(([start, end]) => snapshotBytes.subarray(start, end));
  if (contents.every((span) => span.equals(contents[0]))) {
    return { status: "unique", startByte: unique[0][0], endByte: unique[0][1] };
  }
  // Anchors repeat with distinct bracketed contents. Prefer the span most
  // similar to the referent, but only when it is unambiguously the best AND
  // the maximal span would merge distinct repeated sections (a containment
  // failure like [A..A..B] merging two SEC blocks is never "updated").
  if (referentText === null) return { status: "ambiguous" };
  const scored = unique.map(([start, end]) => ({
    start,
    end,
    score: byteBigramSimilarity(snapshotBytes.subarray(start, end).toString("utf8"), referentText),
  }));
  scored.sort((left, right) => right.score - left.score || left.start - right.start);
  // Triage candidate spans: maximal spans that merge distinct repeated
  // sections are never themselves the answer (they swallow siblings), but
  // they must not veto the minimal-span winner either. Score only the
  // minimal (nearest-end) spans; growth hypotheses only compete when no
  // minimal span reaches the similarity threshold.
  const bestTextOf = (entry) => snapshotBytes.subarray(entry.start, entry.end).toString("utf8");
  const prefixText = Buffer.from(prefixAnchor ?? "", "base64").toString("utf8");
  const suffixText = Buffer.from(suffixAnchor ?? "", "base64").toString("utf8");
  const repeatsInside = (text, anchor) =>
    anchor.length > 0 && text.indexOf(anchor) !== text.lastIndexOf(anchor);
  // Growth hypothesis: when the nearest-end minimal span misses the
  // threshold, the span may have absorbed inserted lines, so extend the
  // best minimal start toward later ends (the full current section).
  const growth = [];
  {
    const endsSorted = [...ends].sort((a, b) => a - b);
    const bestMinimal = [...scored].sort((a, b) => b.score - a.score || a.start - b.start)[0];
    if (bestMinimal) {
      for (const end of endsSorted) {
        if (end > bestMinimal.end && end - bestMinimal.start <= maxSpanBytes) {
          growth.push({
            start: bestMinimal.start,
            end,
            score: byteBigramSimilarity(snapshotBytes.subarray(bestMinimal.start, end).toString("utf8"), referentText),
          });
        }
      }
    }
  }
  const all = [...scored, ...growth.filter((g) => !scored.some((s) => s.start === g.start && s.end === g.end))];
  const minimalKeys = new Set();
  {
    const endsSorted = [...new Set(unique.map(([, end]) => end))].sort((a, b) => a - b);
    for (const [start] of unique) {
      const nearest = endsSorted.find((end) => end > start);
      if (nearest !== undefined) minimalKeys.add(`${start}:${nearest}`);
    }
  }
  const isMinimal = (entry) => minimalKeys.has(`${entry.start}:${entry.end}`);
  const minimal = scored.filter(isMinimal);
  const nonMergingMinimal = minimal.filter(
    (entry) => !repeatsInside(bestTextOf(entry), prefixText) && !repeatsInside(bestTextOf(entry), suffixText),
  );
  // Prefer a non-merging minimal winner; otherwise the best minimal span may
  // still win outright; growth hypotheses (extensions absorbing inserted
  // lines) compete only when no minimal span reaches the threshold. A growth
  // span swallows a sibling section only when the repeated anchor pair
  // recurs: the maximal span must contain a second prefix occurrence that is
  // itself followed by the suffix (a nested bracket pair), not merely a bare
  // repeated newline.
  const minimalViable = minimal.filter((entry) => entry.score >= SIMILARITY_THRESHOLD);
  const nestsPair = (entry) => {
    const text = bestTextOf(entry);
    const prefix = prefixText;
    const suffix = suffixText;
    if (prefix.length === 0 || suffix.length === 0) return false;
    let index = text.indexOf(prefix);
    while (index !== -1) {
      const after = text.indexOf(suffix, index + prefix.length);
      if (after !== -1 && after + suffix.length < text.length) {
        const rest = text.slice(after + suffix.length);
        if (rest.includes(prefix) && rest.includes(suffix)) return true;
      }
      index = text.indexOf(prefix, index + 1);
    }
    return false;
  };
  const growthViable = all.filter(
    (entry) => !isMinimal(entry) && entry.score >= SIMILARITY_THRESHOLD && !nestsPair(entry),
  );
  let pool;
  if (minimalViable.length > 0 && nonMergingMinimal.length > 0) {
    pool = nonMergingMinimal;
  } else if (minimalViable.length > 0) {
    pool = minimal;
  } else if (growthViable.length === 1) {
    return { status: "unique", startByte: growthViable[0].start, endByte: growthViable[0].end };
  } else if (growthViable.length > 1) {
    growthViable.sort((a, b) => b.score - a.score || a.start - b.start);
    if (growthViable[0].score > growthViable[1].score) {
      return { status: "unique", startByte: growthViable[0].start, endByte: growthViable[0].end };
    }
    return { status: "ambiguous" };
  } else {
    pool = all;
  }
  const best = pool[0];
  if (pool.length >= 2 && best.score > pool[1].score && best.score >= SIMILARITY_THRESHOLD) {
    return { status: "unique", startByte: best.start, endByte: best.end };
  }
  // A single non-merging minimal span (every alternative merges sections or
  // misses the threshold) is the unambiguous bracket.
  if (pool.length === 1 && isMinimal(best) && best.score >= SIMILARITY_THRESHOLD) {
    return { status: "unique", startByte: best.start, endByte: best.end };
  }
  return { status: "ambiguous" };
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

export function relocateRegion(input) {
  const {
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
  } = input;
  const inBounds = (start, end) =>
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= snapshotBytes.length;
  const matchesReferent = (start, end) => inBounds(start, end) && snapshotBytes.subarray(start, end).equals(referentBytes);
  const decode = (bytes) => Buffer.from(bytes).toString("utf8");
  const maxSpanBytes = Math.max(512, referentBytes.length * 4);
  const sameParent = (start, end) => {
    if (!parsedOk) return true;
    const enclosing = enclosingParsedUnit(parsedUnits, start, end);
    return (enclosing?.selector ?? null) === (parentSelector ?? null);
  };
  const similarEnough = (start, end) =>
    byteBigramSimilarity(decode(snapshotBytes.subarray(start, end)), decode(referentBytes)) >= SIMILARITY_THRESHOLD;

  // A matching offset proves occurrence identity only in the same snapshot.
  if (snapshotUnchanged && matchesReferent(prevStart, prevEnd)) {
    return { status: "stable", startByte: prevStart, endByte: prevEnd };
  }

  let ambiguous = false;
  const occurrences = findByteOccurrences(snapshotBytes, referentBytes);

  // Resolve the observed surroundings before searching for surviving old
  // bytes. Otherwise an edited occurrence can jump to an unchanged sibling.
  const bracketed = bracketSpan(snapshotBytes, prefixAnchor, suffixAnchor, maxSpanBytes, decode(referentBytes));
  if (bracketed.status === "unique" && sameParent(bracketed.startByte, bracketed.endByte)
    && similarEnough(bracketed.startByte, bracketed.endByte)) {
    if (previousOccurrences === 1 && occurrences.length === 1
      && occurrences[0] >= bracketed.startByte
      && occurrences[0] + referentBytes.length <= bracketed.endByte) {
      const start = occurrences[0];
      return { status: start === prevStart ? "stable" : "relocated", startByte: start, endByte: start + referentBytes.length };
    }
    const unchanged = matchesReferent(bracketed.startByte, bracketed.endByte);
    return {
      status: unchanged ? (bracketed.startByte === prevStart ? "stable" : "relocated") : "updated",
      startByte: bracketed.startByte,
      endByte: bracketed.endByte,
    };
  }

  // Similarity and offsets cannot distinguish repeated occurrences after an
  // edit. Missing legacy multiplicity is also insufficient evidence.
  if (previousOccurrences !== 1 || occurrences.length > 1) return { status: "ambiguous" };

  if (matchesReferent(prevStart, prevEnd) && sameParent(prevStart, prevEnd)) {
    return { status: "stable", startByte: prevStart, endByte: prevEnd };
  }

  // 2. Structural parent moved; same referent at translated offsets.
  if (parentSelector !== null && Number.isInteger(relStart) && Number.isInteger(relEnd)) {
    const matches = parsedUnits.filter((unit) => unit.selector === parentSelector);
    if (matches.length === 1) {
      const start = matches[0].startByte + relStart;
      const end = matches[0].startByte + relEnd;
      if (matchesReferent(start, end)) {
        return { status: "relocated", startByte: start, endByte: end };
      }
    } else if (matches.length > 1) {
      ambiguous = true;
    }
  }

  // 3. A unique unchanged referent; never choose among identical siblings.
  if (occurrences.length > 0) {
    const storedPrefix = Buffer.from(prefixAnchor, "base64");
    const storedSuffix = Buffer.from(suffixAnchor, "base64");
    const anchored = occurrences.find(
      (at) => surroundingsMatch(snapshotBytes, at, storedPrefix, true)
        && surroundingsMatch(snapshotBytes, at + referentBytes.length, storedSuffix, false),
    );
    const at = anchored ?? occurrences[0];
    return { status: "relocated", startByte: at, endByte: at + referentBytes.length };
  }

  if (bracketed.status === "ambiguous") ambiguous = true;

  // 5. Same span, intact surroundings, similar changed content (same-length edits).
  if (inBounds(prevStart, prevEnd)) {
    const storedPrefix = Buffer.from(prefixAnchor, "base64");
    const storedSuffix = Buffer.from(suffixAnchor, "base64");
    if (
      surroundingsMatch(snapshotBytes, prevStart, storedPrefix, true)
      && surroundingsMatch(snapshotBytes, prevEnd, storedSuffix, false)
      && sameParent(prevStart, prevEnd)
      && similarEnough(prevStart, prevEnd)
    ) {
      return { status: "updated", startByte: prevStart, endByte: prevEnd };
    }
  }

  return { status: ambiguous ? "ambiguous" : "invalidated" };
}
