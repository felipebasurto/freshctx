import { fail } from "./errors.mjs";
import { serveJsonLines } from "./jsonl.mjs";
import { parseRequest, response, VERSION } from "./protocol.mjs";
import { FreshCtxSession } from "./session.mjs";
import { openSessionStore } from "./store.mjs";
import { supportedLanguages } from "./treesitter.mjs";
import { openWorkspace } from "./workspace.mjs";

export async function runServer({ root, input = process.stdin, output = process.stdout }) {
  const workspace = await openWorkspace(root);
  let session = null;
  let store = null;
  async function handle(raw) {
    const request = parseRequest(raw);
    if (request.op === "hello") {
      if (session) {
        if (session.sessionId !== request.sessionId) fail("session_active", "this process already serves another session");
        return response(request.id, {
          accepted: true,
          protocol: "freshctx/1",
          version: VERSION,
          session_id: session.sessionId,
          languages: supportedLanguages,
          idempotent: true,
        });
      }
      store = await openSessionStore(workspace, request.sessionId);
      session = new FreshCtxSession({ workspace, store, sessionId: request.sessionId, adapter: request.adapter });
      return response(request.id, {
        accepted: true,
        protocol: "freshctx/1",
        version: VERSION,
        session_id: request.sessionId,
        languages: supportedLanguages,
        idempotent: false,
      });
    }
    if (!session) fail("hello_required", "send hello before any other operation");
    switch (request.op) {
      case "observe":
        return response(request.id, await session.observe(request));
      case "prepare":
        return response(request.id, await session.prepare(request));
      case "commit":
        return response(request.id, await session.commit(request));
      case "recover":
        return response(request.id, await session.recover(request));
      case "status":
        return response(request.id, await session.status());
      default:
        fail("unknown_operation", `unknown operation: ${request.op}`);
    }
  }
  try {
    await serveJsonLines({ input, output, handle });
  } finally {
    await store?.close();
  }
}
