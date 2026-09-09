# FreshCtx

Local sidecar that keeps coding-agent context current. The host records
what it read; FreshCtx replaces those snapshots with one live view of
workspace code right before the model call.

It does not know about models, providers, or agents. A small **bridge** in
the host talks JSONL to `freshctx serve --stdio`. Without a bridge, the CLI
does nothing inside the agent.

npm is unpublished (`private: true`). Install from this checkout.

```sh
git clone https://github.com/felipebasurto/freshctx.git
cd freshctx
npm install
npm install -g .
freshctx doctor
```

`doctor` must list python, javascript, typescript, tsx, go, rust.

```sh
cd /path/to/workspace
freshctx init
freshctx serve --stdio --root /path/to/workspace
```

`stdout` is JSONL. Diagnostics go to stderr. `init` creates `.freshctx/`
and, when the workspace is a Git repo, adds `/.freshctx/` to
`.git/info/exclude` only. It never edits `.gitignore`. `freshctx clean`
deletes the archive. A leftover `.freshctx/` without this process's config
is rejected (`state_unsafe`); remove it and run `init` again.

## Use it

| Host | How |
| --- | --- |
| [Pi](https://github.com/earendil-works/pi) 0.85.0 | `pi -e /path/to/freshctx/bridges/pi/extension.js` with an `openai-completions` model. Details: [bridges/pi](bridges/pi). |
| [OpenHands](https://docs.openhands.dev/) | Rewrite the condensed Chat Completions copy. Details: [bridges/openhands](bridges/openhands). |
| Cursor, Claude Code, Codex CLI | No request-copy hook. FreshCtx will not fake support. |

Which hosts can grow a bridge: [HARNESSES.md](HARNESSES.md).

## Protocol

Schema: [`schema/freshctx-v1.json`](schema/freshctx-v1.json). One JSON object
per line, `protocol: "freshctx/1"`.

1. `hello` with the four capabilities (`request_rewrite`,
   `stable_result_identity`, `projection_insertion`, `shared_workspace`).
2. After each exact code read: `observe` (`result_id`, relative `path`,
   UTF-8 bytes as base64, optional byte `range`).
3. Before the model call: `prepare` with those ids and `budget_bytes`.
4. Verify hashes, replace those results with markers in a **copy** of the
   request, insert the projection. On any failure, **discard the plan and
   cancel dispatch**. Sending the original request leaks stale code.
5. `commit` before send. If the workspace changed, the plan is stale.

`recover` returns archived bytes by unit and revision. `status` is health
only; it never returns source.

Unread code is omitted and is not evidence of absence. Compaction summaries
are not refreshed. Edits after `commit` are possible.

## Limits

- Files: relative, regular, UTF-8, under `--root`, no symlinks, ≤512 KiB.
- Languages with Tree-sitter symbols: Python, JS, TS, TSX, Go, Rust.
  Other files sync as whole files when they can be read safely.
- Pi: Chat Completions only. OpenAI Responses and other APIs are out.
- Historical source lives in `.freshctx/` until `clean`. See [SECURITY.md](SECURITY.md).

## Develop

Node 22+. `npm run check && npm test && npm run pack:check`. Hosts:
`npm run verify -- --setup` once, then `npm run verify`. No provider keys;
HTTP fixtures use loopback.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
