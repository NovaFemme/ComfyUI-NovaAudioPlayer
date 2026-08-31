// freq_percentages design fix: band shares must be of TOTAL energy, with
// contiguous edges so no bin is dropped.
//
// This file used to also cover projected_guidance's zero-clamping integrator.
// That renderer was rewritten as the APG artifact meter and has no integrator
// any more; its coverage lives in /tmp/apgtest.mjs.
import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1150, height: 460 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

const fp = await p.evaluate(async () => {
  const { byteToDb, byteToNorm } = await import("/web/core/gfx.js");
  const BINS = 2048, SR = 48000, hzPerBin = SR / (BINS * 2);
  const freq = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) freq[i] = Math.round(230 * Math.pow(1 - i / BINS, 2.2));

  const EDGES = [0, 250, 2000, 6000, Infinity];   // mirrors BAND_EDGES_HZ
  const sums = [0, 0, 0, 0];
  let total = 0, counted = 0, above = 0;
  for (let i = 0; i < BINS; i++) {
    const db = byteToDb(freq[i]);
    if (db <= -85) continue;
    above++;
    const v = byteToNorm(freq[i]), e = v * v;
    total += e;
    const hz = i * hzPerBin;
    for (let b = 0; b < 4; b++) {
      if (hz >= EDGES[b] && hz < EDGES[b + 1]) { sums[b] += e; counted++; break; }
    }
  }
  return { pct: sums.map(s => +(100 * s / (total || 1)).toFixed(1)), counted, above };
});

console.log("freq_percentages");
console.log("  BASS", fp.pct[0] + "%", "MID", fp.pct[1] + "%", "PRES", fp.pct[2] + "%", "HF", fp.pct[3] + "%");
const sum = +fp.pct.reduce((a, c) => a + c, 0).toFixed(1);
console.log(`  shares sum to ${sum}%`, Math.abs(sum - 100) < 0.2 ? " PASS" : " FAIL");
console.log(`  every above-floor bin lands in a band: ${fp.counted}/${fp.above}`,
            fp.counted === fp.above ? " PASS (no energy dropped)" : " FAIL (gaps remain)");
console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
await b.close();
