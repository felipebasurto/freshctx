# FreshCtx

A local context engine for coding agents. Source is mutable state, not
conversation history. FreshCtx keeps a working set of what the host
actually read, then injects one current view of that code before the
model call.

It is not a plugin. There is no installer for Pi, OpenHands, Cursor, or
anything else. If you want it, speak JSONL to a child process. Hosts that
cannot rewrite a copy of the outgoing request cannot use this.

```sh
node bin/freshctx.mjs doctor
node bin/freshctx.mjs init --root /path/to/workspace
node bin/freshctx.mjs serve --stdio --root /path/to/workspace
```

`stdout` is protocol. Diagnostics go to stderr. Schema:
[`schema/freshctx-v1.json`](schema/freshctx-v1.json).

`hello` → `observe` (exact UTF-8 bytes, optional byte range) → `prepare`
(budgeted live projection) → rewrite a copy of the request → `commit` →
send. If any step fails, drop the plan. Do not send the original request.

`init` writes `.freshctx/` (Git exclude only, never `.gitignore`). `clean`
deletes the archive. See [SECURITY.md](SECURITY.md).

Node 22+. `npm run check && npm test && npm run pack:check`.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
