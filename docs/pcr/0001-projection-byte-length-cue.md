# PCR 0001 — Label projection lengths as UTF-8 bytes

- Date (UTC): 2026-09-06
- Author / agent: Cursor Cloud Agent (`bc-c8c971ea-fd59-46c5-bf35-fb6cdf1f49fa`)
- Branch / PR: `cursor/pi-projection-byte-length-cue-49fa` (draft)
- Commit: recorded after push
- Paper-manifest digest (if research work): not research work
- Result labels used: `synthetic`; `pi-fresh`; `measurement`

## Hypothesis or change

Pi with-FreshCtx reread loops were cued by projection headers shaped like
`path:kind:contentByteLength`. DeepSeek-V4-Flash treated the trailing integer as
a line offset (live: moved-symbol offsets 46/122 past EOF; tax-base rereads of
`[unitId]` markers only). Label the length as UTF-8 `Nbytes` and reject bare
integers.

## What we did

`renderUnit` now emits `path:Nbytes` / `path:kind:Nbytes`. `parseHeader` requires
the `bytes` suffix and fails closed on the live cue strings `moved.py:symbol:46`
and `tax.py:122`. Tree-sitter symbol identity is unchanged and stays on. No gold
or freshctx-bench files were edited. Diagnostic cited from bench commit
`1eeb9a0` only.

## Benchmarks run

| Command | Ran? | Exit | Notes |
|---|---|---|---|
| `npm test` | pending this-run | | core TAP after commit |
| `npm run check` | pending this-run | | |
| `npm run pack:check` | pending this-run | | docs/ must stay out of the tarball |
| `npm test --prefix bridges/pi` | pending this-run | | includes moved-symbol / tax-base fixture |
| `npm run evaluate` | no | | not on this product branch |
| `npm run ctxbench` | no | | bench repo; not touched |
| `npm run demo` | no | | not required for this cue |

RED (before the suffix) on the new core fixture:

```
# Subtest: Pi loop cue headers are not trailing bare integers (bytes, not line offsets)
not ok 1 - Pi loop cue headers are not trailing bare integers (bytes, not line offsets)
    symbol header still looks like a line offset: moved.py:symbol:46
    true !== false
```

GREEN (after the suffix) on that fixture:

```
# Subtest: Pi loop cue headers are not trailing bare integers (bytes, not line offsets)
ok 1 - Pi loop cue headers are not trailing bare integers (bytes, not line offsets)
# tests 2
# pass 2
# fail 0
```

## Metric snapshot

No Pass@1. No dollar figures. No SOTA. This-run product TAP will be pasted after
the verification commands on this revision.

## Comparison

Cited diagnostic: freshctx-bench `1eeb9a0` (Thinker). Measured here: header
shape only. Without-arm native bodies passing in 2 is a bench observation, not
re-run on this product PR.

## Conflicts with constitutions

none observed

## Limitations

This removes the byte-length-as-line-offset cue. It does not prove a live
DeepSeek-V4-Flash session will stop rereading `[unitId]` markers. Opaque
markers remain. A later leftover (OpenHands plan-discard) is out of scope.

## Next measurement

Re-run the Pi moved-symbol / tax-base host fixture on this revision and record
the TAP line. A later live with/without arm is a bench job, not this PR.
