import { createHash, randomBytes } from "node:crypto";

function bytesFor(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

export function sha256(value) {
  return createHash("sha256").update(bytesFor(value)).digest("hex");
}

export function revisionFor(value) {
  return `sha256:${sha256(value)}`;
}

export function stableId(prefix, fields) {
  const canonical = JSON.stringify(fields);
  return `${prefix}_${sha256(canonical).slice(0, 24)}`;
}

export function compactUnitId(fields) {
  return sha256(JSON.stringify(fields)).slice(0, 8);
}

export function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function digestFromRevision(revision) {
  if (typeof revision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(revision)) {
    throw new TypeError("expected a sha256 revision");
  }
  return revision.slice("sha256:".length);
}

export function equalBytes(left, right) {
  return bytesFor(left).equals(bytesFor(right));
}
