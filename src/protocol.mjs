import { fail } from "./errors.mjs";
import { isRevision } from "./hash.mjs";

export const PROTOCOL = "freshctx/1";
export const VERSION = "0.1.0";
export const REQUIRED_CAPABILITIES = Object.freeze([
  "request_rewrite",
  "stable_result_identity",
  "projection_insertion",
  "shared_workspace",
]);

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_request", `${field} must be a non-empty string`);
  }
  return value;
}

function requiredField(record, field) {
  if (!Object.hasOwn(record, field)) {
    fail("invalid_request", `${field} is required`);
  }
  return record[field];
}

function optionalField(record, field) {
  return Object.hasOwn(record, field) ? record[field] : undefined;
}

function requiredStringField(record, field) {
  return requiredString(requiredField(record, field), field);
}

function requiredSafeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("invalid_request", `${field} must be an integer of at least ${minimum}`);
  }
  return value;
}

export function decodeUtf8Base64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/u.test(value)) {
    fail("invalid_request", "content_utf8_base64 must be base64 or base64url");
  }
  if (value.includes("=") && value.length % 4 !== 0) {
    fail("invalid_request", "content_utf8_base64 has invalid base64 padding");
  }
  const unpadded = value.replace(/=+$/u, "").replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Buffer.from(unpadded, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== unpadded) {
    fail("invalid_request", "content_utf8_base64 must be valid base64");
  }
  try {
    return { bytes, text: utf8.decode(bytes) };
  } catch {
    fail("non_utf8", "content_utf8_base64 does not encode UTF-8 text");
  }
}

function parseRange(value) {
  if (value === undefined) return null;
  if (!isObject(value)) fail("invalid_request", "range must be an object");
  const startByte = requiredSafeInteger(requiredField(value, "start_byte"), "range.start_byte");
  const endByte = requiredSafeInteger(requiredField(value, "end_byte"), "range.end_byte", startByte + 1);
  return { startByte, endByte };
}

export function parseRequest(value) {
  if (!isObject(value)) fail("invalid_request", "request must be an object");
  if (optionalField(value, "protocol") !== PROTOCOL) fail("unsupported_protocol", `expected ${PROTOCOL}`);
  const id = requiredStringField(value, "id");
  const op = requiredStringField(value, "op");
  switch (op) {
    case "hello": {
      const sessionId = requiredStringField(value, "session_id");
      const capabilities = requiredField(value, "capabilities");
      if (!isObject(capabilities)) fail("invalid_request", "capabilities must be an object");
      for (const capability of REQUIRED_CAPABILITIES) {
        if (optionalField(capabilities, capability) !== true) {
          fail("host_incompatible", `host lacks required capability: ${capability}`);
        }
      }
      return { id, op, sessionId };
    }
    case "observe": {
      const turn = optionalField(value, "turn");
      return {
        id,
        op,
        resultId: requiredStringField(value, "result_id"),
        path: requiredStringField(value, "path"),
        content: decodeUtf8Base64(requiredField(value, "content_utf8_base64")),
        range: parseRange(optionalField(value, "range")),
        turn: turn === undefined ? 0 : requiredSafeInteger(turn, "turn"),
      };
    }
    case "prepare": {
      const requestId = requiredStringField(value, "request_id");
      const listed = requiredField(value, "result_ids");
      if (!Array.isArray(listed)) fail("invalid_request", "result_ids must be an array");
      const resultIds = listed.map((item) => requiredString(item, "result_ids[]"));
      if (new Set(resultIds).size !== resultIds.length) fail("invalid_request", "result_ids must not contain duplicates");
      return {
        id,
        op,
        requestId,
        resultIds,
        budgetBytes: requiredSafeInteger(requiredField(value, "budget_bytes"), "budget_bytes"),
        granularity: optionalField(value, "selection_granularity"),
      };
    }
    case "commit":
      return { id, op, planId: requiredStringField(value, "plan_id") };
    case "recover": {
      const unitId = requiredStringField(value, "unit_id");
      const revision = requiredStringField(value, "revision");
      if (!isRevision(revision)) fail("invalid_request", "revision must be a sha256 revision");
      return { id, op, unitId, revision };
    }
    case "status":
      return { id, op };
    default:
      fail("unknown_operation", `unknown operation: ${op}`);
  }
}

export function response(id, result) {
  return { protocol: PROTOCOL, id, ok: true, result };
}

export function failure(id, error) {
  return { protocol: PROTOCOL, id: id ?? null, ok: false, error };
}
