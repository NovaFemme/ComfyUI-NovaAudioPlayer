import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1150, height: 460 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let pass = 0, fail = 0;
const ck = (name, ok, note = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note ? "   " + note : ""}`);
  ok ? pass++ : fail++;
};

const out = await p.evaluate(async () => {
  const { makeGfx } = await import("/web/core/gfx.js");
  const { config } = await import("/web/core/config.js");
  const pg = (await import("/web/renderers/projected_guidance.js")).default;
  await config.load();
  const palette = config.palette();

  const BINS = 1024, SR = 48000, N = 2048;
  const W = 620, H = 220, rect = { x: 0, y: 0, w: W, h: H };
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const params = Object.fromEntries(Object.entries(pg.params).map(([k, v]) => [k, v.default]));

  // ---- synthetic material -------------------------------------------------
  // Each case has a KNOWN answer, so the metric can be checked, not just run.
  const DB_MIN = -100, DB_MAX = -30;
  // Mirror the analyser: bytes are dB linearly mapped over DB_MIN..DB_MAX. The
  // float array carries the same dB values, unclamped, as the real one does.
  const toDb = v => DB_MIN + (v / 255) * (DB_MAX - DB_MIN);

  function make(kind, phase) {
    const freq = new Uint8Array(BINS);
    const timeL = new Float32Array(N), timeR = new Float32Array(N);
    if (kind === "tone") {
      // Pure sine: crest = 3.01 dB exactly, flatness ~0, low centroid.
      for (let i = 0; i < N; i++) timeL[i] = timeR[i] = 0.5 * Math.sin((i + phase * 97) * 0.05);
      for (let i = 0; i < BINS; i++) freq[i] = i > 8 && i < 13 ? 230 : 0;
    } else if (kind === "noise") {
      // White noise: crest ~11-13 dB, flatness high, centroid mid-high.
      let s = 12345 + phase * 7919;
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x3fffffff - 1; };
      for (let i = 0; i < N; i++) { timeL[i] = rnd() * 0.4; timeR[i] = rnd() * 0.4; }
      for (let i = 0; i < BINS; i++) freq[i] = 150 + ((i * 37 + phase * 13) % 40);
    } else if (kind === "bright") {
      // Energy pushed to the top: centroid must land high.
      for (let i = 0; i < N; i++) timeL[i] = timeR[i] = 0.3 * Math.sin(i * 1.1 + phase);
      for (let i = 0; i < BINS; i++) freq[i] = Math.round(20 + 200 * (i / BINS) ** 2);
    } else if (kind === "clipped") {
      // Square-ish, jammed to the rail: crest -> 0 dB, clip% high.
      for (let i = 0; i < N; i++) timeL[i] = timeR[i] = Math.sin(i * 0.05 + phase) > 0 ? 1 : -1;
      for (let i = 0; i < BINS; i++) freq[i] = 120;
    } else if (kind === "limited") {
      // Squashed into a ceiling BELOW full scale, then left there — the shape
      // a limiter produces, and the shape a normalise-after-clip leaves behind.
      // CLIP cannot see this: no sample ever reaches the digital ceiling.
      const CEIL = 0.859;   // -1.32 dBFS
      for (let i = 0; i < N; i++) {
        const v = 0.7 * Math.sin((i + phase * 31) * 0.031) + 0.55 * Math.sin((i + phase * 31) * 0.049);
        timeL[i] = timeR[i] = Math.max(-CEIL, Math.min(CEIL, v));
      }
      for (let i = 0; i < BINS; i++) freq[i] = Math.round(180 * Math.pow(1 - i / BINS, 1.2));
    } else if (kind === "bass") {
      // A loud low sine. Its samples barely move near the apex, so a loose
      // flat-top epsilon calls it saturated. It must read 0.
      for (let i = 0; i < N; i++) timeL[i] = timeR[i] = 0.95 * Math.sin((i + phase * 13) * 0.0065);
      for (let i = 0; i < BINS; i++) freq[i] = i < 6 ? 240 : 0;
    } else if (kind === "silence") {
      for (let i = 0; i < BINS; i++) freq[i] = 0;
    }
    const freqDb = Float32Array.from(freq, v => (v === 0 ? -145 : toDb(v)));
    return { ready: true, hasData: true, playing: true, freq, freqDb, timeL, timeR,
             binCount: BINS, sampleRate: SR, fftSize: BINS * 2, clip: false,
             currentTime: 0, progress: 0, duration: 100, frame: 0 };
  }

  // Repaint at 60 Hz but tick the analyser at 30 Hz — the real-world case the
  // gate exists for, and the one that used to double-count.
  function drive(kind, seconds, store = {}, start = 1000, progressFrom = 0) {
    let now = start, frame = store.__f || 0;
    const paints = Math.round(seconds * 60);
    for (let i = 0; i < paints; i++) {
      if (i % 2 === 0) frame++;                 // analyser at half the paint rate
      const sig = make(kind, frame);            // material follows the ANALYSER
      sig.frame = frame;
      sig.progress = progressFrom + (i / paints) * 0.4;
      ctx.clearRect(0, 0, W, H);
      pg.frame(makeGfx({ ctx, palette, params, store, peaks: { ch0: [1] }, stereo: true,
                         layout: { barGap: 2 }, now }), rect, sig);
      now += 1000 / 60;
    }
    store.__f = frame;
    return { store, now, frame };
  }

  const res = {};
  for (const kind of ["tone", "noise", "bright", "clipped", "limited", "bass"]) {
    const r = drive(kind, 4);
    res[kind] = { ...r.store.integrated, specFrames: r.store.acc.specFrames };
  }

  // Silence must not be integrated at all.
  const sil = drive("silence", 3);
  res.silence = { specFrames: sil.store.acc.specFrames, samples: sil.store.acc.samples };

  // Frame-rate independence: same material, 120 Hz repaint / 30 Hz analyser.
  const fast = (() => {
    const store = {};
    let now = 1000, frame = 0;
    for (let i = 0; i < 480; i++) {
      if (i % 4 === 0) frame++;
      const sig = make("noise", frame);
      sig.frame = frame; sig.progress = i / 480 * 0.4;
      ctx.clearRect(0, 0, W, H);
      pg.frame(makeGfx({ ctx, palette, params, store, peaks: { ch0: [1] }, stereo: true,
                         layout: { barGap: 2 }, now }), rect, sig);
      now += 1000 / 120;
    }
    return store.integrated;
  })();

  // Freeze / clear the reference through hit(), at the real coordinates.
  const refRun = drive("noise", 2);
  const gfxRef = makeGfx({ ctx, palette, params, store: refRun.store, peaks: { ch0: [1] },
                           stereo: true, layout: { barGap: 2 }, now: refRun.now });
  const pr = refRun.store.panelRect;
  const inside = { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 };
  const outside = { x: rect.x + rect.w - 4, y: rect.y + rect.h - 4 };
  const hitOutside = pg.hit(outside, rect, gfxRef);
  const hitFreeze = pg.hit(inside, rect, gfxRef);
  const frozen = refRun.store.reference ? { ...refRun.store.reference } : null;
  const hitClear = pg.hit(inside, rect, gfxRef);
  const cleared = refRun.store.reference;

  // A new take must restart the integration even with autoReset OFF, and must
  // KEEP the frozen reference — that pairing is the whole comparison workflow.
  const srcParams = { ...params, autoReset: false };
  const takeA = (() => {
    const store = { sourceId: 1 };
    let now = 1000, frame = 0;
    for (let i = 0; i < 120; i++) {
      if (i % 2 === 0) frame++;
      const sig = make("clipped", frame); sig.frame = frame; sig.progress = i / 120;
      ctx.clearRect(0, 0, W, H);
      pg.frame(makeGfx({ ctx, palette, params: srcParams, store, peaks: { ch0: [1] },
                         stereo: true, layout: { barGap: 2 }, now }), rect, sig);
      now += 1000 / 60;
    }
    return { store, now, frame };
  })();
  const gfxA = makeGfx({ ctx, palette, params: srcParams, store: takeA.store,
                         peaks: { ch0: [1] }, stereo: true, layout: { barGap: 2 }, now: takeA.now });
  pg.hit({ x: takeA.store.panelRect.x + 20, y: takeA.store.panelRect.y + 20 }, rect, gfxA);
  const takeARef = { ...takeA.store.reference };
  const takeAFrames = takeA.store.acc.specFrames;

  // Host bumps sourceId on a new file. Progress deliberately does NOT rewind,
  // so the seek heuristic cannot save us here even if it were enabled.
  takeA.store.sourceId = 2;
  let nB = takeA.now, fB = takeA.frame;
  for (let i = 0; i < 60; i++) {
    if (i % 2 === 0) fB++;
    const sig = make("tone", fB); sig.frame = fB; sig.progress = 0.99;
    ctx.clearRect(0, 0, W, H);
    pg.frame(makeGfx({ ctx, palette, params: srcParams, store: takeA.store, peaks: { ch0: [1] },
                       stereo: true, layout: { barGap: 2 }, now: nB }), rect, sig);
    nB += 1000 / 60;
  }
  const takeB = { frames: takeA.store.acc.specFrames, ...takeA.store.integrated,
                  refKept: takeA.store.reference ? { ...takeA.store.reference } : null };

  // Reset on backwards seek.
  const seek = drive("noise", 2);
  const before = seek.store.acc.specFrames;
  const s2 = make("noise", 1); s2.frame = seek.frame + 1; s2.progress = 0.01;
  pg.frame(makeGfx({ ctx, palette, params, store: seek.store, peaks: { ch0: [1] },
                     stereo: true, layout: { barGap: 2 }, now: seek.now + 16 }), rect, s2);
  const after = seek.store.acc.specFrames;

  // Deltas must survive a re-measure: freeze on tone, then play noise.
  const cmp = drive("tone", 3);
  const gfxC = makeGfx({ ctx, palette, params, store: cmp.store, peaks: { ch0: [1] },
                         stereo: true, layout: { barGap: 2 }, now: cmp.now });
  pg.hit({ x: cmp.store.panelRect.x + 20, y: cmp.store.panelRect.y + 20 }, rect, gfxC);
  const toneRef = { ...cmp.store.reference };
  pg.reset(cmp.store);
  const cmp2 = drive("noise", 3, cmp.store, cmp.now, 0.5);
  const noiseNow = { ...cmp2.store.integrated };

  // Bounds: nothing may go NaN or leave its declared range.
  const METRIC_RANGE = { crest: [0, 100], centroid: [0, 24000], flux: [0, 2],
                         flatness: [-145, 0.01], clip: [0, 100], sat: [0, 100] };
  const bad = [];
  for (const [kind, v] of Object.entries(res)) {
    for (const [k, [lo, hi]] of Object.entries(METRIC_RANGE)) {
      if (!(k in v)) continue;
      if (!Number.isFinite(v[k]) || v[k] < lo || v[k] > hi) bad.push(`${kind}.${k}=${v[k]}`);
    }
  }

  return { takeARef, takeAFrames, takeB,
           res, fast, hitOutside, hitFreeze, frozen, cleared,
           seekBefore: before, seekAfter: after, toneRef, noiseNow, bad,
           refKept: frozen && Object.keys(frozen).length === 6 };
});

console.log("APG meter — metric behaviour on known material\n");
const r = out.res;
const f = n => (n === undefined ? "—" : n.toFixed(3));
for (const [k, v] of Object.entries(r)) {
  if (v.crest === undefined) { console.log(`  ${k.padEnd(9)} specFrames=${v.specFrames} samples=${v.samples}`); continue; }
  console.log(`  ${k.padEnd(9)} crest ${f(v.crest).padStart(7)} dB  centroid ${Math.round(v.centroid).toString().padStart(5)} Hz  ` +
              `flux ${f(v.flux)}  flat ${v.flatness.toFixed(1).padStart(6)} dB  ` +
              `clip ${v.clip.toFixed(3)}%  sat ${v.sat.toFixed(2)}%`);
}
console.log("");

ck("sine crest ≈ 3.01 dB (the analytic answer)", Math.abs(r.tone.crest - 3.01) < 0.15,
   `got ${r.tone.crest.toFixed(2)}`);
ck("uniform noise crest ≈ 4.77 dB (20·log10√3)", Math.abs(r.noise.crest - 4.77) < 0.3,
   `got ${r.noise.crest.toFixed(2)}`);
ck("noise crest above sine crest", r.noise.crest > r.tone.crest + 1,
   `${r.noise.crest.toFixed(2)} vs ${r.tone.crest.toFixed(2)}`);
ck("square-wave crest ≈ 0 dB", r.clipped.crest < 0.2, `got ${r.clipped.crest.toFixed(3)}`);
// Flatness is 10*log10(geo/arith): 0 dB is exactly white noise and nothing can
// exceed it, so that ceiling is a real invariant, not a clamp.
ck("flat spectrum reads ~0 dB flatness (the definition's ceiling)",
   Math.abs(r.clipped.flatness) < 0.01, `${r.clipped.flatness.toFixed(3)} dB`);
ck("noise flatness far above tone flatness",
   r.noise.flatness - r.tone.flatness > 15,
   `${r.tone.flatness.toFixed(1)} dB → ${r.noise.flatness.toFixed(1)} dB`);
ck("no flatness reading exceeds 0 dB",
   Object.values(r).every(v => v.flatness === undefined || v.flatness <= 0.001));
ck("bright material has the highest centroid", r.bright.centroid > r.noise.centroid && r.bright.centroid > r.tone.centroid,
   `${Math.round(r.bright.centroid)} Hz`);
ck("tone has the lowest centroid", r.tone.centroid < r.noise.centroid, `${Math.round(r.tone.centroid)} Hz`);
ck("full-scale square reports clipping", r.clipped.clip > 50, `${r.clipped.clip.toFixed(1)}%`);
ck("clean material reports no clipping", r.tone.clip === 0 && r.noise.clip === 0);

// The reason SAT exists. A take limited at -1.32 dBFS never touches the digital
// ceiling, so CLIP stays a convincing zero while the waveform is flat-topped
// throughout. This is the over-guidance signature that survives normalisation.
ck("a limiter below full scale reports NO clipping", r.limited.clip === 0,
   `clip ${r.limited.clip.toFixed(4)}%`);
ck("...but SAT catches it", r.limited.sat > 10, `sat ${r.limited.sat.toFixed(2)}%`);
ck("a loud low sine is NOT called saturated", r.bass.sat < 0.01,
   `sat ${r.bass.sat.toFixed(4)}% (the false positive a loose epsilon gives)`);
ck("clean tone and noise are not called saturated",
   r.tone.sat < 0.01 && r.noise.sat < 0.01);
ck("a full-scale square is saturated AND clipped",
   r.clipped.sat > 90 && r.clipped.clip > 90);
ck("changing noise has flux, steady tone has less", r.noise.flux > r.tone.flux,
   `${f(r.noise.flux)} vs ${f(r.tone.flux)}`);
ck("silence is excluded from the integrated figures",
   out.res.silence.specFrames === 0 && out.res.silence.samples === 0);
ck("no metric leaves its range or goes NaN", out.bad.length === 0, out.bad.join(", "));

console.log("\nframe-rate independence (60 Hz vs 120 Hz repaint, same analyser rate)");
for (const k of ["crest", "centroid", "flux", "flatness"]) {
  const a = r.noise[k], c = out.fast[k];
  const rel = Math.abs(a - c) / (Math.abs(a) || 1);
  ck(`  ${k} matches within 5%`, rel < 0.05, `${f(a)} vs ${f(c)}  (${(rel * 100).toFixed(1)}%)`);
}

console.log("\nreference take");
ck("click outside the panel is ignored", out.hitOutside === null);
ck("click inside the panel is consumed", out.hitFreeze && out.hitFreeze.action === "consumed");
ck("freeze captures every metric", out.refKept === true);
ck("second click clears the reference", !out.cleared);
ck("frozen tone vs live noise differs in crest",
   Math.abs(out.noiseNow.crest - out.toneRef.crest) > 1,
   `ref ${out.toneRef.crest.toFixed(2)} → now ${out.noiseNow.crest.toFixed(2)}`);
ck("frozen tone vs live noise differs in flatness",
   out.noiseNow.flatness - out.toneRef.flatness > 5,
   `ref ${out.toneRef.flatness.toFixed(1)} dB → now ${out.noiseNow.flatness.toFixed(1)} dB`);

console.log("\nnew take (autoReset OFF, progress does NOT rewind)");
ck("a different render restarts the integration anyway",
   out.takeB.frames < out.takeAFrames && out.takeB.frames <= 31,
   `${out.takeAFrames} frames -> ${out.takeB.frames}`);
ck("the frozen reference survives the new take", !!out.takeB.refKept);
ck("reference still holds take A's numbers, not take B's",
   Math.abs(out.takeB.refKept.crest - out.takeARef.crest) < 1e-9 &&
   Math.abs(out.takeB.crest - out.takeARef.crest) > 1,
   `ref ${out.takeARef.crest.toFixed(2)} dB  |  now ${out.takeB.crest.toFixed(2)} dB`);

console.log("\nauto-reset");
ck("backwards seek restarts the integration",
   out.seekAfter < out.seekBefore && out.seekAfter <= 1,
   `${out.seekBefore} frames → ${out.seekAfter}`);

console.log("\npageerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
