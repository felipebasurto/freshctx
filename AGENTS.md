# FreshCtx development policy

This repository is the maintained engine. The technical article lives on
Felipe's site and is not stored here. Measurements stay in freshctx-research,
which may be read publicly. freshctx-bench stays private. Do not publish npm
packages, make additional repositories public, or distribute further
promotional material without Felipe's explicit authorization. Existing tags
and release history are preserved.

The product is the root package. Maintain host integrations under `bridges/<host>`
with separate manifests and tests. Do not create a repository per harness.
Do not add bridge dependencies to the root package or weaken `pack:check`.
Keep `private: true` in product and bridge manifests until publication is authorized.

Benchmarks remain in freshctx-bench and research remains in freshctx-research.
Do not change frozen reports, research counts, or claims to improve appearances.
No unmeasured SOTA, Pass@1, dollar savings, or closed-host compatibility claims.

For changes, run the relevant actual artifact or host test. Core changes require
`npm run check`, `npm test`, and `npm run pack:check`. Pi changes additionally
require `npm ci --prefix bridges/pi`, `npm run check --prefix bridges/pi`, and
`npm test --prefix bridges/pi`. OpenHands changes additionally require
`npm ci --prefix bridges/openhands`, `npm run check --prefix bridges/openhands`,
and `npm test --prefix bridges/openhands`. HTTP fixture tests need loopback
access, not provider credentials. Leave pre-existing untracked bench logs alone.
