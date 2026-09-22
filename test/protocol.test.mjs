import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { MAX_JSONL_LINE_BYTES, serveJsonLines } from "../src/jsonl.mjs";
import { decodeUtf8Base64, parseRequest } from "../src/protocol.mjs";
import { runServer } from "../src/server.mjs";
import { capabilities, workspaceFor } from "./helpers.mjs";

function request(id, op, fields = {}) {
  return { protocol: "freshctx/1", id, op, ...fields };
}

function observationFrame(byteLength, id = "cap") {
  const prefix = `{"protocol":"freshctx/1","id":${JSON.stringify(id)},"op":"observe","result_id":"r","path":"a.py","content_utf8_base64":"Zg==","pad":"`;
  const suffix = `"}`;
  const padBytes = byteLength - Buffer.byteLength(prefix + suffix, "utf8");
  assert.ok(padBytes >= 0, "observation frame budget is too small");
  const line = `${prefix}${"x".repeat(padBytes)}${suffix}`;
  assert.equal(Buffer.byteLength(line, "utf8"), byteLength);
  return line;
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

const echo = async (raw) => ({ ok: true, id: raw.id });

function within(promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 1000); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function served(chunks, { maxLineBytes, handle = echo } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({ input, output, maxLineBytes, handle });
  for (const chunk of chunks) {
    input.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  input.end();
  await within(running, "JSONL server hung");
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("JSONL counts raw bytes before trimming, rejects an oversized frame, and keeps serving the next line", async () => {
  const responses = await served([`  {"id":1}  \n{"id":2}\n`], { maxLineBytes: 11 });
  assert.equal(responses.length, 2);
  assert.equal(responses[0].error.code, "request_too_large");
  assert.deepEqual(responses[1], { ok: true, id: 2 });
});

test("JSONL counts raw bytes before trimming at EOF", async () => {
  const responses = await served(['  {"id":1}  '], { maxLineBytes: 8 });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, "request_too_large");
});

test("JSONL discards an oversized partial line until the next newline without hanging", async () => {
  const responses = await served(["x".repeat(32), 'garbage\n{"id":"kept"}\n'], { maxLineBytes: 16 });
  assert.equal(responses.length, 2);
  assert.equal(responses[0].error.code, "request_too_large");
  assert.deepEqual(responses[1], { ok: true, id: "kept" });
});

test("JSONL accepts a valid observation frame at the maximum size", async () => {
  const responses = await served([`${observationFrame(MAX_JSONL_LINE_BYTES)}\n`], {
    handle: async (raw) => ({ ok: true, id: raw.id, op: raw.op }),
  });
  assert.deepEqual(responses, [{ ok: true, id: "cap", op: "observe" }]);
});

test("JSONL handles multiple frames in one chunk", async () => {
  const responses = await served(['{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n']);
  assert.deepEqual(responses, ["a", "b", "c"].map((id) => ({ ok: true, id })));
});

test("JSONL waits for output drain before writing the next frame", async () => {
  let released;
  const firstAck = new Promise((resolve) => { released = resolve; });
  let sawFirst;
  const firstWrite = new Promise((resolve) => { sawFirst = resolve; });
  const chunks = [];
  const output = new Writable({
    highWaterMark: 8,
    write(chunk, encoding, callback) {
      chunks.push(String(chunk));
      if (chunks.length === 1) {
        sawFirst();
        firstAck.then(() => callback());
        return;
      }
      callback();
    },
  });
  const input = new PassThrough();
  const running = serveJsonLines({
    input,
    output,
    handle: async (raw) => ({ ok: true, id: raw.id, pad: "n".repeat(32) }),
  });
  input.write('{"id":"one"}\n{"id":"two"}\n');
  input.end();
  await firstWrite;
  assert.equal(chunks.length, 1);
  released();
  await running;
  assert.deepEqual(chunks.map((chunk) => JSON.parse(chunk).id), ["one", "two"]);
});

test("JSONL write waiting for drain terminates when the output closes", async () => {
  let firstCallback;
  const output = new Writable({
    highWaterMark: 8,
    write(chunk, encoding, callback) {
      if (!firstCallback) {
        firstCallback = callback;
        return;
      }
      callback();
    },
  });
  const input = new PassThrough();
  const running = serveJsonLines({
    input,
    output,
    handle: async (raw) => ({ ok: true, id: raw.id, pad: "n".repeat(32) }),
  });
  input.write('{"id":"one"}\n{"id":"two"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  output.destroy();
  input.end();
  await within(running, "drain wait hung after output close");
});
