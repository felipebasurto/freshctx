# FreshCtx is an add-on, not a compact replacement

FreshCtx is a local JSONL sidecar. It is not an agent. A bridge rewrites a copy of the final provider request. Compact still compact. Prune still prunes. FreshCtx does not replace those engines. There is still no drop-in adapter.

This note reports measured scores from five frozen slices in this repository. It does not reproduce SWE-PolyBench_Verified, their filtered SWE-Bench Pro slice, or the Bedrock runs in Zheng et al., arXiv:2607.22711v1. It does not rerun the Pi or Hermes CLIs. Numbers below are measured, not reproduced. USD is estimated from `bench/ledger/price-card-v1.json` (cited Anthropic Sonnet 4.6, 5-minute cache write). `est_tokens` is `ceil(bytes / 4)`.

Slice ids are `freshctx-layer-a-v1`, `freshctx-mva-v1`, `freshctx-econ-v1`, `freshctx-horizon-v1`, `freshctx-addon-v1`, and `freshctx-addon-v2`. Say better only inside a pair. Never treat FreshCtx and prune as rival methods.

## Compose order

Slice `freshctx-addon-v2` keeps `freshctx_then_host`. The host builds native history (512-byte conversation turns plus tool-read bodies). FreshCtx then replaces still-present tool results with markers and attaches a current live projection. Prepare uses every `result_id` still in that native request (`prepare_result_ids: host_present`). Pi compact or Hermes prune may still rewrite history after that. The live block is not compacted. Recency still picks the set; render order is path then id so a stable membership does not reshuffle the suffix. If prune stubs the only history copy of a file, freshness can still hold when that `result_id` is active and the projection has current disk. If the host dropped the `result_id`, FreshCtx omits it.

## With versus without, 64 cycles. Slice freshctx-addon-v2

Same long session fixture as horizon: 64 cycles, 8 files. Addon prepare does not apply `drop_result_ids`. Each row is one host, with FreshCtx versus without.

Today's harness without FreshCtx still leaks. `stale_leakage` true. `freshness_exact` false. Last-cycle `working_set_size` 64. `usd_total_micros` 17398175.

The same host with FreshCtx stops that leak. `stale_leakage` false. `freshness_exact` true. `working_set_size` 8. `live_block_bytes` 66336. `envelope_bytes` 88. `cache_miss_tokens` 190716. `usd_total_micros` 2089626. On this host the add-on is cheaper than leaving every body in history. That is a with-versus-without USD fact, not a claim against prune.

`pi_compact` without FreshCtx still fires: `compact_calls` 63. `api_calls` 127. `usd_total_micros` 1845261. `freshness_exact` false. Compact stubs are not gold.

`pi_compact` with FreshCtx still compact: `compact_calls` 32. `api_calls` 96. `freshness_exact` true. `usd_total_micros` 2155671. The with arm costs 310410 more millionths of a dollar than compact alone. Freshness is the point.

`hermes_prune` without FreshCtx still fires: `prune_commits` 63. `usd_total_micros` 1798183. Lowest USD on this host without the add-on. `freshness_exact` false. Stubs are not current bytes.

`hermes_prune` with FreshCtx still prunes: `prune_commits` 33. `freshness_exact` true. `usd_total_micros` 2111455. The with arm costs 313272 more than prune alone. FreshCtx is the freshness add-on. Prune is still the size tool.

Two add-ons on today's host. `today+corvus`: `freshness_exact` true, `working_set_size` 8, `live_block_bytes` 66327, `cache_miss_tokens` 190694, `usd_total_micros` 2091439. `today+freshctx`: `freshness_exact` true, `working_set_size` 8, `live_block_bytes` 66336, `cache_miss_tokens` 190716, `usd_total_micros` 2089626. FreshCtx is the cheaper exact add-on on this host. CORVUS is a competing add-on, not a prune clone. Do not score it against Hermes.

## Two agents, one disk

