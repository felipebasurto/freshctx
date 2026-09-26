#!/usr/bin/env bash
# Usage: ./render.sh [manim quality flags, default 1080p]
# Needs Manim Community 0.19+, ffmpeg, kokoro-onnx and the Kokoro v1.0 model
# files in $KOKORO_DIR (default /opt/tts). LaTeX is not needed.
set -euo pipefail
cd "$(dirname "$0")"
quality="${1:---resolution=1920,1080}"
out="build/video"
scenes=(S1Hook S2Cache S3Pipeline S4Identity S5Budget S6FailClosed S7Evidence S8Close)
mkdir -p "$out"
python -c "import freshctx_explainer" >/dev/null
for scene in "${scenes[@]}"; do
  manim $quality --frame_rate 30 --media_dir "$out/media" freshctx_explainer.py "$scene" &
done
wait
python merge.py "$out" "${scenes[@]}"
