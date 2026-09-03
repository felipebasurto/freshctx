# How to run the FreshCtx bench

From the repository root:

```sh
npm run bench:layer-a
npm run bench:mva
npm run bench:econ
npm run bench:horizon
npm run bench:addon
npm run bench:announce
```

`bench:layer-a` writes `bench/results/layer-a.json` for slice `freshctx-layer-a-v1`.
`bench:mva` writes `bench/results/mva.json` for slice `freshctx-mva-v1`.
`bench:econ` writes `bench/results/econ.json` for slice `freshctx-econ-v1`.
`bench:horizon` writes `bench/results/horizon.json` for slice `freshctx-horizon-v1`.
`bench:addon` writes `bench/results/addon.json` for slice `freshctx-addon-v1`.
`bench:announce` fails if [ANNOUNCEMENT.md](ANNOUNCEMENT.md) contains an integer that is not in those reports, or if the cited report SHA-256 values do not match the files on disk.

Expected SHA-256:

- `bench/results/layer-a.json` sha256:610ac6e10a1fa82aa93845abed8c0700188f573e176020b438f77c13531efbed
- `bench/results/mva.json` sha256:ec6211e2a52bf01c696f5a2ad7758aa6a0c00b6aea74b3139b5ce7aa6988f28a
- `bench/results/econ.json` sha256:d5fdd0573f9ed216438a3475b3beac83e57702ded02335f231a3984c34b5515c
- `bench/results/horizon.json` sha256:d46b90586affc8e02ba34ca99a12cf8081abe45e4952e7cc5ddd2e7bb68c5f80
- `bench/results/addon.json` sha256:18fce83eebec1ddaf515a9d3471d2f9e65a2ed1f6c4fee828d384763e6c3bccc

Raw stdout from extra probes goes in `bench/results/raw/`, which git ignores. Metric names are in [PROTOCOL.md](PROTOCOL.md).

Do not edit fixture gold to chase a score. Do not change `src/` while scoring. `npm run pack:check` must keep `bench/` out of the npm tarball.
