// The shared bar helper: rounding, derived relief, alpha preservation, caching.
import pw from "./_pw.mjs";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 640 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let pass = 0, fail = 0;
const ck = (n, ok, note = "") => { console.log(`  ${ok?"PASS":"FAIL"}  ${n}${note?"   "+note:""}`); ok?pass++:fail++; };

const out = await p.evaluate(async () => {
  const { drawBar, barRadius, barFill, setBarRelief, barRelief } =
    await import("/web/core/gfx.js");

  const W = 200, H = 120;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const clear = () => { ctx.clearRect(0, 0, W, H); };
  const px = (x, y) => {
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  };

  setBarRelief(0.55);

  // --- radius rules ------------------------------------------------------
  const radii = {
    thin: barRadius(2, 40),          // too thin to round
    thinTall: barRadius(2.5, 90),
    medium: barRadius(10, 40),
    huge: barRadius(200, 90),        // capped
    square: barRadius(6, 6),
  };

  // --- corners are actually cut ------------------------------------------
  clear();
  drawBar(ctx, 10, 10, 80, 60, "#3498db");
  const corner = px(10, 10);          // the bounding-box corner itself
  const middle = px(50, 40);

  // --- relief: the two long edges differ from the centre ------------------
  clear();
  drawBar(ctx, 0, 0, 200, 60, "#3498db", { vertical: false, radius: 0 });
  const rim = px(100, 0);            // dark rim
  const top = px(100, 6);            // highlight band, at 10% of a 60px span
  const mid = px(100, 24), bot = px(100, 57);

  // --- orientation follows the short axis --------------------------------
  clear();
  drawBar(ctx, 0, 0, 40, 120, "#3498db", { radius: 0 });   // tall: lit L->R
  const left = px(2, 60), centre = px(15, 60), right = px(37, 60);

  // --- alpha is preserved -------------------------------------------------
  clear();
  drawBar(ctx, 0, 0, 200, 60, "#3498db80", { vertical: false, radius: 0 });
  const translucent = px(100, 30);

  clear();
  drawBar(ctx, 0, 0, 200, 60, "#3498db", { vertical: false, radius: 0 });
  const opaque = px(100, 30);

  // --- relief 0 is a flat fill -------------------------------------------
  setBarRelief(0);
  clear();
  drawBar(ctx, 0, 0, 200, 60, "#3498db", { vertical: false, radius: 0 });
  const flatTop = px(100, 2), flatMid = px(100, 30), flatBot = px(100, 57);
  const flatIsPlainColor = barFill(ctx, 0, 0, 200, 60, "#3498db", false);
  setBarRelief(0.55);

  // --- rgba() input, not just hex ----------------------------------------
  clear();
  drawBar(ctx, 0, 0, 200, 60, "rgba(52, 152, 219, 0.5)", { vertical: false, radius: 0 });
  const rgbaMid = px(100, 30);

  // --- an unparseable colour must not throw or vanish --------------------
  let threw = null;
  clear();
  try { drawBar(ctx, 0, 0, 200, 60, "notacolour", { vertical: false, radius: 0 }); }
  catch (e) { threw = String(e); }

  // --- degenerate geometry ------------------------------------------------
  let degenThrew = null;
  try {
    drawBar(ctx, 0, 0, 0, 40, "#3498db");
    drawBar(ctx, 0, 0, 40, 0, "#3498db");
    drawBar(ctx, 50, 50, -30, -20, "#3498db");   // negative, must normalise
  } catch (e) { degenThrew = String(e); }
  clear();
  drawBar(ctx, 50, 50, -30, -20, "#3498db", { radius: 0 });
  const negative = px(35, 40);   // inside the normalised rect

  // --- clamping -----------------------------------------------------------
  const clampHi = setBarRelief(5), clampLo = setBarRelief(-1);
  setBarRelief(0.55);

  return {
    radii, corner, middle, top, mid, bot, left, centre, right,
    rim, translucent, opaque, flatTop, flatMid, flatBot,
    flatIsPlainColor: typeof flatIsPlainColor === "string" ? flatIsPlainColor : "gradient",
    rgbaMid, threw, degenThrew, negative, clampHi, clampLo,
    reliefNow: barRelief(),
  };
});

const lum = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

