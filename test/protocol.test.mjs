import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { decodeUtf8Base64, parseRequest } from "../src/protocol.mjs";
import { runServer } from "../src/server.mjs";
import { capabilities, workspaceFor } from "./helpers.mjs";

function request(id, op, fields = {}) {
  return { protocol: "freshctx/1", id, op, ...fields };
}

async function transcript(root, messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = runServer({ root, input, output });
  input.end(messages.map((message) => typeof message === "string" ? message : JSON.stringify(message)).join("\n").concat("\n"));
  await running;
  return body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("JSONL rejects invalid JSON and hosts without every required hook", async (t) => {
  const root = await workspaceFor(t);
  const responses = await transcript(root, [
    "{broken",
    request("bad-host", "hello", {
      session_id: "s",
      capabilities: { ...capabilities, shared_workspace: false },
    }),
  ]);
  assert.equal(responses[0].error.code, "invalid_json");
  assert.equal(responses[1].error.code, "host_incompatible");
});

test("every operation other than hello requires an established session", async (t) => {
  const root = await workspaceFor(t);
  const responses = await transcript(root, [request("status", "status"), request("unknown", "nope")]);
  assert.equal(responses[0].error.code, "hello_required");
  assert.equal(responses[1].error.code, "unknown_operation");
});

test("hello is idempotent and status exposes no code bodies", async (t) => {
  const root = await workspaceFor(t);
  const hello = request("hello", "hello", { session_id: "s", capabilities });
  const responses = await transcript(root, [hello, { ...hello, id: "again" }, request("status", "status")]);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].result.idempotent, true);
  assert.equal(responses[2].result.healthy, true);
  assert.equal(responses[2].result.version, "0.1.0");
  assert.equal(JSON.stringify(responses[2]).includes("content_utf8_base64"), false);
});

test("reserved JavaScript property names are valid host identities, never inherited fields", () => {
  const parsed = parseRequest(request("__proto__", "prepare", {
    request_id: "constructor",
    result_ids: ["toString", "__proto__", "constructor"],
    budget_bytes: 0,
  }));
  assert.equal(parsed.id, "__proto__");
  assert.equal(parsed.requestId, "constructor");
  assert.deepEqual(parsed.resultIds, ["toString", "__proto__", "constructor"]);

  const inheritedCapabilities = Object.create(capabilities);
  assert.throws(() => parseRequest(request("hello", "hello", {
    session_id: "s",
    capabilities: inheritedCapabilities,
  })), (error) => error.code === "host_incompatible");

  const inheritedRequest = Object.create(request("inherited", "status"));
  assert.throws(() => parseRequest(inheritedRequest), (error) => error.code === "unsupported_protocol");
});

test("base64 decoding accepts empty and URL-safe UTF-8 without stripping a BOM", () => {
  const empty = decodeUtf8Base64("");
  assert.equal(empty.text, "");
  assert.equal(empty.bytes.length, 0);

  const bomSource = "\uFEFFdef top():\n    return 'é'\n";
  const base64Url = Buffer.from(bomSource, "utf8").toString("base64url");
  const decoded = decodeUtf8Base64(base64Url);
  assert.equal(decoded.text, bomSource);
  assert.deepEqual(decoded.bytes, Buffer.from(bomSource, "utf8"));
});
