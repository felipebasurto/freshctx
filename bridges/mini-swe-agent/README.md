# Mini-SWE-Agent integration

Mini-SWE-Agent has one tool, `bash`, so FreshCtx must observe shell reads. This
bridge wraps a Mini-SWE-Agent model and environment (tested with
`mini-swe-agent==2.4.1` and its tool-call `LitellmModel` message format). It was
written for SWE-Touch's host-side runner, where the agent loop runs on the host
and commands run in a remote sandbox.

## What it does

1. **Mirror.** FreshCtx needs a local workspace. The bridge keeps a host copy of
   only the files it has observed. Before an allowlisted read runs, it copies
   that file from the sandbox; before each model request, it refreshes every
   observed file. The mirror is the FreshCtx workspace root.
2. **Observe shell reads.** Allowlist, one command with no side effects,
   optionally after `cd DIR &&`: `cat F`, `cat -n F`, `nl -ba F`,
   `sed -n 'A,Bp' F`, `nl -ba F | sed -n 'A,Bp'`, `head -n N F`, `tail -n N F`.
   The bridge renders what the command prints from the mirrored bytes
   (numbered views use `%6d<TAB>`) and observes the raw bytes of that line range
   only if the output matches exactly. Missing, non-UTF-8, failed, elided
   (10,000 characters or more in `mini.yaml`) or mismatching output is skipped,
   never guessed. `cat F`, `cat -n F` and `nl -ba F` observe the whole file.
3. **Rewrite the outgoing copy.** Each observed read's output is replaced with
   its FreshCtx marker inside the same observation message (re-rendered with
   the agent's own template), the projection is appended as a user message, the
   plan is committed, and only then is the request dispatched. If a native
   observation changed or an observed read has no replacement, the request is
   refused (`FreshCtxBlocked`). The saved trajectory is unchanged. An
   optional audit file keeps the full outgoing copy of the first request and
   of the two requests after each intervention.
4. **Coverage log.** For each applied intervention reported by the host, the
   bridge records whether the changed bytes lie inside the selected units of the
   next plan (`full`, `partial`, `none`).
5. **Notice arm.** With `notice=True`, each applied intervention adds one
   message to the next request only, in the outgoing copy:
   `[Note: <path> was changed outside this session after your earlier work. The change:`
   followed by a fenced unified diff with 3 lines of context and `]`.

Modes: `off`, `shadow` (observe and prepare for coverage, dispatch the native
request) and `rewrite`. Events go to a JSONL log (`command`, `request`,
`intervention`, `coverage`).

Shell outputs that are not allowlisted reads (for example `grep -n`) stay native
and are not refreshed. Only the observed range is tracked: an edit next to, but
outside, what the agent read is not projected.

## Host contract

```python
from freshctx_mini import FreshCtxEnvironment, FreshCtxModel, MiniBridge, observation_renderer

bridge = MiniBridge(mirror_root=tmpdir, repo_root="/testbed", internal_exec=env.internal_exec,
                    mode="rewrite", log_path=logs / "freshctx.jsonl")
agent = AgentClass(FreshCtxModel(model, bridge), FreshCtxEnvironment(env, bridge), **config)
bridge.render = observation_renderer(model, agent)
```

`internal_exec(command, cwd) -> (stdout, returncode)` must run in the sandbox
without counting as an agent command. An environment may expose
`drain_interventions()` returning `{patch_applied, patch_diff, intervention_index,
scenario_id}` events. The Python JSONL client is shared with the OpenHands
bridge (`../openhands/freshctx_openhands.py`).

## Run the tests

```sh
npm run check --prefix bridges/mini-swe-agent
uv run --no-project --python 3.12 --with mini-swe-agent==2.4.1 \
  python -m unittest discover -s bridges/mini-swe-agent/test -v
```

`test_shell_reads.py` compares the rendering with the real `cat`, `nl`, `sed`,
`head` and `tail` on the machine. `test_agent.py` runs Mini-SWE-Agent's
`DefaultAgent` with a scripted model on a local git repository, applies a user
patch after a read, and checks markers, projection, commit, coverage and the
notice byte for byte. No model credentials or Docker are needed.
