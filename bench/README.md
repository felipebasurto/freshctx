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

- `bench/results/layer-a.json` sha256:70abb1852a4c62b0d1c1882986f63caaadc2f6147f33df7c225dfd6277271596
- `bench/results/mva.json` sha256:ec639c64e4019cc53c1ed1b7b28144ebb7306186b929046c89804a4c5d426211
- `bench/results/econ.json` sha256:9ccdb214afe3710392cb3015aa441f04ba50454538eb1a86acf989ebe37511af
- `bench/results/horizon.json` sha256:7aff32fb71b24086dbe004f26858b210ea647b4602b6ec45d04a6a3f9bdeb16e
- `bench/results/addon.json` sha256:d7ff61da9dead1fc01341254e9a66c5be9190fa69fced1f6f0ebf5f4e465a314

Raw stdout from extra probes goes in `bench/results/raw/`, which git ignores. Metric names are in [PROTOCOL.md](PROTOCOL.md).

Do not edit fixture gold to chase a score. Do not change `src/` while scoring. `npm run pack:check` must keep `bench/` out of the npm tarball.
