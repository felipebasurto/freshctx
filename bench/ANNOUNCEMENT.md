# FreshCtx context transformer, measured against a CORVUS-style dump

FreshCtx is a local JSONL sidecar. It is not an agent. A bridge rewrites a copy of the final provider request. This note reports measured scores from two frozen slices in this repository. It does not reproduce SWE-PolyBench_Verified, their filtered SWE-Bench Pro slice, or the Bedrock runs in Zheng et al., arXiv:2607.22711v1.

The comparison reimplements Algorithm 1 from that paper as `corvus_full_file`. History stores `sync: <path>`. The live block is the current whole file. We did not import Strands.

Slice ids are `freshctx-layer-a-v1` and `freshctx-mva-v1`. Numbers below are measured, not reproduced. Their published token cuts are cited from the paper only, never placed next to ours as if they were the same experiment.

## Layer A. Gold current bytes

12 fixtures. Three arms. No LLM.

`append_only` left a stale read body in 8 fixtures. `freshness_exact` held in 2.

`corvus_full_file` had `stale_leakage` 0 and `last_known_in_request` 0. `freshness_exact` held in 12. `budget_ok` held in 11. The miss is the budget 0 fixture. CORVUS has no byte cap, so it still dumps the file.

`freshctx_prepare` had `stale_leakage` 0 and `last_known_in_request` 0. `freshness_exact` held in 11. The miss is the same budget 0 fixture, where the projection is 0 bytes by design. `budget_ok` held in 12.

On the unique-symbol fixtures, FreshCtx selected `symbol`. The CORVUS arm selected `file`. Deleted and binary paths contributed 0 last-known bodies on both FreshCtx and CORVUS. `append_only` kept the old body.

Layer A `prompt_bytes` summed to 819 for `append_only`, 1048 for CORVUS, and 3079 for FreshCtx. `payload_bytes` were 0, 415, and 333. `envelope_bytes` were 0, 88, and 1810. The wrapper is larger than a raw dump on these tiny fixtures. That is a measured cost, not a win.

## Scripted MVA. Slice freshctx-mva-v1

8 toy tasks. A fixed policy. Read, then `str_replace` using the last visible quoted token. After an intervening disk edit, a stale visible token fails and the policy re-reads. This is CORVUS Observation 2, counted. It is not a live model.

Across the slice, `append_only` used 22 `cycles` and 4 `duplicate_file_reads`. `corvus_full_file` and `freshctx_prepare` each used 14 `cycles` and 0 `duplicate_file_reads`.

On `stale-edit-python`, `append_only` took 4 `cycles` and 1 `duplicate_file_reads`. The other arms took 2 `cycles` and 0 `duplicate_file_reads`. FreshCtx `payload_bytes` was 43, matching CORVUS. FreshCtx `live_block_bytes` was 230 against 51 because `envelope_bytes` was 187.

On `partial-read-python`, CORVUS `live_block_bytes` was 724 and `payload_bytes` was 714. FreshCtx was 219 live and 26 payload, and selected `symbol`. On `partial-read-go`, 630 versus 223 live, 620 versus 30 payload.

On `large-file-budget`, CORVUS `live_block_bytes` was 835. FreshCtx omitted the file and left 47.

Summed `final_request_bytes` were 1595 for `append_only`, 2833 for CORVUS, and 2412 for FreshCtx. `accumulated_request_bytes` were 2922, 3845, and 5812. Slice `payload_bytes` were 0, 2404, and 301. Slice `envelope_bytes` were 0, 79, and 1508. FreshCtx still pays the remaining envelope on every snapshot. Accumulated request bytes are not a token win.

## Limits

No live LLM. No SWE pass rate. No prompt-cache study. No closed-host claim. The CORVUS `working_set_size` still grows. FreshCtx follows active `result_id`s and `budget_bytes`.

Rerun with `npm run bench:layer-a` and `npm run bench:mva`. Then `npm run bench:announce`. The checker rejects any integer in this file that is missing from the frozen JSON reports. Expected report digests:

- `bench/results/layer-a.json` sha256:610ac6e10a1fa82aa93845abed8c0700188f573e176020b438f77c13531efbed
- `bench/results/mva.json` sha256:ec6211e2a52bf01c696f5a2ad7758aa6a0c00b6aea74b3139b5ce7aa6988f28a
