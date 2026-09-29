/**
 * halotest.mjs — the Halo renderer, drawn for real and read back.
 *
 * Unlike the other browser suites this runs in plain Node against node-canvas,
 * so it needs no devserver and no Playwright:
 *
 *   npm i --no-save canvas          (once)
 *   node dev/tests/halotest.mjs [outDir]
 *
 * With an outDir it also writes halo-dark.png and halo-ice.png — a look at the
 * view without opening ComfyUI. Timing is reported but not asserted: node-canvas
 * rasterises on the CPU and says nothing about Chrome. Draw calls are asserted
 * instead, because those cost the same everywhere.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const { createCanvas } = require("canvas");
globalThis.document = { createElement: () => createCanvas(1, 1) };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = pathToFileURL(join(ROOT, "web")).href;
const { resolvePalette } = await import(REPO + "/core/color.js");
const { makeGfx } = await import(REPO + "/core/gfx.js");
const { fillDemoSignal } = await import(REPO + "/core/idle-demo.js");
const halo = (await import(REPO + "/renderers/halo.js")).default;
const { RENDERER_IDS, defaultParams } = await import(REPO + "/renderers/registry.js");
// The real built-in themes, straight from defaults.py, so a missing role there
// fails here rather than as magenta in ComfyUI.
const cfg = JSON.parse(execFileSync("python3", ["-c",
  "import importlib.util as u,json,sys;s=u.spec_from_file_location('d',sys.argv[1]);" +
  "d=u.module_from_spec(s);s.loader.exec_module(d);print(json.dumps(d.DEFAULT_COLOR_CONFIG))",
  join(ROOT, "nova_player", "defaults.py")], { encoding: "utf8" }));
const OUT = process.argv[2] || null;

let PASS = 0, FAIL = 0;
const ck = (n, ok, d = "") => { ok ? PASS++ : FAIL++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "   " + d : ""}`); };
const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(" "));

function mkSig() {
  const bins = 2048;
  return { ready: true, hasData: true, playing: true, binCount: bins, fftSize: 4096, sampleRate: 48000,
    freq: new Uint8Array(bins), freqDb: new Float32Array(bins), timeL: new Float32Array(4096), timeR: new Float32Array(4096),
    levelL: 0, levelR: 0, peakHold: 0, clip: false, corrRaw: 0 };
}
function run(theme, fps, seconds, W = 900, H = 520, params = defaultParams("halo")) {
  const pal = resolvePalette(cfg.themes, theme, "nova-dark");
  const cv = createCanvas(W, H); const ctx = cv.getContext("2d");
  const store = {}; const sig = mkSig(); const rect = { x: 0, y: 0, w: W, h: H };
  let ms = 0, t0 = performance.now(), n = 0;
  for (let t = 0; t <= seconds; t += 1 / fps, n++) {
    fillDemoSignal(sig, t);
    halo.frame(makeGfx({ ctx, palette: pal, params, store, now: t * 1000 }), rect, sig);
  }
  ms = (performance.now() - t0) / n;
  return { cv, store, ms, sig };
}

ck("registered in the view cycle", RENDERER_IDS.includes("halo"), RENDERER_IDS.length + " renderers");
const r = run("nova-dark", 60, 4);
const ice = run("nova-ice", 60, 4);
if (OUT) {
  writeFileSync(join(OUT, "halo-dark.png"), r.cv.toBuffer("image/png"));
  writeFileSync(join(OUT, "halo-ice.png"), ice.cv.toBuffer("image/png"));
}
ck("no unknown-role or ramp warnings", warns.length === 0, warns.slice(0, 3).join(" | "));
const px = r.cv.getContext("2d").getImageData(0, 0, 900, 520).data;
let magenta = 0, lit = 0;
for (let i = 0; i < px.length; i += 4) { if (px[i] > 240 && px[i + 1] < 20 && px[i + 2] > 240) magenta++; if (px[i] + px[i + 1] + px[i + 2] > 300) lit++; }
ck("no fallback magenta painted", magenta < 20, magenta + " px");
ck("the ring actually draws", lit > 5000, lit + " bright px");
ck("streaks respond to signal", Math.max(...r.store.energy) > 0.3, "max energy " + Math.max(...r.store.energy).toFixed(2));
ck("bubbles exist and are bounded", r.store.bubbles.length > 5 && r.store.bubbles.length <= 260, r.store.bubbles.length + " bubbles");

// frame-rate independence: same signal time, different refresh
const e30 = run("nova-dark", 30, 3).store, e144 = run("nova-dark", 144, 3).store;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const rotDiff = Math.abs(e30.rot - e144.rot);
ck("spin is time-based, not per-frame", rotDiff < 0.02, `30fps ${e30.rot.toFixed(3)} vs 144fps ${e144.rot.toFixed(3)}`);
ck("streak energy is frame-rate independent", Math.abs(mean(e30.energy) - mean(e144.energy)) < 0.04,
   `30fps ${mean(e30.energy).toFixed(3)} vs 144fps ${mean(e144.energy).toFixed(3)}`);

// silence decays
{
  const pal = resolvePalette(cfg.themes, "nova-dark", "nova-dark"); const cv = createCanvas(300, 200); const store = {};
  const sig = mkSig(); const p = defaultParams("halo");
  for (let t = 0; t < 2; t += 1 / 60) { fillDemoSignal(sig, t); halo.frame(makeGfx({ ctx: cv.getContext("2d"), palette: pal, params: p, store, now: t * 1000 }), { x: 0, y: 0, w: 300, h: 200 }, sig); }
  sig.freq.fill(0); sig.levelL = sig.levelR = 0;
  for (let t = 2; t < 5; t += 1 / 60) halo.frame(makeGfx({ ctx: cv.getContext("2d"), palette: pal, params: p, store, now: t * 1000 }), { x: 0, y: 0, w: 300, h: 200 }, sig);
  ck("streaks fall back when the music stops", Math.max(...store.energy) < 0.02, "max " + Math.max(...store.energy).toFixed(4));
}
// robustness
let threw = null;
try {
  for (const [w, h] of [[81, 51], [2000, 90], [90, 900], [1, 1]]) run("nova-dark", 60, 0.2, w, h);
  run("nova-dark", 60, 0.3, 400, 300, { ...defaultParams("halo"), streaks: 360, bubbles: 3, glow: false });
  const cv = createCanvas(100, 100); const pal = resolvePalette(cfg.themes, "nova-dark", "nova-dark"); const s = {};
  halo.frame(makeGfx({ ctx: cv.getContext("2d"), palette: pal, params: {}, store: s, now: 0 }), { x: 0, y: 0, w: 100, h: 100 }, { ready: false });
  halo.frame(makeGfx({ ctx: cv.getContext("2d"), palette: pal, params: {}, store: s, now: 10 }), { x: 0, y: 0, w: 100, h: 100 }, { ...mkSig(), binCount: 1024, sampleRate: 44100, freq: new Uint8Array(1024) });
  halo.dispose({ store: s });
  halo.frame(makeGfx({ ctx: cv.getContext("2d"), palette: pal, params: {}, store: s, now: 20 }), { x: 0, y: 0, w: 100, h: 100 }, mkSig());
} catch (e) { threw = e; }
ck("odd sizes, empty params, no data, bin-count change, dispose: no throw", !threw, threw ? String(threw.stack).split("\n").slice(0,2).join(" ") : "");
{
  // Environment-independent cost: count draw calls, not milliseconds (this
  // sandbox rasterises on the CPU, so a timing would say nothing about Chrome).
  const cv = createCanvas(600, 300); const real = cv.getContext("2d"); let strokes = 0, fills = 0;
  const ctx = new Proxy(real, { get(t, k) { const v = t[k];
    if (k === "stroke") return (...a) => { strokes++; return v.apply(t, a); };
    if (k === "fill" || k === "fillRect") return (...a) => { fills++; return v.apply(t, a); };
    return typeof v === "function" ? v.bind(t) : v; }, set(t, k, v) { t[k] = v; return true; } });
  const pal = resolvePalette(cfg.themes, "nova-dark", "nova-dark"); const sig = mkSig(); const store = {}; const p = defaultParams("halo");
  let n = 0;
  for (let t = 0; t < 3; t += 1 / 60, n++) { if (t > 2.9) { strokes = 0; fills = 0; }
    fillDemoSignal(sig, t); halo.frame(makeGfx({ ctx, palette: pal, params: p, store, now: t * 1000 }), { x: 0, y: 0, w: 600, h: 300 }, sig); }
  const streakStrokes = strokes - 16 - 4;
  ck("streaks are batched (≪ 2 strokes per streak)", streakStrokes < p.streaks * 0.6,
     `${streakStrokes} streak strokes for ${p.streaks} streaks (${p.streaks * 2} unbatched), ${strokes} strokes in total`);
  console.log(`  info  node-canvas CPU time ${r.ms.toFixed(1)} ms/frame at 900x520 — not representative of Chrome`);
}
console.warn = ow;
console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(FAIL ? 1 : 0);
