// Calibrate the APG bar ranges against material measured through a real
// AnalyserNode, using the renderer's own formulas. Picking these by eye is how
// you end up with a needle pinned at one end.
import pw from "./_pw.mjs";
const b = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const p = await b.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });

const out = await p.evaluate(async () => {
  const SR = 48000, FFT = 4096, BINS = FFT / 2, FLOOR_DB = -140;
  const ctx = new AudioContext({ sampleRate: SR });
  await ctx.resume();

  function buffer(kind) {
    const DUR = 4, buf = ctx.createBuffer(1, SR * DUR, SR), d = buf.getChannelData(0);
    const partials = [55, 110, 165, 220, 330, 440, 660, 880, 1320, 1760, 2640, 3520];
    for (let i = 0; i < d.length; i++) {
      const t = i / SR;
      let v = 0;
      if (kind === "noise") { v = (Math.random() * 2 - 1) * 3; }
      else if (kind === "tone") { v = Math.sin(2 * Math.PI * 440 * t) * 3; }
      else {
        for (let k = 0; k < partials.length; k++) v += Math.sin(2 * Math.PI * partials[k] * t) / (k + 1.6);
        v += (Math.random() * 2 - 1) * (kind === "clean" ? 0.0006 : 0.06);
        if (kind !== "smeared" && i % (SR / 2) < 900) v += (Math.random() * 2 - 1) * 0.9;
      }
      d[i] = v * 0.1;
    }
    return buf;
  }

  async function measure(kind, shelfDb) {
    const src = ctx.createBufferSource();
    src.buffer = buffer(kind); src.loop = true;
    const shelf = ctx.createBiquadFilter();
    shelf.type = "highshelf"; shelf.frequency.value = 4000; shelf.gain.value = shelfDb;
    const an = ctx.createAnalyser();
    an.fftSize = FFT; an.smoothingTimeConstant = 0.6;
    src.connect(shelf); shelf.connect(an);
    const sink = ctx.createGain(); sink.gain.value = 0;
    an.connect(sink); sink.connect(ctx.destination);
    src.start();
    await new Promise(r => setTimeout(r, 600));

    const db = new Float32Array(BINS), prev = new Float64Array(BINS), mags = new Float64Array(BINS);
    const hzPerBin = (SR / 2) / BINS;
    let cSum = 0, fSum = 0, xSum = 0, n = 0;
    for (let k = 0; k < 25; k++) {
      an.getFloatFrequencyData(db);
      let total = 0, weighted = 0, flatLog = 0;
      for (let i = 0; i < BINS; i++) {
        const m = Math.pow(10, Math.max(db[i], FLOOR_DB) / 20);
        mags[i] = m; total += m; weighted += m * i * hzPerBin; flatLog += Math.log(m);
      }
      const cen = total > 1e-12 ? weighted / total : 0;
      const ratio = Math.min(1, Math.exp(flatLog / BINS) / (total / BINS));
      const flat = ratio > 0 ? 10 * Math.log10(ratio) : FLOOR_DB;
      let flux = 0;
      for (let i = 0; i < BINS; i++) {
        const share = mags[i] / total;
        if (k > 0 && share > prev[i]) flux += share - prev[i];
        prev[i] = share;
      }
      if (k > 0) { cSum += cen; fSum += flat; xSum += flux; n++; }
      await new Promise(r => setTimeout(r, 40));
    }
    src.stop();
    return { kind, shelfDb, centroid: cSum / n, flatness: fSum / n, flux: xSum / n };
  }

  const rows = [];
  for (const [k, g] of [["clean", -6], ["clean", 0], ["clean", 6],
                        ["mixed", -6], ["mixed", 0], ["mixed", 6],
                        ["smeared", 0], ["tone", 0], ["noise", 0]]) {
    rows.push(await measure(k, g));
  }
  await ctx.close();
  return rows;
});

console.log("New formulas, measured through a real AnalyserNode\n");
console.log("  material        shelf    CENTROID       FLATNESS        FLUX");
for (const r of out) {
  console.log(`  ${r.kind.padEnd(9)} ${String(r.shelfDb).padStart(6)} dB  ` +
              `${r.centroid.toFixed(0).padStart(7)} Hz   ` +
              `${r.flatness.toFixed(1).padStart(7)} dB   ` +
              `${r.flux.toFixed(4).padStart(8)}`);
}
const span = k => {
  const v = out.map(r => r[k]);
  return `${Math.min(...v).toFixed(k === "flux" ? 4 : 1)} .. ${Math.max(...v).toFixed(k === "flux" ? 4 : 1)}`;
};
console.log(`\nobserved spans:  centroid ${span("centroid")} Hz | flatness ${span("flatness")} dB | flux ${span("flux")}`);
const cl = out.filter(r => r.kind === "clean");
console.log(`clean-track shelf response: centroid ${(cl[2].centroid - cl[0].centroid).toFixed(0)} Hz ` +
            `over 12 dB  (${((cl[2].centroid - cl[0].centroid) / cl[1].centroid * 100).toFixed(0)}% of centre)`);
console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
await b.close();
