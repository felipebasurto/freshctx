# Publication readiness audit

Reviewed 14–16 September 2026. Code fixes and the article are prepared locally
on `codex/publication-readiness`, based on `release/private-remediation`
(`5c34a21c5793deb5be6c239c041aab02140ba7c7`). The original checkout and its
pre-existing draft edits were preserved. Temporary worktree contents were
restored from recorded patches into `.worktrees/publication-readiness` after
the temporary directory was cleared; all required checks were rerun there.

The implementation is suitable for further bounded experiments. It is not
validated as a general agent-quality improvement. Public publication still
requires the evidence-access decision described below.

## Findings and disposition

| Priority | Finding | Resolution and evidence |
| --- | --- | --- |
| P1 | Refreshing an edited region could select an unchanged duplicate elsewhere. A previous test explicitly accepted this wrong occurrence. | Resolve surrounding anchors before global matches; track occurrence multiplicity; distinguish identical fingerprints at different offsets; omit ambiguous mappings. `src/relocate.mjs`, `src/session.mjs`; duplicate-region and persisted-identity regressions. |
| P1 | Pi could dispatch a successful native read without any saved FreshCtx observation, including after state loss on resume. | Check read coverage using native call names and trusted error metadata; abort rejected turns. Real Pi HTTP regression proves no resumed dispatch after state deletion. `bridges/pi/src/bridge.mjs`, `extension.js`, `test/pi.test.mjs`. |
| P1 | Python's declared timeout did not bound blocking `readline()` or writes; the async wrapper blocked its event loop. | Deadline covers lock acquisition and the exchange; timeout kills and invalidates the client. Async rewrite uses a worker thread. Subprocess tests bound stalled reads and writes; an async test checks event-loop responsiveness. |
| P2 | An observation of a missing file persisted a v2 unit without identity and could make the next session fail validation. | Persist file identity; reconstruct early v2 identity only if its path hashes to the stored ID. Regression reopens and refreshes the file. |
| P2 | Missing region fingerprint could throw and invalidate preparation for otherwise valid observations. | Treat missing/malformed fingerprint revisions as unresolved; test keeps a valid sibling observation. |
| P2 | Whitespace escaped the JSONL frame-size limit. | Count raw UTF-8 frame bytes before trimming, including the EOF path; regression covers both. |
| P2 | Legacy cached plans survived identity migration with old markers or quarantined identities. | Discard pending and committed legacy plans while retaining the archive and proven aliases. Migration test requires a new prepare. |
| P2 | Pi retained its child across session/workspace changes. | Restart when either changes; normal host, shutdown, and resume suites pass. A live in-app session-switch interaction was not separately exercised. |
| P2 | Root syntax check passed multiple paths to `node --check`, which checked only its entry file; packaging checked contents but never executed the extracted artifact. | Check each source separately; preserve the strict allowlist and checksums; run packed `doctor` and the real observation/edit/prepare/commit example. |
| P2 | Docs claimed actual OpenHands/condenser coverage, richer audit hooks, and a removed `verify` command; several PCR links pointed to absent files. | Rewrite bridge docs to match current callable APIs and fixture coverage; remove dead links and obsolete changelog claims. |
| P2 | Article mixed prototype metrics and later implementations, overstated freshness guarantees, and misreported the rate-task outcome. | New draft explains the byte path and failure boundary, attributes the five-trace measurement to its original implementation, reports the eventual rate-task pass, and retains the negative live result. |

The pre-fix baseline passed 89 core tests. Four new failure-path regressions
failed against that baseline before remediation. Passing the old suite alone
therefore did not establish these properties. The final core suite has 94 tests.

## Remaining limits

- Region identity is heuristic. Arbitrary edits, duplicate surroundings, and
  refactors are not solved by the regression fixes. Unknown legacy region
  multiplicity can require a new read.
- Symbol selection can widen a partial read to a whole declaration. Failed
  parsing or lost symbols can fall back to the whole current file. Smaller
  context is not guaranteed for every read or budget.
- Commit revalidates selected files individually. It does not provide a
  coherent multi-file snapshot or prevent edits between validation and dispatch.
- Recency and overlap drive selection. There is no relevance ranking or
  dependency closure. Summaries, assistant prose, shell output, and other
  unobserved text can remain stale.
- OpenHands is an integration prototype. Before claiming host support, pin an
  actual version, connect exact source reads, classify all successful source
  results, and test real condenser and dispatch behavior. The generic wrapper
  alone cannot prove read coverage.
- Historical blobs and committed plan records grow until explicit cleanup.
  This is documented, not bounded by online garbage collection.
- The tests ran on macOS with Node 22.22.3 and Python 3.9.6. Linux CI is
  configured but was not executed remotely for this local branch.

## Reproducible evidence for the article

### Original five-trace measurement

Source checkout: `/Users/felipe/Proyectos/freshctx-research`, commit
`e4b9ae04b63cf3b0cce673e49956cdde7a3595f2`. The recorded target values also appear
in `docs/CORVUS_MAPPING.md` and
`docs/lab/pcr/0130-corvus-equivalents-skip-inventory.md`.

The read-only helper was run twice and its stable records matched:

```sh
node --input-type=module <<'NODE'
import {runEmpiricalEvaluation, stableEvaluateRecord} from './bench/empirical-verdict.mjs';
const a = await runEmpiricalEvaluation();
const b = await runEmpiricalEvaluation();
if (JSON.stringify(stableEvaluateRecord(a)) !== JSON.stringify(stableEvaluateRecord(b))) {
  throw new Error('Evaluation changed between runs');
}
console.log(JSON.stringify(stableEvaluateRecord(a), null, 2));
NODE
node scripts/holdout-verify.mjs --pack=holdout-v0.3-apex
```

