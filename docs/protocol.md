# FreshCtx protocol and integration contract

Use `freshctx serve --stdio --root <workspace>` as a persistent child process.
The wire protocol is `freshctx/1`; the request schema is
[schema/freshctx-v1.json](../schema/freshctx-v1.json). The runtime validator also
enforces cross-field constraints and JavaScript safe-integer bounds. There is
no provider connection inside the engine.

## Transport

Send one UTF-8 JSON object per line. Requests have `protocol`, a nonempty string
`id`, and `op`. Responses echo `id`:

```json
{"protocol":"freshctx/1","id":"1","ok":true,"result":{}}
```

On failure, `ok` is false and `error` contains `code`, `message`, and sometimes
`details`. A malformed or oversized frame may have a null response ID. The
maximum incoming frame is 1 MiB, including whitespace and excluding the newline.
An oversized frame is discarded through its newline; the next frame can run.
The server processes frames sequentially and respects output backpressure.

Use a deadline covering writes and reads. A transport timeout, malformed reply,
or lost child makes the request unusable; stop that child and cancel dispatch.
Do not pair a late reply with a later request. Response shapes below describe
the implementation; the JSON Schema covers requests only.

## Establish a session

```json
{"protocol":"freshctx/1","id":"1","op":"hello","session_id":"host-session-123","capabilities":{"request_rewrite":true,"stable_result_identity":true,"projection_insertion":true,"shared_workspace":true}}
```

All four capabilities must be true or `hello` returns `host_incompatible`.
These are declarations by the bridge, not host features the engine can verify.
The response includes `accepted`, `protocol`, `version`, `session_id`,
`languages`, and `idempotent`. Repeating the same hello is allowed. Switching
sessions on a child returns `session_active`; start a new child instead.

## Observe exact tool bytes

After a successful workspace read, send `observe` with:

| Field | Meaning |
| --- | --- |
| `result_id` | Stable native tool-result identity, unique within the session. |
| `path` | Workspace-relative file path. |
| `content_utf8_base64` | Exact UTF-8 text bytes that appear in that native result, encoded as base64. |
| `range` | Optional `{ "start_byte": 0, "end_byte": 52 }`; zero-based, end-exclusive byte offsets. |
| `turn` | Optional nonnegative safe integer for host metadata. Selection recency uses the engine's observation sequence. |

Offsets are bytes, not lines, Unicode code points, or JavaScript string indices.
Do not include line-number decorations or a truncation banner in a source span.
The exact bytes matter because the returned plan hashes the native result.
Repeating an observation with the same ID, path, range, and bytes is idempotent;
reusing its ID for different input returns `idempotency_conflict`.

The response contains `result_id`, `unit_id`, `marker`, and `idempotent`.
Do not write the marker back to saved history. For an executable example, see
[request-copy.mjs](../examples/request-copy.mjs).

A matching range resolves to the smallest unique enclosing declaration when
possible; this can widen a one-line read to its whole function. Other parsed
ranges remain regions. Unsupported languages, broken parses at observation,
and unmatched ranges can become current-file observations. A missing symbol
on refresh can also use the current file. Missing/unreadable files are omitted.
Region relocation is heuristic; unknown fingerprints and ambiguous occurrences
must not be represented as a proven current region.

## Prepare, apply, commit, send

```json
{"protocol":"freshctx/1","id":"3","op":"prepare","request_id":"provider-attempt-456","result_ids":["read-1"],"budget_bytes":4096,"selection_granularity":"region"}
```

Send only result IDs present in the actual outgoing copy after any condensation.
Default granularity is `region` (files, symbols, and regions); `file` widens
resolved candidates to whole files **before** budget selection. A file that no
longer fits may be omitted, so the two modes need not select the same units.

A successful plan contains:

