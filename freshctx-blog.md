# Keeping a coding agent's context current

A coding agent reads a function:

```js
function total(quantity) {
  return quantity * 10;
}
```

Someone changes the multiplier to `20`. The agent continues its work. What code does it see on its next model call?

The file on disk says `20`. The earlier tool result still says `10`. If the agent's software sends that result again as conversation history, both versions can become part of the task: the current file the tools operate on, and the old file the model reasons from.

The agent can read the file again. Often it does. But that makes freshness depend on the model deciding to repeat a tool call. I wanted to understand what happens if the software maintaining the conversation takes responsibility for refreshing source code instead.

That question became FreshCtx: a local context engine that tracks observed code and rebuilds a current view before the next model request.

The first prototype made five fixed traces substantially smaller. A later, small live-agent experiment delivered current code correctly but completed fewer tasks than the baseline. This article explains the implementation, the measurements, and why those results can coexist.

## A conversation is also a cache

An agent combines a language model with a harness: the program that executes tools, records their results, and constructs the next model request. The model sees the messages supplied in that request. It does not automatically see a later edit to a file mentioned in an earlier message.

A file-read result therefore has two jobs. It records what a tool returned at a particular time, and it supplies source code for future reasoning. Those jobs agree until the file changes.

Keeping the old result is useful for debugging. Reusing it as current source is risky. Adding a new read can leave several versions in the conversation, each correct at a different moment. Compressing the history into a summary can preserve an obsolete fact after the source that justified it has disappeared.

FreshCtx keeps the historical record and constructs a separate view for the next request. The saved conversation retains the original tool result. Only the outgoing copy gets rewritten.

