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

## Slice `freshctx-econ-v1`

Estimated tokens, prompt-cache hits, API calls, tool calls, and USD from a frozen price card. Files are tens of kilobytes so the projection envelope can amortize. This slice is not a live Pi or Hermes CLI run.

## Econ arms

`today_tool_history` is `append_only` under a public name. Tool-read bodies stay in history. This is Pi and Hermes (and Cursor, Claude Code, Codex) before compact or prune fires.

`pi_compact` reimplements the Pi keep-recent cut as a context transformer. Pinned SHA `1d9787c11fb91ecf7c892050f4c0607a995dd15b` of `earendil-works/pi`, mapping `packages/coding-agent/docs/compaction.md`. `keepRecentTokens` is frozen at 4096 estimated tokens. The dropped prefix becomes one stub string. `compact_calls` is 1 after the cut. There is no live summarizer.

`hermes_prune` reimplements Hermes prune-first tool-result elision. Pinned SHA `63279301bcbdc185c1b07b98a9312eb0c862f26d` of `NousResearch/hermes-agent`, mapping `agent/context_compressor.py` `_prune_old_tool_results`. `proactive_prune_tokens` is frozen at 4096. `protect_last_n` is 1. Old bodies become one-line stubs. `prune_commits` counts a rewrite. Prune is not an API call.

`corvus_full_file` and `freshctx_prepare` are unchanged.

## Cache model

Serialized requests split on the `LIVE` marker in `bench/lib/serialize.mjs`. Bytes before that marker are the prefix (`HISTORY`). Bytes after it are the suffix (`LIVE`).

`est_tokens` is `ceil(utf8_bytes / bytes_per_token)` with `bytes_per_token` from `bench/ledger/price-card-v1.json`.

If the prefix is byte-identical to the previous cycle, prefix tokens are `cache_hit_tokens`. Otherwise they are `cache_write_tokens` (a new Anthropic 5-minute cache write). Compact and prune rewrite history, so they miss the prefix.

If the suffix is byte-identical to the previous cycle, suffix tokens are cache hits. Otherwise they are `cache_miss_tokens` billed at the uncached input price.

USD is estimated. `usd_input_micros` is integer millionths of a United States dollar from the price card. `usd_input` is that value divided by 1,000,000. `usd_output_micros` bills `output_stub_tokens_per_api_call` per `api_calls` plus `output_stub_tokens_per_compact_call` per `compact_calls`. `usd_total_micros` is `usd_input_micros` plus `usd_output_micros`.

`api_calls` is policy `cycles` plus `compact_calls`. `tool_calls` is every `read`, including duplicates.

## Slice `freshctx-horizon-v1`

Long sessions and two agents on the same five econ arms and price card. Not a live Pi or Hermes CLI. Not a drop-in adapter.

`long-session` is one scripted agent, `cycle_count` cycles (frozen in `bench/horizon/long-session.json`), at least 8 files. Each cycle reads one path. Every `stale_every` cycles the next read is preceded by a disk edit of that path. FreshCtx `prepare` uses only the last `active_window` `result_id`s (`drop_result_ids`). CORVUS keeps every registered path. The report stores a `by_cycle` array per arm with `working_set_size`, `usd_total_micros`, `cache_miss_tokens`, `stale_leakage`, `freshness_exact`, and `api_calls`.

On this slice `compact_calls` counts cycles where the Pi compacted history prefix changed. `prune_commits` counts cycles where the Hermes pruned history prefix changed. That is how compact and prune fire more than once on a long run. The transformer flag remains 0 or 1 per snapshot.

`cross_agent_stale` is true when agent A's request still contains an observed body that is not on disk because agent B changed the file. Long-session rows set the field to false: there is no second agent. Self-edits stay in `stale_leakage`.

`multi-agent` is two `session_id`s, one workspace. Default CORVUS behavior is `per_agent`: each agent is one CORVUS process with its own registry `S_t`. A shared-registry dump is not in this slice. Agent B files that A never read must not appear in A's FreshCtx selected units. When A drops a `result_id`, that unit leaves the FreshCtx working set and stays in A's CORVUS registry.

## Labels

Numbers produced by this repo are `measured`. Numbers copied from arXiv:2607.22711v1 or from a dated vendor price page are `cited`. This suite does not mark any score `reproduced` against Bedrock, Pi, or Hermes CLI runs.
