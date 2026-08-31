import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const p = await b.newPage({ viewport: { width: 1260, height: 520 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => { const s = document.getElementById("stage"); s.style.width="1180px"; s.style.height="420px"; });

let pass = 0, fail = 0;
const ck = (n, ok, note="") => { console.log(`  ${ok?"PASS":"FAIL"}  ${n}${note?"   "+note:""}`); ok?pass++:fail++; };

// The flag must follow the active view, both directions.
await p.evaluate(() => window.__setView("waveform"));
await p.waitForTimeout(400);
const offWave = await p.evaluate(() => window.__host.engine.wantFloatFreq);
await p.evaluate(() => window.__setView("projected_guidance"));
await p.waitForTimeout(1800);
const onApg = await p.evaluate(() => window.__host.engine.wantFloatFreq);

ck("waveform does not request float FFT", offWave === false);
ck("APG meter does request float FFT", onApg === true);

const st = await p.evaluate(() => {
  // The harness stubs engine.update() and supplies its own bag, so read THAT.
  // AudioEngine's own allocation is covered directly by enginetest.mjs.
  const s = window.__sig;
  const db = s.freqDb;
  let min = Infinity, max = -Infinity, finite = 0;
  if (db) for (let i = 0; i < db.length; i++) {
    if (Number.isFinite(db[i])) { finite++; if (db[i] < min) min = db[i]; if (db[i] > max) max = db[i]; }
  }
  const L = window.__host._layout();
  return { len: db ? db.length : 0, bins: s.binCount, min, max, finite,
           integrated: window.__host._gfxFor("projected_guidance", L).store.integrated };
});
ck("freqDb allocated at the analyser's bin count", st.len === st.bins && st.len > 0, `${st.len} bins`);
ck("freqDb carries real dBFS, not bytes", st.min < -30 && st.max <= 0,
   `${st.min.toFixed(1)} .. ${st.max.toFixed(1)} dBFS`);
ck("float path reaches below the byte floor of -100 dBFS", st.min < -100,
   `min ${st.min.toFixed(1)} dBFS`);
ck("the renderer consumed it (no placeholder)", !!st.integrated);

const m = st.integrated;
console.log(`\n  measured: crest ${m.crest.toFixed(1)} dB | centroid ${m.centroid.toFixed(0)} Hz | ` +
            `flux ${m.flux.toFixed(3)} | flatness ${m.flatness.toFixed(1)} dB | clip ${m.clip.toFixed(2)}%`);
ck("centroid is musically plausible, not floor-dominated", m.centroid > 800 && m.centroid < 14000);
ck("flatness inside the definition's range", m.flatness <= 0 && m.flatness > -40);

await p.locator("#stage").screenshot({ path: "/home/claude/shots/apg-float.png" });
console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
