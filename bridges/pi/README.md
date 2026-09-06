# FreshCtx for Pi

The Pi reference bridge for [FreshCtx](https://github.com/felipebasurto/freshctx).
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

## Saved-session task

Run `npm run demo:resume --prefix bridges/pi` from the product checkout.
It uses a real Pi read, saves the session, shuts down the extension and child,
changes a function's rate from 10 to 20 while inserting lines above it, then
opens the saved session in a new Pi agent session. A scripted HTTP provider
executes the one complete function it receives to answer `total(3)`. The check
compares that answer with execution of the current file on disk.

The plain Pi arm must expose the stale function and answer 30; the FreshCtx arm
must expose the current function and answer 60. Neither arm rereads the file or
receives the unread declaration. Saved Pi history must retain its original read.
Missing code, duplicate function bodies, stale code, or a failed resume fail the
check. Both arms make three HTTP requests. The fixture reports serialized request
bytes; these are not billed tokens or a cost estimate.

This runs in `npm test` and the product's `npm run verify`. It proves the saved
session and HTTP path with a deterministic code consumer, not model reasoning,
a separate Pi process restart, or compaction-summary freshness. No provider
credentials are needed. Frozen benchmark reports remain separate.

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

## Coverage

Tests cover real Pi HTTP serialization and rejected-request cancellation, Unicode/CRLF ranges, later symbol
reads, duplicate IDs, altered results, deleted files, a zero-byte budget,
symlinks, traversal, stale commits, resume, and child timeouts. Scores from
[freshctx-bench](https://github.com/felipebasurto/freshctx-bench) belong to its
frozen fixtures and are not scores for this Pi integration.

## Product PCR pointer

Product PCR `0001` (2026-09-06): projection frames use `Nbytes` so a trailing
integer cannot be read as a Pi line offset. See [docs/pcr/0001-projection-byte-length-cue.md](../../docs/pcr/0001-projection-byte-length-cue.md)
and [docs/pcr/INDEX.md](../../docs/pcr/INDEX.md).

Living-suite PCR numbers stay in the research repository
`docs/lab/INDEX.md` and `docs/lab/pcr/`. Do not copy those labs into this
package.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
