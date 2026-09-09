import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

import { publicError } from "./errors.mjs";
import { failure } from "./protocol.mjs";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;

const TOO_LARGE = Object.freeze({
  code: "request_too_large",
  message: "JSONL line exceeds the maximum frame size",
});

async function waitForDrain(output) {
  if (!output.writableNeedDrain) return;
  if (!output.writable || output.destroyed) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  output.once("close", abort);
  output.once("finish", abort);
  output.once("error", abort);
  try {
    await once(output, "drain", { signal: controller.signal });
  } catch {
    // close, finish, or error must end the wait instead of hanging on drain
  } finally {
    output.off("close", abort);
    output.off("finish", abort);
    output.off("error", abort);
  }
}

async function writeFrame(output, value) {
  const payload = `${JSON.stringify(value)}\n`;
  if (output.write(payload)) return;
  if (!output.writable || output.destroyed) return;
  await waitForDrain(output);
}

async function writeResponse(line, output, handle) {
  let request;
  try {
    try {
      request = JSON.parse(line);
    } catch {
      await writeFrame(output, failure(null, { code: "invalid_json", message: "JSONL line is not valid JSON" }));
      return;
    }
    const result = await handle(request);
    await writeFrame(output, result);
  } catch (error) {
    const id = request && typeof request === "object" ? request.id : null;
    await writeFrame(output, failure(id, publicError(error)));
  }
}

export async function serveJsonLines({ input, output, handle, maxLineBytes = MAX_JSONL_LINE_BYTES }) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let discarding = false;

  const emitTooLarge = () => writeFrame(output, failure(null, TOO_LARGE));

  const take = async (text) => {
    if (discarding) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      discarding = false;
      buffered = text.slice(newline + 1);
    } else {
      buffered += text;
    }
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        await emitTooLarge();
        continue;
      }
      await writeResponse(line, output, handle);
    }
    if (discarding || buffered.includes("\n")) return;
    if (Buffer.byteLength(buffered, "utf8") <= maxLineBytes) return;
    await emitTooLarge();
    discarding = true;
    buffered = "";
  };

  for await (const chunk of input) {
    await take(decoder.write(chunk));
  }
  const tail = decoder.end();
  if (tail) await take(tail);
  if (discarding || buffered.trim().length === 0) return;
  if (Buffer.byteLength(buffered.trim(), "utf8") > maxLineBytes) {
    await emitTooLarge();
    return;
  }
  await writeResponse(buffered.trim(), output, handle);
}
