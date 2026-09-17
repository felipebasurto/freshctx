# Host bridges

The product is the root package. Bridges live under `bridges/<host>` with
separate manifests, dependencies, and tests. Their development dependency is
`file:../..`; the product tarball excludes bridges and their dependencies.

| Bridge | Verified boundary |
| --- | --- |
| [Pi](pi/README.md) | Pi 0.85.0, `openai-completions`, real tool execution and HTTP serialization against a local scripted provider; saved-session resume and rejected-request cancellation. |
| [OpenHands](openhands/README.md) | Node and Python request-rewriting fixtures and an LLM wrapper. No pinned OpenHands agent or real condenser integration test. |

Read the [protocol contract](../docs/protocol.md) before implementing a host.
The host must identify every successful source read, preserve tool identities,
apply the complete plan to an outgoing copy, and cancel dispatch when validation
fails. Compatibility with one request format does not establish compatibility
with another host.

Pi was imported from freshctx-pi commit
`3ac73c21710199d96be0f2ea2021b59c8de41aa0`. The former repository and its
v0.1.0 tag remain historical provenance. Development continues here.

Publication remains disabled in all manifests. Releasing bridge packages would
require replacing local `file:` dependencies with tested product versions and
validating the installed artifacts. Local fixtures establish transport behavior;
model outcomes and frozen benchmark records remain in the research repositories.
