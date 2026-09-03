// Band shares, against a REAL AnalyserNode.
//
// THE BUG THIS PINS. The FREQ % view summed `(byte/255)^2`, where the byte is
// getByteFrequencyData's output — a LEVEL, minDecibels..maxDecibels mapped
// onto 0-255. Squaring a decibel scale is not energy in any domain. On one of
// NovaFemme's takes the panel read BASS 5.0 / MID 28.3 / PRES 34.3 / HF 32.4
// while compute_bench, summing |FFT|^2, read 43.9 / 39.8 / 13.5 / 2.8 for the
// same file. Both totalled 100 and neither contradicted itself on screen.
//
// The mechanism is bin population: 22 bins below 250 Hz against 1536 above
// 6 kHz at 4096/48k. A bin at the noise floor still returns a byte around
// 20-40, and 1536 of those outweigh 22 loud bass bins. In true power a floor
// bin is ~1e-9 of a loud one and cannot.
//
// Each check below computes BOTH domains from the same analyser frame, so the
// old answer is visible next to the new one rather than described.
import pw from "./_pw.mjs";

const b = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const p = await b.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });

let PASS = 0, FAIL = 0;
const ck = (n, ok, note = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${note ? "   " + note : ""}`);
  ok ? PASS++ : FAIL++;
};

console.log("band shares — power domain vs the byte domain it replaced\n");

const out = await p.evaluate(async () => {
  const { bandShares } = await import("/web/renderers/freq_percentages.js");
  const SR = 48000, FFT = 4096, BINS = FFT / 2;

  // One analyser frame of a tone at `hz`, as both float dBFS and bytes.
  async function frame(hz, amp = 0.5) {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, SR, SR);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * hz * i / SR);
    src.buffer = buf;

    // OfflineAudioContext cannot be polled, so measure through a live one.
    const live = new AudioContext({ sampleRate: SR });
    await live.resume();
    const an = live.createAnalyser();
    an.fftSize = FFT;
    an.smoothingTimeConstant = 0;
    const s2 = live.createBufferSource();
    s2.buffer = buf;
    s2.loop = true;
    s2.connect(an);
    s2.start();
    await new Promise(r => setTimeout(r, 250));

    const db = new Float32Array(BINS), bytes = new Uint8Array(BINS);
    an.getFloatFrequencyData(db);
    an.getByteFrequencyData(bytes);
    s2.stop();
    await live.close();
    return { db, bytes };
  }

  // The old arithmetic, kept here so the comparison is exact rather than
  // remembered: (byte/255)^2, floored on the byte-derived dB.
  function byteDomain(bytes) {
    const EDGES = [20, 250, 2000, 6000, Infinity];
    const hzPerBin = SR / (BINS * 2);
    const sums = [0, 0, 0, 0];
    let total = 0;
    for (let i = 0; i < BINS; i++) {
      const db = -100 + (bytes[i] / 255) * 70;
      if (db <= -85) continue;
      const v = bytes[i] / 255, e = v * v;
      total += e;
      const hz = i * hzPerBin;
      for (let k = 0; k < 4; k++) {
        if (hz >= EDGES[k] && hz < EDGES[k + 1]) { sums[k] += e; break; }
      }
    }
    return sums.map(v => (v / (total || 1)) * 100);
  }

  const bass = await frame(80);
  const hf = await frame(9000);

  return {
    bassPower: bandShares(bass.db, BINS, SR).pct,
    bassByte: byteDomain(bass.bytes),
    hfPower: bandShares(hf.db, BINS, SR).pct,
    silence: bandShares(new Float32Array(BINS).fill(-Infinity), BINS, SR).pct,
  };
});

const f = a => a.map(v => (v === null ? "—" : v.toFixed(1))).join(" / ");

console.log(`  80 Hz tone   power ${f(out.bassPower)}`);
console.log(`               byte  ${f(out.bassByte)}   <- what shipped`);
console.log(`  9 kHz tone   power ${f(out.hfPower)}\n`);

ck("an 80 Hz tone is almost entirely BASS", out.bassPower[0] > 90,
   `BASS ${out.bassPower[0].toFixed(1)}%`);
ck("the byte domain got that wrong — the bug, reproduced",
   out.bassByte[0] < 60, `BASS ${out.bassByte[0].toFixed(1)}%`);
ck("a 9 kHz tone is almost entirely HF", out.hfPower[3] > 90,
   `HF ${out.hfPower[3].toFixed(1)}%`);
ck("shares total 100", Math.abs(out.bassPower.reduce((a, c) => a + c, 0) - 100) < 0.01);

// Per-bin, not per-band: a domain error hides inside the bin counts, so this
// is the assertion that survives both paths being changed together.
const BIN_HZ = 48000 / 4096;
const bins = [(250 - 20) / BIN_HZ, (2000 - 250) / BIN_HZ,
              (6000 - 2000) / BIN_HZ, (24000 - 6000) / BIN_HZ];
const perBin = out.bassPower.map((v, i) => v / bins[i]);
ck("bass energy per bin is >100x HF on bass-heavy material",
   perBin[0] / Math.max(perBin[3], 1e-12) > 100,
   `${(perBin[0] / Math.max(perBin[3], 1e-12)).toFixed(0)} : 1`);

ck("silence reads as no data, not as four zeroes",
   out.silence.every(v => v === null), JSON.stringify(out.silence));

console.log(`\nerrors: ${errs.length ? errs.join(" | ") : "none"}`);
console.log(`\n${PASS} passed, ${FAIL} failed`);
await b.close();
process.exit(FAIL || errs.length ? 1 : 0);
