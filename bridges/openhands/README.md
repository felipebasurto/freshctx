# FreshCtx for OpenHands

Rewrites the already-condensed Chat Completions-shaped copy so
[OpenHands](https://docs.openhands.dev/) can run with versus without FreshCtx.
Compose order: `condense_then_freshctx`. Condenser summaries are not refreshed.
Saved events are not rewritten. This package does not pin OpenHands.

```sh
npm ci --prefix bridges/openhands
npm test --prefix bridges/openhands
npm run demo --prefix bridges/openhands
```

| Flag | Meaning |
| --- | --- |
| `FRESHCTX_ENABLED` | `0`/`false` = pass-through. Otherwise on. |
| `FRESHCTX_ROOT` | Workspace root (`freshctx serve --root`). |
| `FRESHCTX_SESSION_ID` | Stable conversation id. |
| `FRESHCTX_BUDGET_BYTES` | Projection budget. Default `131072`. |
| `FRESHCTX_TIMEOUT_MS` | Child timeout. Default `10000`. |
| `FRESHCTX_FALL_OPEN` | Rejected. A failed plan must cancel dispatch. |

```python
from freshctx_openhands import Bridge, config_from_env, wrap_llm

cfg = config_from_env()
bridge = Bridge(
    root=cfg["root"],
    session_id=cfg["session_id"] or conversation_id,
    budget_bytes=cfg["budget_bytes"],
    enabled=cfg["enabled"],
)
wrap_llm(agent.llm, bridge)  # after condensation
```

If prepare, hash check, or commit fails, `wrap_llm` raises. Do not send the
original request.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
