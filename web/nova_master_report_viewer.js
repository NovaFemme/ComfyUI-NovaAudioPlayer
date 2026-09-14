// Nova Master Report Viewer v0.2.4 - Nova Report Viewer interaction standard
import { app } from "../../scripts/app.js";

const EXT_NAME = "NovaAudio.MasterReportViewer";

(function ensureNovaReportCss() {
    const id = "nova-master-report-viewer-css";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL("./nova_master_report_viewer.css", import.meta.url).href;
    document.head.appendChild(link);
})();


(function ensureNovaCompareCss() {
    const id = "nova-master-report-viewer-compare-css";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      .nova-compare-table{display:grid;grid-template-columns:minmax(110px,1.2fr) repeat(3,minmax(90px,1fr));gap:1px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden}
      .nova-compare-cell{padding:10px 12px;background:rgba(10,14,20,.62);min-width:0}
      .nova-compare-head{font-size:.78em;letter-spacing:.08em;text-transform:uppercase;opacity:.65;font-weight:700}
      .nova-compare-label{font-weight:650}.nova-compare-value,.nova-compare-delta{font-variant-numeric:tabular-nums;font-weight:700}
      .nova-tonal-row{display:grid;grid-template-columns:minmax(82px,.8fr) minmax(170px,2.2fr) minmax(120px,.9fr);gap:12px;align-items:center;margin:14px 0}
      .nova-tonal-name{font-weight:700}.nova-tonal-bars{display:grid;gap:6px}
      .nova-tonal-line{display:grid;grid-template-columns:56px 1fr 64px;gap:8px;align-items:center;font-size:.86em}
      .nova-tonal-track{height:8px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}
      .nova-tonal-fill{height:100%;background:currentColor;border-radius:999px;opacity:.72}
      .nova-tonal-src{opacity:.60}.nova-tonal-master{opacity:1}.nova-tonal-target{opacity:.82}
      .nova-tonal-number{text-align:right;font-variant-numeric:tabular-nums}
      .nova-mini-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .nova-mini-card{padding:12px 14px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.025)}
      .nova-mini-title{font-size:.78em;text-transform:uppercase;letter-spacing:.07em;opacity:.62;margin-bottom:8px}
      .nova-mini-line{display:flex;justify-content:space-between;gap:10px;padding:4px 0}
      .nova-compare-note{padding:13px 15px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.035);line-height:1.5}
    `;
    document.head.appendChild(style);
})();

function esc(v) {
    return String(v ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function num(v, digits = 2, fallback = "—") {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : fallback;
}

function pct(v, digits = 1) {
    return `${num(v, digits)}%`;
}

function clsStatus(value) {
    const s = String(value ?? "").toUpperCase();
    if (["PASS","PREFERRED","BIT_EXACT","MATCH","TARGET_REACHED","GOOD_PROGRESS","STRONG_IMPROVEMENT","EFFECTIVE"].includes(s)) return "good";
    if (["CONDITIONAL_PASS","REPRODUCTION_MATCH","NEAR","NEAR_TARGET","PARTIAL_PROGRESS","LIMITED_PROGRESS","ACCEPTABLE","ACCEPTABLE_CORRECTED","ACCEPTABLE_DYNAMIC"].includes(s)) return "warn";
    if (["FAIL","WARNING","ROLLED_BACK","ROLLBACK","REVIEW_DYNAMIC","NOT_REACHED","DRIFT_DETECTED","VALIDATION_FAIL"].includes(s)) return "bad";
    return "info";
}

function badge(text) {
    if (!text && text !== 0) return "";
    return `<span class="nova-badge ${clsStatus(text)}">${esc(text)}</span>`;
}

function metric(label, value, unit="", sub="") {
    return `
      <div class="nova-metric">
        <div class="nova-metric-label">${esc(label)}</div>
        <div class="nova-metric-value">${esc(value)}${unit ? `<span class="nova-unit">${esc(unit)}</span>` : ""}</div>
        ${sub ? `<div class="nova-metric-sub">${esc(sub)}</div>` : ""}
      </div>`;
}

function get(obj, path, fallback = undefined) {
    let cur = obj;
    for (const key of path.split(".")) {
        if (cur == null || !(key in cur)) return fallback;
        cur = cur[key];
    }
    return cur;
}

function bandRows(obj) {
    const b = obj || {};
    return [
        ["Bass", b.bass_20_250_hz ?? b.bass],
        ["Mid", b.mid_250_2000_hz ?? b.mid],
        ["Presence", b.presence_2000_6000_hz ?? b.presence],
        ["HF", b.hf_6000_plus_hz ?? b.hf],
    ];
}

function progress(label, value, status="") {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    return `
      <div class="nova-progress-wrap">
        <div class="nova-progress-head">
          <span>${esc(label)}</span>
          <span>${num(n,1)}% ${status ? badge(status) : ""}</span>
        </div>
        <div class="nova-progress"><div class="nova-progress-fill" style="width:${n}%"></div></div>
      </div>`;
}

function section(title, body, extraClass="") {
    return `<section class="nova-section ${extraClass}">
      <div class="nova-section-title">${esc(title)}</div>
      ${body}
    </section>`;
}

function deriveReport(p) {
    const source = p.source || {};
    const mastered = p.mastered || {};
    const release = p.release || {};
    const classification = p.classification || {};
    const correction = p.correction || {};
    const provenance = p.provenance || {};
    const settings = p.settings || {};

    const sourceBands = source.bands_percent || {};
    const masteredBands = mastered.bands_percent || {};

    const releaseStatus = release.status || "UNKNOWN";
    const confidence = release.confidence ?? release.score ?? 0;
    const grade = release.grade || "—";

    const title = provenance.software || "NOVA AUDIO MASTER";
    const version = p.master_version || provenance.master_version || "";
    const mode = p.mode || provenance.processing_mode || "";
    const profile = p.profile || provenance.processing_profile || "";

    return {
        source, mastered, release, classification, correction, provenance, settings,
        sourceBands, masteredBands, releaseStatus, confidence, grade,
        title, version, mode, profile
    };
}


function signed(v, digits=2, unit="") {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    const s = n > 0 ? "+" : "";
    return `${s}${n.toFixed(digits)}${unit}`;
}

function deltaMetric(label, from, to, digits=2, unit="") {
    const a = Number(from), b = Number(to);
    const delta = (Number.isFinite(a) && Number.isFinite(b)) ? (b-a) : NaN;
    return `
      <div class="nova-delta-card">
        <div class="nova-delta-label">${esc(label)}</div>
        <div class="nova-delta-values">
          <span>${Number.isFinite(a) ? a.toFixed(digits) : "—"}${unit}</span>
          <span class="nova-arrow">→</span>
          <strong>${Number.isFinite(b) ? b.toFixed(digits) : "—"}${unit}</strong>
        </div>
        <div class="nova-delta-change">${Number.isFinite(delta) ? signed(delta,digits,unit) : "—"}</div>
      </div>`;
}

function findTonalValues(p) {
    const c = p?.correction || {};
    const candidates = [
        c.tonal,
        c.tonal_validation,
        c.tonal_correction,
        p?.processing?.tonal,
        p?.processing?.tonal_eq,
    ].filter(Boolean);

    function first(keys) {
        for (const obj of candidates) {
            for (const k of keys) {
                const v = obj?.[k];
                if (Number.isFinite(Number(v))) return Number(v);
            }
        }
        return NaN;
    }

    return {
        bass: first(["bass_db","bass_effective_db","bass"]),
        mid: first(["mid_db","mid_effective_db","mid"]),
        presence: first(["presence_db","presence_effective_db","presence"]),
        hf: first(["hf_db","air_db","air_effective_db","hf"]),
    };
}

function guidePhase(title, state, summary, checks) {
    return `
      <div class="nova-guide-phase">
        <div class="nova-guide-head">
          <div class="nova-guide-title">${esc(title)}</div>
          ${badge(state)}
        </div>
        <div class="nova-guide-summary">${esc(summary)}</div>
        ${checks?.length ? `<ul>${checks.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      </div>`;
}

