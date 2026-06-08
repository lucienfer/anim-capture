#!/usr/bin/env node
/**
 * anim-capture — turn a moving visual into timestamped frames you can analyze.
 *
 * Two sources:
 *   - Web (default): drive Chromium with Playwright and capture an animation or
 *     transition via the Chrome DevTools Protocol screencast, alongside the
 *     computed CSS that drives it. Frames are timestamped to the ms.
 *   - Video (--from-video <path>): analyze any video file with ffmpeg. Sample it
 *     by frame rate, by a fixed number of evenly-spaced frames, or by scene cuts;
 *     restrict to a time range; every frame is timestamped and described in meta.
 *
 * Output (per run):
 *   <out>/frames/frame_NNNN_tX.XXXs.png   timestamped frames
 *   <out>/computed.json                   computed CSS of the target (web source)
 *   <out>/meta.json                       source, sampling, timing, per-frame index
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------- arg parsing ----------
function parseArgs(argv) {
  const args = {
    url: null,
    interaction: 'load',      // load | hover | click | scroll
    selector: null,           // element to interact with / inspect
    duration: 1000,           // ms to record after the interaction
    settle: 300,              // ms to wait after navigation before triggering
    width: 1280,
    height: 800,
    out: null,
    maxFrames: 240,
    record: false,            // web: record a real video then sample it
    // video source
    fromVideo: null,          // path to a video file to analyze
    fps: null,                // sample N frames per second (default 2 if no mode set)
    frames: null,             // OR sample N evenly-spaced frames across the range
    scene: null,              // OR sample on scene cuts above this threshold (0-1)
    start: null,              // start time in seconds
    end: null,                // end time in seconds
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': args.url = next(); break;
      case '--interaction': args.interaction = next(); break;
      case '--selector': args.selector = next(); break;
      case '--duration': args.duration = Number(next()); break;
      case '--settle': args.settle = Number(next()); break;
      case '--width': args.width = Number(next()); break;
      case '--height': args.height = Number(next()); break;
      case '--out': args.out = next(); break;
      case '--max-frames': args.maxFrames = Number(next()); break;
      case '--record': args.record = true; break;
      case '--from-video': args.fromVideo = next(); break;
      case '--fps': args.fps = Number(next()); break;
      case '--frames': args.frames = Number(next()); break;
      case '--scene': args.scene = Number(next()); break;
      case '--start': args.start = Number(next()); break;
      case '--end': args.end = Number(next()); break;
      case '-h': case '--help': args.help = true; break;
      default: console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  return args;
}

const HELP = `anim-capture — turn a moving visual into timestamped frames you can analyze

Web source (default):
  anim-capture --url <url> [--interaction load|hover|click|scroll]
               [--selector <css>] [--duration <ms>] [--record] [--out <dir>]

Video source:
  anim-capture --from-video <path> [--fps <n> | --frames <n> | --scene <0-1>]
               [--start <sec>] [--end <sec>] [--out <dir>]

Web options:
  --url <url>            Page to open.
  --interaction <type>   What triggers the effect: load (default), hover, click, scroll.
  --selector <css>       Element to hover/click and to inspect for computed CSS.
  --duration <ms>        How long to record after the trigger (default 1000).
  --settle <ms>          Wait after navigation before triggering (default 300).
  --record               Record a real video of the interaction and sample it,
                         instead of the CDP screencast. Catches fast/composited
                         frames the screencast can miss. Sampling options below
                         apply (default --fps 30); needs ffmpeg.
  --width/--height       Viewport size (default 1280x800).

Video options (pick one sampling mode; defaults to --fps 2):
  --from-video <path>    Analyze this video file with ffmpeg.
  --fps <n>              Sample n frames per second.
  --frames <n>           Sample n frames evenly spread across the range.
  --scene <0-1>          Sample only on scene cuts above this threshold (e.g. 0.3).
  --start <sec>          Start time (default 0).
  --end <sec>            End time (default end of video).

Common:
  --max-frames <n>       Safety cap on captured frames (default 240).
  --out <dir>            Output dir (default ./captures/capture_<n>).
`;

function tstamp(seconds) {
  return `t${seconds.toFixed(3)}s`;
}

function which(bin) {
  return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
}

// probe a video for duration / resolution / frame rate
function probeVideo(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const s = (j.streams && j.streams[0]) || {};
    const [num, den] = (s.r_frame_rate || '0/1').split('/').map(Number);
    return {
      width: s.width ?? null,
      height: s.height ?? null,
      fps: den ? Number((num / den).toFixed(3)) : null,
      duration: j.format && j.format.duration ? Number(j.format.duration) : null,
    };
  } catch { return null; }
}

// ---------- Video source: ffmpeg ----------
// Sample a video file into timestamped frames inside framesDir.
// Reused by --from-video and by the web --record mode.
// Returns { written, info, mode, sampling, range }.
async function sampleVideoFile(videoFile, framesDir, args, defaultFps = 2) {
  const info = probeVideo(videoFile) || {};
  const start = args.start ?? 0;
  const end = args.end ?? info.duration ?? null;

  // pick a sampling mode: scene > frames > fps
  const mode = args.scene != null ? 'scene' : args.frames != null ? 'frames' : 'fps';
  const fps = args.fps ?? defaultFps;
  const trim = (extra) => [
    ...(start ? ['-ss', String(start)] : []),
    '-i', videoFile,
    ...(end != null ? ['-t', String(end - start)] : []),
    ...extra,
  ];

  const written = [];

  if (mode === 'frames') {
    // N frames evenly spread across [start, end], sampled at interval midpoints
    // so none lands exactly on the end (which would yield no frame).
    const span = (end ?? info.duration ?? 0) - start;
    const n = Math.max(1, args.frames);
    for (let i = 0; i < n && i < args.maxFrames; i++) {
      const t = start + (span * (i + 0.5)) / n;
      const file = `frame_${String(i).padStart(4, '0')}_${tstamp(t)}.png`;
      const dest = path.join(framesDir, file);
      const r = spawnSync('ffmpeg', [
        '-ss', String(t), '-i', videoFile,
        '-frames:v', '1', '-y', dest,
      ], { stdio: 'ignore' });
      if (r.status === 0 && existsSync(dest)) written.push({ index: i, t: Number(t.toFixed(3)), file });
    }
  } else {
    // fps or scene: let ffmpeg select frames, capture showinfo to recover timestamps
    const vf = mode === 'scene'
      ? `select='gt(scene,${args.scene})',showinfo`
      : `fps=${fps},showinfo`;
    const r = spawnSync('ffmpeg', trim([
      '-vf', vf, '-vsync', 'vfr', '-frame_pts', '1',
      '-y', path.join(framesDir, 'frame_%05d.png'),
    ]), { encoding: 'utf8' });
    if (r.status !== 0) { console.error('ffmpeg failed:\n' + (r.stderr || '')); process.exit(1); }

    // showinfo prints "pts_time:N" per emitted frame, in order
    const times = [...(r.stderr || '').matchAll(/pts_time:([0-9.]+)/g)].map(m => start + Number(m[1]));
    const produced = (await readdir(framesDir)).filter(f => f.endsWith('.png')).sort();
    for (let i = 0; i < produced.length && i < args.maxFrames; i++) {
      const t = times[i] ?? start;
      const file = `frame_${String(i).padStart(4, '0')}_${tstamp(t)}.png`;
      await rename(path.join(framesDir, produced[i]), path.join(framesDir, file));
      written.push({ index: i, t: Number(t.toFixed(3)), file });
    }
    // drop any frames beyond the cap
    for (let i = args.maxFrames; i < produced.length; i++) {
      await rm(path.join(framesDir, produced[i]), { force: true });
    }
  }

  const sampling = mode === 'scene' ? { mode, threshold: args.scene }
                 : mode === 'frames' ? { mode, frames: args.frames }
                 : { mode, fps };
  return { written, info, mode, sampling, range: { start, end } };
}

function nextCaptureDir(args) {
  if (args.out) return args.out;
  let n = 1;
  while (existsSync(path.resolve('captures', `capture_${n}`))) n++;
  return path.resolve('captures', `capture_${n}`);
}

async function fromVideo(args) {
  if (!which('ffmpeg') || !which('ffprobe')) {
    console.error('ffmpeg/ffprobe not found. Install ffmpeg to analyze videos.');
    process.exit(1);
  }
  if (!existsSync(args.fromVideo)) {
    console.error(`Video not found: ${args.fromVideo}`); process.exit(1);
  }

  const out = nextCaptureDir(args);
  const framesDir = path.join(out, 'frames');
  await rm(out, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const { written, info, mode, sampling, range } = await sampleVideoFile(args.fromVideo, framesDir, args);

  await writeFile(path.join(out, 'meta.json'), JSON.stringify({
    source: 'video',
    file: args.fromVideo,
    video: info,
    sampling,
    range,
    framesWritten: written.length,
    frames: written,
  }, null, 2));

  console.log(`\nDone.`);
  console.log(`  frames: ${framesDir} (${written.length} frames, mode=${mode})`);
  console.log(`  meta:   ${path.join(out, 'meta.json')}`);
}

// capture computed CSS of the target (the animation "spec")
async function captureComputed(page, selector) {
  if (!selector) return null;
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `selector not found: ${sel}` };
    const cs = getComputedStyle(el);
    const pick = [
      'transition', 'transitionProperty', 'transitionDuration',
      'transitionTimingFunction', 'transitionDelay',
      'animation', 'animationName', 'animationDuration',
      'animationTimingFunction', 'animationDelay', 'animationIterationCount',
      'transform', 'opacity', 'willChange',
    ];
    const o = {};
    for (const k of pick) o[k] = cs[k];
    return o;
  }, selector);
}

// fire the interaction that triggers the effect
async function triggerInteraction(page, args) {
  switch (args.interaction) {
    case 'hover':
      if (!args.selector) { console.error('hover needs --selector'); process.exit(2); }
      await page.hover(args.selector);
      break;
    case 'click':
      if (!args.selector) { console.error('click needs --selector'); process.exit(2); }
      await page.click(args.selector);
      break;
    case 'scroll':
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      break;
    case 'load':
    default:
      break; // effect already triggered by navigation
  }
}

// ---------- Web source, --record: drive + record a real video, then sample ----------
// Avoids the screencast's frame-selection gaps: the video is a continuous capture,
// so fast/composited transitions don't lose their in-between states.
async function recordWeb(args) {
  if (!which('ffmpeg') || !which('ffprobe')) {
    console.error('ffmpeg/ffprobe not found. Install ffmpeg to use --record.');
    process.exit(1);
  }
  const out = nextCaptureDir(args);
  const framesDir = path.join(out, 'frames');
  await rm(out, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  const videoDir = path.join(out, '.video');
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: args.width, height: args.height } },
  });
  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: 'load' });
  await page.waitForTimeout(args.settle);

  const computed = await captureComputed(page, args.selector);
  const video = page.video();
  await triggerInteraction(page, args);
  await page.waitForTimeout(args.duration);

  await context.close();              // finalizes the .webm
  const videoPath = await video.path();
  await browser.close();

  // sample the recording; default to a dense fps so nothing is missed
  const { written, info, mode, sampling, range } =
    await sampleVideoFile(videoPath, framesDir, args, 30);
  await rm(videoDir, { recursive: true, force: true });

  if (computed) await writeFile(path.join(out, 'computed.json'), JSON.stringify(computed, null, 2));
  await writeFile(path.join(out, 'meta.json'), JSON.stringify({
    source: 'web-record',
    url: args.url,
    interaction: args.interaction,
    selector: args.selector,
    durationMs: args.duration,
    video: info,
    sampling,
    range,
    framesWritten: written.length,
    frames: written,
  }, null, 2));

  console.log(`\nDone.`);
  console.log(`  frames:   ${framesDir} (${written.length} frames from recording, mode=${mode})`);
  if (computed) console.log(`  computed: ${path.join(out, 'computed.json')}`);
  console.log(`  meta:     ${path.join(out, 'meta.json')}`);
}

// ---------- Web source, default: CDP screencast ----------
async function fromBrowser(args) {
  if (!args.url) { console.error('--url is required (or use --from-video).'); process.exit(2); }

  const out = nextCaptureDir(args);
  const framesDir = path.join(out, 'frames');
  await rm(out, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await page.goto(args.url, { waitUntil: 'load' });
  await page.waitForTimeout(args.settle);

  const computed = await captureComputed(page, args.selector);

  // start screencast
  const client = await context.newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', async (frame) => {
    frames.push({ data: frame.data, ts: frame.metadata.timestamp });
    try { await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }); }
    catch { /* page may be closing */ }
  });
  await client.send('Page.startScreencast', {
    format: 'png',
    everyNthFrame: 1,
  });

  const t0 = Date.now();

  await triggerInteraction(page, args);

  await page.waitForTimeout(args.duration);
  await client.send('Page.stopScreencast').catch(() => {});
  await browser.close();

  // normalise timestamps relative to the first frame, write to disk
  if (frames.length === 0) {
    console.error('No frames captured. The page may not have painted any changes.');
  }
  const base = frames.length ? frames[0].ts : 0;
  const kept = frames.slice(0, args.maxFrames);
  const written = [];
  for (let i = 0; i < kept.length; i++) {
    const rel = kept[i].ts - base;
    const name = `frame_${String(i).padStart(4, '0')}_${tstamp(rel)}.png`;
    await writeFile(path.join(framesDir, name), Buffer.from(kept[i].data, 'base64'));
    written.push({ index: i, t: Number(rel.toFixed(3)), file: name });
  }

  if (computed) await writeFile(path.join(out, 'computed.json'), JSON.stringify(computed, null, 2));
  await writeFile(path.join(out, 'meta.json'), JSON.stringify({
    route: 'cdp-screencast',
    url: args.url,
    interaction: args.interaction,
    selector: args.selector,
    requestedDurationMs: args.duration,
    realDurationMs: Date.now() - t0,
    framesCaptured: frames.length,
    framesWritten: written.length,
    viewport: { width: args.width, height: args.height },
    frames: written,
  }, null, 2));

  console.log(`\nDone.`);
  console.log(`  frames:   ${framesDir} (${written.length} frames over ~${args.duration}ms)`);
  if (computed) console.log(`  computed: ${path.join(out, 'computed.json')}`);
  console.log(`  meta:     ${path.join(out, 'meta.json')}`);
}

// ---------- main ----------
const args = parseArgs(process.argv);
if (args.help) { console.log(HELP); process.exit(0); }
if (args.fromVideo) await fromVideo(args);
else if (args.record) await recordWeb(args);
else await fromBrowser(args);
