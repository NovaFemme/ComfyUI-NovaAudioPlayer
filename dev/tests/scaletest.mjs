// Text scale and the resizable bench strip.
import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 700 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => { const s = document.getElementById("stage"); s.style.width="1180px"; s.style.height="600px"; });

let pass = 0, fail = 0;
const ck = (n, ok, note = "") => { console.log(`  ${ok?"PASS":"FAIL"}  ${n}${note?"   "+note:""}`); ok?pass++:fail++; };

// ---- the font interception -----------------------------------------------
const font = await p.evaluate(async () => {
  const { setTextScale, scaleFontString, patchFontScaling, textScale, scaled } =
    await import("/web/core/gfx.js");
  const before = textScale();

  const strings = {
    plain: ["9px ui-monospace, monospace", null],
    bold: ["bold 10px sans-serif", null],
    decimal: ["11.5px serif", null],
    italicWeight: ["italic 600 12px Georgia", null],
    noPx: ["caption", null],
  };
  setTextScale(1.5);
  for (const k of Object.keys(strings)) strings[k][1] = scaleFontString(strings[k][0]);

  // Real context: assignment must be intercepted, and reading back gives the
  // scaled value (which is what measureText is working from).
  const c = document.createElement("canvas").getContext("2d");
  patchFontScaling(c);
  c.font = "10px sans-serif";
  const readBack = c.font;
  const w15 = c.measureText("MMMM").width;
  setTextScale(1);
  c.font = "10px sans-serif";
  const w10 = c.measureText("MMMM").width;

  // Patching twice must not double-scale.
  patchFontScaling(c);
  setTextScale(2);
  c.font = "10px sans-serif";
  const twice = c.font;

  // Clamp probes and scaled() must run BEFORE the restore: an object literal
  // evaluates its properties in order, so putting setTextScale calls in the
  // returned object leaves the module at whatever the last one set — which
  // silently poisoned every drawing measurement further down this file.
  const clampHigh = setTextScale(99);
  const clampLow = setTextScale(-5);
  setTextScale(2);
  const scaledAt1 = scaled(10);

  setTextScale(before);
  return { strings, readBack, w15, w10, twice, clampHigh, clampLow, scaledAt1,
           leftAt: textScale() };
});

console.log("text scaling\n");
ck("a plain px size scales", font.strings.plain[1].startsWith("13.50px"), font.strings.plain[1]);
ck("a bold prefix survives", font.strings.bold[1] === "bold 15.00px sans-serif", font.strings.bold[1]);
ck("decimal sizes scale", font.strings.decimal[1].startsWith("17.25px"), font.strings.decimal[1]);
ck("style and weight prefixes survive",
   font.strings.italicWeight[1] === "italic 600 18.00px Georgia", font.strings.italicWeight[1]);
ck("a keyword font with no px is left alone", font.strings.noPx[1] === "caption");
ck("assignment to ctx.font is intercepted", font.readBack.startsWith("15px"), font.readBack);
ck("text actually measures wider at 1.5x",
   Math.abs(font.w15 / font.w10 - 1.5) < 0.05, `${(font.w15 / font.w10).toFixed(3)}x`);
ck("patching the same context twice does not double-scale",
   font.twice.startsWith("20px"), font.twice);
ck("scale is clamped at both ends",
   font.clampHigh === 2.5 && font.clampLow === 0.6, `${font.clampLow} .. ${font.clampHigh}`);
ck("scaled() tracks the same factor", font.scaledAt1 === 20, String(font.scaledAt1));
ck("the probe leaves the scale where it found it", font.leftAt === 1, String(font.leftAt));

// ---- it reaches the drawn output ----------------------------------------
const drawn = await p.evaluate(async () => {
  const h = window.__host;
  // Rightmost lit pixel in the badge row. Counting lit pixels inside a fixed
  // window is the wrong measure — larger glyphs push characters OUT of the
  // window, so the count can fall while the text is genuinely bigger. How far
  // the text reaches cannot be fooled that way.
  const extent = () => {
    h.markDirty(); h._draw();
    const s = h._renderScale || 1, L = h._layout();
    const ctx = h.canvas.getContext("2d");
    const w = Math.round(L.w * s), hh = Math.round(L.wfTop * s);
    const d = ctx.getImageData(0, 0, w, hh).data;
    let right = 0, lit = 0;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (d[o] + d[o+1] + d[o+2] > 220) { lit++; if (x > right) right = x; }
      }
    }
    return { right: right / s, lit };
  };
  const at1 = extent();
  h.panel.controller.previewTextScale(1.6);
  const at16 = extent();
  h.panel.controller.previewTextScale(1);
  const back = extent();

  // At a large scale the badge must not run into the clip indicator, which is
  // right-aligned in the same row.
  h.panel.controller.previewTextScale(2);
  const at2 = extent();
  const L = h._layout();
  h.panel.controller.previewTextScale(1);
  return { at1, at16, back, at2, nodeW: L.w };
});
console.log("\nreaching the canvas");
ck("badge text reaches further right at 1.6x",
   drawn.at16.right > drawn.at1.right * 1.3,
   `${drawn.at1.right.toFixed(0)} -> ${drawn.at16.right.toFixed(0)} px`);
