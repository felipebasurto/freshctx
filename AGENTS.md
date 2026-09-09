# FreshCtx

The product is the sidecar in this repository. Do not add host plugins,
installers, or compatibility shims. Do not `npm publish`. The public
contract is JSONL over `freshctx serve --stdio`. README starts at clone
and `doctor`. Host wiring stays a few sentences.

No SOTA, Pass@1, dollar-savings, or “works in Cursor” claims.

`npm run check && npm test && npm run pack:check`.
