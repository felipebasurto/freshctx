# FreshCtx

Private development prototype. npm remains unpublished. Existing tags record
historical snapshots, not an active public launch. See [development policy](AGENTS.md).

FreshCtx keeps code context current without knowing anything about a model,
provider, or agent harness. It is a local Node 22+ process that exposes a small
JSONL protocol over stdio. A harness-specific bridge owns its native request
format; FreshCtx owns safe workspace resolution, Tree-sitter symbol identity,
exact revision storage, selection, and projection.

Measured with-versus-without scores live in
[freshctx-bench](https://github.com/felipebasurto/freshctx-bench).
That repository is not this package. FreshCtx is an add-on, not a compact
replacement. Those figures are not a SWE
pass rate. The maintained host bridges are [Pi](bridges/pi) (Chat Completions) and
[OpenHands](bridges/openhands) (real agent plus summarizing condenser). See
each bridge's compatibility limits and local verification fixture before use.

## Private development

Requires repository access and Node 22+. From an authorized checkout:

```sh
node bin/freshctx.mjs doctor
npm run check
npm test
npm run pack:check
```

For the combined core, Pi, and OpenHands loop, run `npm run verify -- --setup` once.
After setup, `npm run verify` checks core behavior, the package allowlist, Pi
HTTP fixtures, and the OpenHands request-rewrite fixtures. It rejects a bridge
dependency linked to another checkout. Each phase stops on failure, has a
three-minute timeout, and reports elapsed time.
The loop uses a temporary-directory npm cache, overridable with `npm_config_cache`. HTTP fixtures require loopback
access; they need no provider credentials.

For a separate Git worktree, run setup there too. Tests create temporary
workspaces and clean them up. `init` intentionally does not write through a
worktree Git pointer; keep any `.freshctx/` state out of commits yourself.
For debugging, run a single test with Node, for example
`node --inspect-brk --test --test-name-pattern="resume" bridges/pi/test/bridge.test.mjs`.

Install locally with `npm install -g .` if you need the `freshctx` command.
Then run `freshctx init` from the workspace you want to use.
The root package has no bridge dependencies. For Pi, follow [bridges/pi](bridges/pi).
For OpenHands, follow [bridges/openhands](bridges/openhands).

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

The maintained reference integrations are [bridges/pi](bridges/pi) and
[bridges/openhands](bridges/openhands). Other hosts need their own bridge
implementing this contract. The core contains no vendor names or message
schemas. A closed host that lacks any hook is incompatible; FreshCtx will
reject it rather than pretending to provide freshness.

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
format. If any step fails, the bridge must discard the entire plan and cancel dispatch.
Sending the original request can leak stale code. Before dispatching the copied
request, it calls `commit`. `commit` revalidates the selected file revisions and returns `stale_plan` if anything changed. A failed
commit also cancels dispatch and discards the entire copied request.
This checks freshness at commit;
it cannot prevent edits after commit or refresh facts in assistant summaries.

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
budget. After the set is chosen, units render by path then id. Each frame is
length-prefixed (`path:bytes` for a file, `path:kind:bytes` for a symbol or
region), so code containing FreshCtx header text remains unambiguous.

Programmatic imports for a local bench or bridge (`freshctx/session`,
`freshctx/projection`, `freshctx/hash`, `freshctx/store`,
`freshctx/workspace`, `freshctx/treesitter`) resolve through `package.json`
`exports`. Harnesses should still speak JSONL.

FreshCtx archives immutable SHA-256 blobs and session state under
`.freshctx/` until an explicit `freshctx clean`. See [SECURITY.md](SECURITY.md)
before using it with proprietary code.
