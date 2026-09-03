# How to run the FreshCtx bench

From the repository root:

```sh
npm run bench:layer-a
npm run bench:mva
npm run bench:announce
```

`bench:layer-a` writes `bench/results/layer-a.json` for slice `freshctx-layer-a-v1`.
`bench:mva` writes `bench/results/mva.json` for slice `freshctx-mva-v1`.
`bench:announce` fails if [ANNOUNCEMENT.md](ANNOUNCEMENT.md) contains an integer that is not in those reports, or if the cited report SHA-256 values do not match the files on disk.

Expected SHA-256:

- `bench/results/layer-a.json` sha256:610ac6e10a1fa82aa93845abed8c0700188f573e176020b438f77c13531efbed
- `bench/results/mva.json` sha256:ec6211e2a52bf01c696f5a2ad7758aa6a0c00b6aea74b3139b5ce7aa6988f28a

Raw stdout from extra probes goes in `bench/results/raw/`, which git ignores. Metric names are in [PROTOCOL.md](PROTOCOL.md).

Do not edit fixture gold to chase a score. Do not change `src/` while scoring. `npm run pack:check` must keep `bench/` out of the npm tarball.
