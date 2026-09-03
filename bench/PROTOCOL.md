# FreshCtx bench metrics

Reference for `bench/` v1. Definitions are frozen. A later change is a new slice id.

## Slice ids

`freshctx-layer-a-v1` is the model-free context-transformer suite.

`freshctx-mva-v1` is the scripted minimum-viable-agent policy on frozen toy tasks. It is not SWE-PolyBench_Verified. It is not SWE-Bench Pro. It is not a reproduction of Zheng et al. Table 3.

## Arms

`append_only` keeps each `read` body in request history. Later disk edits do not update those bodies.

`corvus_full_file` reimplements Algorithm 1 of arXiv:2607.22711v1. A `read` registers a path. History stores `sync: <path>`. The live block is the current whole file for each registered path that still exists as UTF-8 text. Missing or non-UTF-8 paths are omitted. Last-known bytes are never inserted. This arm does not run Strands or Bedrock.

`freshctx_prepare` calls `FreshCtxSession.observe` for each `read`, then `prepare` with the fixture `result_id`s and `budgetBytes`. The bridge copy applies every replacement and the projection, or keeps the original request.

## Layer A scores

`stale_leakage` is true when an observed body that is no longer the current file (or, for a ranged read, no longer contained in that file) appears as a history entry of kind `body`.

`freshness_exact` is true when every selected live unit equals current gold for that arm. `append_only` compares history bodies to gold. `corvus_full_file` compares live whole files to current disk files. `freshctx_prepare` compares decoded projection units to gold `kind` and gold bytes. When gold marks a path `omit`, exactness requires zero selected units for that path.

`last_known_in_request` is true when a stale observed body appears as a history `body` entry or as the full content of a selected live unit.

`budget_ok` is true when `live_block_bytes` is less than or equal to `budgetBytes`. `corvus_full_file` has no budget and still reports the flag.

`prompt_bytes` is the UTF-8 byte length of the serialized request (history plus live block).

`live_block_bytes` is the UTF-8 byte length of the live block only.

`payload_bytes` is the UTF-8 byte length of selected unit `content` inside that live block. When the live block is empty, `payload_bytes` is 0.

`envelope_bytes` is `live_block_bytes` minus `payload_bytes`, floored at 0. It is the wrapper around current bytes (path labels, XML tags, preambles). History markers are not in this field. They sit in `prompt_bytes`.

`selected_count` is the number of live units (files or projection units).

`selected_kind` is the kind of the first selected unit, or `null`.

## MVA scores

Names follow Zheng et al. §6.2, measured on slice `freshctx-mva-v1` only.

`duplicate_file_reads` counts a `read` of a path already read in an earlier cycle of that task.

`cycles` counts policy steps, including a retry after a failed `str_replace`.

`final_request_bytes` is `prompt_bytes` after the last cycle.

`accumulated_request_bytes` is the sum of `prompt_bytes` across cycles.

`live_block_bytes` is the live block after the last cycle.

`payload_bytes` and `envelope_bytes` are the same split as Layer A, after the last cycle.

`working_set_size` is registered files (`corvus_full_file`) or selected units (`freshctx_prepare`) after the last cycle. `append_only` uses the number of historical read bodies still in the request.

## Labels

Numbers produced by this repo are `measured`. Numbers copied from arXiv:2607.22711v1 are `cited`. This suite does not mark any score `reproduced` against their Bedrock runs.
