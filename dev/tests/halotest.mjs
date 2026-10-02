/**
 * halotest.mjs — the Halo renderer, drawn in real Chromium and read back.
 *
 * Same setup as the other browser suites:
 *
 *   python3 dev/devserver.py --port 8731 &
 *   node dev/tests/halotest.mjs [outDir]
 *
 * With an outDir it also writes halo-dark.png and halo-ice.png — a look at the
 * view without opening ComfyUI.
 *
 * An earlier version ran on node-canvas to avoid needing the devserver. That
 * was a mistake: node-canvas is a native module with no prebuilt binary for
 * current Node, so it failed to load on the machine that matters. Playwright
 * is already required by every other suite here.
 */
import pw from "./_pw.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || null;
const BASE = process.env.NOVA_DEV_URL || "http://127.0.0.1:8731";

let PASS = 0, FAIL = 0;
const ck = (n, ok, d = "") => { ok ? PASS++ : FAIL++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "   " + d : ""}`); };

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
const warns = [];
p.on("console", m => { if (m.type() === "warning" && /NovaPlayer/.test(m.text())) warns.push(m.text()); });
await p.goto(`${BASE}/dev/harness.html`, { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

const R = await p.evaluate(async () => {
  const halo = (await import("/web/renderers/halo.js")).default;
  const { makeGfx } = await import("/web/core/gfx.js");
  const { resolvePalette } = await import("/web/core/color.js");
  const { fillDemoSignal } = await import("/web/core/idle-demo.js");
  const { RENDERER_IDS, defaultParams } = await import("/web/renderers/registry.js");
  const cfg = await (await fetch("/nova_player/config")).json();
  const pal = theme => resolvePalette(cfg.themes, theme, "nova-dark");

  const mkSig = () => {
    const bins = 2048;
    return { ready: true, hasData: true, playing: true, binCount: bins, fftSize: 4096, sampleRate: 48000,
      freq: new Uint8Array(bins), freqDb: new Float32Array(bins),
      timeL: new Float32Array(4096), timeR: new Float32Array(4096),
      levelL: 0, levelR: 0, peakHold: 0, clip: false, corrRaw: 0 };
  };
  const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

  function run(theme, fps, seconds, W = 900, H = 520, params = defaultParams("halo")) {
    const cv = newCanvas(W, H), ctx = cv.getContext("2d");
    const palette = pal(theme), store = {}, sig = mkSig(), rect = { x: 0, y: 0, w: W, h: H };
    let n = 0; const t0 = performance.now();
    for (let t = 0; t <= seconds; t += 1 / fps, n++) {
      fillDemoSignal(sig, t);
      halo.frame(makeGfx({ ctx, palette, params, store, now: t * 1000 }), rect, sig);
    }
    return { cv, store, ms: (performance.now() - t0) / n };
  }
  const out = {};
  out.registered = RENDERER_IDS.includes("halo");
  out.count = RENDERER_IDS.length;

  const r = run("nova-dark", 60, 4);
  const ice = run("nova-ice", 60, 4);
  out.pngDark = r.cv.toDataURL("image/png");
  out.pngIce = ice.cv.toDataURL("image/png");
  const px = r.cv.getContext("2d").getImageData(0, 0, 900, 520).data;
  let magenta = 0, lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 240 && px[i + 1] < 20 && px[i + 2] > 240) magenta++;
    if (px[i] + px[i + 1] + px[i + 2] > 300) lit++;
  }
  Object.assign(out, { magenta, lit, maxE: Math.max(...r.store.energy), bubbles: r.store.bubbles.length });

  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const a30 = run("nova-dark", 30, 3).store, a144 = run("nova-dark", 144, 3).store;
  Object.assign(out, { rot30: a30.rot, rot144: a144.rot, e30: mean(a30.energy), e144: mean(a144.energy) });

  { // silence decays
    const cv = newCanvas(300, 200), ctx = cv.getContext("2d"), store = {}, sig = mkSig(), p = defaultParams("halo");
    const draw = t => halo.frame(makeGfx({ ctx, palette: pal("nova-dark"), params: p, store, now: t * 1000 }), { x: 0, y: 0, w: 300, h: 200 }, sig);
    for (let t = 0; t < 2; t += 1 / 60) { fillDemoSignal(sig, t); draw(t); }
    sig.freq.fill(0); sig.freqDb.fill(-Infinity); sig.levelL = sig.levelR = 0;
    for (let t = 2; t < 5; t += 1 / 60) draw(t);
    out.silenceMax = Math.max(...store.energy);
  }

  try { // robustness
    for (const [w, h] of [[81, 51], [2000, 90], [90, 900], [1, 1]]) run("nova-dark", 60, 0.2, w, h);
    run("nova-dark", 60, 0.3, 400, 300, { ...defaultParams("halo"), streaks: 360, bubbles: 3, glow: false });
    const cv = newCanvas(100, 100), ctx = cv.getContext("2d"), s = {}, rect = { x: 0, y: 0, w: 100, h: 100 };
    const g = now => makeGfx({ ctx, palette: pal("nova-dark"), params: {}, store: s, now });
    halo.frame(g(0), rect, { ready: false });
    halo.frame(g(10), rect, { ...mkSig(), binCount: 1024, sampleRate: 44100, freq: new Uint8Array(1024) });
    halo.dispose({ store: s });
    halo.frame(g(20), rect, mkSig());
    out.threw = null;
  } catch (e) { out.threw = String(e && e.stack || e).split("\n").slice(0, 2).join(" "); }

  { // draw calls, counted through a proxy
    const cv = newCanvas(600, 300), real = cv.getContext("2d"); let strokes = 0;
    const ctx = new Proxy(real, {
      get(t, k) { const v = t[k];
        if (k === "stroke") return (...a) => { strokes++; return v.apply(t, a); };
        return typeof v === "function" ? v.bind(t) : v; },
      set(t, k, v) { t[k] = v; return true; } });
    const store = {}, sig = mkSig(), p = defaultParams("halo");
    for (let t = 0; t < 3; t += 1 / 60) {
      if (t > 2.99) strokes = 0;
      fillDemoSignal(sig, t);
      halo.frame(makeGfx({ ctx, palette: pal("nova-dark"), params: p, store, now: t * 1000 }), { x: 0, y: 0, w: 600, h: 300 }, sig);
    }
    out.strokes = strokes; out.streaks = p.streaks;
  }

  // Timing in real Chromium. Informational: headless may be software-rendered.
  out.ms = run("nova-dark", 60, 3, 900, 300).ms;
  return out;
});

ck("registered in the view cycle", R.registered, `${R.count} renderers`);
ck("no unknown-role or ramp warnings", warns.length === 0, warns.slice(0, 3).join(" | "));
ck("no fallback magenta painted", R.magenta < 20, `${R.magenta} px`);
ck("the ring actually draws", R.lit > 5000, `${R.lit} bright px`);
ck("streaks respond to signal", R.maxE > 0.3, `max energy ${R.maxE.toFixed(2)}`);
ck("bubbles exist and are bounded", R.bubbles > 5 && R.bubbles <= 260, `${R.bubbles} bubbles`);
ck("spin is time-based, not per-frame", Math.abs(R.rot30 - R.rot144) < 0.02, `30fps ${R.rot30.toFixed(3)} vs 144fps ${R.rot144.toFixed(3)}`);
ck("streak energy is frame-rate independent", Math.abs(R.e30 - R.e144) < 0.04, `30fps ${R.e30.toFixed(3)} vs 144fps ${R.e144.toFixed(3)}`);
ck("streaks fall back when the music stops", R.silenceMax < 0.02, `max ${R.silenceMax.toFixed(4)}`);
ck("odd sizes, empty params, no data, bin-count change, dispose: no throw", !R.threw, R.threw || "");
ck("strokes are batched (far fewer than one per segment)", R.strokes < R.streaks * 3,
   `${R.strokes} strokes/frame for ${R.streaks} streaks (${R.streaks * 9} unbatched)`);
ck("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));
console.log(`  info  ${R.ms.toFixed(2)} ms/frame at 900x300 in headless Chromium`);

if (OUT) {
  for (const [name, url] of [["halo-dark.png", R.pngDark], ["halo-ice.png", R.pngIce]]) {
    writeFileSync(join(OUT, name), Buffer.from(url.split(",")[1], "base64"));
  }
  console.log(`  wrote halo-dark.png and halo-ice.png to ${OUT}`);
}

await b.close();
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
