# How to connect FreshCtx to an agent host

FreshCtx is a local Node.js sidecar. A small bridge in the host talks JSONL to
`freshctx serve --stdio`. The host never imports FreshCtx internals.

This package ships the sidecar only. It does not ship Pi, Hermes, or OpenCode
bridges. Until a bridge exists for your host, installing the CLI does nothing
inside that agent.

## Install the sidecar

You need Node.js 22 or newer.

From this repository:

```sh
cd /path/to/freshctx
npm test
npm link
freshctx doctor
```

When the package is on npm:

```sh
npm install -g freshctx
freshctx doctor
```

`doctor` must print the vendored languages: python, javascript, typescript, tsx,
go, rust.

In each workspace the agent will edit:

```sh
cd /path/to/workspace
freshctx init
```

That creates `.freshctx/` and, when Git metadata lives inside the workspace,
adds `/.freshctx/` only to `.git/info/exclude`. It never edits `.gitignore`.

The bridge starts one child per host session:

```sh
freshctx serve --stdio --root /path/to/workspace
```

`stdout` is JSONL. Diagnostics go to `stderr`. A Node bridge can use
`src/client.mjs` instead of speaking JSONL by hand. Full protocol details are
in [README.md](README.md) and [`schema/freshctx-v1.json`](schema/freshctx-v1.json).

## Wire a bridge

Before the host can use FreshCtx, you need a bridge that spawns the sidecar and
runs the FreshCtx loop. `hello` is rejected unless all four capabilities are
true:

| Capability | Meaning |
| --- | --- |
| `request_rewrite` | Rewrite a copy of the final provider request |
| `stable_result_identity` | Stable native id for each tool result still in that copy |
| `projection_insertion` | Insert one live projection in a valid place in the host format |
| `shared_workspace` | Same filesystem root as `--root` |

Loop:

1. After a successful code read, call `observe` with `result_id`, relative
   `path`, UTF-8 bytes as base64, and an optional byte `range`.
2. Before the model call, call `prepare` with those `result_id`s and
   `budget_bytes`.
3. Verify every `expected_sha256`, replace only those results with the given
   markers, insert the decoded projection, and validate the host request.
4. If any step fails, discard the plan and send the original request.
5. After a successful apply, call `commit`. If the workspace changed, prepare
   again or fail open.

Do not persist the rewritten request. Do not emulate a host that cannot rewrite.

## Find your host

Check whether your host exposes a public request-copy rewrite hook. That hook
lets a bridge replace the assembled provider request without changing the
stored session.

### Hosts with a public request-copy hook

These hosts document request-copy rewrite. This repo does not publish a bridge
for any of them. The load commands below are the host's path once you have a
bridge file.

| Host | Host load command (after bridge exists) | What the bridge uses |
| --- | --- | --- |
| Pi | `pi -e /path/to/your-bridge.ts` | `tool_result` for observe, `context` to replace the request-copy `messages`, optional `before_provider_request`. `toolCallId` is the `result_id`. Extension path: `~/.pi/agent/extensions/` or `.pi/extensions/`. Docs: [Extensions](https://pi.dev/docs/latest/extensions). |
| Oh My Pi | `omp --extension /path/to/your-bridge.ts` | Same extension family as Pi. `context` rewrites the LLM-bound copy, not the session file. Pin a host version in the bridge. |
| Hermes Agent | Set `context.engine: freshctx` in `config.yaml` | Only `select_context()` replaces the per-request message list. `pre_llm_call` only appends. Map OpenAI `tool_call_id` to `result_id`. Fail open with `None`. Only one context engine is active. Docs: [Context Engine plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin). |
| OpenCode | Register a plugin in OpenCode's plugin config | Hook `experimental.chat.messages.transform` rewrites the list sent to the model. Observe reads with `tool.execute.after`. Mutate `output.messages` in place with `splice`. Assigning `output.messages = …` is ignored. The transform API is experimental. |

The bridge spawns `freshctx serve --stdio --root <workspace>`, not the host.

### Hosts without a request-copy hook

These products do not publish a way to replace the assembled provider request.
Hooks that inject `additionalContext`, rewrite a single tool's persisted output,
or block a run are not FreshCtx. MCP cannot remove an old read from a host
transcript.

| Host | Why FreshCtx cannot install |
| --- | --- |
| Cursor | Public hooks inject or gate. No rewrite of the final request copy. |
| Claude Code | Hooks rewrite stored tool output only. No ephemeral request rewrite. |
| Codex CLI | Hooks add developer context only. No message list rewrite. |
| Other closed IDEs and hosted agents | No documented request-copy hook. |

If a vendor later exposes the four capabilities, the install path is the sidecar
plus a new bridge package. That is not a change to this core.

## Verify the session

`freshctx doctor` only checks that the vendored Tree-sitter WASM files load. It
does not open a workspace and it does not talk to a running sidecar.

The live check is `status` after `hello`. `status` never returns source bodies.
A working session shows observations and units increasing after reads, and a
`prepare` plan whose projection decodes to `<freshctx-unit>` frames with current
file bytes.

If the host cannot rewrite the request, `hello` must fail with
`host_incompatible`. Do not hide that behind a fake supported install.
