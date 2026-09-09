# How to connect FreshCtx to an agent host

FreshCtx is a local Node sidecar. A bridge in the host talks JSONL to
`freshctx serve --stdio`. The host never imports FreshCtx internals.

This repo ships the sidecar plus [Pi](bridges/pi) and
[OpenHands](bridges/openhands) bridges. It does not ship Hermes, Oh My Pi, or
OpenCode. Install: `npm install -g .` from this checkout (not npm).

`hello` requires all four capabilities:

| Capability | Meaning |
| --- | --- |
| `request_rewrite` | Rewrite a copy of the final provider request |
| `stable_result_identity` | Stable native id for each tool result still in that copy |
| `projection_insertion` | Insert one live projection in a valid host slot |
| `shared_workspace` | Same filesystem root as `--root` |

Loop: `observe` after each exact code read → `prepare` before the model call
→ verify hashes and rewrite a copy → `commit` → send. If any step fails,
**discard the plan and cancel dispatch**. Do not send the original request.
Do not persist the rewritten copy into session history.

## Hosts with a request-copy hook

| Host | Load | Notes |
| --- | --- | --- |
| Pi | `pi -e /path/to/freshctx/bridges/pi/extension.js` | [bridges/pi](bridges/pi). `toolCallId` is `result_id`. `openai-completions` only. |
| OpenHands | [bridges/openhands](bridges/openhands) | Rewrites the already-condensed copy (`condense_then_freshctx`). |
| Oh My Pi | `omp --extension …` | Same family as Pi. No bridge in this repo. |
| Hermes | `context.engine` in `config.yaml` | `select_context()` only. No bridge in this repo. |
| OpenCode | plugin `experimental.chat.messages.transform` | Mutate `output.messages` in place. No bridge in this repo. |

## Hosts without a request-copy hook

Inject, gate, rewrite stored tool output, or MCP: not FreshCtx.

| Host | Why not |
| --- | --- |
| Cursor | Inject/gate only |
| Claude Code | Stored tool output only |
| Codex CLI | Extra developer context only |

`freshctx doctor` only checks Tree-sitter WASM. The live check is `status`
after `hello`.
