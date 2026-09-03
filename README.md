<img width="1254" height="1254" alt="37a9a9b4-664d-4385-a863-f331067a67fc" src="https://github.com/user-attachments/assets/29eb24fd-6328-4575-8de4-ba087e0fc3a5" />

# FreshCtx

FreshCtx keeps code context current without knowing anything about a model,
provider, or agent harness. It is a local Node 22+ process that exposes a small
JSONL protocol over stdio. A harness-specific bridge owns its native request
format; FreshCtx owns safe workspace resolution, Tree-sitter symbol identity,
exact revision storage, selection, and projection.

Measured context-transformer scores against today's append-only tool history,
a Pi compact clone, a Hermes prune clone, and a CORVUS-style whole-file dump
live in [bench/ANNOUNCEMENT.md](bench/ANNOUNCEMENT.md), including a 64-cycle
session and two agents on one disk. This package is still a prototype. Those
figures are not a SWE pass rate. There is no drop-in adapter.

## Install and initialize

```sh
npm install -g freshctx
cd /path/to/workspace
freshctx init
```

`init` creates `.freshctx/` and, when Git metadata is itself inside the
workspace, adds only `/.freshctx/` to `.git/info/exclude`. It never changes the
workspace `.gitignore`.

Start one persistent child process for each host session:

```sh
freshctx serve --stdio --root /path/to/workspace
```

`stdout` is reserved for JSONL protocol responses. Diagnostics go to `stderr`.
Run `freshctx clean` from a workspace to clear only validated FreshCtx state,
including its historical code archive. It retains the empty owned state
directory and its non-code configuration so a concurrent service cannot be
mistaken for a directory to delete.

## Compatibility

FreshCtx works with any bridge that can truthfully provide all four hooks:

1. Rewrite a copy of the final provider request.
2. Keep a stable native ID for each tool result still in that request.
3. Insert one projection in a valid location in its own request format.
4. Share the same workspace with the FreshCtx child process.

That includes bridges for Pi, Hermes, OpenCode, Cursor, Claude, Codex, or a
future harness when they implement the contract. The core contains no vendor
names or message schemas. A closed host that lacks any hook is incompatible;
FreshCtx will reject it rather than pretending to provide freshness.

## Bridge contract

Send one JSON object per line, with `protocol: "freshctx/1"` and a unique
`id`. The full request schema is at
[`schema/freshctx-v1.json`](schema/freshctx-v1.json).
The runtime validator is authoritative for cross-field constraints such as a
byte range whose end must be greater than its start.

Begin with `hello`:

```json
{
  "protocol": "freshctx/1",
  "id": "1",
  "op": "hello",
  "session_id": "native-stable-session-id",
  "capabilities": {
    "request_rewrite": true,
    "stable_result_identity": true,
    "projection_insertion": true,
    "shared_workspace": true
  }
}
```

For each code result, call `observe` with its stable `result_id`, its
workspace-relative `path`, exact UTF-8 bytes encoded as base64, and an optional
byte range. Before sending a provider request, call `prepare` with the native
`result_id`s still present and a hard `budget_bytes` limit.

`prepare` returns a declarative plan: expected SHA-256 values for each native
result, replacement markers, and one current code projection encoded as UTF-8
base64. The bridge must verify every expected hash, replace only those native
results in a copy of its request, insert the projection, and validate its own
format. If any step fails, it discards the entire plan and sends its original
request. After it applied the plan, it calls `commit`. `commit` revalidates the
selected file revisions and returns `stale_plan` if anything changed.

`recover` returns archived exact bytes by FreshCtx unit and SHA-256 revision.
`status` exposes health and counters only; it never returns source bodies.

## Code semantics and safety

FreshCtx vendors Tree-sitter WASM for Python, JavaScript, TypeScript, TSX, Go,
and Rust. A partial read becomes a `symbol` only when Tree-sitter resolves one
unique class, function, or method. A ranged observe that parses but does not
pin a unique symbol stays a `region` slice of those bytes. It is not the rest
of the file. Unread code is omitted from the projection and is not evidence of
absence. Unsupported languages, parse errors, renamed symbols, and deleted
symbols still use the current complete `file` when FreshCtx can safely read it.
It never reuses a past file body as current context.

The host must send `observe.range` when it has a byte span. FreshCtx does not
invent a selector from prompt text. After `freshctx serve` restarts, the same
`session_id` reloads `.freshctx/sessions/` and refreshes from disk on the next
`prepare`. Missing files stay unresolved. Last-known bodies are never injected.

Files must be relative, regular, UTF-8, below the workspace root, not symlinks,
at most 512 KiB, and stable across a double-stat snapshot. Selection considers
only active native results, sorts deterministically by recent observation and
stable ID, removes byte-range overlaps, and never exceeds the rendered byte
budget. Projection frames include `content-bytes`, so code containing FreshCtx
delimiter text remains unambiguous.

FreshCtx archives immutable SHA-256 blobs and session state under
`.freshctx/` until an explicit `freshctx clean`. See [SECURITY.md](SECURITY.md)
before using it with proprietary code.
