/**
 * Control hints: they appear, they say the right thing, and they stay out of
 * the way.
 *
 * Run:  python3 dev/devserver.py --port 8731 &
 *       node dev/tests/tooltiptest.mjs
 *
 * The interesting cases are the negative ones. A hint that appears instantly,
 * survives a drag, or paints outside the node is worse than no hint at all.
 */
import pw from "./_pw.mjs";

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 400 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let PASS = 0, FAIL = 0;
const ck = (name, ok, detail = "") => {
  ok ? PASS++ : FAIL++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
};

console.log("control hints\n");

// ---- the text, straight from the map -------------------------------------
const text = await p.evaluate(async () => {
  const { tipFor, TOOLTIP_DELAY_MS } = await import("/web/ui/tooltips.js");
  return {
    delay: TOOLTIP_DELAY_MS,
    playing: tipFor("play", { playing: true }),
    paused: tipFor("play", { playing: false }),
    loopOn: tipFor("loop", { looping: true }),
    loopOff: tipFor("loop", { looping: false }),
    muted: tipFor("speaker", { muted: true }),
    unmuted: tipFor("speaker", { muted: false }),
    vol: tipFor("volume", { volume: 0.42 }),
    view: tipFor("view", { viewLabel: "SPECTRUM" }),
    benchOpen: tipFor("bench", { benchOpen: true }),
    benchShut: tipFor("bench", { benchOpen: false }),
    back: tipFor("skipBack"),
    fwd: tipFor("skipFwd"),
    visualisation: tipFor("visualisation"),
    unknown: tipFor("nonsense-key"),
  };
});

ck("play reflects transport state", text.playing === "Pause" && text.paused === "Play",
   `${text.paused} / ${text.playing}`);
ck("loop says what a click will do",
   /disable/.test(text.loopOn) && /enable/.test(text.loopOff));
ck("speaker reflects mute state",
   text.muted === "Unmute" && text.unmuted === "Mute");
ck("volume reports the actual level", text.vol === "Volume 42%", text.vol);
ck("view names the current renderer", /SPECTRUM/.test(text.view), text.view);
ck("bench says show or hide, matching its state",
   /Hide/.test(text.benchOpen) && /Show/.test(text.benchShut));
ck("skip buttons state the interval",
   /10 seconds/.test(text.back) && /10 seconds/.test(text.fwd));
ck("the visualisation has no hint — it is a seek target, not a control",
   text.visualisation === null);
ck("an unknown key yields null rather than a stale or wrong hint",
   text.unknown === null);

// ---- timing and suppression ----------------------------------------------
const play = await p.evaluate(() => {
  const L = window.__host._layout();
  return { x: L.btnCX, y: L.btnCY };
});

const box = await p.evaluate(() => window.__host.canvas.getBoundingClientRect());
const at = (pt) => p.mouse.move(box.x + pt.x, box.y + pt.y);

const shown = () => p.evaluate(() => !!window.__host._tipShown);

await at(play);
await p.waitForTimeout(120);
ck("nothing appears immediately — a hint on every passing pointer is noise",
   (await shown()) === false);

await p.waitForTimeout(text.delay + 250);
ck("it appears once the pointer has rested", (await shown()) === true);

// Moving to a different control must restart the wait, not carry the old hint.
const vol = await p.evaluate(() => {
  const L = window.__host._layout();
  return { x: L.volX + L.volW * 0.5, y: L.volY };
});
await at(vol);
ck("moving to another control drops the previous hint at once",
   (await shown()) === false);

// A drag must not leave a box hanging over the pointer.
await p.waitForTimeout(text.delay + 250);
ck("the new control gets its own hint", (await shown()) === true);
await p.mouse.down();
ck("pressing to drag clears it", (await shown()) === false);
await p.mouse.up();

// Leaving the node clears it.
await at(play);
await p.waitForTimeout(text.delay + 250);
await p.mouse.move(box.x + box.width / 2, box.y - 40);
ck("leaving the node clears it", (await shown()) === false);

// ---- the box stays inside the node ---------------------------------------
const inside = await p.evaluate(async () => {
  const { drawTooltip } = await import("/web/ui/tooltips.js");
  const { config } = await import("/web/core/config.js");
  await config.load();
  const palette = config.palette();

  const W = 300, H = 160;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const L = { w: W, h: H };

  // Corners and edges: every one of these would overflow a naive placement.
  const probes = [{ x: 2, y: 2 }, { x: W - 2, y: 2 },
                  { x: 2, y: H - 2 }, { x: W - 2, y: H - 2 },
                  { x: W / 2, y: 4 }];
  const results = [];
  for (const ptr of probes) {
    ctx.clearRect(0, 0, W, H);
    drawTooltip(ctx, L, palette, "Drag to resize the bench strip", ptr);
    const d = ctx.getImageData(0, 0, W, H).data;
    // Any painted pixel on the outermost ring means it escaped the node.
    let edge = 0;
    for (let x = 0; x < W; x++) {
      if (d[(0 * W + x) * 4 + 3] > 0) edge++;
      if (d[((H - 1) * W + x) * 4 + 3] > 0) edge++;
    }
    for (let y = 0; y < H; y++) {
      if (d[(y * W + 0) * 4 + 3] > 0) edge++;
      if (d[(y * W + W - 1) * 4 + 3] > 0) edge++;
    }
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    results.push({ ptr, edge, painted });
  }
  return results;
});

ck("the box is actually drawn at every probe",
   inside.every(r => r.painted > 200), inside.map(r => r.painted).join(", "));
ck("it never paints outside the node, at any corner",
   inside.every(r => r.edge === 0), inside.map(r => r.edge).join(", "));

console.log(`\nerrors: ${errs.length ? errs.join("; ") : "none"}`);
console.log(`\n${PASS} passed, ${FAIL} failed`);
await b.close();
process.exit(FAIL ? 1 : 0);
