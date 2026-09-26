import re
import subprocess
import sys
from pathlib import Path

out = Path(sys.argv[1])
scenes = sys.argv[2:]
files = {s: next(out.joinpath("media", "videos").rglob(f"{s}.mp4")) for s in scenes}
out.joinpath("scenes.txt").write_text("".join(f"file '{files[s].resolve()}'\n" for s in scenes))
video = out / "freshctx-explainer.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(out / "scenes.txt"), "-c", "copy", str(video)], check=True)


def seconds(stamp):
    h, m, rest = stamp.split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def stamp(value):
    ms = round(value * 1000)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


offset, index, cues = 0.0, 1, []
for scene in scenes:
    srt = files[scene].with_suffix(".srt")
    for block in srt.read_text().strip().split("\n\n") if srt.exists() else []:
        lines = block.splitlines()
        start, end = (seconds(t.strip()) + offset for t in lines[1].split("-->"))
        cues.append(f"{index}\n{stamp(start)} --> {stamp(end)}\n" + "\n".join(lines[2:]) + "\n")
        index += 1
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(files[scene])],
                           check=True, capture_output=True, text=True)
    offset += float(probe.stdout)
video.with_suffix(".srt").write_text("\n".join(cues))
print(video)
