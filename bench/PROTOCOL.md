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

On this slice FreshCtx `freshness_exact` 11 of 12 is not a public loss. The miss is budget 0: gold wants the file, the projection is empty by design. Do not edit gold or emit the file at budget 0. Do not change `freshness()` so empty plus budget 0 counts as exact; that is a new slice id. CORVUS dumps the file and fails `budget_ok`. Do not chase 12 of 12 on v1.

`last_known_in_request` is true when a stale observed body appears as a history `body` entry or as the full content of a selected live unit.

`budget_ok` is true when `live_block_bytes` is less than or equal to `budgetBytes`. `corvus_full_file` has no budget and still reports the flag.

`prompt_bytes` is the UTF-8 byte length of the serialized request (history plus live block).

`live_block_bytes` is the UTF-8 byte length of the live block only.

`payload_bytes` is the UTF-8 byte length of selected unit `content` inside that live block. When the live block is empty, `payload_bytes` is 0.

`envelope_bytes` is `live_block_bytes` minus `payload_bytes`, floored at 0. It is the wrapper around current bytes (path labels, length-prefixed headers). History markers are not in this field. They sit in `prompt_bytes`.

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

Five-way USD ranking is retired on purpose. Addon-v2 is the public long-session claim. Do not retain dropped `result_id`s to undercut CORVUS USD. Do not flip `drop_result_ids` on the horizon fixture. Horizon USD versus CORVUS is not a public loss. Do not chase it.

`cross_agent_stale` is true when agent A's request still contains an observed body that is not on disk because agent B changed the file. Long-session rows set the field to false: there is no second agent. Self-edits stay in `stale_leakage`.

`multi-agent` is two `session_id`s, one workspace. Default CORVUS behavior is `per_agent`: each agent is one CORVUS process with its own registry `S_t`. A shared-registry dump is not in this slice. Agent B files that A never read must not appear in A's FreshCtx selected units. When A drops a `result_id`, that unit leaves the FreshCtx working set and stays in A's CORVUS registry. FreshCtx `selected_paths` follow render order (`path` then `id`). That reorders the `b-edits-a-read` FreshCtx path list versus recency; USD and miss tokens are unchanged. Do not treat that as a new horizon slice.

## Slice `freshctx-addon-v1`

Retired rotating-window pair slice. It reused `bench/horizon/long-session.json` including `drop_result_ids` / `active_window` 3, so FreshCtx `prepare` saw only the last three `result_id`s. Numbers stay in git history. The public with-versus-without claim moved to `freshctx-addon-v2`. Compose order `freshctx_then_host` did not change.

Paired with-versus-without on the same host. FreshCtx is an add-on a harness attaches. It does not replace Pi compact or Hermes prune. Frozen host conversation turns are `host_turn_bytes` 512 per read so compact/prune still have history to rewrite after tool bodies become markers.

### Compose order `freshctx_then_host`

Frozen. Do not invert it in this slice or in `freshctx-addon-v2`.

1. The host builds a native request: conversation turns plus tool-read bodies.
2. FreshCtx `observe` during reads, then `prepare`/`apply` on a copy. Still-present `result_id`s become markers. The live projection is attached. Compact and prune have not run yet.
3. The host engine may still compact or prune **history** (turns, stubs, markers). The live block is unchanged.

If a combined arm disables prune or compact, the row is invalid. Markers are tiny, so prune mostly eats old conversation; freshness is the live projection for still-active `result_id`s. If the host also dropped a `result_id`, FreshCtx omits it.

Pi compact may drop ids from **history** after prepare. The next cycle still prepares from native `result_id`s still in the request because compose order is FreshCtx first. Do not invert to prune-first.

### Pairs

Each report row is one host:

- `today_tool_history` vs `today_tool_history+freshctx`
- `pi_compact` vs `pi_compact+freshctx`
- `hermes_prune` vs `hermes_prune+freshctx`

`compact_calls` and `prune_commits` must still increment on the with-FreshCtx long-session arm (`>= 2` on 64 cycles). USD is with versus without on that host. Hermes winning USD by stubbing is not a FreshCtx loss.

Optional add-on pair on today's host: `today+corvus` vs `today+freshctx`. CORVUS is a competing add-on, not a compact clone. Do not score CORVUS against prune.

### What “better” means

Say better only on metrics the JSON wins **inside a pair**. `stopped_stale_leakage` is true when without leaked and with did not. `restored_freshness_exact` is true when with is exact and without is not. Never rank FreshCtx against prune as rival methods. Slice `freshctx-horizon-v1` remains on disk as the earlier five-way bake-off; do not treat those USD totals as the public with-versus-without claim.

Layer A stays a model-free leak test: freshness transformer vs append-only vs CORVUS. Layer A 11 of 12 and horizon-v1 USD versus CORVUS are not public losses. Do not chase them. Compact/prune-with USD above compact/prune-without is the live-block freshness cost, not a ranking to invert.

## Slice `freshctx-addon-v2`

Current public with-versus-without slice. Same hosts, compose order, price card, 60s / 512MB budget, `host_turn_bytes` 512, and multi-agent stories as v1. Writes `bench/results/addon.json`. Does not overwrite `bench/results/horizon.json`.

### Host-present `result_id`s

Addon `prepare` uses every `result_id` still in the native request (`prepare_result_ids: "host_present"`). On today's host that is every observation; the same list is visible at prepare time because FreshCtx runs first. Do not apply `long-session.json`'s `drop_result_ids` / `active_window` 3 here. That rotating window remains the retired five-way bake-off in `freshctx-horizon-v1` / `bench/run-horizon.mjs`.

Gold for with-FreshCtx is the unique paths of those host-present ids (plateau at `file_count`, 8 on this fixture). Recency still wins **selection** (newer symbol over older file; budget fill). After the selected set is frozen, **render** is `path` then `id` so a stable membership and disk produce byte-identical LIVE UTF-8. The live frame is length-prefixed and has no selected/omitted counts, so a metadata-only header change cannot bust suffix identity.

Story `a-drops-result-id` remains the explicit drop case (`activeResultIdsA`).

If the suffix is byte-identical to the previous cycle, suffix tokens are cache hits. A rotating trio or recency-shuffled XML misses the whole suffix at the uncached input price.

### What “better” means

Unchanged from v1. Say better only inside a pair. Do not assert FreshCtx is cheaper than Hermes prune unless the frozen JSON is; prune stubs can still win USD. Do not claim cheaper than compact or prune unless the JSON is. Compact/prune-with still must be `freshness_exact` and still fire. The miss-tax claim is that with-FreshCtx `cache_miss_tokens` sit in band with `today+corvus`, not at the rotating-window v1 hole. Do not add a compose-order slice to invert that tax.

## Labels

Numbers produced by this repo are `measured`. Numbers copied from arXiv:2607.22711v1 or from a dated vendor price page are `cited`. This suite does not mark any score `reproduced` against Bedrock, Pi, or Hermes CLI runs.
