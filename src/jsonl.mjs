import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

import { publicError } from "./errors.mjs";
import { failure } from "./protocol.mjs";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;

const TOO_LARGE = Object.freeze({
  code: "request_too_large",
  message: "JSONL line exceeds the maximum frame size",
});

const INVALID_JSON = Object.freeze({
  code: "invalid_json",
  message: "JSONL line is not valid JSON",
});

async function writeFrame(output, value) {
  if (output.write(`${JSON.stringify(value)}\n`) || !output.writable || output.destroyed) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  output.once("close", abort);
  output.once("finish", abort);
  try {
    await once(output, "drain", { signal: controller.signal });
  } catch {
  } finally {
    output.off("close", abort);
    output.off("finish", abort);
  }
}

async function writeResponse(line, output, handle) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    await writeFrame(output, failure(null, INVALID_JSON));
    return;
  }
  try {
    await writeFrame(output, await handle(request));
  } catch (error) {
    await writeFrame(output, failure(request?.id, publicError(error)));
  }
}

export async function serveJsonLines({ input, output, handle, maxLineBytes = MAX_JSONL_LINE_BYTES }) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let discarding = false;

  const dispatch = async (raw) => {
    if (Buffer.byteLength(raw, "utf8") > maxLineBytes) {
      await writeFrame(output, failure(null, TOO_LARGE));
      return;
    }
    const line = raw.trim();
    if (line.length > 0) await writeResponse(line, output, handle);
  };

  const take = async (text) => {
    if (discarding) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      discarding = false;
      buffered = text.slice(newline + 1);
    } else {
      buffered += text;
    }
    let start = 0;
    for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n", start)) {
      const raw = buffered.slice(start, newline);
      start = newline + 1;
      await dispatch(raw);
    }
    buffered = buffered.slice(start);
    if (Buffer.byteLength(buffered, "utf8") > maxLineBytes) {
      await writeFrame(output, failure(null, TOO_LARGE));
      discarding = true;
      buffered = "";
    }
  };

  for await (const chunk of input) {
    await take(decoder.write(chunk));
  }
  await take(decoder.end());
  if (!discarding && buffered.length > 0) await dispatch(buffered);
}
