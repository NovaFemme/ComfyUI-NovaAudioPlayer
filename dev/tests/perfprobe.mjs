/**
 * Not a test — measures where the spectrum renderer's frame time goes.
 *
 * Reports median ms per drawSpectrum() call for the shipped settings and for
 * each suspected cost removed in isolation. Absolute numbers are headless
 * Chromium's, not a real GPU's; the RATIOS are the point.
 *
 * This is what identified the choppy-spectrum cause. On a 1760x600 canvas the
 * renderer cost 17.3 ms a frame; removing the rim stroke took it to 3.4 ms, and
 * setting glow to 0 while keeping the stroke took it to 7.2 ms. Blur radius 4
 * and radius 12 measured the same, which is the tell: canvas shadows take a
 * slow path whose cost tracks path complexity, not blur size.
 *
 * Run:  python3 dev/devserver.py --port 8731 &
 *       node dev/tests/perfprobe.mjs
 */
import pw from "./_pw.mjs";

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 700 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

const out = await p.evaluate(async () => {
  const { drawSpectrum } = await import("/web/renderers/spectrum.js");
  const { makeGfx } = await import("/web/core/gfx.js");
  const { config } = await import("/web/core/config.js");
  await config.load();
  const palette = config.palette();

  const BINS = 1024;
  const freq = new Uint8Array(BINS);
  const sig = { ready: true, hasData: true, playing: true, freq,
                binCount: BINS, sampleRate: 48000 };

  function median(a) { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; }

  // A fresh spectrum every frame, like real audio: forces the full path build.
  function reseed(t) {
    for (let i = 0; i < BINS; i++) {
      freq[i] = Math.max(0, Math.min(255,
        200 * Math.exp(-i / 180) + 40 * Math.sin(i * 0.05 + t) + 30 * Math.random()));
    }
  }

  function bench(label, W, H, params, frames = 120) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const store = {};
    const rect = { x: 0, y: 0, w: W, h: H };
    const times = [];
    for (let i = 0; i < frames; i++) {
      reseed(i * 0.1);
      const gfx = makeGfx({ ctx, palette, params, store, peaks: { ch0: [1] },
                            stereo: true, layout: { barGap: 2 }, now: 1000 + i * 16 });
      const t0 = performance.now();
      drawSpectrum(gfx, rect, sig, params.showLabels !== false);
      // Force the rasteriser to actually finish this frame's work, otherwise
      // the timing measures how fast commands are queued, not executed.
      ctx.getImageData(0, 0, 1, 1);
      times.push(performance.now() - t0);
    }
    return { label, W, H, ms: +median(times).toFixed(3) };
  }

  const SHIPPED = { gain: 1, noiseFloor: 2, usableBinFraction: 0.75,
                    rimWidth: 2, glow: 4, showLabels: true };

  const rows = [];
  // 880x300 is a comfortable node; 1760x600 is that node at graph zoom 2 or on
  // a HiDPI display, which is where it actually hurt.
  for (const [W, H] of [[880, 300], [1760, 600]]) {
    rows.push(bench("shipped (glow 4)", W, H, SHIPPED));
    rows.push(bench("glow 0", W, H, { ...SHIPPED, glow: 0 }));
    rows.push(bench("glow 12", W, H, { ...SHIPPED, glow: 12 }));
    rows.push(bench("no rim at all", W, H, { ...SHIPPED, rimWidth: 0 }));
    rows.push(bench("no labels", W, H, { ...SHIPPED, showLabels: false }));
  }
  return rows;
});

console.log("spectrum drawSpectrum() — median ms per call\n");
let lastW = null;
for (const r of out) {
  if (r.W !== lastW) { console.log(`  ${r.W}x${r.H}`); lastW = r.W; }
  const fps = 1000 / r.ms;
  console.log(`    ${r.label.padEnd(18)} ${String(r.ms).padStart(7)} ms   ~${fps.toFixed(0).padStart(4)} fps ceiling`);
}
console.log("\nerrors:", errs.length ? errs.join("; ") : "none");
await b.close();
