#!/usr/bin/env bash
# Usage: ./render.sh [es|en] [quality flag, default -qh]
# Needs Manim Community 0.19+ and ffmpeg. No LaTeX required.
set -euo pipefail
cd "$(dirname "$0")"
lang="${1:-es}"
quality="${2:---resolution=1920,1080}"
out="build/$lang"
mkdir -p "$out"
scenes=(S1Hook S2Cache S3Pipeline S4Identity S5Budget S6FailClosed S7Evidence S8Close)
for scene in "${scenes[@]}"; do
  FRESHCTX_LANG="$lang" manim $quality --frame_rate 30 --media_dir "$out/media" -o "$scene.mp4" freshctx_explainer.py "$scene" &
done
wait
list="$out/scenes.txt"
: > "$list"
for scene in "${scenes[@]}"; do
  echo "file '$(find "$out/media/videos" -name "$scene.mp4" | head -1 | xargs realpath)'" >> "$list"
done
ffmpeg -v error -y -f concat -safe 0 -i "$list" -c copy "$out/freshctx-explainer-$lang.mp4"
echo "$out/freshctx-explainer-$lang.mp4"
