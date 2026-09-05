# Changelog

## Unreleased

- Label projection frame lengths as UTF-8 `Nbytes` so models cannot treat
  `path:kind:N` as a Pi line offset. Bare integer headers fail closed.
- Keep up to 16 pending plans per session so `commit A` still works after
  `prepare B`. Evicted or expired pending projections are garbage-collected
  when no live record references the blob.
- JSONL writes waiting for drain terminate if the output stream closes.
- Declare Node `>=22.19.0` for the Pi bridge to match its SDK engines.

- Add a private OpenHands request-rewriting bridge under `bridges/openhands`.
  Compose order is `condense_then_freshctx`. Rejected plans cancel dispatch.

## 0.1.0

Initial prototype release of the local Node 22+ JSONL service.

- Implements hello, observe, prepare, commit, recover, and status.
- Provides init, doctor, clean, and persistent stdio service commands.
- Resolves current files, Tree-sitter symbols, and observed byte ranges.
- Archives exact revisions and validates workspace boundaries and commit revisions.
- Keeps benchmark scores and research adapters outside the npm package.
- Documents a separate Pi bridge, a Git install path, and maintainer contact.

Install from the Git tag until an npm registry release is available. FreshCtx is
a prototype. The Pi bridge supports only its documented request format; closed
hosts without all required hooks remain incompatible. Measured benchmark
fixtures are not model answer accuracy or a SWE pass rate.
