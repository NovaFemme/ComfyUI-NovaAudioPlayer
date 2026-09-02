// The flux priming fix and the reference-relative hint selection.
import pw from "./_pw.mjs";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 400 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let pass = 0, fail = 0;
const ck = (n, ok, note = "") => { console.log(`  ${ok?"PASS":"FAIL"}  ${n}${note?"   "+note:""}`); ok?pass++:fail++; };

const out = await p.evaluate(async () => {
  const { makeGfx } = await import("/web/core/gfx.js");
  const { config } = await import("/web/core/config.js");
  const pg = (await import("/web/renderers/projected_guidance.js")).default;
  await config.load();
  const palette = config.palette();
  const BINS = 512, SR = 48000, N = 1024, W = 600, H = 220;
  const rect = { x: 0, y: 0, w: W, h: H };
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const params = Object.fromEntries(Object.entries(pg.params).map(([k,v]) => [k, v.default]));
  const toDb = v => -100 + (v/255)*70;

  // A perfectly STATIC spectrum: after the first frame, true flux is exactly 0.
  // Any non-zero integrated flux here is the priming bug and nothing else.
  function staticSig(frame) {
    const freq = new Uint8Array(BINS);
    for (let i = 0; i < BINS; i++) freq[i] = Math.round(200 * Math.pow(1 - i/BINS, 1.5)) + 10;
    const timeL = new Float32Array(N), timeR = new Float32Array(N);
    for (let i = 0; i < N; i++) timeL[i] = timeR[i] = 0.4 * Math.sin(i * 0.05);
    return { ready:true, hasData:true, playing:true, freq,
             freqDb: Float32Array.from(freq, v => v === 0 ? -145 : toDb(v)),
             timeL, timeR, binCount:BINS, sampleRate:SR, fftSize:N, clip:false,
             currentTime:0, progress:0.5, duration:100, frame };
  }
  const store = {};
  let now = 1000;
  const fluxPerFrame = [];
  for (let f = 1; f <= 20; f++) {
    ctx.clearRect(0,0,W,H);
    pg.frame(makeGfx({ ctx, palette, params, store, peaks:{ch0:[1]}, stereo:true,
                       layout:{barGap:2}, now }), rect, staticSig(f));
    fluxPerFrame.push(store.liveRaw.flux);
    now += 33;
  }

  // suggest() is exported, so the rules are exercised directly. Driving them
  // through frame() does not work — it recomputes `integrated` from the
  // accumulator and overwrites any values a test injects.
  const { suggest } = await import("/web/renderers/projected_guidance.js");
  const base = { crest: 14, centroid: 3000, flux: 0.15, flatness: -11, clip: 0 };
  const hintFor = (now_, ref) => suggest({ ...base, ...now_ }, ref).text;

  return {
    firstFlux: fluxPerFrame[0],
    laterFlux: fluxPerFrame.slice(1),
    integratedFlux: store.integrated.flux,
    hints: {
      crestDrop:  hintFor({ crest: 10 }, base),
      crestRise:  hintFor({ crest: 18 }, base),
      brighter:   hintFor({ centroid: 4200 }, base),
      darker:     hintFor({ centroid: 2000 }, base),
      noisier:    hintFor({ flatness: -6 }, base),
      smeared:    hintFor({ flux: 0.09 }, base),
      clipAppear: hintFor({ clip: 0.5, crest: 10 }, base),
      quiet:      hintFor({}, base),
      // crest -2 dB is 1.3x its 1.5 dB threshold; centroid 9000 is +200%,
      // 13x its 15% threshold. The brighter line must win.
      biggestWins: hintFor({ crest: 12, centroid: 9000 }, base),
      noRef:      hintFor({}, null),
    },
  };
});

console.log("flux priming (a perfectly static spectrum — true flux is 0)\n");
ck("first frame is primed, not counted as a full-scale rise",
   out.firstFlux === 0, `frame 1 flux = ${out.firstFlux}`);
// prevSpec is a Float32Array while the shares are computed in Float64, so the
// round-trip leaves a rounding floor around 1e-8. Real flux is ~0.15, so that
// is seven orders of magnitude down — noise, not signal.
ck("every later frame reads zero to within Float32 rounding",
   Math.max(...out.laterFlux) < 1e-6, `max ${Math.max(...out.laterFlux).toExponential(1)}`);
ck("integrated flux is not inflated by the first frame",
   out.integratedFlux < 1e-6, `integrated = ${out.integratedFlux.toExponential(1)}`);

console.log("\nreference-relative hints");
const h = out.hints;
for (const [k, v] of Object.entries(h)) console.log(`  ${k.padEnd(12)} "${v}"`);
console.log("");
ck("a crest drop is read as flattening transients",
   /^CREST -\d.*flattening/.test(h.crestDrop), h.crestDrop);
ck("a crest rise is read as an improvement",
   /^CREST \+.*sharper/.test(h.crestRise), h.crestRise);
ck("a brighter take is named as such",
   /^CENTROID \+\d+% vs REF.*brighter/.test(h.brighter), h.brighter);
ck("a darker take is named as such",
   /^CENTROID -\d+% vs REF.*darker/.test(h.darker), h.darker);
ck("rising flatness reads as noisier", /noisier/.test(h.noisier));
ck("falling flux reads as smeared", /smeared/.test(h.smeared));
// Clipping is now TIER 2 and no longer a reference-relative candidate: it
// short-circuits before relative() is reached, so it still wins over the
// crest drop that accompanies it — by precedence rather than by score.
ck("clipping still wins over the crest drop it causes",
   /^CLIP /.test(h.clipAppear) && !/CREST/.test(h.clipAppear), h.clipAppear);
ck("no drift says so rather than inventing a finding", /no meaningful drift/.test(h.quiet));
ck("the largest move wins, not the first rule",
   /^CENTROID \+\d+% vs REF/.test(h.biggestWins), `got "${h.biggestWins}"`);
ck("without a reference it falls back to absolute rules",
   !/REF/.test(h.noRef) && h.noRef.length > 0, `"${h.noRef}"`);

// Auditability: a reading nobody can check is an oracle, not an instrument.
const named = [h.crestDrop, h.crestRise, h.brighter, h.darker, h.noisier,
               h.smeared, h.clipAppear, h.biggestWins];
ck("every firing hint names the metric and its threshold",
   named.every(t => /^(CREST|CENTROID|FLATNESS|FLUX|CLIP|SAT)\b/.test(t) && /[(<>]/.test(t)),
   named.find(t => !/^(CREST|CENTROID|FLATNESS|FLUX|CLIP|SAT)\b/.test(t)) || "all named");

console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
