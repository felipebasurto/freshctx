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
`bench:addon` writes `bench/results/addon.json` for slice `freshctx-addon-v2`.
`bench:announce` fails if [ANNOUNCEMENT.md](ANNOUNCEMENT.md) contains an integer that is not in those reports, or if the cited report SHA-256 values do not match the files on disk.

Expected SHA-256:

- `bench/results/layer-a.json` sha256:610ac6e10a1fa82aa93845abed8c0700188f573e176020b438f77c13531efbed
- `bench/results/mva.json` sha256:ec6211e2a52bf01c696f5a2ad7758aa6a0c00b6aea74b3139b5ce7aa6988f28a
- `bench/results/econ.json` sha256:d5fdd0573f9ed216438a3475b3beac83e57702ded02335f231a3984c34b5515c
- `bench/results/horizon.json` sha256:e92b7df3b82fa4e33d305bcfdf3a772a8101c607ea4122e8dc0f53447fb77421
- `bench/results/addon.json` sha256:c5e0a64d805dd374c2d1972c62de7e19e6b2b2c2982e312a3ae2bad3dc1b411f

Raw stdout from extra probes goes in `bench/results/raw/`, which git ignores. Metric names are in [PROTOCOL.md](PROTOCOL.md).

Do not edit fixture gold to chase a score. Do not change `src/` while scoring. `npm run pack:check` must keep `bench/` out of the npm tarball.
