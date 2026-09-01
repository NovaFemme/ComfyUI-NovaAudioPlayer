// Directly exercise AudioEngine.update()'s float-FFT path with stub analysers.
// The harness replaces engine.update() wholesale, so nothing else covers the
// lines actually changed in the engine.
import pw from "./_pw.mjs";
const b = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const p = await b.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let pass = 0, fail = 0;
const ck = (n, ok, note = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${note ? "   " + note : ""}`); ok ? pass++ : fail++; };

const out = await p.evaluate(async () => {
  const { AudioEngine } = await import("/web/core/audio-engine.js");
  const BINS = 1024, FFT = 2048;

  // Stub analysers: byte data clamps at the -100 dB floor exactly as the real
  // one does, float data reports the true value below it. That difference is
  // the entire reason the float path exists, so the stub has to reproduce it.
  const trueDb = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) trueDb[i] = -30 - (i / BINS) * 90;   // -30 .. -120

  const mkAnalyser = () => ({
    fftSize: FFT,
    frequencyBinCount: BINS,
    context: { sampleRate: 48000 },
    getByteFrequencyData(a) {
      for (let i = 0; i < BINS; i++) {
        const t = (trueDb[i] - (-100)) / 70;
        a[i] = Math.max(0, Math.min(255, Math.round(t * 255)));   // clamps at 0
      }
    },
    getFloatFrequencyData(a) { a.set(trueDb); },
    getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = Math.sin(i * 0.03) * 0.5; },
  });

  const eng = new AudioEngine("test.flac", { duration: 10, stereo: true, fftSize: FFT, fps: 1000 });
  eng.analyserL = mkAnalyser();
  eng.analyserR = mkAnalyser();
  eng.gain = { gain: { value: 1 } };
  Object.defineProperty(eng, "playing", { get: () => true });
  eng._adopt({ analyserL: eng.analyserL, analyserR: eng.analyserR, gain: eng.gain });

  const res = {};

  // Default: nothing asked for it.
  eng.wantFloatFreq = false;
  eng.update(1000);
  res.offAllocated = !!eng.sig.freqDb;

  // Switched on.
  eng.wantFloatFreq = true;
  eng.update(2000);
  const db = eng.sig.freqDb;
  res.onAllocated = !!db;
  res.len = db ? db.length : 0;
  res.bins = eng.sig.binCount;
  res.matchesTruth = db ? Array.from(db).every((v, i) => Math.abs(v - trueDb[i]) < 1e-4) : false;

  // The point of the exercise: bins the byte path has thrown away.
  const bytes = eng.sig.freq;
  // Every bin the byte path collapsed to a single value 0. What matters is not
  // that each is under some threshold — rounding puts a couple right on the
  // boundary — but that the float path still tells them APART, which is the
  // information the byte path destroyed.
  let floored = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < BINS; i++) {
    if (bytes[i] === 0) { floored++; if (db) { if (db[i] < lo) lo = db[i]; if (db[i] > hi) hi = db[i]; } }
  }
  res.floored = floored;
  res.spreadDb = floored ? hi - lo : 0;
  res.byteFloorDb = -100;
  res.trueMin = Math.min(...trueDb);

  // Switched back off: the array may persist, but it must stop being refreshed.
  eng.wantFloatFreq = false;
  if (eng.sig.freqDb) eng.sig.freqDb[0] = 12345;
  eng.update(3000);
  res.staleAfterOff = eng.sig.freqDb ? eng.sig.freqDb[0] === 12345 : true;

  eng.dispose();
  return res;
});

console.log("AudioEngine float-FFT path\n");
ck("no float array allocated when nothing asks for it", out.offAllocated === false);
ck("allocated at the analyser's bin count once requested",
   out.onAllocated && out.len === out.bins, `${out.len} bins`);
ck("values are the analyser's true dBFS, copied exactly", out.matchesTruth === true);
ck("byte path really does throw bins away",
   out.floored > 0, `${out.floored}/1024 bins clamp to byte 0 (true values down to ${out.trueMin.toFixed(0)} dBFS)`);
ck("float path still distinguishes them from each other",
   out.spreadDb > 15, `those bins span ${out.spreadDb.toFixed(1)} dB in the float data, ` +
   `all identical (byte 0) in the byte data`);
ck("stops refreshing when switched back off", out.staleAfterOff === true);

console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
