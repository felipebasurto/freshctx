import { fail } from "./errors.mjs";

export const PROTOCOL = "freshctx/1";
export const VERSION = "0.1.0";
export const REQUIRED_CAPABILITIES = Object.freeze([
  "request_rewrite",
  "stable_result_identity",
  "projection_insertion",
  "shared_workspace",
]);

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

function requiredSafeInteger(value, field, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("invalid_request", `${field} must be an integer of at least ${minimum}`);
  }
  return value;
}

function requiredArray(value, field) {
  if (!Array.isArray(value)) fail("invalid_request", `${field} must be an array`);
  return value;
}

export function decodeUtf8Base64(value, field = "content_utf8_base64") {
  if (typeof value !== "string") fail("invalid_request", `${field} must be a base64 string`);
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/u.test(value) || /=/u.test(value.slice(0, -2))) {
    fail("invalid_request", `${field} must be base64 or base64url`);
  }
  if (value.includes("=") && value.length % 4 !== 0) {
    fail("invalid_request", `${field} has invalid base64 padding`);
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const unpadded = normalized.replace(/=+$/u, "");
  if (unpadded.length % 4 === 1) fail("invalid_request", `${field} has an invalid base64 length`);
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  const bytes = Buffer.from(padded, "base64");
  if (bytes.toString("base64") !== padded) fail("invalid_request", `${field} must be valid base64`);
  try {
    return { bytes, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    fail("non_utf8", `${field} does not encode UTF-8 text`);
  }
}

function parseRange(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_request", "range must be an object");
  }
  const startByte = requiredSafeInteger(requiredField(value, "start_byte"), "range.start_byte");
  const endByte = requiredSafeInteger(requiredField(value, "end_byte"), "range.end_byte", { minimum: startByte + 1 });
  return { startByte, endByte };
}

export function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_request", "request must be an object");
  }
  if (!Object.hasOwn(value, "protocol") || value.protocol !== PROTOCOL) fail("unsupported_protocol", `expected ${PROTOCOL}`);
  const id = requiredStringField(value, "id");
  const op = requiredStringField(value, "op");
  const request = { id, op };
  switch (op) {
    case "hello": {
      request.sessionId = requiredStringField(value, "session_id");
      const capabilities = requiredField(value, "capabilities");
      if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
        fail("invalid_request", "capabilities must be an object");
      }
      for (const capability of REQUIRED_CAPABILITIES) {
        if (!Object.hasOwn(capabilities, capability) || capabilities[capability] !== true) {
          fail("host_incompatible", `host lacks required capability: ${capability}`);
        }
      }
      request.capabilities = Object.fromEntries(REQUIRED_CAPABILITIES.map((key) => [key, true]));
      const adapter = optionalField(value, "adapter");
      request.adapter = typeof adapter === "string" ? adapter : "unknown";
      return request;
    }
    case "observe":
      request.resultId = requiredStringField(value, "result_id");
      request.path = requiredStringField(value, "path");
      request.content = decodeUtf8Base64(requiredField(value, "content_utf8_base64"));
      request.range = parseRange(optionalField(value, "range"));
      const turn = optionalField(value, "turn");
      request.turn = turn === undefined ? 0 : requiredSafeInteger(turn, "turn");
      return request;
    case "prepare":
      request.requestId = requiredStringField(value, "request_id");
      request.resultIds = requiredArray(requiredField(value, "result_ids"), "result_ids").map((item) => requiredString(item, "result_ids[]"));
      if (new Set(request.resultIds).size !== request.resultIds.length) {
        fail("invalid_request", "result_ids must not contain duplicates");
      }
      request.budgetBytes = requiredSafeInteger(requiredField(value, "budget_bytes"), "budget_bytes");
      return request;
    case "commit":
      request.planId = requiredStringField(value, "plan_id");
      return request;
    case "recover":
      request.unitId = requiredStringField(value, "unit_id");
      request.revision = requiredStringField(value, "revision");
      if (!/^sha256:[a-f0-9]{64}$/u.test(request.revision)) {
        fail("invalid_request", "revision must be a sha256 revision");
      }
      return request;
    case "status":
      return request;
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
