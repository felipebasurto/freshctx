import { publicError } from "./errors.mjs";
import { failure } from "./protocol.mjs";
import { StringDecoder } from "node:string_decoder";

export async function serveJsonLines({ input, output, handle }) {
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  for await (const chunk of input) {
    buffered += decoder.write(chunk);
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      await writeResponse(line, output, handle);
    }
  }
  buffered += decoder.end();
  if (buffered.trim().length > 0) await writeResponse(buffered.trim(), output, handle);
}

async function writeResponse(line, output, handle) {
  let request;
  try {
    try {
      request = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(failure(null, { code: "invalid_json", message: "JSONL line is not valid JSON" }))}\n`);
      return;
    }
    const result = await handle(request);
    output.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const id = request && typeof request === "object" ? request.id : null;
    output.write(`${JSON.stringify(failure(id, publicError(error)))}\n`);
  }
}