console.log("bar radius rules\n");
ck("a 2 px bar is not rounded", out.radii.thin === 0, String(out.radii.thin));
ck("a 2.5 px bar is not rounded", out.radii.thinTall === 0, String(out.radii.thinTall));
ck("a 10 px bar gets a proportional radius",
   out.radii.medium > 1 && out.radii.medium <= 4, out.radii.medium.toFixed(2));
ck("a huge bar's radius is capped", out.radii.huge === 4, String(out.radii.huge));
ck("radius never exceeds half the short side",
   out.radii.square <= 3, out.radii.square.toFixed(2));

console.log("\nrounded corners");
ck("the corner pixel is cut away", out.corner.a < 40, `alpha ${out.corner.a}`);
ck("the middle is filled", out.middle.a > 200, `alpha ${out.middle.a}`);

console.log("\nderived relief");
ck("a horizontal bar has a highlight band near the top",
   lum(out.top) > lum(out.mid), `${lum(out.top).toFixed(0)} vs ${lum(out.mid).toFixed(0)}`);
ck("...with a darker rim outside it, separating the bar from the background",
   lum(out.rim) < lum(out.top), `rim ${lum(out.rim).toFixed(0)} vs peak ${lum(out.top).toFixed(0)}`);
ck("...and shaded at the bottom",
   lum(out.bot) < lum(out.mid), `${lum(out.bot).toFixed(0)} vs ${lum(out.mid).toFixed(0)}`);
ck("a tall bar is lit across its WIDTH, not its length",
   lum(out.left) > lum(out.centre) && lum(out.right) < lum(out.centre),
   `${lum(out.left).toFixed(0)} / ${lum(out.centre).toFixed(0)} / ${lum(out.right).toFixed(0)}`);

console.log("\nalpha");
ck("a translucent bar stays translucent",
   out.translucent.a > 100 && out.translucent.a < 200, `alpha ${out.translucent.a}`);
ck("an opaque bar stays opaque", out.opaque.a > 250, `alpha ${out.opaque.a}`);
ck("rgba() input is parsed, not dropped",
   out.rgbaMid.a > 100 && out.rgbaMid.a < 200, `alpha ${out.rgbaMid.a}`);

console.log("\nrelief 0 means flat");
ck("no vertical variation at relief 0",
   Math.abs(lum(out.flatTop) - lum(out.flatBot)) < 2,
   `${lum(out.flatTop).toFixed(0)} vs ${lum(out.flatBot).toFixed(0)}`);
ck("relief 0 returns the plain colour, building no gradient at all",
   out.flatIsPlainColor === "#3498db", out.flatIsPlainColor);

console.log("\nrobustness");
ck("an unparseable colour does not throw", out.threw === null, out.threw || "");
ck("zero and negative sizes do not throw", out.degenThrew === null, out.degenThrew || "");
ck("a negative-size bar is normalised and drawn", out.negative.a > 200, `alpha ${out.negative.a}`);
ck("relief is clamped to 0..1",
   out.clampHi === 1 && out.clampLo === 0, `${out.clampLo} .. ${out.clampHi}`);

// ---- it reaches the real renderers ---------------------------------------
const inApp = await p.evaluate(async () => {
  const h = window.__host;
  const sample = (view) => new Promise(async resolve => {
    window.__setView(view);
    await new Promise(r => setTimeout(r, 400));
    h.markDirty(); h._draw();
    const s = h._renderScale || 1, L = h._layout();
    const ctx = h.canvas.getContext("2d");
    // A VERTICAL slice: these bars are horizontal, so their relief runs
    // top-to-bottom and a horizontal slice through one is uniform by
    // construction — which is exactly what this measured the first time.
    const x = Math.round((L.wfX + 120) * s);
    const d = ctx.getImageData(x, Math.round(L.wfTop * s), 1,
                               Math.round(Math.min(90, L.wfH) * s)).data;
    // Count distinct luminance values along the row: a flat fill gives very
    // few, a shaded one gives many.
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200) seen.add(Math.round(0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]));
    }
    resolve(seen.size);
  });

  h.panel.controller.previewBarRelief(0.55);
  const on = await sample("freq_percentages");
  h.panel.controller.previewBarRelief(0);
  const off = await sample("freq_percentages");
  h.panel.controller.previewBarRelief(0.55);
  return { on, off };
});
console.log("\nreaching the renderers");
ck("freq bands show many shades with relief on",
   inApp.on > inApp.off, `${inApp.off} shades flat -> ${inApp.on} with relief`);

console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
if (errs.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
