import { createHash, randomBytes } from "node:crypto";

const REVISION = /^sha256:[a-f0-9]{64}$/u;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function revisionFor(value) {
  return `sha256:${sha256(value)}`;
}

export function isRevision(value) {
  return typeof value === "string" && REVISION.test(value);
}

export function digestFromRevision(revision) {
  if (!isRevision(revision)) throw new TypeError("expected a sha256 revision");
  return revision.slice("sha256:".length);
}

export function compactUnitId(fields) {
  return sha256(JSON.stringify(fields)).slice(0, 24);
}

export function legacyCompactUnitId(fields) {
  return compactUnitId(fields).slice(0, 8);
}

export function stableId(prefix, fields) {
  return `${prefix}_${compactUnitId(fields)}`;
}

export function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function fileUnitIdentity(sourcePath) {
  return { kind: "file", path: sourcePath };
}

export function symbolUnitIdentity(sourcePath, selector) {
  return { kind: "symbol", path: sourcePath, selector };
}

export function regionUnitIdentity(sourcePath, revision, prefixAnchor, suffixAnchor, parentSelector = null) {
  return {
    kind: "region",
    path: sourcePath,
    revision,
    prefixAnchor,
    suffixAnchor,
    parentSelector,
  };
}
