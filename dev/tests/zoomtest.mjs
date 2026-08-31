import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pw;

async function run(label, patched) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  await p.goto("http://127.0.0.1:8731/dev/harness-zoom.html", { waitUntil: "networkidle" });
  await p.waitForFunction(() => window.__ready === true, { timeout: 15000 });

  if (!patched) {
    // Restore the OLD, broken mapping to prove the diagnosis.
    await p.evaluate(() => {
      window.__host._pointerPos = function (e) {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
    });
  }

  console.log(`\n=== ${label} ===`);
  for (const zoom of [0.5, 0.75, 1, 1.4, 2]) {
    await p.evaluate(z => window.__setZoom(z), zoom);
    await p.waitForTimeout(350);

    // Where the play button actually is on screen, per the browser.
    const target = await p.evaluate(() => {
      const L = window.__host._layout();
      const r = window.__host.canvas.getBoundingClientRect();
      const sx = r.width / window.__host._cssW, sy = r.height / window.__host._cssH;
      return { x: r.left + L.btnCX * sx, y: r.top + L.btnCY * sy };
    });

    const before = await p.evaluate(() => window.__isPlaying());
    await p.mouse.click(target.x, target.y);
    await p.waitForTimeout(120);
    const after = await p.evaluate(() => window.__isPlaying());

    // Did the click seek instead? (the symptom Anton reported)
    const seeked = await p.evaluate(() => window.__host.engine.sig.currentTime !== 60);

    const ok = before !== after;
    console.log(`  zoom ${String(zoom).padEnd(5)} play button -> ${ok ? "TOGGLED  PASS" : "no effect  FAIL" + (seeked ? " (seeked instead)" : "")}`);
    if (ok) { await p.mouse.click(target.x, target.y); await p.waitForTimeout(80); }
  }

  // Backing-store sharpness follows zoom (patched build only)
  if (patched) {
    const sharp = await p.evaluate(async () => {
      const out = [];
      for (const z of [1, 2]) {
        window.__setZoom(z);
        await new Promise(r => setTimeout(r, 700));
        out.push({ z, backing: window.__host.canvas.width, scale: +(window.__host._renderScale||0).toFixed(2) });
      }
      return out;
    });
    console.log("  backing store follows zoom:",
      sharp.map(s => `z${s.z}->${s.backing}px @${s.scale}x`).join("  "));
  }

  console.log("  page errors:", errs.length ? errs.join(" | ") : "none");
  await b.close();
}

await run("BEFORE the fix (old coordinate mapping)", false);
await run("AFTER the fix", true);
