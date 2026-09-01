// The bench strip: geometry, toggle path, and the invariants that keep it from
// colliding with the visualiser or the settings drawer.
import pw from "./_pw.mjs";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1260, height: 640 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => { const s = document.getElementById("stage"); s.style.width="1180px"; s.style.height="540px"; });

let pass = 0, fail = 0;
const ck = (n, ok, note = "") => { console.log(`  ${ok?"PASS":"FAIL"}  ${n}${note?"   "+note:""}`); ok?pass++:fail++; };

// ---- geometry -----------------------------------------------------------
const geo = await p.evaluate(async () => {
  const { computeLayout, minimumNodeSize, visualisationRect } = await import("/web/core/layout.js");
  const out = [];
  for (const [w, h, stereo] of [[460,280,true],[900,400,true],[1180,540,true],[600,300,false]]) {
    const closed = computeLayout(w, h, stereo, 120, { benchOpen: false });
    const open   = computeLayout(w, h, stereo, 120, { benchOpen: true });
    const rOpen = visualisationRect(open);
    out.push({
      size: `${w}x${h}${stereo?" st":" mo"}`,
      closedH: closed.benchH, openH: open.benchH,
      benchTop: open.benchTop, nodeH: h,
      wfBottomOpen: open.wfBottom, wfBottomClosed: closed.wfBottom,
      rectBottom: rOpen.y + rOpen.h,
      btnCX: open.benchBtnCX, dlCX: open.dlBtnCX, dlR: open.dlBtnR, btnR: open.benchBtnR,
      btnCY: open.btnCY,
      viewX: open.viewBtnX, loopCX: open.loopCX,
    });
  }
  return {
    rows: out,
    minClosed: minimumNodeSize(true, { benchOpen: false }),
    minOpen: minimumNodeSize(true, { benchOpen: true }),
  };
});

console.log("bench strip geometry\n");
for (const g of geo.rows) {
  console.log(`  ${g.size.padEnd(12)} benchH ${String(g.closedH).padStart(3)}->${String(g.openH).padStart(3)}  ` +
              `top ${g.benchTop}  wfBottom ${g.wfBottomClosed}->${g.wfBottomOpen}`);
}
console.log("");
ck("closed strip has zero height", geo.rows.every(g => g.closedH === 0));
ck("open strip has height at every size", geo.rows.every(g => g.openH > 0));
ck("strip is flush with the bottom edge",
   geo.rows.every(g => g.benchTop + g.openH === g.nodeH));
ck("the visualiser shrinks rather than the node growing",
   geo.rows.every(g => g.wfBottomOpen <= g.wfBottomClosed));
ck("renderer rect never reaches into the strip",
   geo.rows.every(g => g.rectBottom <= g.benchTop),
   geo.rows.map(g => `${g.rectBottom}<=${g.benchTop}`).join(" "));
ck("toggle button clears the download button",
   geo.rows.every(g => g.btnCX + g.btnR < g.dlCX - g.dlR),
   `gap ${(geo.rows[0].dlCX - geo.rows[0].dlR) - (geo.rows[0].btnCX + geo.rows[0].btnR)} px`);
ck("view pill still sits between loop and the toggle",
   geo.rows.every(g => g.viewX > g.loopCX && g.viewX < g.btnCX));
// A short node must degrade by clipping the strip, never by drawing it over
// the transport row. This was a real overlap before the clamp: at 460x280 the
// play button sat at y=176 inside a strip starting at y=128.
ck("the transport row is never buried under the strip",
   geo.rows.every(g => g.btnCY + 20 <= g.benchTop),
   geo.rows.map(g => `${g.size}:${g.btnCY}<=${g.benchTop}`).join(" "));
ck("the strip is clamped to the spare space on a short node",
   geo.rows[0].openH < 152 && geo.rows[0].openH > 0,
   `460x280 gets ${geo.rows[0].openH} px, not the full 152`);
ck("a tall node gets the full strip",
   geo.rows[2].openH === 152, `${geo.rows[2].openH} px`);

