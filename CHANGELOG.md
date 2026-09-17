# Changelog

## Unreleased

- Retain host bridges with separate dependencies and checks; document Pi's
  tested host boundary and OpenHands' fixture-only status.
- Prevent region refresh from jumping to an unchanged duplicate. Omit unknown
  region fingerprints and recover file observations made while files were absent.
- Reject unobserved successful Pi reads before dispatch, including lost state
  on resume; reset the child when session or workspace changes.
- Enforce Python transport deadlines across blocking reads and writes, and
  move asynchronous wrapper work off the event loop.
- Count whitespace toward JSONL frame limits and discard legacy cached plans
  during identity migration.
- Check every JavaScript source file and smoke-test the actual packed CLI.
- Add an executable request-copy example, protocol reference, contributor guide,
  publication audit, and evidence-scoped article draft.
- Fold unit ranking into `projection.mjs`. Flatten the JSONL transport
  to functions.
- Label projection frame lengths as UTF-8 `Nbytes` so models cannot treat
  `path:kind:N` as a Pi line offset. Bare integer headers fail closed.
- Keep up to 16 pending plans per session so `commit A` still works after
  `prepare B`. Orphan projection blobs stay until `freshctx clean`; online
  expire/evict does not delete blobs while sessions are live.
- Region refresh uses surrounding anchors before a global exact match, so
  an edited span is not replaced by an unchanged duplicate. Identical
  region fingerprints at different offsets keep distinct identities.
  Missing or malformed region revisions leave sibling observations
  preparable.
- JSONL frame limits count raw UTF-8 bytes before trimming, including the
  EOF path.
- `npm run check` syntax-checks each source file. `npm run pack:check`
  extracts the tarball and runs `doctor` plus observe, edit, prepare, and
  commit on the packed CLI.

## 0.1.0

Initial prototype release of the local Node 22+ JSONL service.

- Implements hello, observe, prepare, commit, recover, and status.
- Provides init, doctor, clean, and persistent stdio service commands.
- Resolves current files, Tree-sitter symbols, and observed byte ranges.
- Archives exact revisions and validates workspace boundaries and commit revisions.
