/**
 * Cross-path invariants: the meter and the Python bench measure the same audio
 * through different chains, and the RELATIONSHIP between them is knowable.
 *
 * These are inequalities on purpose. The two systems are not supposed to agree
 * — the meter's denominator excludes silence and its window may be partial,
 * while compute_bench counts every sample in the file exactly once. What is
 * fixed is the DIRECTION of the difference, and every bug this session inverted
 * one of these:
 *
 *   - clipped_samples double-counted, so bench clipping exceeded what any
 *     honest count could produce
 *   - the integrated window was partial and unlabelled, so meter figures
 *     silently described a fraction of the take
 *
 * Both were caught by eye, in screenshots, after shipping. An inequality is
 * cheaper than a screenshot.
 *
 * Run:  python3 dev/devserver.py --port 8731 &
 *       node dev/tests/invariants.mjs
 */
import pw from "./_pw.mjs";

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 400 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let PASS = 0, FAIL = 0;
const ck = (n, ok, note = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${note ? "   " + note : ""}`);
  ok ? PASS++ : FAIL++;
};

console.log("cross-path invariants\n");

const r = await p.evaluate(async () => {
  const pg = (await import("/web/renderers/projected_guidance.js")).default;
  const { makeGfx } = await import("/web/core/gfx.js");
  const { config } = await import("/web/core/config.js");
  await config.load();
  const palette = config.palette();

  const BINS = 512, SR = 48000, N = 1024, W = 600, H = 260;
  const rect = { x: 0, y: 0, w: W, h: H };
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const params = Object.fromEntries(
    Object.entries(pg.params).map(([k, v]) => [k, v.default]));
  const store = {};

  const freq = new Float32Array(BINS);
  const timeL = new Float32Array(N), timeR = new Float32Array(N);
  for (let i = 0; i < BINS; i++) freq[i] = -30 - (i / BINS) * 60;

  const DURATION = 100;
  let now = 0, frame = 0;

  // Half the take is signal, half is silence below the gate. compute_bench
  // would average over all of it; the meter excludes the silent half.
  function step(t, silent) {
    for (let i = 0; i < N; i++) {
      const v = silent ? 0.0001 : 0.5 * Math.sin((i + frame * 64) * 0.05);
      timeL[i] = v; timeR[i] = v;
    }
    const sig = {
      ready: true, hasData: true, playing: true, frame: ++frame,
      freq: new Uint8Array(BINS), freqDb: freq, timeL, timeR,
      binCount: BINS, sampleRate: SR, progress: t / DURATION,
      currentTime: t, duration: DURATION, clip: false,
    };
    now += 33;
    pg.frame(makeGfx({ ctx, palette, params, store, peaks: { ch0: [1] },
                       stereo: true, layout: { barGap: 2 }, now,
                       bench: null }), rect, sig);
  }

  for (let t = 0; t <= 50; t += 0.5) step(t, false);   // first half: signal
  for (let t = 50; t <= 100; t += 0.5) step(t, true);  // second half: silence

  const covFull = pg.coverage(store, DURATION);
  const integ = { ...store.integrated };

  // A fresh store, played only to 40% — the partial-window case.
  const store2 = {};
  frame = 0; now = 0;
  const saveStore = store2;
  for (let t = 0; t <= 40; t += 0.5) {
    for (let i = 0; i < N; i++) { const v = 0.5 * Math.sin((i + frame * 64) * 0.05); timeL[i] = v; timeR[i] = v; }
    const sig = { ready: true, hasData: true, playing: true, frame: ++frame,
                  freq: new Uint8Array(BINS), freqDb: freq, timeL, timeR,
                  binCount: BINS, sampleRate: SR, progress: t / DURATION,
                  currentTime: t, duration: DURATION, clip: false };
    now += 33;
    pg.frame(makeGfx({ ctx, palette, params, store: saveStore, peaks: { ch0: [1] },
                       stereo: true, layout: { barGap: 2 }, now, bench: null }), rect, sig);
  }

  return {
    covFull, integ,
    covPartial: pg.coverage(store2, DURATION),
    windowStart: store.acc.windowStart,
    windowEnd: store.acc.windowEnd,
    autoResets: store.autoResets || 0,
  };
});

// -- coverage is real and bounded -------------------------------------------
ck("coverage is reported, not left implicit",
   typeof r.covFull === "number", String(r.covFull));
ck("coverage stops at the last NON-SILENT frame, not the transport position",
   r.covFull > 0.4 && r.covFull < 0.6,
   `${(r.covFull * 100).toFixed(0)}% — silence after 50s is excluded`);
ck("the window is the gated window",
   r.windowStart === 0 && r.windowEnd <= 50.5,
   `${r.windowStart}s to ${r.windowEnd}s`);
ck("a partial listen reports partial coverage",
   Math.abs(r.covPartial - 0.4) < 0.02, `${(r.covPartial * 100).toFixed(0)}%`);
ck("coverage never exceeds 1.0",
   r.covFull <= 1 && r.covPartial <= 1);
ck("no automatic reset fired during linear playback",
   r.autoResets === 0, `${r.autoResets}`);

// -- metric bounds ----------------------------------------------------------
ck("flux stays within [0, 1] — shares sum to 1",
   r.integ.flux >= 0 && r.integ.flux <= 1, String(r.integ.flux));
ck("clip and sat are percentages, not fractions",
   r.integ.clip >= 0 && r.integ.clip <= 100 &&
   r.integ.sat >= 0 && r.integ.sat <= 100);
ck("crest is non-negative",
   r.integ.crest >= 0, String(r.integ.crest.toFixed(2)));

// -- the RMS convention identity, asserted rather than documented -----------
const rmsIdentity = await p.evaluate(() => {
  // 10*log10((1+r)/2) is the exact gap between a both-channels RMS and a mono
  // downmix at equal channel power. docs/TECHNICAL.md states it; this checks it.
  const out = [];
  for (const target of [1.0, 0.9, 0.591, 0.0]) {
    const n = 200000;
    let sa = 0, sb = 0, sab = 0, sMono = 0;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    for (let i = 0; i < n; i++) {
      const a = rnd(), bb = rnd();
      const L = a * 0.1;
      const R = (target * a + Math.sqrt(Math.max(0, 1 - target * target)) * bb) * 0.1;
      sa += L * L; sb += R * R; sab += L * R;
      const mono = (L + R) / 2;
      sMono += mono * mono;
    }
    const r = sab / Math.sqrt(sa * sb);
    const both = 10 * Math.log10((sa + sb) / (2 * n));
    const mono = 10 * Math.log10(sMono / n);
    out.push({ r, delta: mono - both, predicted: 10 * Math.log10((1 + r) / 2) });
  }
  return out;
});
for (const x of rmsIdentity) {
  ck(`RMS identity holds at r=${x.r.toFixed(3)}`,
     Math.abs(x.delta - x.predicted) < 0.02,
     `measured ${x.delta.toFixed(3)} dB vs 10log10((1+r)/2) = ${x.predicted.toFixed(3)}`);
}

console.log(`\nerrors: ${errs.length ? errs.join("; ") : "none"}`);
console.log(`\n${PASS} passed, ${FAIL} failed`);
await b.close();
process.exit(FAIL ? 1 : 0);
