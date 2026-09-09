# Changelog

## Unreleased

- Drop host bridges and harness install docs. This repository is the
  engine. Wire it yourself.
- Open the README with clone and `doctor`. Host wiring stays a few
  sentences. If any step fails, drop the plan and do not send the original
  request. JSONL over stdio is the public contract. Package `exports` of
  internal modules are gone.
- Remove `scripts/verify.mjs`. CI already runs `check`, `test`, and
  `pack:check`.
- Fold unit ranking into `projection.mjs`. Flatten the JSONL transport
  to functions.
- Label projection frame lengths as UTF-8 `Nbytes` so models cannot treat
  `path:kind:N` as a Pi line offset. Bare integer headers fail closed.
- Keep up to 16 pending plans per session so `commit A` still works after
  `prepare B`. Orphan projection blobs stay until `freshctx clean`; online
  expire/evict does not delete blobs while sessions are live.
- JSONL writes waiting for drain terminate if the output stream closes.

## 0.1.0

Initial prototype release of the local Node 22+ JSONL service.

- Implements hello, observe, prepare, commit, recover, and status.
- Provides init, doctor, clean, and persistent stdio service commands.
- Resolves current files, Tree-sitter symbols, and observed byte ranges.
- Archives exact revisions and validates workspace boundaries and commit revisions.
