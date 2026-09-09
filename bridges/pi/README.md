# FreshCtx for Pi

Bridge for [FreshCtx](https://github.com/felipebasurto/freshctx) on
[`@earendil-works/pi-coding-agent@0.85.0`](https://github.com/earendil-works/pi).
`openai-completions` only. Replaces Pi's `read` with an exact-byte reader,
talks `freshctx/1`, rewrites a copy of the Chat Completions request. Saved
Pi history is unchanged.

```sh
pi -e /absolute/path/to/freshctx/bridges/pi/extension.js
```

Load this last. Do not combine with other request rewriters or read
overrides. On timeout, bad format, tamper, or failed commit the bridge
calls `ctx.abort()` and prints **FreshCtx blocked**. It does not send the
original request.

```sh
npm ci --prefix bridges/pi
npm test --prefix bridges/pi
npm run demo --prefix bridges/pi
```

`npm run demo:resume` is a saved-session check (stale vs current function,
deterministic HTTP consumer, no LLM). See `npm test` for the full fixture
list.

MIT. Felipe Basurto, [felipebasurto.com](https://felipebasurto.com).
