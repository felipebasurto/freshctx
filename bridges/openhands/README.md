# OpenHands integration prototype

This directory contains Node and Python clients for FreshCtx and an LLM-call
wrapper intended for OpenHands. Tests exercise Chat Completions-shaped request
fixtures. **They do not instantiate a pinned OpenHands agent or its real
summarizing condenser.** Actual host integration remains to be validated.

The intended order is: build and condense the host's message copy, rewrite it
with FreshCtx, then dispatch it. Saved events remain unchanged. A source fact
inside a condenser summary is not refreshed; observations absent from the
outgoing copy are inactive until read again.

## Run the fixtures

From the product checkout:

```sh
npm ci --prefix bridges/openhands
npm run check --prefix bridges/openhands
npm test --prefix bridges/openhands
npm run demo --prefix bridges/openhands
```

No model credentials are needed. The package depends on the local product at
`file:../..`; npm publication is disabled.

## Integrate a host

The Node `Bridge.read` reader returns exact UTF-8 source bytes with native
result IDs. Python exposes `Bridge.observe`; its host must supply the exact
text and byte range returned by its own reader.
Numbered editor output is not an exact source observation. After the host has
built its outgoing messages, call `Bridge.rewrite` or install the Python
`wrap_llm` wrapper on an object exposing `completion` / `async_completion`.
The wrapper's placement after condensation is a host integration responsibility,
not something the wrapper can establish by itself.

```python
from freshctx_openhands import Bridge, config_from_env, wrap_llm

cfg = config_from_env()
bridge = Bridge(
    root=cfg["root"],
    session_id=cfg["session_id"] or conversation_id,
    budget_bytes=cfg["budget_bytes"],
    timeout_ms=cfg["timeout_ms"],
    enabled=cfg["enabled"],
)
wrap_llm(agent.llm, bridge)
# After each successful exact read, register its result with bridge.observe(...).
# Close bridge when the conversation ends.
```

The host must check coverage of successful source reads: unknown tool results
are allowed for unrelated tools, and this generic bridge cannot infer every
OpenHands source-reading tool. Do not resume an old conversation after losing
FreshCtx state and assume that its original source results have been refreshed.
See the complete [integration contract](../../docs/protocol.md).

## Configuration

| Variable | Meaning |
| --- | --- |
| `FRESHCTX_ENABLED` | `0` or `false` selects pass-through; otherwise enabled. |
| `FRESHCTX_ROOT` | Workspace shared with the sidecar. |
| `FRESHCTX_SESSION_ID` | Stable host conversation ID. |
| `FRESHCTX_BUDGET_BYTES` | Projection byte budget; default 131072. |
| `FRESHCTX_TIMEOUT_MS` | Child request deadline; default 10000 ms. |
| `FRESHCTX_FALL_OPEN` | Enabling it is rejected. |

`FRESHCTX_AUDIT` is parsed for callers; it does not enable logging by itself.
Python accepts `on_audit`, reporting compose order, enabled state, and whether
a projection was inserted. Detailed stale/current/unread presence checks belong
to the demo fixture, not the bridge.

The Node reader accepts `offset` / `limit` or `view_range: [start, end]`, with `-1`
meaning EOF. It defaults to 200 lines and rejects symlinks, traversal,
non-UTF-8 input, and files larger than 512 KiB. A declaration read can widen
to its whole function; fallback resolution can widen to a whole file.

A rejected plan raises and must cancel dispatch. Python deadlines cover lock
acquisition, writing, and reading; timeout stops the child and invalidates the
client so a late response cannot satisfy a later call. The asynchronous wrapper
performs sidecar work in a worker thread. Commit detects changed selected files,
but does not hold a workspace lock through the provider call.

The paired demo changes a header constant from 10 to 20 and inspects the final
request. A separate simulated condensation arm shows that summary text stays
stale. Neither fixture measures model accuracy, cost, or real condenser behavior.
