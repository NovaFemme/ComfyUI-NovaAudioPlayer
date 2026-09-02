import pw from "./_pw.mjs";
import { snap } from "./_shots.mjs";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 800 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
p.on("console", m => { const t=m.text(); if (m.type()==="error" && !t.includes("MediaError") && !t.includes("404")) errs.push(t); });

await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => { const s=document.getElementById("stage"); s.style.width="1100px"; s.style.height="420px"; });
await p.evaluate(() => { window.__host.state.viewMode = "analyzer"; window.__host.panel.refresh(); window.__host._togglePanel(); });
await p.waitForTimeout(500);

const sections = () => p.evaluate(() =>
  [...document.querySelectorAll(".nova-panel details")].map(d => ({ id: d.dataset.section, open: d.open })));

console.log("1. scoped to the active renderer only");
console.log("   sections:", (await sections()).map(s => s.id).join(", "));
const heads = await p.evaluate(() => [...document.querySelectorAll(".nova-panel summary")].map(s=>s.textContent));
console.log("   headings:", heads.join(" | "));
console.log("   -> only ANALYZER + chrome:", heads.every(h => /ANALYZER|chrome/i.test(h)) ? "PASS" : "FAIL");

console.log("\n2. single-open accordion");
await p.click('.nova-panel details[data-section="colours"] summary');
await p.waitForTimeout(200);
let s = await sections();
console.log("   after opening colours:", JSON.stringify(s), s.filter(x=>x.open).length === 1 && s.find(x=>x.id==="colours").open ? "PASS" : "FAIL");
await p.click('.nova-panel details[data-section="chrome"] summary');
await p.waitForTimeout(200);
s = await sections();
console.log("   after opening chrome: ", JSON.stringify(s), s.filter(x=>x.open).length === 1 ? "PASS" : "FAIL");

// The default scope is now "node"; these two checks are about disk writes,
// so switch to theme scope explicitly.
await p.evaluate(() => { document.querySelectorAll(".nova-scope button")[1].click(); });
await p.waitForTimeout(150);

console.log("\n3. THE BUG: changing a colour must not collapse the open section");
await p.click('.nova-panel details[data-section="colours"] summary');
await p.waitForTimeout(200);
const before = await p.evaluate(() => window.__host.palette.get("gonio.trace"));
await p.evaluate(() => {
  const row = [...document.querySelectorAll('.nova-panel details[data-section="colours"] input[type="color"]')];
  const well = row.find(w => w.title === "gonio.trace");
  well.value = "#ff2277";
  well.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.waitForTimeout(250);
const after = await p.evaluate(() => window.__host.palette.get("gonio.trace"));
s = await sections();
console.log(`   colour ${before} -> ${after}`, after !== before ? "APPLIED IMMEDIATELY  PASS" : "NOT APPLIED  FAIL");
console.log("   section still open:", JSON.stringify(s.find(x=>x.id==="colours")), s.find(x=>x.id==="colours").open ? "PASS" : "FAIL");

console.log("\n4. autosave to disk (no button pressed)");
await p.waitForTimeout(1600);
const persisted = await p.evaluate(async () => {
  const r = await fetch("/nova_player/config", { cache: "no-store" });
  const j = await r.json();
  return j.themes["nova-dark"].roles["gonio.trace"];
});
console.log("   config on disk now:", persisted, /ff2277/i.test(persisted) ? "PASS" : "FAIL");
const overrides = await p.evaluate(() => JSON.stringify(window.__host.state.overrides.roles));
console.log("   node override cleared after save:", overrides, overrides === "{}" ? "PASS" : "FAIL");

console.log("\n5. param autosave");
await p.click('.nova-panel details[data-section="settings"] summary');
await p.waitForTimeout(200);
await p.evaluate(() => {
  const sl = document.querySelector('.nova-panel details[data-section="settings"] input[type="range"]');
  sl.value = String(Number(sl.max) * 0.8);
  sl.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.waitForTimeout(1600);
const rp = await p.evaluate(async () => (await (await fetch("/nova_player/config",{cache:"no-store"})).json()).renderers.analyzer);
console.log("   analyzer params on disk:", JSON.stringify(rp));
console.log("   no save button in the panel:",
  await p.evaluate(() => ![...document.querySelectorAll(".nova-panel__body .nova-btn")].length) ? "PASS" : "FAIL");

console.log("\n6. new theme / save as, no window.prompt");
let sawPrompt = false;
p.on("dialog", async d => { sawPrompt = true; await d.dismiss(); });
await p.click('.nova-panel__themerow .nova-btn:nth-child(1)');   // New
await p.waitForTimeout(200);
const dialogVisible = await p.evaluate(() => !document.querySelector(".nova-panel__dialog").hidden);
console.log("   inline dialog shown:", dialogVisible ? "PASS" : "FAIL", "| browser prompt used:", sawPrompt ? "YES  FAIL" : "no  PASS");
await p.fill(".nova-panel__dialog input", "studio-blue");
await p.click(".nova-panel__dialog .nova-btn--primary");
await p.waitForTimeout(900);
const themes = await p.evaluate(() => [...document.querySelectorAll(".nova-panel select option")].map(o=>o.value));
console.log("   themes now:", themes.join(", "), themes.includes("studio-blue") ? "PASS" : "FAIL");
console.log("   active theme switched to it:", await p.evaluate(() => window.__host.state.theme));

console.log("\n7. panel resize by dragging the edge");
const w0 = await p.evaluate(() => document.querySelector(".nova-panel").offsetWidth);
const box = await p.locator(".nova-panel__grip").boundingBox();
await p.mouse.move(box.x + 3, box.y + box.height/2);
await p.mouse.down();
await p.mouse.move(box.x - 120, box.y + box.height/2, { steps: 10 });
await p.mouse.up();
await p.waitForTimeout(250);
const w1 = await p.evaluate(() => document.querySelector(".nova-panel").offsetWidth);
console.log(`   width ${w0} -> ${w1}`, w1 > w0 + 80 ? "PASS" : "FAIL");
console.log("   persisted in state:", await p.evaluate(() => window.__host.state.panelWidth));

console.log("\n8. switching view mode re-scopes the panel");
await p.evaluate(() => { window.__host.state.viewMode = "spectrogram"; window.__host.panel.refresh(); });
await p.waitForTimeout(300);
const h2 = await p.evaluate(() => [...document.querySelectorAll(".nova-panel summary")].map(s=>s.textContent));
console.log("   headings:", h2.join(" | "), h2.some(h=>/SPECTROGRAM/.test(h)) && !h2.some(h=>/ANALYZER/.test(h)) ? "PASS" : "FAIL");

await snap(p.locator("#stage"), "panel-v2.png");
console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
await b.close();
