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

test("JSONL rejects an oversized frame and keeps serving the next line", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    maxLineBytes: 32,
    handle: async (raw) => ({ ok: true, id: raw.id }),
  });
  input.write(`${"x".repeat(64)}\n`);
  input.write('{"id":"ok"}\n');
  input.end();
  await running;
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses[0].error.code, "request_too_large");
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].id, "ok");
});

test("JSONL discards an oversized partial line until the next newline", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    maxLineBytes: 16,
    handle: async (raw) => ({ ok: true, id: raw.id }),
  });
  input.write("x".repeat(32));
  await new Promise((resolve) => setImmediate(resolve));
  input.write('garbage\n{"id":"kept"}\n');
  input.end();
  await running;
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses[0].error.code, "request_too_large");
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].id, "kept");
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
  assert.equal(chunks.length, 2);
  assert.equal(JSON.parse(chunks[0]).id, "one");
  assert.equal(JSON.parse(chunks[1]).id, "two");
});

test("JSONL accepts a valid observation frame at the maximum size", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    handle: async (raw) => ({ ok: true, id: raw.id, op: raw.op }),
  });
  input.end(`${observationFrame(MAX_JSONL_LINE_BYTES)}\n`);
  await running;
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].id, "cap");
  assert.equal(responses[0].op, "observe");
});

test("JSONL fails an oversized partial line without hanging and still serves the next line", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    maxLineBytes: 16,
    handle: async (raw) => ({ ok: true, id: raw.id }),
  });
  input.write("x".repeat(32));
  await new Promise((resolve) => setImmediate(resolve));
  input.write('\n{"id":"ok"}\n');
  input.end();
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error("oversized partial line hung")), 1000)),
  ]);
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses[0].error.code, "request_too_large");
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].id, "ok");
});

test("JSONL handles multiple frames in one chunk", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    handle: async (raw) => ({ ok: true, id: raw.id }),
  });
  input.end('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
  await running;
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((item) => item.id), ["a", "b", "c"]);
  assert.ok(responses.every((item) => item.ok === true));
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
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error("drain wait hung after output close")), 1000)),
  ]);
});

test("JSONL counts raw UTF-8 bytes before trimming whitespace on the newline path", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    maxLineBytes: 11,
    handle: async (raw) => ({ ok: true, id: raw.id }),
  });
  input.write(`  {"id":1}  \n{"id":2}\n`);
  input.end();
  await running;
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses[0].error.code, "request_too_large");
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].id, 2);
});

test("JSONL counts raw UTF-8 bytes before trimming whitespace on the EOF path", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { body += chunk; });
  const running = serveJsonLines({
    input,
    output,
    maxLineBytes: 8,
    handle: async (raw) => ({ ok: true, id: raw.id }),
  });
  input.end("  {\"id\":1}  ");
  await running;
  const responses = body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, "request_too_large");
});
