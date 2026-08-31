import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 400 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

// Drive spectrogram.frame() directly at a simulated frame rate and count how
// far the field actually scrolled, by looking for the boundary between the
// painted columns and the untouched background.
const run = await p.evaluate(async () => {
  const spectrogram = (await import("/web/renderers/spectrogram.js")).default;
  const { makeGfx } = await import("/web/core/gfx.js");
  const { config } = await import("/web/core/config.js");
  await config.load();
  const palette = config.palette();

  const W = 400, H = 120;
  const rect = { x: 0, y: 0, w: W, h: H };

  const BINS = 1024;
  const freq = new Uint8Array(BINS).fill(200);      // constant, bright field
  const sig = { ready: true, hasData: true, playing: true, freq,
                binCount: BINS, sampleRate: 48000 };

  // Measure painted width: scan the bottom row of the offscreen buffer for
  // non-background pixels.
  function paintedWidth(store) {
    const d = store.ctx.getImageData(0, H - 2, W, 1).data;
    let n = 0;
    for (let i = 0; i < W; i++) {
      const o = i * 4;
      if (d[o] > 8 || d[o + 1] > 8 || d[o + 2] > 8) n++;
    }
    return n;
  }

  function simulate(fps, seconds, pxPerSecond) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const store = {};
    const step = 1000 / fps;
    const frames = Math.round(fps * seconds);
    let now = 1000;
    for (let i = 0; i < frames; i++) {
      const gfx = makeGfx({ ctx, palette, params: { scrollSpeed: pxPerSecond,
                            gain: 1, noiseFloor: 4, usableBinFraction: 0.75,
                            showFreqTicks: false },
                            store, peaks: { ch0: [1] }, stereo: false,
                            layout: { barGap: 2 }, now });
      spectrogram.frame(gfx, rect, sig);
      now += step;
    }
    return { fps, painted: paintedWidth(store.buffer) };
  }

  const SECONDS = 2, RATE = 60;   // 60 px/s for 2 s => ~120 px expected
  return {
    expected: SECONDS * RATE,
    results: [simulate(30, SECONDS, RATE), simulate(60, SECONDS, RATE),
              simulate(144, SECONDS, RATE), simulate(240, SECONDS, RATE)],
    // sanity: doubling the rate should double the distance
    doubled: simulate(60, SECONDS, RATE * 2).painted,
    timeSpan: spectrogram.timeSpan({ w: 600 }, { scrollSpeed: RATE }),
  };
});

console.log(`expected ~${run.expected}px of scroll for 2s at 60 px/s\n`);
let min = Infinity, max = -Infinity;
for (const r of run.results) {
  console.log(`  ${String(r.fps).padStart(3)} fps -> ${String(r.painted).padStart(4)} px`);
  min = Math.min(min, r.painted); max = Math.max(max, r.painted);
}
const spread = max - min;
console.log(`\n  spread across 30-240 fps: ${spread} px`,
            spread <= 3 ? "FRAME-RATE INDEPENDENT  PASS" : "FAIL");
console.log(`  within 2px of expected:`,
            run.results.every(r => Math.abs(r.painted - run.expected) <= 2) ? "PASS" : "FAIL");
console.log(`  doubling px/s doubles distance: ${run.doubled} px`,
            Math.abs(run.doubled - run.expected * 2) <= 3 ? "PASS" : "FAIL");
console.log(`  timeSpan(600px @60px/s) = ${run.timeSpan}s`,
            run.timeSpan === 10 ? "PASS" : "FAIL");

// What the OLD behaviour would have produced, for comparison.
console.log(`\n  for reference, the old one-column-per-frame rule over 2s:`);
for (const fps of [30, 60, 144, 240]) console.log(`  ${String(fps).padStart(3)} fps -> ${fps * 2} px`);

console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
await b.close();
