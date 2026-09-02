import pw from "./_pw.mjs";
import { snap } from "./_shots.mjs";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 800 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
p.on("console", m => { const t=m.text(); if (m.type()==="error" && !t.includes("MediaError") && !t.includes("404")) errs.push(t); });

await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);
await p.evaluate(() => { const s=document.getElementById("stage"); s.style.width="1150px"; s.style.height="440px"; });
await p.evaluate(() => { window.__host.state.viewMode="analyzer"; window.__host.panel.refresh(); window.__host._togglePanel(); });
await p.waitForTimeout(500);
await p.click('.nova-panel details[data-section="colours"] summary');
await p.waitForTimeout(250);

const setColour = (role, hex) => p.evaluate(([r,h]) => {
  const well = [...document.querySelectorAll('.nova-panel input[type="color"]')].find(w => w.title.startsWith(r));
  well.value = h; well.dispatchEvent(new Event("input", { bubbles: true }));
}, [role, hex]);

const diskRole = (role) => p.evaluate(async r => {
  const j = await (await fetch("/nova_player/config", { cache: "no-store" })).json();
  return j.themes["nova-dark"].roles[r];
}, role);

console.log("default scope:", await p.evaluate(() => window.__host.state.colorScope));

console.log("\n1. NODE scope - edit stays on the node, disk untouched");
const diskBefore = await diskRole("gonio.trace");
await setColour("gonio.trace", "#ff2277");
await p.waitForTimeout(1800);
const applied = await p.evaluate(() => window.__host.palette.get("gonio.trace"));
const diskAfter = await diskRole("gonio.trace");
const ov = await p.evaluate(() => JSON.stringify(window.__host.state.overrides.roles));
console.log("   display   :", applied, /255,34,119/.test(applied) ? "PASS" : "FAIL");
console.log("   disk      :", diskBefore, "->", diskAfter, diskBefore === diskAfter ? "UNCHANGED  PASS" : "CHANGED  FAIL");
console.log("   node state:", ov, ov.includes("gonio.trace") ? "PASS" : "FAIL");
console.log("   row marked local:", await p.evaluate(() =>
  !![...document.querySelectorAll('.nova-row--local label')].find(l => l.title.startsWith("gonio.trace"))) ? "PASS" : "FAIL");
console.log("   promote offered:", await p.evaluate(() => {
  const b = document.querySelector(".nova-panel__promote"); return b.hidden ? "hidden FAIL" : b.textContent; }));

console.log("\n2. workflow carries it, deltas only");
const ser = await p.evaluate(() => JSON.stringify(window.__host.serialise()));
console.log("  ", ser);
console.log("   deltas only:", /gonio\.trace/.test(ser) && !/wave\.left/.test(ser) ? "PASS" : "FAIL");

console.log("\n3. a second node on the same theme is unaffected");
const second = await p.evaluate(async () => {
  const { PlayerHost } = await import("/web/core/host.js");
  const node = { id: 2, size:[900,300], properties:{}, graph:{_version:0}, setSize(){}, addDOMWidget(){return{};} };
  const h = new PlayerHost(node, { filename:"t2.wav", duration:60, sample_rate:48000,
                                   stereo:true, lufs:-14, peaks: window.__host.peaks });
  window.__host2 = h;
  return h.palette.get("gonio.trace");
});
console.log("   node 1:", applied);
console.log("   node 2:", second, second !== applied ? "DIFFERENT  PASS" : "SAME  FAIL");

console.log("\n4. promote to theme");
await p.click(".nova-panel__promote");
await p.waitForTimeout(1400);
const diskPromoted = await diskRole("gonio.trace");
const ovAfter = await p.evaluate(() => JSON.stringify(window.__host.state.overrides.roles));
console.log("   disk now :", diskPromoted, /ff2277/i.test(diskPromoted) ? "PASS" : "FAIL");
console.log("   override cleared:", ovAfter, ovAfter === "{}" ? "PASS" : "FAIL");
console.log("   display unchanged:", await p.evaluate(() => window.__host.palette.get("gonio.trace")));

console.log("\n5. THEME scope - edit goes straight to disk");
await p.evaluate(() => { document.querySelectorAll(".nova-scope button")[1].click(); });
await p.waitForTimeout(200);
console.log("   scope now:", await p.evaluate(() => window.__host.state.colorScope));
await setColour("gonio.border", "#00ff88");
await p.waitForTimeout(1600);
const borderDisk = await diskRole("gonio.border");
console.log("   disk     :", borderDisk, /00ff88/i.test(borderDisk) ? "PASS" : "FAIL");
console.log("   promote hidden in theme scope:", await p.evaluate(() =>
  document.querySelector(".nova-panel__promote").hidden) ? "PASS" : "FAIL");

console.log("\n6. node overrides survive a theme switch");
await p.evaluate(() => { document.querySelectorAll(".nova-scope button")[0].click(); });
await setColour("gonio.grid", "#ffaa00");
await p.waitForTimeout(400);
await p.evaluate(() => { const s = document.querySelector(".nova-panel select"); s.value = "nova-ice"; s.dispatchEvent(new Event("change")); });
await p.waitForTimeout(500);
const survived = await p.evaluate(() => window.__host.state.overrides.roles["gonio.grid"]);
console.log("   theme:", await p.evaluate(() => window.__host.state.theme), "| override kept:", survived, survived ? "PASS" : "FAIL");

console.log("\n7. Reset node clears them");
await p.click('.nova-panel__foot .nova-btn');
await p.waitForTimeout(300);
console.log("   overrides:", await p.evaluate(() => JSON.stringify(window.__host.state.overrides)),
  await p.evaluate(() => Object.keys(window.__host.state.overrides.roles).length === 0) ? "PASS" : "FAIL");

await p.evaluate(() => window.__host2 && window.__host2.destroy());
await snap(p.locator("#stage"), "panel-scope.png");
console.log("\nerrors:", errs.length ? errs.join(" | ") : "none");
await b.close();
