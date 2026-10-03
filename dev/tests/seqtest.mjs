/**
 * seqtest.mjs — recorded sequences, end to end, through the real drawer.
 *
 * Record → save → list → play (once, looped) → hostile file → hand-back on a
 * manual edit → delete with confirmation → list refresh on view change →
 * a recording survives switching view. Drives the drawer's own buttons where
 * a user would click, and the controller's setParam where a user would drag a
 * slider (the same call the slider makes).
 *
 *   python3 dev/devserver.py --port 8731 &
 *   node dev/tests/seqtest.mjs
 *
 * The devserver writes sequences to a temp folder (NOVA_SEQUENCES_DIR to
 * override), never to a real ComfyUI user folder.
 */
import pw from "./_pw.mjs";

const BASE = process.env.NOVA_DEV_URL || "http://127.0.0.1:8731";
let PASS = 0, FAIL = 0;
const ck = (n, ok, d = "") => { ok ? PASS++ : FAIL++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "   " + d : ""}`); };

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 1300, height: 1000 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto(`${BASE}/dev/harness-vuenode.html`, { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

const TAG = "seqtest " + Date.now().toString(36);
const R = await p.evaluate(async (TAG) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const h = window.__host, ctl = h.panel.controller;
  const api = (m, path, body) => fetch("/nova_player/sequences" + path, {
    method: m, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined }).then(r => r.json().then(j => ({ code: r.status, ...j })));
  const sec = () => h.element.querySelector('details[data-section="sequences"]');
  const q = s => sec()?.querySelector(s);
  const btn = txt => [...(sec()?.querySelectorAll("button") || [])].find(b => b.textContent.includes(txt) && !b.closest("[hidden]"));
  const show = view => { h.state.viewMode = view; h.panel.refresh(); };
  const out = {};
  try {

  // The sequences clock follows the song, and the harness song starts paused.
  await h.engine.play();

  // -- only decorative views get it ------------------------------------------
  if (!h.state.panelOpen) h._togglePanel();
  show("waveform"); await sleep(100);
  out.waveformHasSection = !!sec();
  show("halo"); await sleep(400);
  out.haloHasSection = !!sec();
  sec().open = true;

  // -- record ------------------------------------------------------------------
  btn("Record new").click();
  const nameIn = q('input[type="text"]');
  const start = btn("Start");
  out.startDisabledEmpty = start.disabled;
  nameIn.value = `${TAG} Spinning Fury`; nameIn.dispatchEvent(new Event("input"));
  out.startEnabledNamed = !start.disabled;
  start.click();
  await sleep(50);
  out.recordingShown = !!btn("Stop & save");
  const before = JSON.stringify(h.state.overrides.renderers.halo || {});
  await sleep(300); ctl.setParam("halo", "tilt", 30);
  await sleep(300); ctl.setParam("halo", "gain", 2);
  // A fast burst on one slider merges into one step.
  for (let v = 0.1; v <= 0.5; v += 0.1) ctl.setParam("halo", "spin", +v.toFixed(2));
  await sleep(300); ctl.setParam("halo", "spinMode", "rotate");
  await sleep(400);
  btn("Stop & save").click();
  await sleep(600);
  const name = `${TAG} Spinning Fury`;
  const pick = q("select.nova-seq__pick");
  out.listedAndSelected = pick.value === name;
  const file = await api("GET", "/halo/" + encodeURIComponent(name));
  out.file = { code: file.code, steps: file.sequence?.steps?.length, keys: file.sequence?.steps?.map(s => s.key),
               waits: file.sequence?.steps?.map(s => s.wait_ms), end: file.sequence?.end_ms,
               startTilt: file.sequence?.start?.tilt, format: file.sequence?.format, renderer: file.sequence?.renderer };

  // Restore the node's own settings, so playback differences are visible.
  ctl.setParam("halo", "tilt", -45); ctl.setParam("halo", "gain", 1.2);
  ctl.setParam("halo", "spin", 0.04); ctl.setParam("halo", "spinMode", "spin");
  const ownBefore = JSON.stringify(h.state.overrides.renderers.halo);

  // -- play once ---------------------------------------------------------------
  const loop = q(".nova-seq__loop input"), times = q('input[type="number"]');
  loop.checked = false; times.value = "1";
  btn("Play").click();
  await sleep(120);
  out.atStart = { tilt: h.paramsFor("halo").tilt, gain: h.paramsFor("halo").gain };
  await sleep(1000);
  out.midway = { tilt: h.paramsFor("halo").tilt, gain: h.paramsFor("halo").gain,
                 spin: h.paramsFor("halo").spin, mode: h.paramsFor("halo").spinMode };
  out.overridesUntouched = JSON.stringify(h.state.overrides.renderers.halo) === ownBefore;
  await sleep(1200);
  out.afterEnd = { playing: !!h.seqState().playing, tilt: h.paramsFor("halo").tilt, mode: h.paramsFor("halo").spinMode };

  // -- loop, then stop ---------------------------------------------------------
  loop.checked = true;
  btn("Play").click();
  await sleep(3000);                           // > 2 passes of a ~1.6 s sequence
  const st = h.seqState().playing;
  out.looping = st && st.loop && st.pass >= 2 ? st.pass : 0;
  btn("Stop").click();
  await sleep(100);
  out.stopped = !h.seqState().playing && h.paramsFor("halo").tilt === -45;

  // -- a manual edit during playback hands control back ------------------------
  btn("Play").click(); await sleep(200);
  ctl.setParam("halo", "gain", 2.5);
  await sleep(100);
  out.handBack = !h.seqState().playing && h.paramsFor("halo").gain === 2.5;
  ctl.setParam("halo", "gain", 1.2);

  // -- a hostile / foreign file -------------------------------------------------
  const hostile = `${TAG} copied in`;
  const saved = await api("POST", "/halo", { name: hostile, sequence: {
    start: { tilt: 10, nonsense: 1, gain: "loud" },
    steps: [
      { wait_ms: 100, key: "doesNotExist", value: 5 },     // unknown setting
      { wait_ms: 100, key: "tilt", value: 500 },           // outside -90..90
      { wait_ms: 100, key: "glow", value: "yes" },         // wrong type
      { wait_ms: 100, key: "spinMode", value: "sideways" },// old value, aliased
      { wait_ms: 100, key: "tilt", value: 60 },            // fine
      { wait_ms: "x", key: "gain", value: 2 },             // bad wait, fine value
    ], end_ms: 300 } });
  out.hostileSaved = saved.status === "success";
  show("waveform"); show("halo"); await sleep(400);     // choosing the view re-reads the folder
  sec().open = true;
  const pick2 = q("select.nova-seq__pick");
  out.hostileListed = [...pick2.options].some(o => o.value === hostile);
  pick2.value = hostile;
  q(".nova-seq__loop input").checked = false;
  btn("Play").click();
  await sleep(250);
  out.hostileStatus = h.element.querySelector(".nova-panel__status")?.textContent || "";
  await sleep(500);
  out.hostileMid = { tilt: h.paramsFor("halo").tilt, mode: h.paramsFor("halo").spinMode,
                     glow: h.paramsFor("halo").glow, gain: h.paramsFor("halo").gain };
  await sleep(700);
  out.hostileFinished = !h.seqState().playing;

  // -- delete with confirmation ---------------------------------------------------
  pick2.value = hostile; h.panel.sync();
  q('button[aria-label="Delete this sequence"]').click();
  await sleep(50);
  const confirm = q(".nova-seq__confirm");
  out.confirmShown = !confirm.hidden && confirm.textContent.includes("Are you sure?");
  [...confirm.querySelectorAll("button")].find(b => b.textContent === "Keep").click();
  await sleep(50);
  out.keepKeeps = confirm.hidden && (await api("GET", "/halo/" + encodeURIComponent(hostile))).code === 200;
  q('button[aria-label="Delete this sequence"]').click();
  [...confirm.querySelectorAll("button")].find(b => b.textContent === "Delete").click();
  await sleep(500);
  out.deleted = (await api("GET", "/halo/" + encodeURIComponent(hostile))).code === 404
             && ![...q("select.nova-seq__pick").options].some(o => o.value === hostile);

  // -- switching view mid-recording keeps the recording --------------------------
  const r2 = `${TAG} interrupted`;
  ctl.seqStartRecording(r2);
  await sleep(100); ctl.setParam("halo", "tilt", 20); await sleep(100);
  show("waveform"); await sleep(700);
  const g2 = await api("GET", "/halo/" + encodeURIComponent(r2));
  out.interruptedSaved = g2.code === 200 && g2.sequence.steps.length === 1;
  show("halo");

  // -- the clock follows the song ------------------------------------------------
  // Recording: time spent with the song paused is not recorded as a wait, so a
  // slow, thoughtful user does not end up with long dead gaps.
  const r3 = `${TAG} thoughtful`;
  ctl.seqStartRecording(r3);
  await sleep(200); ctl.setParam("halo", "tilt", 10);
  h.engine.pause();
  await sleep(250);
  out.recPausedShown = /paused with the song/.test(sec().querySelector(".nova-seq__rectext")?.textContent || "");
  await sleep(700); ctl.setParam("halo", "gain", 2);           // decided while paused
  await h.engine.play();
  await sleep(300); ctl.setParam("halo", "tilt", 30);
  await sleep(150);
  const saved3 = await ctl.seqStopRecording();
  const f3 = (await api("GET", "/halo/" + encodeURIComponent(saved3.name))).sequence;
  out.pauseWaits = f3.steps.map(s => s.wait_ms);

  // Playback: pauses with the song and resumes where it was.
  ctl.setParam("halo", "tilt", -45);
  await ctl.seqPlay(saved3.name, { loop: false, times: 1 });
  await sleep(100);
  h.engine.pause();
  const tPause = h.seqState().playing?.progress;
  await sleep(700);
  const st3 = h.seqState().playing;
  out.playbackPaused = !!st3 && st3.paused && Math.abs(st3.progress - tPause) < 0.02;
  await h.engine.play();
  await sleep(900);
  out.playbackResumedAndFinished = !h.seqState().playing;

  // -- the drawer keeps the width you drag it to ---------------------------------
  {
    const panel = h.element.querySelector(".nova-panel"), grip = panel.querySelector(".nova-panel__grip");
    const w0 = panel.offsetWidth, r = grip.getBoundingClientRect();
    const ev = (type, x) => grip.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: r.top + 20, pointerId: 1, bubbles: true }));
    ev("pointerdown", r.left + 2);
    ev("pointermove", r.left + 2 - 90);                    // drag 90 px wider
    const dragged = panel.offsetWidth;
    h.panel.sync(); h.panel.sync();                        // what recording does several times a second
    out.widthHeldDuringSync = panel.offsetWidth === dragged && dragged > w0;
    ev("pointerup", r.left + 2 - 90);
    h.panel.sync();
    out.widthKeptAfterRelease = panel.offsetWidth === dragged && h.state.panelWidth === dragged;
    h.state.panelWidth = w0; h.panel.sync();
  }

  // -- tidy up -------------------------------------------------------------------
  const list = await api("GET", "/halo");
  for (const it of list.items || []) if (it.name.startsWith(TAG)) await api("DELETE", "/halo/" + encodeURIComponent(it.name));
  ctl.setParam("halo", "tilt", 0);
  } catch (e) {
    out.__error = String(e && e.stack || e).split("\n").slice(0, 3).join(" | ");
    out.__html = sec()?.innerText?.slice(0, 400);
  }
  return out;
}, TAG);
if (R.__error) { console.log("ERROR inside test:", R.__error, "\nsection:", R.__html, "\nso far:", JSON.stringify(R).slice(0, 900)); }

ck("measurement views have no Sequences section", !R.waveformHasSection);
ck("Halo has a Sequences section", R.haloHasSection);
ck("Start is disabled until a name is typed", R.startDisabledEmpty && R.startEnabledNamed);
ck("recording shows Stop & save", R.recordingShown);
ck("saved, and the refreshed list selects it", R.listedAndSelected);
ck("file holds the start snapshot and each change", R.file.code === 200 && R.file.startTilt === 0
   && JSON.stringify(R.file.keys) === JSON.stringify(["tilt", "gain", "spin", "spinMode"])
   && R.file.format === "nova-player-sequence" && R.file.renderer === "halo",
   `keys ${JSON.stringify(R.file.keys)} waits ${JSON.stringify(R.file.waits)} end ${R.file.end}`);
ck("waits are the real gaps between changes", R.file.waits && R.file.waits[0] >= 250 && R.file.waits[1] >= 250
   && R.file.waits[3] >= 250 && R.file.end >= 350, JSON.stringify(R.file.waits));
ck("a fast burst on one slider merged into one step", R.file.steps === 4);
ck("playback starts from the recorded start", R.atStart.tilt === 0 && R.atStart.gain === 1.2, JSON.stringify(R.atStart));
ck("playback applies the changes in time", R.midway.tilt === 30 && R.midway.gain === 2 && R.midway.spin === 0.5
   && R.midway.mode === "rotate", JSON.stringify(R.midway));
ck("playback never writes to the node's own settings", R.overridesUntouched);
ck("after one pass the node's own settings are back", !R.afterEnd.playing && R.afterEnd.tilt === -45
   && R.afterEnd.mode === "spin", JSON.stringify(R.afterEnd));
ck("loop keeps going past the end", R.looping >= 2, `pass ${R.looping}`);
ck("Stop stops, and restores", R.stopped);
ck("touching a setting during playback hands control back", R.handBack);
ck("a file copied into the folder shows up when the view is chosen", R.hostileSaved && R.hostileListed);
ck("unusable settings are reported, not fatal", /ignoring \d+ unusable/.test(R.hostileStatus), R.hostileStatus);
ck("valid steps still apply; bad ones are skipped", R.hostileMid.tilt === 60 && R.hostileMid.mode === "rotate"
   && R.hostileMid.glow === true && R.hostileMid.gain === 2, JSON.stringify(R.hostileMid));
ck("the foreign file plays through to the end", R.hostileFinished);
ck("Delete asks 'Are you sure?'", R.confirmShown);
ck("Keep keeps the file", R.keepKeeps);
ck("Delete removes it and refreshes the list", R.deleted);
ck("switching view mid-recording saves what was recorded", R.interruptedSaved);
ck("recording shows the clock is paused with the song", R.recPausedShown);
ck("time with the song paused is not recorded as a wait", R.pauseWaits && R.pauseWaits[1] < 150
   && R.pauseWaits[0] >= 150 && R.pauseWaits[2] >= 250, `waits ${JSON.stringify(R.pauseWaits)} (0.95 s of it was paused)`);
ck("playback pauses with the song", R.playbackPaused);
ck("…and resumes to finish", R.playbackResumedAndFinished);
ck("the drawer keeps its dragged width while it refreshes", R.widthHeldDuringSync);
ck("…and after release", R.widthKeptAfterRelease);
ck("no page errors", errs.length === 0, errs.slice(0, 2).join(" | "));

await b.close();
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
