# FreshCtx explainer video

A narrated, Manim-animated explainer for the article
[Model context is not static](https://felipebasurto.com/blog/model-context-is-not-static/).
It is not part of the product package and is not listed in `package.json` `files`.

Chapters:

1. The problem: an old tool result says `10`, the file on disk says `20`.
2. A conversation is also a cache: rereading, compaction, and FreshCtx's outgoing copy.
3. Observe → prepare → apply → commit, using the same `total()` example as `npm run demo`.
4. Unit identity: file, symbol, region, and the repeated-block relocation bug.
5. Budgeted selection by recency and overlap.
6. Failing as a unit: hash checks, optimistic commit, invalid plan versus unavailable marker.
7. Measurements: 8,504 vs 36,701 bytes on five traces, and the 5/5 vs 3/5 live pilot, with their limits.
8. Differences from rereading, compaction, and CORVUS; limitations; next experiments.

Numbers and claims come from the article and keep its caveats. Change them only
if the article changes.

## Voice-over

Narration is the text passed to `Base.say` in `freshctx_explainer.py`. It is
synthesized locally with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
(voice `am_michael`, override with `FRESHCTX_VOICE`) and cached in
`build/voice/`. `say(text, spoken=...)` lets the subtitle read `FreshCtx`
while the voice says "Fresh Context". The screen shows no captions; the
render writes them to a sidecar `.srt`.

To use a recorded voice instead, replace the cached WAV files or swap `speak()`
for a function that returns your recording and its duration.

## Render

Requires Manim Community 0.19+, ffmpeg, and `kokoro-onnx`. LaTeX is not needed.

```sh
python -m venv .venv && .venv/bin/pip install manim kokoro-onnx soundfile
mkdir -p /opt/tts && cd /opt/tts
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cd - && PATH=.venv/bin:$PATH ./render.sh
```

Output: `build/video/freshctx-explainer.mp4` and `freshctx-explainer.srt`.
Pass `-ql` to `render.sh` for a fast low-resolution preview.
