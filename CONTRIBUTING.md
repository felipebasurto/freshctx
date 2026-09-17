# Contributing

FreshCtx is a research prototype. Start with the [request-copy example](examples/request-copy.mjs)
and [protocol](docs/protocol.md), then reproduce a concrete failure or identify
a falsifiable improvement. Keep public claims proportional to the evidence.

## Source map

| Area | Files |
| --- | --- |
| CLI and JSONL | `bin/freshctx.mjs`, `src/cli.mjs`, `src/jsonl.mjs`, `src/server.mjs` |
| Request validation | `src/protocol.mjs`, `schema/freshctx-v1.json` |
| Observation, refresh, plans | `src/session.mjs` |
| Parsing and region tracking | `src/treesitter.mjs`, `src/relocate.mjs` |
| Selection and projection | `src/projection.mjs` |
| Workspace and revision archive | `src/workspace.mjs`, `src/store.mjs`, `src/hash.mjs` |
| Host integrations | `bridges/pi`, `bridges/openhands` |

The wire protocol is the main integration boundary. Only `freshctx/hash` and
`freshctx/workspace` have package exports for the maintained bridges. Other
modules are implementation details, not a stable external API.

## Validate a change

Core work requires Node 22+ and no dependency install:

```sh
npm run check
npm test
npm run pack:check
```

`check` syntax-checks each maintained JavaScript file in the core, tests,
scripts, and example. `pack:check` verifies the allowlist and vendored asset
hashes, then exercises the extracted tarball. Keep it strict.

For each changed bridge, also run its own `npm ci`, `npm run check`, and
`npm test` with `--prefix bridges/pi` or `--prefix bridges/openhands`. Pi needs
Node 22.19+ and loopback access. OpenHands needs Python (CI uses 3.12). On a
restricted macOS environment, set `PYTHONPYCACHEPREFIX` to a writable temporary
path if the system Python cache is outside the sandbox.

Add a regression when changing correctness behavior. Assert which bytes and
identities may reach the outgoing request, and cancellation before dispatch
where appropriate. A test that merely accepts any resolved or omitted result
cannot establish correct region identity. Include restart/migration coverage
when changing persisted state.

## Research and publication

Keep experiments in `freshctx-bench` and `freshctx-research`. Do not copy their
runners or raw transcripts into the product package. Do not edit frozen results
to make new changes look better. Before reporting a comparison, record the
implementation commit, executable, host/model pins, frozen task/checker hashes,
arm order, attempt limits, and original outcomes including failures.

Local protocol and HTTP fixtures use no LLM. Payload bytes, model tokens,
cached tokens, provider usage, elapsed time, and checker success are separate
measurements. New paid provider calls and publication require Felipe's explicit
authorization under [AGENTS.md](AGENTS.md).

Report security issues through [SECURITY.md](SECURITY.md).
