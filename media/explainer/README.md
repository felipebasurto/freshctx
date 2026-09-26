# FreshCtx explainer video

An animated explainer (Manim, 3Blue1Brown style) for the article
[Model context is not static](https://felipebasurto.com/blog/model-context-is-not-static/).
It is not part of the product package and is not listed in `package.json` `files`.

Chapters:

1. The problem: an old tool result says `10`, the file on disk says `20`.
2. A conversation is also a cache: rereading, compaction, and FreshCtx's outgoing copy.
3. Observe → prepare → validate and apply → commit, using the same `total()` example as `npm run demo`.
4. Unit identity: file, symbol, region, and the repeated-block relocation bug.
5. Budgeted selection by recency and overlap.
6. Failing as a unit: hash checks, optimistic commit, invalid plan versus unavailable marker.
7. Measurements: 8,504 vs 36,701 bytes on five traces, and the 5/5 vs 3/5 live pilot, with their limits.
8. Differences from rereading, compaction, and CORVUS; limitations; next experiments.

Numbers and claims come from the article and match its caveats. Change them only
if the article changes.

## Render

Requires Manim Community 0.19+ and ffmpeg. LaTeX is not needed.

```sh
python -m venv .venv && .venv/bin/pip install manim
PATH=.venv/bin:$PATH ./render.sh es   # build/es/freshctx-explainer-es.mp4
PATH=.venv/bin:$PATH ./render.sh en   # build/en/freshctx-explainer-en.mp4
```

Pass `-ql` as the second argument for a fast low-resolution preview.

Captions are burned in. `NARRATION.md` lists them in order for recording a
voice-over; regenerate it with `python narration.py` after editing captions.
