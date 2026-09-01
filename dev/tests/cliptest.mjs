import pw from "./_pw.mjs";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1250, height: 500 }, deviceScaleFactor: 2 });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => { const s = document.getElementById("stage"); s.style.width = "1180px"; s.style.height = "400px"; });

// Geometry: the indicator must sit above every renderer's rect, at every size.
const geo = await p.evaluate(async () => {
  const { computeLayout } = await import("/web/core/layout.js");
  const out = [];
  for (const [w, h, st] of [[460,280,true],[460,280,false],[900,400,true],[1180,400,true],[1400,700,true]]) {
    const L = computeLayout(w, h, st, 120, {});
    out.push({ size: `${w}x${h}${st ? " stereo" : " mono"}`, wfTop: L.wfTop, clear: 16 + 6 < L.wfTop });
  }
  return out;
});
console.log("clip indicator vs the renderer rect:");
for (const g of geo) {
  console.log(`  ${g.size.padEnd(18)} indicator y=16(+6)  rect starts y=${g.wfTop}`,
              g.clear ? " CLEAR  PASS" : " OVERLAPS  FAIL");
}

// Visual: force the clip LED on over the band view that showed the collision.
await p.evaluate(() => {
  window.__setView("freq_percentages");
  const engine = window.__host.engine;
  const realUpdate = engine.update.bind(engine);
  engine.update = () => { const s = realUpdate(); s.clip = true; return s; };
  window.__host.markDirty();
});
await p.waitForTimeout(900);
await p.locator("#stage").screenshot({ path: "/home/claude/shots/clip-fixed.png" });

// Confirm nothing is painted clip-red inside the renderer rect any more.
const overlap = await p.evaluate(() => {
  const c = window.__host.canvas, L = window.__host._layout();
  const s = window.__host._renderScale || 1;
  const ctx = c.getContext("2d");
  const x0 = Math.round((L.w - 90) * s), x1 = Math.round((L.w - 4) * s);
  const y0 = Math.round(L.wfTop * s), y1 = Math.round(L.wfBottom * s);
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
  }
  return red;
});
console.log(`\nclip-red pixels inside the renderer rect: ${overlap}`,
            overlap === 0 ? " PASS (no collision)" : " FAIL");

// And that it is still actually visible where it now lives.
const badge = await p.evaluate(() => {
  const c = window.__host.canvas, L = window.__host._layout();
  const s = window.__host._renderScale || 1;
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(Math.round((L.w - 90) * s), 0, Math.round(86 * s), Math.round(28 * s)).data;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 90 && d[i + 2] < 90) red++;
  return red;
});
console.log(`clip-red pixels in the badge row: ${badge}`,
            badge > 50 ? " PASS (still clearly visible)" : " FAIL (vanished)");

console.log("errors:", errs.length ? errs.join(" | ") : "none");
await b.close();