function renderGuide(p, opts) {
    const d = deriveReport(p);
    const src = d.source || {};
    const mst = d.mastered || {};
    const cls = d.classification || {};
    const rel = d.release || {};

    const loudStatus = cls.loudness?.status || "";
    const crestStatus = cls.crest?.status || "";
    const tonalStatus = cls.tonal_balance?.status || "";
    const peakStatus = cls.true_peak?.status || "";
    const stereoStatus = cls.stereo?.status || "";

    let next = "Review the master and confirm it translates well on your reference system.";
    if (String(rel.status).toUpperCase().includes("PASS")) {
        next = "This master is technically acceptable. Prioritize listening checks before further processing.";
    } else if (String(rel.status).toUpperCase().includes("WARNING")) {
        next = "One or more areas need review. Avoid forcing targets until you identify which metric is responsible.";
    }

    return `
      <div class="nova-hero">
        <div>
          <div class="nova-kicker">NOVA MASTERING GUIDE</div>
          <div class="nova-title">Mastering Workflow</div>
          <div class="nova-subtitle">${esc(d.profile || "Profile")} · ${esc(d.mode || "Mode")}</div>
        </div>
        <div class="nova-release">
          ${badge(rel.status || "UNKNOWN")}
          <div class="nova-confidence">${num(rel.confidence,1)} / 100</div>
        </div>
      </div>

      ${section("Recommended Next Action", `
        <div class="nova-guide-next">${esc(next)}</div>
      `)}

      <div class="nova-guide-flow">
        ${guidePhase(
          "1. Source Assessment",
          "INFO",
          `Source is ${num(src.integrated_lufs,2)} LUFS, ${num(src.true_peak_dbtp,2)} dBTP, crest ${num(src.crest_db,2)} dB, correlation ${num(src.lr_correlation,3)}.`,
          [
            "Listen for clipping, distortion, excessive noise, harsh transients, or low-end masking.",
            "Confirm the source is the correct mix/version before mastering."
          ]
        )}

        ${guidePhase(
          "2. Tonal Correction",
          tonalStatus || "INFO",
          `Nova's tonal result is classified as ${tonalStatus || "unclassified"}.`,
          [
            "Check whether bass, midrange, presence and HF feel balanced for the selected profile.",
            "Prefer broad tonal balance over chasing exact percentages."
          ]
        )}

        ${guidePhase(
          "3. Stereo",
          stereoStatus || "INFO",
          `Correlation moved from ${num(src.lr_correlation,3)} to ${num(mst.lr_correlation,3)}.`,
          [
            "Check mono compatibility and vocal/lead stability.",
            "Avoid widening further if the image already feels spacious or unstable."
          ]
        )}

        ${guidePhase(
          "4. Dynamics / Crest",
          crestStatus || "INFO",
          `Crest moved from ${num(src.crest_db,2)} dB to ${num(mst.crest_db,2)} dB.`,
          [
            "Listen for punch, drum impact and transient integrity.",
            "Do not force the nominal crest target if the safer adaptive result sounds better."
          ]
        )}

        ${guidePhase(
          "5. Loudness / Limiting",
          loudStatus || peakStatus || "INFO",
          `Master is ${num(mst.integrated_lufs,2)} LUFS with ${num(mst.true_peak_dbtp,2)} dBTP true peak.`,
          [
            "Check for pumping, harshness or flattened transients.",
            "If loudness target is not reached but limiter pressure is already high, preserve the safer result."
          ]
        )}

        ${guidePhase(
          "6. Final Validation",
          rel.status || "INFO",
          rel.summary || "Review all validation states before release.",
          [
            "Compare against the source at matched playback level.",
            "Check headphones, speakers and mono.",
            "Only reprocess when a specific audible problem or validation warning justifies it."
          ]
        )}

        ${guidePhase(
          "7. Export / Reproduction",
          "INFO",
          "Export the intended delivery representation and validate the saved file against its matching reference report.",
          [
            "PCM24: expect REPRODUCTION_MATCH.",
            "FLOAT32: ideal archival result is BIT_EXACT.",
            "Preserve report JSON and identity/fingerprint records with the master."
          ]
        )}
      </div>`;
}

function renderDashboard(p, opts) {
    const d = deriveReport(p);
    const src = d.source;
    const mst = d.mastered;

    const header = `
      <div class="nova-hero">
        <div>
          <div class="nova-kicker">${esc(d.title)}</div>
          <div class="nova-title">Mastering Report</div>
          <div class="nova-subtitle">
            ${d.version ? `v${esc(d.version)} · ` : ""}${esc(d.mode)}${d.profile ? ` · ${esc(d.profile)}` : ""}
          </div>
        </div>
        <div class="nova-release">
          ${badge(d.releaseStatus)}
          <div class="nova-grade">${esc(d.grade)}</div>
          <div class="nova-confidence">${num(d.confidence,1)} / 100</div>
        </div>
      </div>`;

    const summary = `
      <div class="nova-grid nova-grid-4">
        ${metric("LUFS", num(mst.integrated_lufs ?? src.integrated_lufs,2))}
        ${metric("True Peak", num(mst.true_peak_dbtp ?? src.true_peak_dbtp,2), " dBTP")}
        ${metric("Crest", num(mst.crest_db ?? src.crest_db,2), " dB")}
        ${metric("L/R Corr", num(mst.lr_correlation ?? src.lr_correlation,3))}
      </div>`;

    let html = header + summary;

    html += section("Source → Mastered", `
      <div class="nova-grid nova-grid-4">
        ${deltaMetric("LUFS", src.integrated_lufs, mst.integrated_lufs, 2, "")}
        ${deltaMetric("True Peak", src.true_peak_dbtp, mst.true_peak_dbtp, 2, " dBTP")}
        ${deltaMetric("RMS", src.rms_dbfs, mst.rms_dbfs, 2, " dBFS")}
        ${deltaMetric("Crest", src.crest_db, mst.crest_db, 2, " dB")}
      </div>
    `);

    if (opts.show_source) {
        html += section("Source", `
          <div class="nova-grid nova-grid-4">
            ${metric("LUFS", num(src.integrated_lufs,2))}
            ${metric("True Peak", num(src.true_peak_dbtp,2), " dBTP")}
            ${metric("RMS", num(src.rms_dbfs,2), " dBFS")}
            ${metric("Crest", num(src.crest_db,2), " dB")}
          </div>
          <div class="nova-band-grid">
            ${bandRows(d.sourceBands).map(([k,v]) => `
              <div class="nova-band"><span>${k}</span><strong>${pct(v,1)}</strong></div>`).join("")}
          </div>
        `);
    }

    if (opts.show_processing) {
        const tonal = findTonalValues(p);
        const dynamics = d.correction.dynamics || {};
        const stereo = d.correction.stereo || {};
        const loudness = d.correction.loudness || {};

        html += section("Processing", `
          <div class="nova-cards">
            <div class="nova-card">
              <div class="nova-card-title">Tonal</div>
              <div class="nova-row"><span>Bass</span><strong>${signed(tonal.bass,2," dB")}</strong></div>
              <div class="nova-row"><span>Mid</span><strong>${signed(tonal.mid,2," dB")}</strong></div>
              <div class="nova-row"><span>Presence</span><strong>${signed(tonal.presence,2," dB")}</strong></div>
              <div class="nova-row"><span>HF</span><strong>${signed(tonal.hf,2," dB")}</strong></div>
            </div>

            <div class="nova-card">
              <div class="nova-card-title">Stereo</div>
              <div class="nova-row"><span>Source</span><strong>${num(src.lr_correlation,3)}</strong></div>
              <div class="nova-row"><span>Mastered</span><strong>${num(mst.lr_correlation,3)}</strong></div>
              <div class="nova-row"><span>Width</span><strong>${num(stereo.applied_width ?? stereo.applied ?? d.settings.stereo_width_percent,1)}${(stereo.applied_width ?? stereo.applied) ? "×" : "%"}</strong></div>
              ${stereo.status ? `<div class="nova-card-foot">${badge(stereo.status)}</div>` : ""}
            </div>

            <div class="nova-card">
              <div class="nova-card-title">Dynamics</div>
              <div class="nova-row"><span>Crest</span><strong>${num(src.crest_db,2)} → ${num(mst.crest_db,2)} dB</strong></div>
              <div class="nova-row"><span>RMS</span><strong>${num(src.rms_dbfs,2)} → ${num(mst.rms_dbfs,2)}</strong></div>
              <div class="nova-row"><span>Limiter GR</span><strong>${num(dynamics.limiter_gr_db ?? loudness.limiter_gr_db ?? get(p,"processing.true_peak_limiter_gr_db"),2)} dB</strong></div>
              ${dynamics.status ? `<div class="nova-card-foot">${badge(dynamics.status)}</div>` : ""}
            </div>
          </div>
        `);
    }

    if (opts.show_validation) {
        const crest = d.classification.crest || {};
        const loud = d.classification.loudness || {};
        const tonal = d.classification.tonal_balance || {};
        const peak = d.classification.true_peak || {};

        html += section("Validation", `
          <div class="nova-validation-list">
            <div class="nova-validation-row"><span>True Peak</span><span>${badge(peak.status)} <strong>${num(peak.score,1)}</strong></span></div>
            <div class="nova-validation-row"><span>Loudness</span><span>${badge(loud.status)} <strong>${num(loud.score,1)}</strong></span></div>
            <div class="nova-validation-row"><span>Crest</span><span>${badge(crest.status)} <strong>${num(crest.score,1)}</strong></span></div>
            <div class="nova-validation-row"><span>Tonal Balance</span><span>${badge(tonal.status)} <strong>${num(tonal.score,1)}</strong></span></div>
          </div>
          ${Number.isFinite(Number(d.confidence)) ? progress("Release confidence", d.confidence, d.releaseStatus) : ""}
        `);
    }

    if (opts.show_release) {
        const notes = Array.isArray(d.release.notes) ? d.release.notes : [];
        html += section("Release Decision", `
          <div class="nova-release-box">
            <div class="nova-release-big">${badge(d.releaseStatus)}</div>
            <div class="nova-release-summary">${esc(d.release.summary || "")}</div>
            ${notes.length ? `<ul>${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
          </div>
        `);
    }

    return html;
}

