# FreshCtx

A local context engine for coding agents. Source is mutable state, not
conversation history. FreshCtx keeps a working set of what the host
actually read, then returns one current view of that code to inject before
the model call.

It is not a chat and not a plugin. If you cannot rewrite a copy of the
outgoing model request, you cannot use this.

## Try it

Node 22+.

```sh
git clone https://github.com/felipebasurto/freshctx.git
cd freshctx
node bin/freshctx.mjs doctor
```

You should see `"healthy": true`. That is the engine starting.

```sh
node bin/freshctx.mjs init --root /path/to/workspace
node bin/freshctx.mjs serve --stdio --root /path/to/workspace
```

`stdout` is JSONL. Diagnostics go to stderr. Shapes:
[`schema/freshctx-v1.json`](schema/freshctx-v1.json).

The wiring is yours. After each workspace read, send `observe`. Before the
model call, `prepare`. In a copy of the request, replace the old source
with the returned `marker`, insert the projection, `commit`, then send.
If any step fails, drop the plan. Do not send the original request.

`init` writes `.freshctx/` (Git exclude only, never `.gitignore`). `clean`
deletes the archive. See [SECURITY.md](SECURITY.md).

`npm run check && npm test && npm run pack:check`.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
