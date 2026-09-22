# FreshCtx

FreshCtx is a research prototype for keeping a coding agent's observed source
code current. It runs as a local Node.js process. Before a model request, a
host bridge replaces old file-read results in a copy of the conversation with
markers and adds a budgeted view of current workspace code.

The saved conversation stays intact. The engine handles file snapshots, code
units, revision storage, and selection; the bridge handles the host's tools
and outgoing request format. Freshness checks do not establish better model
outcomes. Measurements and the live-run records are in
[freshctx-research](https://github.com/felipebasurto/freshctx-research).

npm publication is disabled. This checkout is prepared under the
[development policy](AGENTS.md); no registry install is required.

## Run the example

Requires Node.js 22+. From a checkout:

```sh
node bin/freshctx.mjs doctor
npm run demo
```

`doctor` loads the six vendored language parsers. It does not test an agent
integration. The example starts the real sidecar, observes a function, changes
it on disk, verifies the replacement hashes, and commits the rewritten request.
It prints the resulting messages. It uses a temporary workspace, cleans up
after itself, and makes no provider requests. Read
[examples/request-copy.mjs](examples/request-copy.mjs) to follow each step.

For an actual workspace:

```sh
node bin/freshctx.mjs init --root /path/to/workspace
node bin/freshctx.mjs serve --stdio --root /path/to/workspace
```

One persistent child serves one host session. Standard output contains JSONL
responses; diagnostics go to standard error. The host must support rewriting
its final request copy, stable tool-result IDs, projection insertion, and a
shared workspace. Installing the CLI alone does not connect an agent.

## Integrations

| Bridge | Verified scope |
| --- | --- |
| [Pi](bridges/pi/README.md) | Pi 0.85.0, `openai-completions`, real AgentSession with a scripted local HTTP provider; saved-session resume and cancellation fixtures. |
| [OpenHands](bridges/openhands/README.md) | Node and Python request-rewrite fixtures. An actual OpenHands release and its condenser are not pinned or exercised here. |

Bridge dependencies and tests live under `bridges/<host>`. They are excluded
from the product tarball. Compatibility with other hosts or provider formats
has not been established.

## What is refreshed

A complete read can track a file. A byte range inside a uniquely resolved
function, class, or method tracks that symbol. Other parsed ranges remain
regions. Python, JavaScript, TypeScript, TSX, Go, and Rust have vendored
Tree-sitter parsers. Unsupported syntax or a lost symbol can fall back to the
current whole file, subject to the same byte budget.

Region relocation uses textual anchors and similarity heuristics. Ambiguous
repeated occurrences are omitted; arbitrary refactors and semantic identity
are not guaranteed. Selection uses observation recency and overlap, not task
relevance or a dependency graph. Unread or omitted code is not evidence that
something is absent.

A failed plan cancels dispatch. A deleted or over-budget unit can instead be
represented by an unavailable marker in a valid plan. `commit` rechecks the
selected source files; it neither freezes the workspace nor refreshes old
facts in user messages, assistant text, shell output, or summaries.

## Build on it

- [Protocol and integration contract](docs/protocol.md): operations, responses, identity, retries, failure handling, and storage.
- [Contributing](CONTRIBUTING.md): source map, validation, and research boundaries.
- [Security](SECURITY.md): workspace restrictions and historical code retention.
- [Third-party notices](THIRD_PARTY_NOTICES.md): parser versions and provenance.

```sh
npm run check
npm test
npm run pack:check
```

The packaging check enforces the fixed allowlist and parser checksums, then
runs the extracted tarball's CLI through the same observation/edit example.
There are no root package dependencies. Host checks are documented in their
respective bridge directories.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