Run from that research checkout with its existing parser dependencies. This
reproduces the bounded metric; it is not a claim to have rerun the entire
historical `npm run evaluate` regression gate.

Result: candidate **8,504**, local `corvus-file` baseline **36,701** final text
payload bytes; **5/5** required-code hits. Reduction:
`(36701 - 8504) / 36701 * 100 = 76.828969...%`, rounded to **76.8%**.
The five rows and upstream commit pins are returned by the helper.

Metric path: `bench/empirical-verdict.mjs` → `bench/trace-runner.mjs` →
`bench/baselines.mjs`. It counts message-content text joined with `\n\n`, not
the complete provider request. The raw `reports/results.jsonl` path uses a
different serialized-request measurement and totals 9,785 / 38,533. A later
research README reports 8,589 / 36,701. Neither substitutes for the reproduced
8,504-byte result from this first-version checkout.

The project verifier returns `valid: true`, classification `locally-frozen`,
no errors, and no remote attestation. The result-set hash is computed over
normalized records; comparing it directly with a raw file hash is invalid.

| Verification field | Value |
| --- | --- |
| Manifest | `5698bb3b17366abdfa9aecd5e23ada7bc65a51f3de56b16f57b356160ceb67cb` |
| Freeze commit | `2156615d4bf7ecc4b88362d229d968518e7bc128` |
| Trace set | `3a934627f82bea5533dc871ba8f7dbaee220ca8f03f0edcd2c16a4afa774be87` |
| Normalized result set | `ecce39269b66c302f0cd4bf198df3646a3926201408ca89e59f519750fe66f74` |
| Report | `d7ebbedfa376db07e944ad834eb4c5937b2bb7424e49b814bf1a800e40163a86` |

### Five-task live pilot

Source checkout: `/Users/felipe/Proyectos/freshctx/outcome-research`, inspected
at `6e35334771cbd7d1715d6a7d28c10bddb49a392c`. Evidence lives under
`labs/pi-outcome-v1/`; see `README.md`, `RESULTS.md`, the frozen tasks/checker,
and the following raw records. No new provider calls were made in this audit.

| Task | Record | SHA-256 |
| --- | --- | --- |
| rate-constant-v1 | `live-1788614404231.json` | `270457eeb3e1017a495412c94c632792d390bb47d15dd71b3b734f3165d24a99` |
| moved-symbol-v1 | `live-1788623217761.json` | `d01ed561c4b8115db80e56f254aff53f01a5108a933945409e56e2adfc7b212b` |
| operator-shift-v1 | `live-1788623234679.json` | `b2b807d23ee533b5448e934edb1ab6fa7d426b6a5f867f690e91ef5b8dd25550` |
| tax-base-v1 | `live-1788623248484.json` | `9ae520c71561d552245f7122f0e5bf783c0a684eed09f6b80ef3bd1bdf0ad827` |
| quote-surcharge-v1 | `live-1788623270229.json` | `7ef5e5d888f27dc2ee0b76c72ab9b9106888b957406f8eb65381d877cbd860ff` |

Product at measurement: `3e3c4489969fbe02b7313b666767651d1faf133c`; Pi 0.85.0;
requested and returned model `deepseek-v4-flash`; recorded 5 September 2026.
Research SHA was `7c2d0ebec4155f7bdc973a8ed5110cbbd5f852ac` for rate-constant
and `b4f844d48540a649fc0da82415c23fb7eb0d1a29` for the remaining four.
One pair per task, baseline first, temperature 0, thinking disabled, 512 output
tokens, at most eight requests and two submissions per arm. The treatment
includes its reader description and formatting. Only post-resume calls use
the live model; seeded history uses real reads with a scripted provider.

All five baseline first requests contained stale observed code; all five
FreshCtx first requests contained current observed code. Within the attempt
limits, baseline passed 5/5 and FreshCtx 3/5. The rate task passed after a
formatting retry. Moved-symbol and tax-base exhausted the request cap.
The earlier diagnostic pair `live-1788612329848.json` failed both arms under
the original task/checker and remains separate from these later frozen tasks.
It is preserved, not silently converted into a success or merged into the table.

The draft excludes other SWE figures and the old internal region/file
comparison because they were not established as controlled, comparable results
in this audit. It makes no general Pass@1, SOTA, dollar-saving, or causal claim.

## Final validation

All passed after restoring the worktree:

- Core: `npm run check`, `npm test` (**94/94**), `npm run pack:check`,
  `npm run demo`. Tarball: 28 allowlisted files and eight verified parser assets;
  extracted CLI passes doctor and the observation/edit/prepare/commit scenario.
- Pi: clean pinned install, syntax check, and **17/17** tests, including real
  loopback HTTP dispatch, resume, modified-result rejection, dead child, and
  missing-state cancellation. No live model.
- OpenHands: clean install, syntax checks, **13/13** Node fixtures and **5/5**
  Python tests. No real OpenHands host or model.
- Research: two matching stable first-version evaluations and a passing frozen
  pack verifier. Existing modified/untracked research files were left unchanged.

## Publication decision

The configured product GitHub repository was already public when inspected,
while the development policy requires keeping new work private. This audit
changed no visibility, tags, frozen reports, or publication flags and did not
push the branch or create a public PR.

Before publishing the article, authorize a reader-accessible research release
or a scoped evidence bundle containing the referenced code, pinned fixtures,
checker, and original run records after reviewing them for publication. Keep
research outside the product tarball. Replace the draft's final editorial note
with those stable links. Hashes and tables alone do not let readers reproduce
an experiment whose inputs remain private.
