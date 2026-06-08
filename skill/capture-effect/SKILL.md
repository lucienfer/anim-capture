---
name: capture-effect
description: Capture a web animation/transition as timestamped frames plus the computed CSS that drives it, so the effect can be analyzed visually. Use when asked to analyze, reproduce, debug, or critique a hover/click/scroll/load animation or transition on a web page — anything where seeing the motion (not just reading the code) matters.
---

# capture-effect

Capture a web animation as **timestamped frames + computed CSS**, then read both
to analyze the effect. Pixels give you the perceptual reality (spring feel, WebGL,
layered effects); the computed CSS gives you the exact numbers (duration, easing).
Use them together.

## When to use
- Analyze / reproduce / debug a transition or animation on a site.
- Compare "what the spec says" (CSS) vs "what actually renders" (frames).
- Effects driven by JS/canvas/WebGL/springs where reading code is not enough.

## Prerequisites
The repo's CLI must be installed once:
```bash
cd <repo>/anim-capture && npm install   # installs Playwright + Chromium
```
`ffmpeg` is only needed for the `--from-video` route.

## How to run

Capture an interaction (the common case):
```bash
node <repo>/bin/capture.mjs \
  --url "https://example.com" \
  --interaction hover \
  --selector ".card" \
  --duration 800
```

`--interaction` is one of: `load` (default), `hover`, `click`, `scroll`.
`hover` and `click` require `--selector`.

Extract frames from a video you already have (ffmpeg route):
```bash
node <repo>/bin/capture.mjs --from-video ./demo.mov --fps 30
```

## Output
A run writes a folder (default `./captures/capture_<n>/`):
- `frames/frame_NNNN_tX.XXXs.png` — one image per painted frame, timestamped.
- `computed.json` — computed CSS of `--selector` (transition, easing, animation…).
- `meta.json` — url, interaction, real duration, per-frame timing.

## How to analyze
1. Read `meta.json` for the frame list and timing.
2. Read a spread of frames (start / mid / end — not every frame; they are redundant
   and costly). Aim for ~6–12 frames across the animation.
3. Read `computed.json` for the exact duration/easing/properties.
4. Combine: describe the motion from the frames, anchor the numbers from the CSS,
   and flag any mismatch between the two.

## Tips
- Keep `--duration` close to the real animation length; padding just adds redundant
  frames. Bump it if you suspect the animation is longer than captured.
- The screencast frame rate is capped by the browser's paint rate (~60fps max).
- For "why is it janky" questions, frames won't tell you — use a perf trace instead.
