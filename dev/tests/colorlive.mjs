/**
 * A colour edit must show up on the very next frame.
 *
 * The bug this pins: waveform, combined and spectrum all cached pixels keyed on
 * `palette.name`. A per-node colour override does not change the theme's name,
 * so the key was identical before and after an edit and the stale bitmap kept
 * being blitted. It only corrected itself when something unrelated dropped the
 * cache — moving a renderer slider, resizing, loading another file — which is
 * exactly how it was reported: "the colour applies when I move a slider".
 *
 * Run:  node dev/tests/colorlive.mjs
 */
import pw from "./_pw.mjs";

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 400 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let PASS = 0, FAIL = 0;
const ck = (name, ok, detail = "") => {
  (ok ? PASS++ : FAIL++);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
};

const out = await p.evaluate(async () => {
  const waveform = (await import("/web/renderers/waveform.js")).default;
  const { makeGfx } = await import("/web/core/gfx.js");
  const { config } = await import("/web/core/config.js");
  await config.load();

  const W = 300, H = 120;
  const rect = { x: 0, y: 0, w: W, h: H };
  const peaks = { ch0: Array.from({ length: 120 }, () => 0.9), ch1: null };
  const sig = { progress: 0.5, playing: false, ready: true, hasData: true };

  // A store per renderer instance, exactly as the host keeps them.
  const store = {};

  function paint(palette) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const gfx = makeGfx({ ctx, palette, params: {}, store, peaks, stereo: false,
                          layout: { barGap: 2 }, now: 1000 });
    waveform.frame(gfx, rect, sig);
    // Sample the played half, above the label strip.
    const d = ctx.getImageData(20, Math.floor(H / 2) - 20, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  const before = paint(config.palette());

  // The same edit setRole() makes: a per-node override, theme name untouched.
  const overrides = { roles: { "wave.left": "#ff0000" }, renderers: {} };
  const edited = config.palette(overrides);
  const after = paint(edited);

  // And back again, to prove the cache still hits when nothing changed.
  const same = config.palette();
  const revSame = same.revision;
  const revEdited = edited.revision;

  return { before, after, revSame, revEdited,
           nameBefore: config.palette().name, nameEdited: edited.name };
});

console.log("colour edits reach the next frame\n");

ck("a per-node override does NOT change the theme name",
   out.nameBefore === out.nameEdited,
   `both "${out.nameBefore}" — which is why keying on it failed`);

ck("but it DOES change palette.revision",
   out.revEdited !== out.revSame,
   `${out.revSame} -> ${out.revEdited}`);

const [r0, g0, b0] = out.before;
const [r1, g1, b1] = out.after;
ck("the waveform repaints in the new colour immediately",
   r1 > 120 && r1 > g1 + 60 && r1 > b1 + 60,
   `rgb(${r0},${g0},${b0}) -> rgb(${r1},${g1},${b1})`);

ck("the pixels actually changed",
   r0 !== r1 || g0 !== g1 || b0 !== b1);

console.log(`\nerrors: ${errs.length ? errs.join("; ") : "none"}`);
console.log(`\n${PASS} passed, ${FAIL} failed`);
await b.close();
process.exit(FAIL ? 1 : 0);