This follows a useful direction explored by [CORVUS](https://arxiv.org/html/2607.22711v1), which registers files and refreshes their contents for later model calls. FreshCtx explores a narrower unit of context: a function or observed region when it can identify one. Its local whole-file comparison is inspired by CORVUS; it is not a reproduction of the paper's agent evaluation.

## From one read to the next request

FreshCtx runs as a persistent Node process beside the agent. A bridge connects it to the host's reader and final request hook. The processes exchange newline-delimited JSON over standard input and output; the engine does not call a model provider.

There are four steps in the normal path:

1. **Observe:** record the exact source bytes returned by a successful read.
2. **Prepare:** resolve the corresponding code in the current workspace and construct a proposed request rewrite.
3. **Validate and apply:** check that the plan matches the host's actual tool results, then rewrite a copy.
4. **Commit:** recheck selected files before allowing that copy to be dispatched.

Consider the `total` function above. The reader gives the model its original body and separately tells FreshCtx where those bytes came from. A shortened observation looks like this:

```json
{
  "op": "observe",
  "result_id": "read-1",
  "path": "price.js",
  "range": { "start_byte": 0, "end_byte": 52 },
  "content_utf8_base64": "<base64 of the exact tool result>"
}
```

The actual envelope also includes the protocol and transport request ID. The range is zero-based and end-exclusive. It uses UTF-8 bytes, so a JavaScript string index is not necessarily a valid offset: an emoji takes multiple bytes. Line numbers added for display are not source bytes either. The bridge must keep that distinction straight.

FreshCtx stores the observed content by SHA-256 revision and records its native tool-result ID. It also assigns a unit identity. These identify different things: the result ID ties a plan to a message; the unit identifies the tracked code; the revision identifies particular bytes.

After the file changes, the bridge asks FreshCtx to prepare a projection using only observations still present in the outgoing request. This matters after context compaction. A forgotten read should not silently reactivate just because its archive still exists.

For the example, the projection is:

```text
price.js:symbol:52bytes
function total(quantity) {
  return quantity * 20;
}
```

The body is 52 UTF-8 bytes. The entire projection, including its header, is 76 bytes. The suffix `bytes` is intentional: a bare trailing number looked too much like a line offset for the reader tool.

In the outgoing copy, the original `read-1` result becomes a short unit marker. The current projection is appended as a user message. Tool-call IDs remain paired, and the saved history still contains `quantity * 10`.

This example is executable:

```sh
npm run demo
```

It starts the real sidecar, observes the function, edits and moves it, prepares the rewrite, checks hashes, and commits. It also checks that the unrelated function in the same file stays out of this projection. It does not call an LLM. The complete client is [examples/request-copy.mjs](examples/request-copy.mjs).

## What counts as the same code?

Refreshing an entire file is straightforward: keep its path and read it again. Refreshing a small part requires deciding what that part is after edits move or reshape it.

FreshCtx uses three kinds of unit:

| Unit | How it is found again |
| --- | --- |
| File | Workspace-relative path. |
| Symbol | A unique declaration selector recovered through Tree-sitter. |
| Region | Observed bytes and surrounding anchors, with relocation heuristics. |

For supported languages, Tree-sitter can turn a range inside a uniquely identifiable function into a symbol observation. Inserting lines above `total` then changes its offsets without changing its selector. FreshCtx can locate the declaration again and project its current body.

This can widen the read. One observed line inside a function may cause the whole function to enter the projection. The implementation is not a promise to return only bytes the model previously saw. Unsupported languages, broken parses, and symbols that can no longer be resolved may also fall back to the current whole file.

A top-level header such as `const RATE = 10` may remain a region. FreshCtx saves nearby byte anchors and tries to identify the corresponding span after edits. This is heuristic identity, with a different failure surface from a unique symbol selector.

Repeated code exposed an especially subtle bug during the audit. Suppose a file contains two identical blocks, and the agent reads the first. Later, the first block changes while the second remains untouched. Searching globally for the old bytes finds a perfect match—in the wrong block.

That is worse than a missing result because the projected text looks credible. The revised resolver uses occurrence information and surrounding anchors, and omits mappings it cannot disambiguate. The regression test checks that refreshing the first block does not substitute its unchanged sibling. More complicated edits can still defeat heuristic identity; omission and a new read remain necessary outcomes.

## Selecting what fits

Resolved units compete for a projection byte budget. The current policy sorts them by observation recency, skips overlapping candidates, and admits units that fit. It does not truncate a function to fill the last few bytes. The selected set is rendered in deterministic path and unit-ID order.

There is no learned relevance score, dependency traversal, or embedding search here. The reader chooses what to observe; the engine maintains those observations. This makes the policy inspectable, but it also means a selected function can arrive without an important import, caller, or surrounding invariant.

The budget includes projection headers and source bodies. It excludes the rest of the conversation, provider JSON, tool definitions, and historical markers. It is not a token limit or a cost estimate.

The protocol also supports whole-file selection. It widens candidates before applying the budget, so a file may no longer fit where its function did. Comparing the two modes requires checking what was actually selected, not just which mode was requested.

## The request must fail as a unit

The bridge verifies each replacement against the exact native result's hash. It checks the projection hash, the budget, and tool-call/result pairing. It must also account for successful source reads that have no saved observation. Otherwise, losing the sidecar's state could silently turn an old read back into ordinary conversation text.

The Pi bridge now blocks that case, including on saved-session resume. Trusted metadata distinguishes a failed read, which contains an error, from a successful source read that should have an observation.

After constructing the copy, the bridge commits the plan. The engine rereads selected files and compares their complete revisions with those used during preparation. If a selected file changed, the host must discard the proposed request.

This is an optimistic check. It does not create an atomic snapshot across several files or lock the workspace until the model receives the request. Concurrent writers and edits after commit remain possible. A host that needs stronger consistency has to provide workspace isolation or its own coordination.

Failures at this boundary also depend on the host. Pi catches errors thrown by extension hooks. Simply throwing from a failed rewrite was therefore insufficient to prevent dispatch. The bridge must abort the active turn. Its tests use real Pi execution and a local HTTP fixture to check that rejected requests never reach the provider endpoint.

A valid plan can still omit code because it was deleted, ambiguous, overlapping, or too large. Its old body is replaced with an unavailable marker. That differs from an invalid plan, where dispatch itself must stop.

## What the first prototype measured

The first experiment used five fixed traces from pinned revisions of Express, Flask, Go tools, and ripgrep. Each trace specified code that the final payload had to retain. The local comparison used a narrow semantic unit on one side and the corresponding whole file on the other.

Replaying the original evaluation helper at research commit `e4b9ae04b63cf3b0cce673e49956cdde7a3595f2` reproduced these totals twice:

| Trace target | Narrow context, bytes | Whole-file context, bytes |
| --- | ---: | ---: |
| Express `createApplication` | 1,075 | 1,778 |
| Flask `View.as_view` | 2,715 | 7,111 |
| Flask nested `view` | 829 | 7,120 |
| Go tools `ContainingPackage` | 1,425 | 6,034 |
| ripgrep `Config.is_fixed_strings` | 2,460 | 14,658 |
| **Total** | **8,504** | **36,701** |

That is **76.8% fewer bytes**, with all five required-code checks passing.

Here, “bytes” means the UTF-8 size of the evaluation's final message-content text, joined with blank lines. It includes the trace's task text, markers, and projected code; it excludes the full provider envelope and tool definitions. Other historical reports use serialized-request measurements and produce different totals. They should not be mixed into this table.

The five checks establish that the fixture-required code survived. They do not establish that every dependency needed by a real task survived. No model solved a task in this experiment, so it says nothing directly about completion rate, billed tokens, or dollar savings. It also measures the first prototype, not a benchmark run of the current package.

## Current code did not guarantee better answers

A later pilot tested five small tasks with Pi 0.85.0 and `deepseek-v4-flash`. Each task had one baseline run and one FreshCtx run. The setup seeded history through real Pi reads driven by a scripted provider, closed the agent session, changed the workspace, and reopened the saved session. The continuation used the live model.

The baseline's first resumed request contained old code in all five cases. FreshCtx's contained the current observed code in all five. The outcome checker told a different story:

| Task | Baseline | FreshCtx | Provider requests, baseline / FreshCtx |
| --- | --- | --- | ---: |
| Rate constant | Pass | Pass | 2 / 5 |
| Moved symbol | Pass | Fail | 2 / 8 |
| Operator shift | Pass | Pass | 2 / 4 |
| Tax base | Pass | Fail | 2 / 8 |
| Quote surcharge | Pass | Pass | 2 / 2 |

The baseline completed **5/5** tasks; FreshCtx completed **3/5**. The two failed FreshCtx runs exhausted their eight-request cap. The baseline could reread the file, so stale initial context did not force a wrong final answer.

The rate task is a useful detail. FreshCtx first computed the correct value, `80`, but surrounded unfenced JSON with prose. The checker rejected that submission. A later submission passed. Reporting only the first rejection would incorrectly turn an eventual success into a failure; reporting only the correct value would hide the extra interaction required to finish.

These are five paired observations, with baseline runs first, not a general model-quality estimate. The treatment also changed the reader description and presentation of source code. The experiment cannot isolate the effect of freshness from formatting or instructions. Its caps, seeded history, and small synthetic tasks further limit the conclusion.

The result still matters. Delivering current bytes and completing a task are separate properties. The first can be checked at the request boundary. The second depends on what the model does with that request, including whether it understands the format, obtains missing context, follows the answer contract, and stops.

A later internal check asked a narrower question: did the real engine put current disk bytes into the request that reached a provider? A Fresh session read `TARGET_RATE = 10`, an external process changed the file to `TARGET_RATE = 12`, and the next request went through the local FreshCtx binary. A capture provider recorded `TARGET_RATE = 12`, not `10`, with no second read. The same sequence with FreshCtx off retained `10`. Two native sessions also ran concurrently with separate workspaces, sessions, ports, and FreshCtx state directories; their plans did not cross.

That establishes request freshness for that path. It does not establish better model outcomes, lower cost, or a general performance gain.

The fail-closed result is narrower still. A supported host hook that tampered with a read result blocked the next provider dispatch before it was sent. The engine's ordinary file-deletion path instead reports an invalidated unit and still allows a request. We have not produced a real-engine disk mutation that both blocks dispatch and records a `WRONG` revalidation verdict.

One region-versus-file task with DeepSeek V4 Flash also remains incomplete evidence. The region arm completed and recorded 367 projection bytes against a 19,402-byte whole-file counterfactual. The file arm completed too, but its persisted plan still reported `region` selection with the same byte counters, so it did not exercise file selection. The next check is a protocol trace from the active setting through `prepare` to the persisted plan.

## Building on this

The current repository is a foundation for studying that boundary. Its [protocol reference](docs/protocol.md) describes identities, exact-byte observations, retries, budgets, and failure behavior. The [contributor guide](CONTRIBUTING.md) maps those concepts to the implementation and its checks.

The root package has no runtime npm dependencies to install, but it does bundle third-party Tree-sitter assets with licenses and checksums. Host integrations keep their dependencies separately. Pi has a pinned real-host test path. The OpenHands directory currently contains request fixtures and a wrapper; it does not yet establish compatibility with a real OpenHands agent and condenser.

Three follow-up experiments would make the evidence more useful:

1. Hold reader instructions and projection formatting constant while varying only whether source is refreshed. Repeat paired runs and record failure categories.
2. Compare regions, symbols, and whole files on tasks where dependencies matter. Record omissions alongside completion, rather than rewarding smaller payloads by themselves.
3. Measure complete provider requests, token usage, cache behavior, latency, and outcomes together. A smaller projection alone cannot establish the tradeoff.

FreshCtx also leaves stale assistant explanations and compaction summaries untouched. Refreshing a source function does not retract an earlier conclusion about it. That is a separate problem, and a good reason to keep the claims here narrow.

I started with an old tool result and a changed file. The useful artifact is now an explicit boundary: recorded history on one side, the current source view sent to a model on the other. That boundary gives future experiments something concrete to inspect, change, and measure.

---

*Evidence and reproduction details are recorded in [PUBLICATION_AUDIT.md](PUBLICATION_AUDIT.md). The historical evaluation sources and live-run records are in research checkouts that still need an approved, reader-accessible release before this article is published.*