| Field | Meaning |
| --- | --- |
| `plan_id` | Session-scoped plan identity used by `commit`. |
| `replacements` | `{ result_id, expected_sha256, marker }` for known observations. |
| `projection_utf8_base64`, `projection_sha256` | One current projection and its SHA-256 revision. |
| `selected`, `omitted`, `unresolved` | Selected unit IDs, `{ unitId, reason }` omissions, and unresolved result metadata. Unknown result IDs appear as `unknown_result`. |
| `selection_granularity` | Mode the engine actually used. |
| `unit_states` | Resolution/mapping status and byte ranges for selected units. A symbol status of `stable` describes its mapping; it is not a claim that its body is unchanged. |
| `whole_file_equivalent` | Region mode only: unique selected paths with raw source byte lengths and their sum. This excludes frame headers and does not run a whole-file control arm. |

The bridge must:

1. Validate native tool-call/result pairing. Verify the projection hash and byte
   budget. Verify every replacement's expected hash against that exact native
   result; reject duplicate replacements or unsupported serialization.
2. Check coverage of successful source reads. `unknown_result` is allowed for
   unrelated tools, but an unobserved successful read must not pass through as
   if freshness were guaranteed. Pi checks this using tool names and trusted
   error metadata. Custom integrations must identify their own source reads.
3. Apply replacements to a copy. Insert the projection in a legal position in
   the provider format. Preserve IDs and the saved event log.
4. Send `commit` with `plan_id`. Dispatch only if `applied` is true. A failed
   prepare, application, or commit discards the entire copied request and
   cancels dispatch; sending the original can expose stale code.

A valid plan may omit deleted, unresolved, overlapping, or over-budget units.
Their historical bodies still get unavailable markers. That is different from
a rejected plan. Summaries and other unobserved text remain outside this check.

## Frame format and budget

A file renders as `path:Nbytes\n<body>`; a symbol or region as
`path:kind:Nbytes\n<body>`. Adjacent frames concatenate without a separator.
Read exactly N UTF-8 bytes after each header, even if a body contains newlines
or text resembling another header. `Nbytes` is never a read-tool line offset.

The byte budget covers rendered headers and source bodies in the projection.
It excludes historical markers, other messages, provider serialization, and
model tokens. Units rank by descending observation recency, then ID; admitted
units prevent overlapping candidates from also being admitted. Oversized units
are skipped without truncation. Rendering orders the final set by path, then ID.
This policy does not discover dependencies or score task relevance.

## Freshness boundary, retries, and storage

Commit re-reads each selected file and compares its complete source revision.
A changed or unreadable file returns `stale_plan`. This is a per-file optimistic
check, not an atomic multi-file snapshot or a lock through provider dispatch.
Edits after a check, concurrent writers, and stale summary facts require host
coordination. Use conditional writes or workspace isolation when needed.

`id` correlates transport messages; `request_id` identifies a prepared provider
attempt. Retrying the same `request_id` returns the same plan, even if disk has
changed. Use a **new** `request_id` for a new attempt or to refresh after a
rejection. Idempotent commit acknowledges a previously committed plan; it does
not revalidate that old response for a new model call.

At most 16 pending plans are retained, with a 30-minute expiry processed on
`prepare` or `status`. A seventeenth plan evicts the oldest. A removed plan
returns `unknown_plan`. Committed records and historical source blobs remain
until explicit cleanup; there is no online blob garbage collection or fixed
total archive size.

Session state lives under `.freshctx/sessions/`; content-addressed SHA-256
blobs live under `.freshctx/blobs/sha256/`. State schema v2 uses 24-hex unit IDs.
When v1 state is opened, provable identities migrate, ambiguous observations
are quarantined, and cached plans are discarded. Proven legacy IDs can still
recover archived bytes. Legacy regions without enough identity information
need a new read. Session state versions are separate from the wire version.

`recover` takes `unit_id` and a `sha256:<64 hex>` revision; it returns archived
`content_utf8_base64`. This is historical evidence, not current workspace code.
`status` reports health, languages, and observation/unit/plan counts, without
source bodies. A session lock prevents two sidecars from owning the same
session; it does not lock source files against editors.

`clean` deletes all sessions and archived code for that workspace, preserves
owned configuration, and refuses while a session is active. It is a reset,
not a selective repair. Read [SECURITY.md](../SECURITY.md) before retaining
proprietary code or carrying an old host session across cleanup.
