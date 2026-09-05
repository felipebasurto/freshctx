# FreshCtx development policy

FreshCtx stays private while its substance improves. Do not make repositories
public, publish npm packages, create a public launch, or distribute promotional
material without Felipe's new explicit authorization. Existing tags and release
history are preserved. The intended public launch is Felipe's technical blog
post after the evidence supports the story.

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
`npm test --prefix bridges/pi`. HTTP fixture tests need loopback access, not
provider credentials. Leave pre-existing untracked bench logs alone.
