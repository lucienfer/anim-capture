#!/usr/bin/env node
/**
 * capture-effect — capture a web animation/transition as timestamped frames
 * plus the computed CSS that drives it.
 *
 * Two routes:
 *   - Route B (default): drive Chromium with Playwright, capture frames via the
 *     Chrome DevTools Protocol screencast. Frames are timestamped to the ms.
 *   - Route A (fallback): extract frames from an existing video with ffmpeg
 *     (--from-video <path>).
 *
 * Output (per run):
 *   <out>/frames/frame_tNNNN.NNNs.png   one image per painted frame
 *   <out>/computed.json                 computed CSS of the target selector
 *   <out>/meta.json                     url, interaction, fps, real duration
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
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
    fromVideo: null,          // Route A: extract from this video instead
    fps: 30,                  // only used by the ffmpeg route
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
      case '--from-video': args.fromVideo = next(); break;
      case '--fps': args.fps = Number(next()); break;
      case '-h': case '--help': args.help = true; break;
      default: console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  return args;
}

const HELP = `capture-effect — capture a web animation as timestamped frames + computed CSS

Usage:
  capture-effect --url <url> [--interaction load|hover|click|scroll]
                 [--selector <css>] [--duration <ms>] [--out <dir>]

  capture-effect --from-video <path> [--fps 30] [--out <dir>]   (ffmpeg route)

Options:
  --url <url>            Page to open.
  --interaction <type>   What triggers the effect: load (default), hover, click, scroll.
  --selector <css>       Element to hover/click and to inspect for computed CSS.
  --duration <ms>        How long to record after the trigger (default 1000).
  --settle <ms>          Wait after navigation before triggering (default 300).
  --width/--height       Viewport size (default 1280x800).
  --max-frames <n>       Safety cap on captured frames (default 240).
  --out <dir>            Output dir (default ./captures/capture_<n>).
  --from-video <path>    Skip the browser; extract frames from a video with ffmpeg.
  --fps <n>              Frame rate for the ffmpeg route (default 30).
`;

function tstamp(seconds) {
  return `t${seconds.toFixed(3)}s`;
}

// ---------- Route A: ffmpeg ----------
async function fromVideo(args) {
  const out = args.out || path.resolve('captures', 'capture_video');
  const framesDir = path.join(out, 'frames');
  await mkdir(framesDir, { recursive: true });
  const r = spawnSync('ffmpeg', [
    '-i', args.fromVideo,
    '-vf', `fps=${args.fps}`,
    '-y',
    path.join(framesDir, 'frame_%04d.png'),
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('ffmpeg failed. Is ffmpeg installed?');
    process.exit(1);
  }
  await writeFile(path.join(out, 'meta.json'), JSON.stringify({
    route: 'ffmpeg', source: args.fromVideo, fps: args.fps,
  }, null, 2));
  console.log(`\nDone. Frames extracted to ${framesDir}`);
}

// ---------- Route B: CDP screencast ----------
async function fromBrowser(args) {
  if (!args.url) { console.error('--url is required (or use --from-video).'); process.exit(2); }

  // pick a default out dir
  let out = args.out;
  if (!out) {
    let n = 1;
    while (existsSync(path.resolve('captures', `capture_${n}`))) n++;
    out = path.resolve('captures', `capture_${n}`);
  }
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

  // capture computed CSS of the target before we start (the "spec")
  let computed = null;
  if (args.selector) {
    computed = await page.evaluate((sel) => {
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
    }, args.selector);
  }

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

  // trigger the effect
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
else await fromBrowser(args);
