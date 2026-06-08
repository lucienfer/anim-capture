---
name: capture-effect
description: Turn a moving visual into timestamped frames you can analyze — either a web animation/transition (captured live, with the computed CSS) or any video file (sampled by frame rate, fixed count, or scene cuts). Use when asked to analyze, reproduce, debug, or critique a hover/click/scroll/load animation or transition on a web page, OR to analyze the content of a video file frame by frame — anything where seeing the motion over time (not a single screenshot or just the code) matters.
---

# capture-effect

Turn a moving visual into **timestamped frames** you can analyze, from two sources:
a live **web** animation (captured with the computed CSS that drives it) or any
**video file** (sampled into frames). A still screenshot misses the motion; reading
code misses the rendered reality. Frames over time give you both.

## When to use
- Analyze / reproduce / debug a transition or animation on a site.
- Compare "what the spec says" (CSS) vs "what actually renders" (frames).
- Effects driven by JS/canvas/WebGL/springs where reading code is not enough.
- Analyze the content of a **video file** frame by frame (a recording, a demo, a
  screen capture) — sample it and read the frames.

## Prerequisites
The repo's CLI must be installed once:
```bash
cd <repo>/anim-capture && npm install   # installs Playwright + Chromium
```
`ffmpeg` (with `ffprobe`) is required for the video source.

## How to run

### Web animation/transition
```bash
node <repo>/bin/capture.mjs \
  --url "https://example.com" \
  --interaction hover \
  --selector ".card" \
  --duration 800
```
`--interaction` is one of: `load` (default), `hover`, `click`, `scroll`.
`hover` and `click` require `--selector`.

The default capture is a CDP screencast, which can miss frames of a fast or
GPU-composited transition. Add `--record` to capture a real video of the
interaction and sample it instead (continuous, nothing skipped); the computed CSS
is still dumped, and `--fps`/`--frames`/`--scene` apply to the sampling:
```bash
node <repo>/bin/capture.mjs --url "https://example.com" \
  --interaction hover --selector ".card" --duration 800 --record --frames 10
```
Prefer `--record` when timing/intermediate states matter; the plain screencast is
fine for a quick look or when you mostly care about the CSS.

### Video file
```bash
node <repo>/bin/capture.mjs --from-video ./clip.mp4 --frames 12   # 12 even frames
node <repo>/bin/capture.mjs --from-video ./clip.mp4 --scene 0.3   # key moments only
node <repo>/bin/capture.mjs --from-video ./clip.mp4 --fps 5 --start 4 --end 7
```
Sampling modes are exclusive; precedence `--scene` > `--frames` > `--fps` (default 2).

## Output
A run writes a folder (default `./captures/capture_<n>/`):
- `frames/frame_NNNN_tX.XXXs.png` — sampled frames, each named with its timestamp.
- `computed.json` — (web source) computed CSS of `--selector`.
- `meta.json` — source, sampling mode, range, video info, per-frame timing.

## How to analyze
1. Read `meta.json` for the frame list, timing, and (video) duration/resolution.
2. Read a spread of frames (start / mid / end — not every frame; they are redundant
   and costly). Aim for ~6–12 frames across the clip or animation.
3. For a web effect, read `computed.json` for the exact duration/easing/properties.
4. Combine: describe the motion from the frames, anchor numbers from the CSS (web),
   and flag any mismatch.

## Tips
- Web: keep `--duration` close to the real animation length; extra time just adds
  redundant frames. Screencast frame rate is capped by paint rate (~60fps max).
- Video: more frames isn't better. For long clips prefer `--frames N` or `--scene`
  over a high `--fps`, to avoid a flood of near-identical images. You can't sample
  finer than the recording's own frame rate.
- For web "why is it janky" questions, frames won't tell you — use a perf trace.
