# FreshCtx against today's harness and a CORVUS-style dump

FreshCtx is a local JSONL sidecar. It is not an agent. A bridge rewrites a copy of the final provider request. This note reports measured scores from four frozen slices in this repository. It does not reproduce SWE-PolyBench_Verified, their filtered SWE-Bench Pro slice, or the Bedrock runs in Zheng et al., arXiv:2607.22711v1. It does not rerun the Pi or Hermes CLIs. There is still no drop-in adapter.

People who have not read that paper already run an open harness that leaves tool-read bodies in the request until compact or prune fires. That is today's default in Pi and Hermes. We reimplemented those two context engines as transformers. Pinned SHAs live in `bench/PROTOCOL.md`. We reimplemented CORVUS Algorithm 1 as `corvus_full_file`. History stores `sync: <path>`. The live block is the current whole file. We did not import Strands.

Slice ids are `freshctx-layer-a-v1`, `freshctx-mva-v1`, `freshctx-econ-v1`, and `freshctx-horizon-v1`. Numbers below are measured, not reproduced. USD is estimated from `bench/ledger/price-card-v1.json` (cited Anthropic Sonnet 4.6, 5-minute cache write). `est_tokens` is `ceil(bytes / 4)`.

## Today's harness leaks. Compact and prune drop gold bytes.

12 Layer A fixtures. No LLM.

`append_only` (public name is today's harness) left a stale read body in 8 fixtures. `freshness_exact` held in 2.

`corvus_full_file` had `stale_leakage` 0 and `last_known_in_request` 0. `freshness_exact` held in 12. `budget_ok` held in 11. The miss is the budget 0 fixture. CORVUS has no byte cap, so it still dumps the file.

`freshctx_prepare` had `stale_leakage` 0 and `last_known_in_request` 0. `freshness_exact` held in 11. The miss is the same budget 0 fixture, where the projection is 0 bytes by design. `budget_ok` held in 12.

Layer A `prompt_bytes` summed to 819 for today's harness, 1048 for CORVUS, and 3079 for FreshCtx. `payload_bytes` were 0, 415, and 333. `envelope_bytes` were 0, 88, and 1810. The wrapper is larger than a raw dump on these tiny fixtures. That is a measured cost, not a win.

## Long sessions and two agents. Slice freshctx-horizon-v1

64 cycles. 8 files. Five arms. `by_cycle` records `working_set_size`, `usd_total_micros`, `cache_miss_tokens`, `stale_leakage`, `freshness_exact`, and `api_calls`. FreshCtx `prepare` keeps the last 3 `result_id`s. CORVUS keeps every registered path. `cross_agent_stale` is reserved false on the long session: there is no second agent.

Today's harness. `stale_leakage` becomes true at cycle 8, after the first intervening edit, and stays true. Last-cycle `working_set_size` 64. `usd_total_micros` 16371159. `freshness_exact` false.

`pi_compact`. `compact_calls` 62. `api_calls` 126. Last-cycle `working_set_size` 3. `usd_total_micros` 1834478. `stale_leakage` false because the old body was stubbed. `freshness_exact` false. Compact is not gold.

`hermes_prune`. `prune_commits` 63. Last-cycle `working_set_size` 64. Lowest long-session `usd_total_micros` at 771105. `freshness_exact` false. Stubs are not gold current bytes.

`corvus_full_file`. `stale_leakage` false. `freshness_exact` true. Last-cycle `working_set_size` 8. `live_block_bytes` 66327. `cache_miss_tokens` 190694. `usd_total_micros` 1064415. Lowest total among arms that stay exact.

`freshctx_prepare`. `stale_leakage` false. `freshness_exact` true. Last-cycle `working_set_size` 3. `live_block_bytes` 25325. `envelope_bytes` 482. `cache_miss_tokens` 398928. `usd_total_micros` 1399159. The working set plateaus while CORVUS holds all 8 paths. Sliding the active `result_id` window rewrites the live suffix every cycle, so FreshCtx misses cache more than CORVUS and loses estimated USD on this 64-cycle run. At cycle 8, FreshCtx was 180304 and CORVUS was 301856. That order flips by cycle 63.

Two agents, one disk. `corvus_registry` is `per_agent`. Story `b-edits-a-read`: agent B edits a file agent A read. `cross_agent_stale` is true on today's harness and false on FreshCtx and per-agent CORVUS. Compact and prune on A go `freshness_exact` false after they stub A's read. Story `b-only-file`: B's file is absent from A's FreshCtx selected units. Story `a-drops-result-id`: dropping a `result_id` leaves FreshCtx `working_set_size` 1 and CORVUS at 2.

## Money on short tasks. Slice freshctx-econ-v1

8 tasks. Same five arms. `usd_total_micros` is integer millionths of a United States dollar.

Today's harness. 22 `cycles`, 22 `api_calls`, 4 `duplicate_file_reads`. `usd_total_micros` 309844.

`pi_compact`. 22 `cycles`, 26 `api_calls` (4 `compact_calls`). `usd_total_micros` 282890.

`hermes_prune`. 22 `cycles`, 4 `prune_commits`. `usd_input_micros` 174867. Lowest input USD on this slice. `usd_total_micros` 240867.

`corvus_full_file`. 14 `cycles`. `usd_total_micros` 262370. `live_block_bytes` 139610.

`freshctx_prepare`. 14 `cycles`. `usd_total_micros` 224693. Lowest `usd_total_micros` on this slice. `live_block_bytes` 86906. `envelope_bytes` 1541.

Hermes wins `usd_input_micros` by stubbing history. FreshCtx wins `usd_total_micros` on this short slice because it skips the retry tax and sends a smaller live suffix than CORVUS. It does not win the 64-cycle USD total against CORVUS or prune.

Scripted MVA `freshctx-mva-v1` used 22 `cycles` on today's harness and 14 on CORVUS and FreshCtx, with 4 `duplicate_file_reads` only on today.

## Limits

No live LLM. No SWE pass rate. No closed Cursor claim. Estimated tokens. Frozen price card. Compact and prune are not Pi or Hermes CLI scores. There is still no drop-in adapter. The proof is the add-on mechanics: active `result_id`s, `budget_bytes`, and two `session_id`s on one workspace.

Rerun with `npm run bench:layer-a`, `npm run bench:mva`, `npm run bench:econ`, and `npm run bench:horizon`. Then `npm run bench:announce`. The checker rejects any integer in this file that is missing from the frozen JSON reports. Expected report digests:

- `bench/results/layer-a.json` sha256:610ac6e10a1fa82aa93845abed8c0700188f573e176020b438f77c13531efbed
- `bench/results/mva.json` sha256:ec6211e2a52bf01c696f5a2ad7758aa6a0c00b6aea74b3139b5ce7aa6988f28a
- `bench/results/econ.json` sha256:d5fdd0573f9ed216438a3475b3beac83e57702ded02335f231a3984c34b5515c
- `bench/results/horizon.json` sha256:d46b90586affc8e02ba34ca99a12cf8081abe45e4952e7cc5ddd2e7bb68c5f80
