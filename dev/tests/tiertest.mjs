/**
 * The hypothesis line's tier precedence.
 *
 * THE BUG THIS PINS. A take that overshot full scale — peak +0.45 dBFS, 87
 * samples clamped by the WAV write — produced:
 *
 *     HYP: low crest → transients flattened; lower cfg_scale
 *
 * Clipping is a crest-reduction mechanism, so a level fault reads as low crest.
 * The meter looked at a gain problem and named a model parameter. Acting on it
 * means a five-minute re-render chasing a fault that no value of cfg_scale can
 * touch.
 *
 * The fix is precedence, not better thresholds: a level fault SUPPRESSES every
 * generation-stage hypothesis rather than merely outranking it, because a
 * confident wrong hypothesis is worse than none.
 *
 * The level tier cannot come from the meter's own rows. It measures the decoded
 * WAV, which save_wav already clamped — the overshoot is gone by then and the
 * peak reads 0 dBFS. It has to come from the Python whole-file bench.
 *
 * Run:  node dev/tests/tiertest.mjs
 */
import pw from "./_pw.mjs";

const b = await pw.chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 400 } });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://127.0.0.1:8731/dev/harness.html", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__ready === true);

let PASS = 0, FAIL = 0;
const ck = (n, ok, note = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${note ? "   " + note : ""}`);
  ok ? PASS++ : FAIL++;
};

console.log("hypothesis tiers\n");

const r = await p.evaluate(async () => {
  const { suggest } = await import("/web/renderers/projected_guidance.js");

  // Exactly the reported take: flat crest, and a level fault behind it.
  const flatCrest = { crest: 5.9, centroid: 1894, flux: 0.084,
                      flatness: -14.2, clip: 0, sat: 0 };
  const healthy   = { crest: 14.6, centroid: 3554, flux: 0.102,
                      flatness: -10.9, clip: 0, sat: 0 };

  const overshoot = { peak_db: 0.45, over_fs: 87, dc_offset: -0.00012, lr_corr: 0.803 };
  const clean     = { peak_db: -1.32, over_fs: 0, dc_offset: -0.00012, lr_corr: 0.803 };

  return {
    noBench:    suggest(flatCrest, null, null),
    withFault:  suggest(flatCrest, null, overshoot),
    cleanBench: suggest(flatCrest, null, clean),
    healthyFault: suggest(healthy, null, overshoot),
    dc:         suggest(healthy, null, { peak_db: -3, over_fs: 0, dc_offset: 0.05, lr_corr: 0.8 }),
    // 0.0027 is the WORST of 54 measured ACE-Step takes (median 0.0020). If
    // this fires, the DC line is alarming on ordinary material and, being
    // tier 1, is suppressing every generation hypothesis behind it.
    dcTypical:  suggest(healthy, null, { peak_db: -3, over_fs: 0, dc_offset: 0.0027, lr_corr: 0.8 }),
    // A reference frozen over half the take, read against a near-complete one.
    // The panel greys this delta column and says so in its header; the hint
    // line must not then draw a conclusion from the same numbers.
    refMismatch: suggest(healthy, { ...healthy, crest: 13.0, coverage: 0.50 }, clean, 0.98),
    refMatched:  suggest(healthy, { ...healthy, coverage: 0.96 }, clean, 0.98),
    phase:      suggest(healthy, null, { peak_db: -3, over_fs: 0, dc_offset: 0, lr_corr: -0.2 }),
    mono:       suggest(healthy, null, { peak_db: -3, over_fs: 0, dc_offset: 0, lr_corr: null }),
    satFault:   suggest({ ...healthy, sat: 21.9 }, null, clean),
    clipFault:  suggest({ ...healthy, clip: 0.5 }, null, clean),
    // A level fault must also beat a reference-relative generation hint.
    refDrift:   suggest({ ...healthy, crest: 8.0 }, healthy, overshoot),
    refClean:   suggest({ ...healthy, crest: 8.0 }, healthy, clean),
  };
});

// -- the reported failure ---------------------------------------------------
ck("without bench data the old wrong hint is still what fires",
   r.noBench.tier === 3 && /CREST/.test(r.noBench.text),
   r.noBench.text);

ck("with the level fault visible, the generation hint is SUPPRESSED",
   r.withFault.tier === 1 && !/cfg_scale/.test(r.withFault.text),
   r.withFault.text);

ck("the level line names the peak and the clamped count",
   /\+0\.45 dBFS/.test(r.withFault.text) && /87 samples/.test(r.withFault.text),
   r.withFault.text);

ck("a clean bench lets the generation hint through again",
   r.cleanBench.tier === 3 && /CREST/.test(r.cleanBench.text),
   r.cleanBench.text);

// -- tier 1 covers more than peak -------------------------------------------
ck("an overshoot fires even on otherwise healthy metrics",
   r.healthyFault.tier === 1, r.healthyFault.text);
ck("DC offset is tier 1", r.dc.tier === 1 && /DC offset/.test(r.dc.text), r.dc.text);
ck("a decoder's ordinary DC does not fire",
   !/DC offset/.test(r.dcTypical.text), r.dcTypical.text);
ck("no drift claim across mismatched windows",
   r.refMismatch.partial === true && /freeze again/.test(r.refMismatch.text),
   r.refMismatch.text);
ck("comparable windows still compare",
   /tracking REF/.test(r.refMatched.text), r.refMatched.text);
ck("weak L/R correlation is tier 1",
   r.phase.tier === 1 && /mono compatibility/.test(r.phase.text), r.phase.text);
ck("mono is not a fault — null correlation must not fire",
   r.mono.tier !== 1, r.mono.text);

// -- tier 2 ------------------------------------------------------------------
ck("flat-topping is tier 2, above generation", r.satFault.tier === 2, r.satFault.text);
ck("clipping is tier 2, above generation", r.clipFault.tier === 2, r.clipFault.text);

// -- precedence over the reference-relative path -----------------------------
ck("a level fault outranks a reference-relative drift hint",
   r.refDrift.tier === 1, r.refDrift.text);
ck("without the fault, the drift hint is what shows",
   r.refClean.tier === 3, r.refClean.text);

// -- the coverage gate -------------------------------------------------------
// A generation-stage claim about "the take" cannot be made from part of it.
const gate = await p.evaluate(async () => {
  const { suggest } = await import("/web/renderers/projected_guidance.js");
  const flat = { crest: 5.9, centroid: 1894, flux: 0.084, flatness: -14.2, clip: 0, sat: 0 };
  const clean = { peak_db: -1.32, over_fs: 0, dc_offset: 0, lr_corr: 0.803 };
  const fault = { peak_db: 0.45, over_fs: 87, dc_offset: 0, lr_corr: 0.803 };
  return {
    low:   suggest(flat, null, clean, 0.45),
    high:  suggest(flat, null, clean, 0.95),
    exact: suggest(flat, null, clean, 0.80),
    none:  suggest(flat, null, clean, null),
    faultAtLowCoverage: suggest(flat, null, fault, 0.45),
  };
});

ck("below 80% coverage a generation hint is withheld",
   gate.low.partial === true && !/CREST/.test(gate.low.text), gate.low.text);
ck("the withheld line says how much was measured",
   /45% of take/.test(gate.low.text), gate.low.text);
ck("at 80% the gate opens", !gate.exact.partial && /CREST/.test(gate.exact.text),
   gate.exact.text);
ck("above the gate the hint states its coverage",
   /over 95% of take/.test(gate.high.text), gate.high.text);
ck("unknown coverage does not block the hint",
   /CREST/.test(gate.none.text), gate.none.text);
ck("a LEVEL fault still fires at low coverage — it is whole-file, not windowed",
   gate.faultAtLowCoverage.tier === 1, gate.faultAtLowCoverage.text);

// -- auditability ------------------------------------------------------------
const audited = [r.noBench, r.cleanBench, r.satFault, r.clipFault, r.refClean];
ck("every generation and master hint names its metric",
   audited.every(h => /CREST|CENTROID|FLATNESS|FLUX|CLIP|SAT/.test(h.text)),
   audited.map(h => h.text.slice(0, 28)).join(" | "));
ck("thresholds are stated, so a reading can be checked",
   audited.every(h => /[(<>]/.test(h.text)));

// -- the doc contradiction ---------------------------------------------------
// docs say no metric isolates a single setting; the line must not command one.
ck("no hint issues a bare causal instruction",
   !/^(lower|raise|increase|reduce) /i.test(r.cleanBench.text),
   r.cleanBench.text);

console.log(`\nerrors: ${errs.length ? errs.join("; ") : "none"}`);
console.log(`\n${PASS} passed, ${FAIL} failed`);
await b.close();
process.exit(FAIL ? 1 : 0);
