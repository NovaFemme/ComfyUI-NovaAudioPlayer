// Measure Anton's actual ACE-Step render with the renderer's own formulas,
// over the whole file. AnalyserNode can only be polled in real time (4:20 of
// wall clock), so this reproduces what it does — Blackman window, 4096-point
// FFT, smoothingTimeConstant EMA on the magnitude spectrum — and walks the
// file at the analyser's frame rate.
import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const p = await b.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });

const out = await p.evaluate(async () => {
  const FFT = 4096, BINS = FFT / 2, FPS = 30, SMOOTH = 0.6;
  const CLIP_LEVEL = 0.999969482421875;
  const SAT_EPS = 1e-6, SAT_RUN = 4, SAT_LEVEL = 0.35;
  const SILENCE_RMS = 0.002, FLOOR_DB = -140;

  const resp = await fetch("/dev/audio/take.mp3");
  const bytes = await resp.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const buf = await ctx.decodeAudioData(bytes);
  const SR = buf.sampleRate;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const N = L.length;

  // ---- whole-file time domain, exactly as the renderer accumulates it ----
  let peak = 0, sumSq = 0, clip = 0, flat = 0, runL = 1, runR = 1;
  for (let i = 0; i < N; i++) {
    const l = L[i], r = R[i];
    const a = l < 0 ? -l : l, bb = r < 0 ? -r : r;
    if (a > peak) peak = a;
    if (bb > peak) peak = bb;
    if (a >= CLIP_LEVEL) clip++;
    if (bb >= CLIP_LEVEL) clip++;
    sumSq += l * l + r * r;
    if (i > 0) {
      const dl = l - L[i - 1], dr = r - R[i - 1];
      if ((dl < 0 ? -dl : dl) <= SAT_EPS && a >= SAT_LEVEL) runL++;
      else { if (runL >= SAT_RUN) flat += runL; runL = 1; }
      if ((dr < 0 ? -dr : dr) <= SAT_EPS && bb >= SAT_LEVEL) runR++;
      else { if (runR >= SAT_RUN) flat += runR; runR = 1; }
    }
  }
  if (runL >= SAT_RUN) flat += runL;
  if (runR >= SAT_RUN) flat += runR;
  const rms = Math.sqrt(sumSq / (N * 2));

  // ---- FFT ----------------------------------------------------------------
  const rev = new Uint32Array(FFT), cosT = new Float64Array(FFT / 2), sinT = new Float64Array(FFT / 2);
  { let j = 0;
    for (let i = 0; i < FFT; i++) {
      rev[i] = j;
      let m = FFT >> 1;
      while (m >= 1 && j >= m) { j -= m; m >>= 1; }
      j += m;
    }
    for (let i = 0; i < FFT / 2; i++) { cosT[i] = Math.cos(-2 * Math.PI * i / FFT); sinT[i] = Math.sin(-2 * Math.PI * i / FFT); }
  }
  function fft(re, im) {
    for (let i = 0; i < FFT; i++) if (i < rev[i]) {
      let t = re[i]; re[i] = re[rev[i]]; re[rev[i]] = t;
      t = im[i]; im[i] = im[rev[i]]; im[rev[i]] = t;
    }
    for (let size = 2; size <= FFT; size <<= 1) {
      const half = size >> 1, step = FFT / size;
      for (let i = 0; i < FFT; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cosT[k], s = sinT[k];
          const tr = re[j + half] * c - im[j + half] * s;
          const ti = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tr; im[j + half] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  }
  // Blackman, the window AnalyserNode specifies.
  const win = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) {
    const a0 = 0.42, a1 = 0.5, a2 = 0.08;
    win[i] = a0 - a1 * Math.cos(2 * Math.PI * i / FFT) + a2 * Math.cos(4 * Math.PI * i / FFT);
  }

  const hop = Math.round(SR / FPS);
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  const smoothed = new Float64Array(BINS);
  const prevShare = new Float64Array(BINS);
  const mags = new Float64Array(BINS);
  const hzPerBin = (SR / 2) / BINS;

  let cSum = 0, fSum = 0, xSum = 0, frames = 0, primed = false;
  const centroids = [], fluxes = [], flatnesses = [], crests = [];
  let first = true;

  for (let off = 0; off + FFT <= N; off += hop) {
    let fPeak = 0, fSq = 0;
    for (let i = 0; i < FFT; i++) {
      const s = L[off + i];
      const a = s < 0 ? -s : s;
      if (a > fPeak) fPeak = a;
      fSq += s * s;
      re[i] = s * win[i]; im[i] = 0;
    }
    const fRms = Math.sqrt(fSq / FFT);
    fft(re, im);

    for (let i = 0; i < BINS; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / FFT;
      smoothed[i] = first ? m : SMOOTH * smoothed[i] + (1 - SMOOTH) * m;
    }
    first = false;
    if (fRms <= SILENCE_RMS) continue;

    let total = 0, weighted = 0, flatLog = 0;
    for (let i = 0; i < BINS; i++) {
      const db = smoothed[i] > 0 ? 20 * Math.log10(smoothed[i]) : FLOOR_DB;
      const m = Math.pow(10, Math.max(db, FLOOR_DB) / 20);
      mags[i] = m; total += m; weighted += m * i * hzPerBin; flatLog += Math.log(m);
    }
    const cen = total > 1e-12 ? weighted / total : 0;
    const ratio = Math.min(1, Math.exp(flatLog / BINS) / (total / BINS));
    const flt = ratio > 0 ? 10 * Math.log10(ratio) : FLOOR_DB;
    let flx = 0;
    for (let i = 0; i < BINS; i++) {
      const share = mags[i] / total;
      const d = share - prevShare[i];
      if (d > 0) flx += d;
      prevShare[i] = share;
    }
    if (!primed) { flx = 0; primed = true; }

    cSum += cen; fSum += flt; xSum += flx; frames++;
    centroids.push(cen); fluxes.push(flx); flatnesses.push(flt);
    crests.push(fRms > 1e-6 ? 20 * Math.log10(fPeak / fRms) : 0);
  }

  const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(q * (a.length - 1))]; };

  return {
    durationSec: N / SR, sampleRate: SR, channels: buf.numberOfChannels, frames,
    peakDb: 20 * Math.log10(peak), rmsDb: 20 * Math.log10(rms),
    crestIntegrated: 20 * Math.log10(peak / rms),
    clipPct: (clip / (N * 2)) * 100, satPct: (flat / (N * 2)) * 100,
    clipSamples: clip, flatSamples: flat, totalSamples: N * 2,
    centroid: { mean: cSum / frames, p05: pct(centroids, .05), p50: pct(centroids, .5), p95: pct(centroids, .95) },
    flatness: { mean: fSum / frames, p05: pct(flatnesses, .05), p50: pct(flatnesses, .5), p95: pct(flatnesses, .95) },
    flux:     { mean: xSum / frames, p05: pct(fluxes, .05), p50: pct(fluxes, .5), p95: pct(fluxes, .95) },
    crestFrame: { p05: pct(crests, .05), p50: pct(crests, .5), p95: pct(crests, .95) },
  };
});

