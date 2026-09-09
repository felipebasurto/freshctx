# FreshCtx for OpenHands

Request-rewriting bridge so [OpenHands](https://docs.openhands.dev/) can run
the same model and tools with versus without FreshCtx. It speaks `freshctx/1`
to a persistent local child, observes exact workspace UTF-8 reads, and
transforms a copy of the final Chat Completions-shaped message list.

OpenHands is the preferred live harness: a real agent plus
`LLMSummarizingCondenser`. This package does not pin or vendor OpenHands.
Scores, SWE-bench matrices, and dollar figures belong in a separate private
bench repository, not here.

## Compose order

`condense_then_freshctx`:

1. OpenHands builds native history and runs `LLMSummarizingCondenser` on the
   event view (`View.from_events()` then `events_to_messages()`).
2. FreshCtx rewrites only that already-condensed **model-bound copy**.
3. Still-present observed tool results become markers. One current projection
   is appended as a final user message.
4. Forgotten observations stay inactive until the host reads them again.
   Condenser summaries are not refreshed.

The projection is inserted after condensation so it is eligible and is not
summarized away. Saved OpenHands events are not rewritten. Tree-sitter stays
on in the sidecar; this bridge does not replace it.

Do not run another final-request rewriter after this one. Do not persist the
rewritten copy back into the event log.

## Checkout setup

npm publication is disabled. From the product checkout:

```sh
npm ci --prefix bridges/openhands
npm run check --prefix bridges/openhands
npm test --prefix bridges/openhands
npm run demo --prefix bridges/openhands
python3 bridges/openhands/test/test_hook.py
```

The bridge depends on the product at `file:../..`. The root package stays
independent of OpenHands. HTTP and LLM credentials are not required.

## Config flags

| Flag | Meaning |
| --- | --- |
| `FRESHCTX_ENABLED` | `0`/`false` is the without arm (pass-through). Unset or any other value enables FreshCtx. |
| `FRESHCTX_ROOT` | Workspace root shared with `freshctx serve --stdio --root`. |
| `FRESHCTX_SESSION_ID` | Stable OpenHands conversation / session id. |
| `FRESHCTX_BUDGET_BYTES` | Projection budget. Default `131072`. |
| `FRESHCTX_TIMEOUT_MS` | JSONL child timeout. Default `10000`. |
| `FRESHCTX_AUDIT` | When `1`, emit stale-versus-current audit records. |
| `FRESHCTX_FALL_OPEN` | Rejected. A failed plan must cancel dispatch. |

CLI contract is the product sidecar: `freshctx init`, `freshctx serve --stdio`,
`freshctx clean`. `stdout` is JSONL; diagnostics go to `stderr`.

## Wire OpenHands

Use the exact-byte reader this bridge exposes, not a numbered `cat -n` dump.
Stock FileEditor `view` output is not an observation unless it is re-emitted
as the exact UTF-8 range.

```python
from freshctx_openhands import Bridge, config_from_env, wrap_llm

cfg = config_from_env()
bridge = Bridge(
    root=cfg["root"],
    session_id=cfg["session_id"] or conversation_id,
    budget_bytes=cfg["budget_bytes"],
    enabled=cfg["enabled"],
)
# After a successful exact file read, and after the condenser built messages:
wrap_llm(agent.llm, bridge)
```

`wrap_llm` intercepts `completion` / `async_completion` **after** condensation.
If prepare, hash check, or commit fails, it raises and must not send the
original request. That is not Hermes-style fall-open.

Node hosts can call `Bridge.read` / `Bridge.rewrite` directly on a
`{ messages }` payload. `read` accepts Pi-style `offset`/`limit` or OpenHands
`view_range: [start, end]` (`end: -1` means EOF).

## Audit hooks

`Bridge` accepts `onAudit`. Each rewrite reports:

- `compose_order` (`condense_then_freshctx`)
- `enabled`
- `original` / `rewritten` presence of caller-supplied `stale`, `current`, and
  `unread` snippets
- `historical_results_replaced`
- `projection_inserted`
- `forgotten_result_ids` when the condensed copy still carries them

`npm run demo` and `npm test` run a paired with/without fixture: a two-line
header read, then `RATE` changes from 10 to 20. Without FreshCtx the model-bound
request still contains `RATE = 10`. With FreshCtx it contains current
`RATE = 20` and not the unread function. A second demo arm condenses the
historical read into a summary; the summary stays stale until a new exact read.

This is request-level evidence, not model accuracy, Pass@1, or a cost claim.

## Boundaries and failure behavior

- Only exact UTF-8 workspace reads this bridge observed are refreshed.
  Bash, grep, numbered dumps, user quotes, assistant text, and condenser
  summaries are not refreshed.
- Reads default to 200 lines. They preserve UTF-8 byte offsets and internal
  CRLFs, excluding terminal line separators. Symlinks, paths outside the
  workspace, non-UTF-8 files, images, and files over 512 KiB fail closed.
- A header read stays a region. Unread functions are omitted and are not
  evidence of absence. Unique functions and methods use Tree-sitter identity.
- The live projection has a 128 KiB budget unless overridden. Omitted or
  deleted code gets an unavailable marker. Old bodies are never substituted
  as current code.
- Native tool IDs and replacement hashes must match. The projection hash is
  checked, the copy is prepared atomically, and commit rechecks disk before
  the rewritten request may be sent. Sending the original request after a
  rejected plan can leak stale code.
- Resume uses the host session id and FreshCtx persisted observations.

## Product PCR pointer

Product PCR `openhands-0001` (2026-09-05): first OpenHands request-rewriting
host under `bridges/openhands`. Compose order is `condense_then_freshctx`.
Fail-closed.

Living-suite PCR numbers stay in a separate private research repository.
Do not copy those labs into this package.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