Story `b-edits-a-read`. Today's harness without FreshCtx: `cross_agent_stale` true, `usd_total_micros` 44363. The same host with FreshCtx: `cross_agent_stale` false, `freshness_exact` true, `usd_total_micros` 36704. Compact-without and prune-without go `freshness_exact` false after they stub A's read. Compact-with and prune-with restore `freshness_exact` true.

Story `b-only-file`. B's file is absent from A's FreshCtx selected units on every host.

Story `a-drops-result-id`. Without FreshCtx, today's harness keeps `working_set_size` 2 (`usd_total_micros` 19564). With FreshCtx, dropping the `result_id` leaves `working_set_size` 1 and `keep.py` only (`usd_total_micros` 10246). CORVUS on A still holds both paths at `usd_total_micros` 16505.

## Layer A stays a leak test

12 Layer A fixtures. No LLM. `append_only` left a stale read body in 8 fixtures. `freshness_exact` held in 2. `corvus_full_file` had `stale_leakage` 0 and `freshness_exact` 12, with `budget_ok` 11. `freshctx_prepare` had `stale_leakage` 0 and `freshness_exact` 11. The miss is budget 0, where the projection is 0 bytes by design. `prompt_bytes` summed to 819, 1048, and 1013. `envelope_bytes` were 0, 88, and 108. The wrapper is a measured cost.

Scripted MVA `freshctx-mva-v1` used 22 `cycles` on today's harness and 14 on CORVUS and FreshCtx, with 4 `duplicate_file_reads` only on today.

Short tasks `freshctx-econ-v1` still exist as measured USD on the same engines. Today's harness 309844. `pi_compact` 282890. `hermes_prune` 240867. `corvus_full_file` 262370. `freshctx_prepare` 221760. Those five totals are not a public ranking of FreshCtx against prune. Hermes wins `usd_input_micros` 174867 by stubbing. The public pair design is `freshctx-addon-v2`.

## Retired slices

Slice `freshctx-addon-v1` remains the rotating-window pair (`drop_result_ids`, last 3 ids). Its LIVE suffix changed every cycle. That slice is retired the same way as the five-way bake-off. Current addon.json is `freshctx-addon-v2`.

Slice `freshctx-horizon-v1` remains on disk. It compared five arms as rivals. Last-cycle today's harness `usd_total_micros` 16371159. `pi_compact` 1834478. `hermes_prune` 771105. `corvus_full_file` 1064415. `freshctx_prepare` 1372796. That ranking is retired. Hermes winning USD by stubbing was never a FreshCtx loss.

## Limits

No live LLM. No SWE pass rate. No closed Cursor claim. Estimated tokens. Frozen price card. Compact and prune are not Pi or Hermes CLI scores. There is still no drop-in adapter. The proof is the add-on mechanics: host-present `result_id`s, `budget_bytes`, two `session_id`s, and `freshctx_then_host`.

Rerun with `npm run bench:layer-a`, `npm run bench:mva`, `npm run bench:econ`, `npm run bench:horizon`, and `npm run bench:addon`. Then `npm run bench:announce`. The checker rejects any integer in this file that is missing from the frozen JSON reports. Expected report digests:

- `bench/results/layer-a.json` sha256:70abb1852a4c62b0d1c1882986f63caaadc2f6147f33df7c225dfd6277271596
- `bench/results/mva.json` sha256:ec639c64e4019cc53c1ed1b7b28144ebb7306186b929046c89804a4c5d426211
- `bench/results/econ.json` sha256:9ccdb214afe3710392cb3015aa441f04ba50454538eb1a86acf989ebe37511af
- `bench/results/horizon.json` sha256:7aff32fb71b24086dbe004f26858b210ea647b4602b6ec45d04a6a3f9bdeb16e
- `bench/results/addon.json` sha256:d7ff61da9dead1fc01341254e9a66c5be9190fa69fced1f6f0ebf5f4e465a314
