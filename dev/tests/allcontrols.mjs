import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness-zoom.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

const at = async (key) => p.evaluate(k => {
  const L = window.__host._layout();
  const r = window.__host.canvas.getBoundingClientRect();
  const sx = r.width / window.__host._cssW, sy = r.height / window.__host._cssH;
  const pts = {
    play:[L.btnCX,L.btnCY], skipBack:[L.skipBackCX,L.btnCY], skipFwd:[L.skipFwdCX,L.btnCY],
    loop:[L.loopCX,L.loopCY], view:[L.viewBtnX,L.btnCY], settings:[L.gearCX,L.gearCY],
    download:[L.dlBtnCX,L.dlBtnCY], speaker:[L.spkX,L.spkY],
    volMid:[L.volX+L.volW*0.5,L.volY], volLow:[L.volX+L.volW*0.15,L.volY],
    scrubQ:[L.scrubX+L.scrubW*0.25,L.scrubTop+L.scrubH/2],
    waveMid:[L.wfX+L.totalW*0.6,L.wfTop+L.wfH/2],
  }[k];
  return { x: r.left + pts[0]*sx, y: r.top + pts[1]*sy };
}, key);

for (const zoom of [0.6, 1, 1.75]) {
  await p.evaluate(z => window.__setZoom(z), zoom);
  await p.waitForTimeout(350);
  console.log(`\n--- zoom ${zoom} ---`);

  // hover reports the right control
  for (const key of ["play","skipBack","skipFwd","loop","view","settings","download","speaker","scrubQ"]) {
    const pt = await at(key);
    await p.mouse.move(pt.x, pt.y);
    await p.waitForTimeout(60);
    const hov = await p.evaluate(() => window.__host._hovered);
    const want = { scrubQ: "scrub" }[key] || key;
    console.log(`  hover ${key.padEnd(9)} -> ${String(hov).padEnd(9)} ${hov === want ? "PASS" : "FAIL (want " + want + ")"}`);
  }

  // loop toggle
  const lp = await at("loop");
  const l0 = await p.evaluate(() => window.__host.state.looping);
  await p.mouse.click(lp.x, lp.y); await p.waitForTimeout(100);
  const l1 = await p.evaluate(() => window.__host.state.looping);
  console.log(`  click loop        -> ${l0} => ${l1} ${l0 !== l1 ? "PASS" : "FAIL"}`);
  await p.mouse.click(lp.x, lp.y); await p.waitForTimeout(80);

  // view cycles
  const v0 = await p.evaluate(() => window.__host.state.viewMode);
  const vp = await at("view");
  await p.mouse.click(vp.x, vp.y); await p.waitForTimeout(120);
  const v1 = await p.evaluate(() => window.__host.state.viewMode);
  console.log(`  click view        -> ${v0} => ${v1} ${v0 !== v1 ? "PASS" : "FAIL"}`);
  await p.evaluate(() => { window.__host.state.viewMode = "waveform"; window.__host.markDirty(); });

  // mute
  const sp = await at("speaker");
  const m0 = await p.evaluate(() => window.__host.state.muted);
  await p.mouse.click(sp.x, sp.y); await p.waitForTimeout(100);
  const m1 = await p.evaluate(() => window.__host.state.muted);
  console.log(`  click speaker     -> muted ${m0} => ${m1} ${m0 !== m1 ? "PASS" : "FAIL"}`);
  await p.mouse.click(sp.x, sp.y); await p.waitForTimeout(80);

  // volume click lands at the right value
  const vm = await at("volMid");
  await p.mouse.click(vm.x, vm.y); await p.waitForTimeout(100);
  const vol = await p.evaluate(() => window.__host.state.volume);
  console.log(`  click vol @50%    -> ${vol.toFixed(2)} ${Math.abs(vol-0.5) < 0.06 ? "PASS" : "FAIL"}`);

  // volume drag
  const vlo = await at("volLow");
  await p.mouse.move(vm.x, vm.y); await p.mouse.down();
  await p.mouse.move(vlo.x, vlo.y, { steps: 8 }); await p.mouse.up();
  await p.waitForTimeout(100);
  const vol2 = await p.evaluate(() => window.__host.state.volume);
  console.log(`  drag vol to 15%   -> ${vol2.toFixed(2)} ${Math.abs(vol2-0.15) < 0.07 ? "PASS" : "FAIL"}`);
  await p.evaluate(() => window.__host._applyVolume(9999, window.__host._layout()));

  // scrub click seeks to the right fraction
  await p.evaluate(() => { window.__host.engine.seekFraction = f => { window.__seeked = f; }; });
  const sq = await at("scrubQ");
  await p.mouse.click(sq.x, sq.y); await p.waitForTimeout(100);
  const sf = await p.evaluate(() => window.__seeked);
  console.log(`  click scrub @25%  -> ${sf === undefined ? "no seek FAIL" : sf.toFixed(3) + (Math.abs(sf-0.25) < 0.04 ? " PASS" : " FAIL")}`);

  // waveform click seeks to the right fraction
  await p.evaluate(() => { window.__seeked = undefined; });
  const wm = await at("waveMid");
  await p.mouse.click(wm.x, wm.y); await p.waitForTimeout(100);
  const wf = await p.evaluate(() => window.__seeked);
  console.log(`  click wave @60%   -> ${wf === undefined ? "no seek FAIL" : wf.toFixed(3) + (Math.abs(wf-0.6) < 0.04 ? " PASS" : " FAIL")}`);
}

console.log("\npage errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