function renderTechnical(p) {
    return `<pre class="nova-json">${esc(JSON.stringify(p, null, 2))}</pre>`;
}


function compareSigned(v, digits = 2, suffix = "") {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return `${n > 0 ? "+" : ""}${n.toFixed(digits)}${suffix}`;
}

function compareCell(label, src, mst, delta, unit = "", digits = 2, deltaDigits = 2) {
    return `
      <div class="nova-compare-cell nova-compare-label">${esc(label)}</div>
      <div class="nova-compare-cell nova-compare-value">${num(src,digits)}${esc(unit)}</div>
      <div class="nova-compare-cell nova-compare-value">${num(mst,digits)}${esc(unit)}</div>
      <div class="nova-compare-cell nova-compare-delta">${compareSigned(delta,deltaDigits,unit)}</div>`;
}

function compareTonalBar(label, value, klass) {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="nova-tonal-line ${klass}">
      <span>${esc(label)}</span>
      <div class="nova-tonal-track"><div class="nova-tonal-fill" style="width:${n}%"></div></div>
      <span class="nova-tonal-number">${pct(value,1)}</span>
    </div>`;
}

function renderCompare(payload, opts) {
    const d = deriveReport(payload);
    const s = d.source || {};
    const m = d.mastered || {};
    const tonalBands = get(payload, "correction.tonal.bands", {}) || {};

    let html = `
      <div class="nova-hero">
        <div>
          <div class="nova-kicker">${esc(d.title)}</div>
          <div class="nova-title">Source → Master Comparison</div>
          <div class="nova-subtitle">${d.version ? `v${esc(d.version)} · ` : ""}${esc(d.mode)}${d.profile ? ` · ${esc(d.profile)}` : ""}</div>
        </div>
        <div class="nova-release">
          ${badge(d.releaseStatus)}
          <div class="nova-grade">${esc(d.grade)}</div>
          <div class="nova-confidence">${num(d.confidence,1)} / 100</div>
        </div>
      </div>`;

    html += section("Core Metrics", `<div class="nova-compare-table">
      <div class="nova-compare-cell nova-compare-head">Metric</div>
      <div class="nova-compare-cell nova-compare-head">Source</div>
      <div class="nova-compare-cell nova-compare-head">Master</div>
      <div class="nova-compare-cell nova-compare-head">Change</div>
      ${compareCell("LUFS",s.integrated_lufs,m.integrated_lufs,Number(m.integrated_lufs)-Number(s.integrated_lufs),"",2,2)}
      ${compareCell("True Peak",s.true_peak_dbtp,m.true_peak_dbtp,Number(m.true_peak_dbtp)-Number(s.true_peak_dbtp)," dB",2,2)}
      ${compareCell("Sample Peak",s.sample_peak_dbfs,m.sample_peak_dbfs,Number(m.sample_peak_dbfs)-Number(s.sample_peak_dbfs)," dB",2,2)}
      ${compareCell("RMS",s.rms_dbfs,m.rms_dbfs,Number(m.rms_dbfs)-Number(s.rms_dbfs)," dB",2,2)}
      ${compareCell("Crest",s.crest_db,m.crest_db,Number(m.crest_db)-Number(s.crest_db)," dB",2,2)}
      ${compareCell("L/R Corr",s.lr_correlation,m.lr_correlation,Number(m.lr_correlation)-Number(s.lr_correlation),"",3,3)}
    </div>`);

    const bands = [["Bass","bass"],["Mid","mid"],["Presence","presence"],["HF","hf"]];
    html += section("Tonal Balance", bands.map(([label,key]) => {
        const b = tonalBands[key] || {};
        return `<div class="nova-tonal-row">
          <div class="nova-tonal-name">${label}</div>
          <div class="nova-tonal-bars">
            ${compareTonalBar("Source",b.source_percent,"nova-tonal-src")}
            ${compareTonalBar("Master",b.output_percent,"nova-tonal-master")}
            ${compareTonalBar("Target",b.target_percent,"nova-tonal-target")}
          </div>
          <div class="nova-tonal-number">
            ${compareSigned(b.measured_delta_percent,1," pp")}
            <br><span style="opacity:.62">EQ ${compareSigned(b.requested_db,2," dB")}</span>
            <br><span style="display:inline-block;margin-top:4px">${badge(b.status)}</span>
          </div>
        </div>`;
    }).join(""));

    const tonalStatus = get(payload,"classification.tonal_balance.status","—");
    const stereoStatus = get(payload,"correction.stereo.status",get(payload,"classification.stereo.status","—"));
    const crestStatus = get(payload,"classification.crest.status","—");
    const loudStatus = get(payload,"classification.loudness.status","—");
    const limiterBudget = get(payload,"validation.limiter_dependency.budget",get(payload,"correction.loudness.limiter_budget","—"));

    html += section("Processing Outcome", `<div class="nova-mini-grid">
      <div class="nova-mini-card">
        <div class="nova-mini-title">Tonal</div>
        <div class="nova-mini-line"><span>Status</span><span>${badge(tonalStatus)}</span></div>
        <div class="nova-mini-line"><span>Profile error</span><strong>${num(get(payload,"correction.tonal.profile_error_before"),2)} → ${num(get(payload,"correction.tonal.profile_error_after_candidate"),2)}</strong></div>
        <div class="nova-mini-line"><span>Error reduction</span><strong>${pct(get(payload,"classification.tonal_balance.adaptive.profile_error_reduction_percent"),1)}</strong></div>
      </div>
      <div class="nova-mini-card">
        <div class="nova-mini-title">Stereo</div>
        <div class="nova-mini-line"><span>Status</span><span>${badge(stereoStatus)}</span></div>
        <div class="nova-mini-line"><span>Image</span><strong>${esc(get(payload,"correction.stereo.source_classification","—"))} → ${esc(get(payload,"correction.stereo.output_classification","—"))}</strong></div>
        <div class="nova-mini-line"><span>Correlation</span><strong>${num(s.lr_correlation,3)} → ${num(m.lr_correlation,3)}</strong></div>
      </div>
      <div class="nova-mini-card">
        <div class="nova-mini-title">Dynamics / Crest</div>
        <div class="nova-mini-line"><span>Status</span><span>${badge(crestStatus)}</span></div>
        <div class="nova-mini-line"><span>Crest movement</span><strong>${compareSigned(Number(m.crest_db)-Number(s.crest_db),2," dB")}</strong></div>
        <div class="nova-mini-line"><span>Adaptive target</span><strong>${num(get(payload,"classification.crest.adaptive.target_db"),2)} dB</strong></div>
        <div class="nova-mini-line"><span>Convergence</span><strong>${pct(get(payload,"classification.crest.adaptive.convergence_percent"),1)}</strong></div>
      </div>
      <div class="nova-mini-card">
        <div class="nova-mini-title">Loudness / Limiter</div>
        <div class="nova-mini-line"><span>Status</span><span>${badge(loudStatus)}</span></div>
        <div class="nova-mini-line"><span>LUFS movement</span><strong>${compareSigned(Number(m.integrated_lufs)-Number(s.integrated_lufs),2," LU")}</strong></div>
        <div class="nova-mini-line"><span>Limiter GR</span><strong>${num(get(payload,"validation.limiter_dependency.gr_db"),2)} dB</strong></div>
        <div class="nova-mini-line"><span>Limiter budget</span><span>${badge(limiterBudget)}</span></div>
      </div>
    </div>`);

    html += section("Mastering Outcome", `<div class="nova-compare-note">${esc(d.release.summary || `Release decision: ${d.releaseStatus} at ${num(d.confidence,1)}/100 confidence.`)}</div>`);
    return html;
}

function renderReport(payload, opts) {
    if (!payload || typeof payload !== "object") return `<div class="nova-empty">No report data.</div>`;
    if (opts.view_mode === "Compare") return renderCompare(payload, opts);
    if (opts.view_mode === "Technical") return renderTechnical(payload);
    if (opts.view_mode === "Mastering Guide") return renderGuide(payload, opts);
    return renderDashboard(payload, opts);
}

function makeRoot() {
    const root = document.createElement("div");
    root.className = "nova-report-root";
    root.innerHTML = `<div class="nova-empty">Run the workflow to render the mastering report.</div>`;
    return root;
}

function applyTheme(root, theme, fontScale) {
    root.dataset.theme = theme || "Nova Dark";
    root.style.setProperty("--nova-font-scale", String(fontScale || 1));
}


function getNodeWidget(node, name) {
    return node?.widgets?.find?.(w => w?.name === name) || null;
}

function currentViewerOptions(node, fallback = {}) {
    const read = (name, def) => {
        const w = getNodeWidget(node, name);
        return w && w.value !== undefined ? w.value : (fallback[name] ?? def);
    };
    return {
        view_mode: String(read("view_mode", "Dashboard")),
        theme: String(read("theme", "Nova Dark")),
        font_scale: Number(read("font_scale", 1)) || 1,
        show_source: read("show_source", true) !== false,
        show_processing: read("show_processing", true) !== false,
        show_validation: read("show_validation", true) !== false,
        show_release: read("show_release", true) !== false,
    };
}

function renderCachedReport(node) {
    const root = node?.__novaReportRoot;
    const block = node?.__novaReportBlock;
    if (!root) return;

    // Frontend-only refresh: never queues ComfyUI or executes Python/upstream nodes.
    if (!block) {
        root.innerHTML = `<div class="nova-empty">No report data is cached in this viewer yet. Run the report once; view/theme/font changes then redraw locally. Apply View is an optional explicit refresh.</div>`;
        return;
    }

    const opts = currentViewerOptions(node, block);
    applyTheme(root, opts.theme, opts.font_scale);
    if (block.error) root.innerHTML = `<div class="nova-error">${esc(block.error)}</div>`;
    else root.innerHTML = renderReport(block.payload, opts);
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: EXT_NAME,

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "NovaMasterReportViewer") return;

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = originalCreated?.apply(this, arguments);

            this.size = this.size || [720, 760];
            if (this.size[0] < 640) this.size[0] = 720;
            if (this.size[1] < 520) this.size[1] = 760;

            const root = makeRoot();
            this.__novaReportRoot = root;
            this.__novaReportActive = false;
            this.__novaReportHeight = 72;
            this.__novaReportBlock = null;

            // Refresh only this viewer from its already received report payload.
            const loadViewButton = this.addWidget?.(
                "button",
                "Apply View",
                null,
                () => renderCachedReport(this),
                { serialize: false }
            );
            if (loadViewButton) {
                loadViewButton.name = "Apply View";
                loadViewButton.label = "Apply View";
                loadViewButton.tooltip = "Apply the selected report view/theme/font scale from cached data. Frontend only; does not execute the workflow.";
                this.__novaApplyViewButton = loadViewButton;
                // Nova Report Viewer standard: place Apply View above view_mode.
                const li = this.widgets?.indexOf(loadViewButton) ?? -1;
                const vi = this.widgets?.findIndex?.(w => w?.name === "view_mode") ?? -1;
                if (li >= 0 && vi >= 0 && li !== vi) {
                    this.widgets.splice(li, 1);
                    const target = this.widgets.findIndex(w => w?.name === "view_mode");
                    this.widgets.splice(Math.max(0, target), 0, loadViewButton);
                }
            }

            const widget = this.addDOMWidget?.(
                "nova_master_report",
                "NOVA_REPORT",
                root,
                {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => this.__novaReportActive ? 320 : 72,
                }
            );

            this.__novaReportWidget = widget;

            if (widget) {
                // computeSize reads only our stored viewport height. It never reads
                // node.size directly, preventing the old resize feedback loop.
                widget.computeSize = (width) => [
                    Math.max(320, width),
                    this.__novaReportActive ? Math.max(320, this.__novaReportHeight || 440) : 72
                ];

                root.style.height = `${this.__novaReportHeight}px`;
                root.style.minHeight = this.__novaReportActive ? "320px" : "72px";

                // Nodes 2.0 exposes setHeight() on DOM widgets. Use it when available.
                widget.setHeight?.(this.__novaReportHeight);
            }

            // Nova Report Viewer standard. These controls only redraw this DOM
            // viewer from the already cached report payload; they never queue ComfyUI.
            for (const name of ["view_mode", "theme", "font_scale", "show_source", "show_processing", "show_validation", "show_release"]) {
                const ctrl = this.widgets?.find?.(w => w?.name === name);
                if (ctrl && !ctrl.__novaLocalViewWrapped) {
                    const prior = ctrl.callback;
                    ctrl.callback = (value, ...args) => {
                        const out = prior?.call(ctrl, value, ...args);
                        requestAnimationFrame(() => renderCachedReport(this));
                        return out;
                    };
                    ctrl.__novaLocalViewWrapped = true;
                }
            }

            return r;
        };

        const originalResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = originalResize?.apply(this, arguments);

            const widget = this.__novaReportWidget;
            const root = this.__novaReportRoot;
            if (!widget || !root) return r;

            // widget.y is the actual layout position of the report area after the
            // regular controls. Subtracting that from the requested node height
            // gives the viewport's available height. This is stable: unlike the
            // old implementation, computeSize() never feeds node.size back into itself.
            const nodeHeight = Array.isArray(size)
                ? Number(size[1])
                : Number(size?.height ?? this.size?.[1]);

            const widgetTop = Number(widget.y);
            const top = Number.isFinite(widgetTop) && widgetTop > 0 ? widgetTop : 150;

            if (Number.isFinite(nodeHeight) && nodeHeight > 0) {
                const desired = this.__novaReportActive
                    ? Math.max(320, nodeHeight - top - 14)
                    : 72;

                if (Math.abs(desired - (this.__novaReportHeight || 0)) > 1) {
                    this.__novaReportHeight = desired;
                    root.style.height = `${desired}px`;
                    root.style.minHeight = this.__novaReportActive ? "320px" : "72px";

                    // New frontend API / Nodes 2.0.
                    widget.setHeight?.(desired);

                    // Classic LiteGraph redraw.
                    this.setDirtyCanvas?.(true, true);
                }
            }

            return r;
        };

        const originalExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = originalExecuted?.apply(this, arguments);
            const root = this.__novaReportRoot;
            if (!root) return r;

            try {
                const rawBlock = message?.nova_master_report_viewer;
                const block = Array.isArray(rawBlock) ? rawBlock[0] : rawBlock;

                if (!block) {
                    root.innerHTML = `<div class="nova-empty">No report payload returned.</div>`;
                    return r;
                }

                // A real report payload is now available. Expand the DOM widget
                // into the user-sized report viewport. Until this point the idle
                // placeholder stays compact and does not cover the node.
                this.__novaReportActive = true;
                const widget = this.__novaReportWidget;
                const nodeHeight = Number(this.size?.[1]);
                const widgetTop = Number(widget?.y);
                const top = Number.isFinite(widgetTop) && widgetTop > 0 ? widgetTop : 150;
                if (Number.isFinite(nodeHeight) && nodeHeight > 0) {
                    const desired = Math.max(320, nodeHeight - top - 14);
                    this.__novaReportHeight = desired;
                    root.style.height = `${desired}px`;
                    root.style.minHeight = "320px";
                    widget?.setHeight?.(desired);
                }

                // Cache the backend payload. View changes after this are local only.
                this.__novaReportBlock = block;

                // Prefer the values currently visible in the node widgets so a
                // restored workflow cannot show stale backend view settings.
                renderCachedReport(this);
            } catch (e) {
                root.innerHTML = `<div class="nova-error">${esc(e?.message || e)}</div>`;
            }

            return r;
        };
    },
});