const f = (n, d = 2) => n.toFixed(d);
console.log(`Anton's take — master_00018.mp3`);
console.log(`  ${f(out.durationSec,1)} s · ${out.sampleRate} Hz · ${out.channels} ch · ${out.frames} analysed frames\n`);
console.log("TIME DOMAIN (whole file)");
console.log(`  peak            ${f(out.peakDb)} dBFS`);
console.log(`  RMS             ${f(out.rmsDb)} dBFS`);
console.log(`  crest           ${f(out.crestIntegrated)} dB   (integrated, peak-over-RMS)`);
console.log(`  per-frame crest p05 ${f(out.crestFrame.p05,1)} / median ${f(out.crestFrame.p50,1)} / p95 ${f(out.crestFrame.p95,1)} dB`);
console.log(`  CLIP            ${f(out.clipPct,4)}%   (${out.clipSamples} of ${out.totalSamples} samples at the ceiling)`);
console.log(`  SAT             ${f(out.satPct,4)}%   (${out.flatSamples} samples in flat-top runs)`);
console.log("\nSPECTRAL (per analyser frame, then averaged)");
for (const [k, unit, d] of [["centroid","Hz",0],["flatness","dB",1],["flux","",3]]) {
  const m = out[k];
  console.log(`  ${k.padEnd(9)} mean ${f(m.mean,d).padStart(8)} ${unit}` +
              `   p05 ${f(m.p05,d)}  median ${f(m.p50,d)}  p95 ${f(m.p95,d)}`);
}
console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
await b.close();
