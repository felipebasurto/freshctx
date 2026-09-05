# FreshCtx for Pi

A separate reference bridge for [FreshCtx](https://github.com/felipebasurto/freshctx).
Tested with `@earendil-works/pi-coding-agent@0.85.0`, Node 22, and Pi's
`openai-completions` API. It replaces Pi's `read` tool with an exact workspace
text reader, speaks `freshctx/1` to a persistent local child, and transforms a
copy of the final Chat Completions request. It does not modify saved Pi history.

## Private checkout setup

Development lives here in the private product repository. The former
freshctx-pi repository and v0.1.0 tag are historical snapshots. npm publication
is disabled. With repository access, run from the product checkout:

```sh
npm ci --prefix bridges/pi
npm run check --prefix bridges/pi
npm test --prefix bridges/pi
npm run demo --prefix bridges/pi
```

The bridge depends on the product at `file:../..`, so the tests exercise the
same checkout. It has its own dependency directory; the root product remains
independent of Pi. The SDK test pins Pi 0.85.0 and its separately required
pi-server package. The latter is only a test dependency.

To use a locally installed Pi 0.85.0, start it from your target workspace with
`pi -e /absolute/path/to/freshctx/bridges/pi/extension.js`. Select a configured
model whose API is `openai-completions`. Provider credentials belong to Pi.
OpenAI Responses and other request formats are not supported. Load this bridge
last and do not combine it with other final-request rewriters or read overrides.

The demo uses real Pi tool execution and HTTP serialization with a deterministic
loopback provider. It reads two header lines, edits the rate between turns, and
checks that the outgoing request contains current observed code with FreshCtx
and stale code without it. Neither arm receives the unread function. No LLM is
used, and this fixture establishes no model accuracy, cost, or SOTA claim.

## Boundaries and failure behavior

- Only this extension's `read` results are tracked. Bash, grep, previous native
  reads, user quotes, assistant text, and compacted summaries are not refreshed.
- Reads default to 200 lines and accept `offset` and `limit`. They preserve
  UTF-8 byte offsets and internal CRLFs, excluding terminal line separators.
  Symlinks, paths outside the workspace, non-UTF-8 files, images, and files
  over 512 KiB fail closed without returning source content.
- A header read stays a region. It does not establish that unread functions
  are absent. Use another ranged read to inspect later code. Regions remain
  byte ranges; edits that move their meaning require a new read. Unique
  functions and methods use Tree-sitter identity instead.
- The live projection has a 128 KiB budget. Omitted or deleted code gets an
  unavailable marker. Old bodies are never substituted as current code.
- Native tool IDs and all replacement hashes must match. The projection hash
  is checked, the copy is prepared atomically, and commit rechecks the disk
  before dispatch. Edits after commit remain possible.
- Pi catches thrown hook errors. On timeout, unsupported format, altered
  history, or rejected commit, this bridge cancels the active request with
  `ctx.abort()` before discarding the plan. It displays **FreshCtx blocked**
  and writes the warning to stderr. Real Pi HTTP tests verify that an altered
  result and a dead child cancel the turn without dispatching the rejected
  request. Custom SDK hosts that replace Pi's abort handler must preserve
  cancellation. Other extensions must not rewrite requests after this bridge.
- Resume uses Pi's session ID and FreshCtx's persisted observations. Session
  shutdown closes stdin and releases the child process's workspace lock.

FreshCtx keeps historical source in `.freshctx/`. Run `freshctx clean` when it
is no longer needed. Read the product [security policy](https://github.com/felipebasurto/freshctx/blob/main/SECURITY.md).

## Validate

```sh
npm ci
npm run check
npm test
```

Tests cover real Pi HTTP serialization and rejected-request cancellation, Unicode/CRLF ranges, later symbol
reads, duplicate IDs, altered results, deleted files, a zero-byte budget,
symlinks, traversal, stale commits, resume, and child timeouts. Scores from
[freshctx-bench](https://github.com/felipebasurto/freshctx-bench) belong to its
frozen fixtures and are not scores for this Pi integration.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
