# FreshCtx development policy

Source is public. Do not `npm publish`. Keep `private: true` on the product
and both bridges.

The product is the root package. Host integrations live in `bridges/<host>/`
with their own manifests. Do not add bridge dependencies to the root package
or weaken `pack:check`.

No unmeasured SOTA, Pass@1, dollar savings, or closed-host compatibility claims.

Core: `npm run check`, `npm test`, `npm run pack:check`. Pi / OpenHands:
`npm ci`, `npm run check`, and `npm test` in that bridge prefix. HTTP
fixtures need loopback, not provider keys.