ck("returning to 1.0 restores the original extent",
   Math.abs(drawn.back.right - drawn.at1.right) < 2,
   `${drawn.at1.right.toFixed(0)} vs ${drawn.back.right.toFixed(0)}`);
ck("even at 2x the badge stays inside the node",
   drawn.at2.right < drawn.nodeW,
   `reaches ${drawn.at2.right.toFixed(0)} of ${drawn.nodeW} px`);

// ---- persistence round-trip ---------------------------------------------
const persisted = await p.evaluate(async () => {
  const { config } = await import("/web/core/config.js");
  const h = window.__host;
  const res = await h.panel.controller.setTextScale(1.25);
  await config.load();
  const stored = config.appearance("text_scale", null);
  const bad = await h.panel.controller.setTextScale(99);   // clamped server-side
  await config.load();
  const clamped = config.appearance("text_scale", null);
  await h.panel.controller.setTextScale(1);
  return { ok: res.ok, stored, badOk: bad.ok, clamped };
});
console.log("\npersistence");
ck("a scale change is saved to disk", persisted.ok && persisted.stored === 1.25,
   `stored ${persisted.stored}`);
ck("the server clamps an out-of-range value", persisted.clamped === 2.5,
   `99 -> ${persisted.clamped}`);

// ---- bench strip resize --------------------------------------------------
const openBench = async () => {
  const t = await p.evaluate(() => {
    const h = window.__host, L = h._layout(), r = h.canvas.getBoundingClientRect();
    return { x: r.left + L.benchBtnCX * (r.width / h._cssW),
             y: r.top + L.benchBtnCY * (r.height / h._cssH) };
  });
  await p.mouse.click(t.x, t.y);
  await p.waitForTimeout(250);
};
if (!(await p.evaluate(() => window.__host.state.benchOpen))) await openBench();

const grip = await p.evaluate(() => {
  const h = window.__host, L = h._layout(), r = h.canvas.getBoundingClientRect();
  const sx = r.width / h._cssW, sy = r.height / h._cssH;
  return { x: r.left + (L.w / 2) * sx, y: r.top + (L.benchGripTop + 4) * sy,
           sy, top: r.top, startH: L.benchH, minH: L.benchMinH, maxH: L.benchMaxH,
           hit: null };
});
const gripHit = await p.evaluate(async ([mx, my]) => {
  const { hitTest } = await import("/web/ui/chrome.js");
  return hitTest(mx, my, window.__host._layout());
}, [590, await p.evaluate(() => window.__host._layout().benchGripTop + 4)]);

console.log("\nbench strip resize");
ck("the top edge hit-tests as a grip", gripHit === "benchGrip", `got ${gripHit}`);

// Drag it upward (taller).
await p.mouse.move(grip.x, grip.y);
await p.mouse.down();
await p.mouse.move(grip.x, grip.y - 80 * grip.sy, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(200);
const taller = await p.evaluate(() => ({
  h: window.__host._layout().benchH, state: window.__host.state.benchHeight,
}));
ck("dragging up makes it taller", taller.h > grip.startH, `${grip.startH} -> ${taller.h} px`);
ck("the new height is stored in node state", taller.state === taller.h);

// Drag far past the floor: must clamp, not invert.
await p.mouse.move(grip.x, grip.top + (await p.evaluate(() => window.__host._layout().benchGripTop + 4)) * grip.sy);
await p.mouse.down();
await p.mouse.move(grip.x, grip.top + 5000, { steps: 6 });
await p.mouse.up();
await p.waitForTimeout(200);
const floored = await p.evaluate(() => {
  const L = window.__host._layout();
  return { h: L.benchH, min: L.benchMinH, btnCY: L.btnCY, top: L.benchTop };
});
ck("dragging far down clamps at the minimum", floored.h === floored.min,
   `${floored.h} px (min ${floored.min})`);
ck("even clamped, the transport is never covered", floored.btnCY + 20 <= floored.top,
   `btn ${floored.btnCY} <= top ${floored.top}`);

// And the ceiling.
await p.mouse.move(grip.x, grip.top + (await p.evaluate(() => window.__host._layout().benchGripTop + 4)) * grip.sy);
await p.mouse.down();
await p.mouse.move(grip.x, grip.top - 5000, { steps: 6 });
await p.mouse.up();
await p.waitForTimeout(200);
const ceiling = await p.evaluate(() => {
  const L = window.__host._layout();
  return { h: L.benchH, max: L.benchMaxH, btnCY: L.btnCY, top: L.benchTop };
});
ck("dragging far up clamps at the ceiling", ceiling.h === ceiling.max,
   `${ceiling.h} px (max ${ceiling.max})`);
ck("at full height the transport is still clear", ceiling.btnCY + 20 <= ceiling.top,
   `btn ${ceiling.btnCY} <= top ${ceiling.top}`);

console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
