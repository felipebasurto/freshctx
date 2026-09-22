import { fail } from "./errors.mjs";
import { serveJsonLines } from "./jsonl.mjs";
import { parseRequest, PROTOCOL, response, VERSION } from "./protocol.mjs";
import { FreshCtxSession } from "./session.mjs";
import { openSessionStore } from "./store.mjs";
import { supportedLanguages } from "./treesitter.mjs";
import { openWorkspace } from "./workspace.mjs";

function accepted(id, sessionId, idempotent) {
  return response(id, {
    accepted: true,
    protocol: PROTOCOL,
    version: VERSION,
    session_id: sessionId,
    languages: supportedLanguages,
    idempotent,
  });
}

export async function runServer({ root, input = process.stdin, output = process.stdout }) {
  const workspace = await openWorkspace(root);
  let session = null;
  async function handle(raw) {
    const request = parseRequest(raw);
    if (request.op === "hello") {
      if (session) {
        if (session.sessionId !== request.sessionId) fail("session_active", "this process already serves another session");
        return accepted(request.id, session.sessionId, true);
      }
      const store = await openSessionStore(workspace, request.sessionId);
      session = new FreshCtxSession({ workspace, store, sessionId: request.sessionId });
      return accepted(request.id, request.sessionId, false);
    }
    if (!session) fail("hello_required", "send hello before any other operation");
    return response(request.id, await session[request.op](request));
  }
  try {
    await serveJsonLines({ input, output, handle });
  } finally {
    await session?.store.close();
  }
}
