# Bridges in one repository

The product package stays at the repository root. Maintained bridges live in
`bridges/<host>/`, each with its own manifest, dependencies, and host tests.
They share product changes through a local `file:../..` development dependency.
No root workspace install or host dependencies are needed to use the core.
The fixed product tarball allowlist excludes this entire directory.

Pi and OpenHands are the maintained integrations. Future hosts go here when
their actual hooks can support the contract. Reuse transport or request-format
code when a second real caller needs it; do not build a speculative adapter
framework. Sharing an API request format does not prove another host is
compatible.

## Migration and publication

Pi was imported from freshctx-pi commit
`3ac73c21710199d96be0f2ea2021b59c8de41aa0`. The old private repository and its
v0.1.0 tag remain as historical provenance. Development continues here.
No tags were moved or deleted. Both package manifests prevent npm publication.
Private collaborators install from a checkout; there is no public install promise.

If publication is later authorized, independently built bridge packages can be
released from these directories with exact product version dependencies. Their
development `file:` dependencies must first be replaced and the resulting
tarballs tested. This layout does not require one GitHub repository per host.

## Current priority and evidence

The first priority is preventing rejected plans from sending stale code. The
v0.1.0 Pi bridge discarded failed plans but continued dispatch. A real Pi HTTP
fixture reproduced that behavior after a native result was changed by another
extension. The maintained bridge cancels the active request instead. Tests check
that only the initial request reaches HTTP, and Pi ends the turn as aborted,
both for an altered result and for a child process killed after a read.

This is a correctness improvement on Pi 0.85.0's Chat Completions path. It is
not an LLM evaluation or evidence of SOTA. Frozen bench scores are unchanged.

Next work should test semantic freshness under line insertions, deleted symbols,
compaction, and resume in paired task fixtures with externally checked answers.
Record omission, stale evidence, successful completion, and request cost
separately. Freeze task definitions and scoring before evaluating changes. A
header-only read must not be judged as evidence that an unread function is absent.
OpenHands is the preferred next live harness (real agent plus summarizing
condenser). Its bridge rewrites the already-condensed model-bound copy so the
current projection stays eligible. That host test is request-level; it is not
an LLM evaluation. Broader claims need repeated real-provider task results and
a documented comparison baseline; the deterministic transport demos alone
cannot justify a public launch.
