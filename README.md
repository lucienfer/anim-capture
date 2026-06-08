# anim-capture

Turn a moving visual into **timestamped frames you can analyze** — from a live web
page or from any video file. So an agent (or you) can reason about a visual effect
from the rendered pixels, not just from code or a single screenshot.

Two sources:

- **Web** — drive Chromium and capture an animation/transition as it paints, plus
  the **computed CSS** that drives it.
- **Video** — sample any video file into frames (by frame rate, by a fixed count,
  or on scene cuts), each one timestamped.

> Why frames? A still screenshot misses the motion; reading code misses the
> rendered reality (spring feel, WebGL, compositing, spec-vs-actual mismatch).
> Sampled, timestamped frames let you analyze how a visual evolves over time.

## Install

```bash
npm install        # installs Playwright + downloads Chromium (for the web source)
```

`ffmpeg` (with `ffprobe`) is required for the video source.

## Usage

### Web source — capture an animation/transition

```bash
node bin/capture.mjs \
  --url "https://example.com" \
  --interaction hover \
  --selector ".card" \
  --duration 800
```

`--interaction`: `load` (default) · `hover` · `click` · `scroll`
(`hover`/`click` need `--selector`).

### Video source — analyze a video file

```bash
# sample 2 frames per second (default)
node bin/capture.mjs --from-video ./clip.mp4

# sample 12 frames evenly across the clip
node bin/capture.mjs --from-video ./clip.mp4 --frames 12

# sample only on scene cuts (good for "show me the key moments")
node bin/capture.mjs --from-video ./clip.mp4 --scene 0.3

# restrict to a time window
node bin/capture.mjs --from-video ./clip.mp4 --start 4 --end 7 --fps 5
```

Sampling modes are mutually exclusive; precedence is `--scene` > `--frames` >
`--fps` (default `--fps 2`).

Run `node bin/capture.mjs --help` for all options.

## Output

Each run writes `./captures/capture_<n>/`:

| File | What |
|---|---|
| `frames/frame_NNNN_tX.XXXs.png` | sampled frames, each named with its timestamp |
| `computed.json` | *(web source)* computed CSS of `--selector` (transition, easing…) |
| `meta.json` | source, sampling mode, time range, video info, per-frame timing |

## How it works

- **Web (CDP screencast).** Drives Chromium via the Chrome DevTools Protocol and
  grabs frames as they paint, timestamped to the millisecond — no video re-encoding,
  so no compression loss.
- **Video (ffmpeg + ffprobe).** Probes the file for duration/resolution/frame rate,
  then samples it by frame rate, by an even frame count, or on scene cuts, recovering
  each frame's real timestamp.

## Use from an agent harness

The `skill/capture-effect/` folder ships a `SKILL.md` manifest so an agent harness
that supports the skill format can invoke the CLI autonomously. Point your harness's
skills directory at it, e.g.:

```bash
ln -s "$(pwd)/skill/capture-effect" <your-skills-dir>/capture-effect
```

## Notes & limits

- Web screencast frame rate is capped by the browser paint rate (~60fps max).
- Video frame extraction can only surface frames that exist in the file — you can't
  sample finer than the recording's own frame rate.
- More frames isn't better: for a long video prefer `--frames N` or `--scene` over a
  high `--fps`, to avoid a flood of near-identical images.
- For web "why is it janky" (dropped frames, layout thrash), use a performance trace,
  not frames.