ck("minimum node height allows for the strip",
   geo.minOpen[1] > geo.minClosed[1],
   `${geo.minClosed[1]} -> ${geo.minOpen[1]} px`);

// ---- hit test -----------------------------------------------------------
const hits = await p.evaluate(async () => {
  const { computeLayout } = await import("/web/core/layout.js");
  const { hitTest } = await import("/web/ui/chrome.js");
  const L = computeLayout(1180, 540, true, 120, { benchOpen: true });
  return {
    onButton: hitTest(L.benchBtnCX, L.benchBtnCY, L),
    onDownload: hitTest(L.dlBtnCX, L.dlBtnCY, L),
    onGear: hitTest(L.gearCX, L.gearCY, L),
    betweenThem: hitTest(Math.round((L.benchBtnCX + L.dlBtnCX) / 2), L.benchBtnCY, L),
  };
});
console.log("\nhit testing");
ck('the toggle reports "bench"', hits.onButton === "bench", `got ${hits.onButton}`);
ck("download is not shadowed by it", hits.onDownload === "download", `got ${hits.onDownload}`);
ck("settings is not shadowed by it", hits.onGear === "settings", `got ${hits.onGear}`);
ck("the gap between them hits nothing", hits.betweenThem === null, `got ${hits.betweenThem}`);

// ---- the real click path ------------------------------------------------
const clickAt = async () => {
  const t = await p.evaluate(() => {
    const h = window.__host, L = h._layout(), r = h.canvas.getBoundingClientRect();
    return { x: r.left + L.benchBtnCX * (r.width / h._cssW),
             y: r.top + L.benchBtnCY * (r.height / h._cssH) };
  });
  await p.mouse.click(t.x, t.y);
  await p.waitForTimeout(250);
};
const readState = () => p.evaluate(() => {
  const h = window.__host, L = h._layout();
  return { open: !!h.state.benchOpen, benchH: L.benchH,
           drawerBottom: h.panel.element.style.bottom, wfBottom: L.wfBottom,
           cssH: h._cssH };
});

console.log("\ntoggling through a real click");
const before = await readState();
await clickAt();
const opened = await readState();
await clickAt();
const closed = await readState();

ck("starts closed", before.open === false);
ck("click opens it", opened.open === true && opened.benchH > 0);
ck("click again closes it", closed.open === false && closed.benchH === 0);
ck("the settings drawer follows the moved visualiser edge",
   opened.drawerBottom === `${Math.max(0, Math.round(opened.cssH - opened.wfBottom))}px` &&
   closed.drawerBottom === `${Math.max(0, Math.round(closed.cssH - closed.wfBottom))}px`,
   `${closed.drawerBottom} -> ${opened.drawerBottom}`);

// ---- painted output -----------------------------------------------------
await clickAt();   // open again
const painted = await p.evaluate(() => {
  const h = window.__host, L = h._layout(), s = h._renderScale || 1;
  const ctx = h.canvas.getContext("2d");
  const d = ctx.getImageData(0, Math.round(L.benchTop * s),
                             Math.round(L.w * s), Math.round(L.benchH * s)).data;
  let lit = 0, magenta = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i+1] + d[i+2] > 150) lit++;
    // The palette paints unknown roles magenta; none should appear here.
    if (d[i] > 200 && d[i+1] < 60 && d[i+2] > 200) magenta++;
  }
  return { lit, magenta };
});
console.log("\npainted output");
ck("the strip actually paints content", painted.lit > 500, `${painted.lit} lit subpixels`);
ck("no unknown colour roles (magenta) in the strip",
   painted.magenta === 0, `${painted.magenta} magenta pixels`);

// ---- no bench data ------------------------------------------------------
const noData = await p.evaluate(() => {
  const h = window.__host;
  const saved = h.data.bench;
  h.data = { ...h.data, bench: null };
  h.markDirty();
  let threw = null;
  try { h._draw(); } catch (e) { threw = String(e); }
  h.data = { ...h.data, bench: saved };
  return threw;
});
ck("a payload with no bench block does not throw", noData === null, noData || "");

console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
