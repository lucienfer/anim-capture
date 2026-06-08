# anim-capture

Capture web animations / transitions as **timestamped frames + the computed CSS
that drives them**, so an agent (or you) can analyze a visual effect instead of
only reading its code.

> Why both? The code is the *specification* (exact duration, easing, properties).
> The frames are the *rendered reality* (spring feel, WebGL, layered effects, and
> any mismatch between spec and what actually paints). Good analysis uses both.

## Install

```bash
npm install        # installs Playwright + downloads Chromium
```

`ffmpeg` is only required for the `--from-video` route (extracting frames from an
existing video).

## Usage

Capture an interaction:

```bash
node bin/capture.mjs \
  --url "https://example.com" \
  --interaction hover \
  --selector ".card" \
  --duration 800
```

`--interaction`: `load` (default) · `hover` · `click` · `scroll`
(`hover`/`click` need `--selector`).

Extract frames from a video you already have:

```bash
node bin/capture.mjs --from-video ./demo.mov --fps 30
```

Run `node bin/capture.mjs --help` for all options.

## Output

Each run writes `./captures/capture_<n>/`:

| File | What |
|---|---|
| `frames/frame_NNNN_tX.XXXs.png` | one image per painted frame, timestamped |
| `computed.json` | computed CSS of `--selector` (transition, easing, animation…) |
| `meta.json` | url, interaction, real duration, per-frame timing |

## Two capture routes

- **CDP screencast (default).** Drives Chromium via the Chrome DevTools Protocol
  and grabs frames as they paint, timestamped to the millisecond. No video
  re-encoding, so no compression loss.
- **ffmpeg (`--from-video`).** Falls back to extracting frames from an existing
  video file.

## Use from an agent harness

The `skill/capture-effect/` folder ships a `SKILL.md` manifest so an agent harness
that supports the skill format can invoke the CLI autonomously when a task involves
analyzing a web animation. Point your harness's skills directory at it, e.g.:

```bash
ln -s "$(pwd)/skill/capture-effect" <your-skills-dir>/capture-effect
```

## Notes & limits

- Screencast frame rate is capped by the browser paint rate (~60fps max).
- Keep `--duration` close to the real animation length; extra time just adds
  redundant frames.
- For "why is it janky" (dropped frames, layout thrash), use a performance trace,
  not frames.
