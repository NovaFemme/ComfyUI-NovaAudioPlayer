/**
 * bench-panel.js — the whole-file statistics strip below the transport.
 *
 * WHY THIS EXISTS
 *
 * The same take was being measured by several separate nodes that each used
 * their own band edges, their own peak convention and their own idea of what
 * counts as clipping, and they disagreed. This panel reads ONE set of numbers,
 * computed once in `nova_player/audio_io.compute_bench()` from the same
 * waveform tensor that produced the file, the waveform display and the loudness
 * badge. Everything on screen therefore describes the same audio.
 *
 * WHOLE-FILE, NOT LIVE. Every figure here covers the entire take and never
 * moves during playback. That is deliberate: peak, RMS and band shares are
 * properties of the render, and a rolling version of them would answer a
 * different question. The APG meter is the live instrument; this is the
 * bench sheet.
 *
 * Colours come from the same theme tokens as the rest of the player, so a
 * theme change restyles this panel with everything else and no colour here is
 * a literal.
 */

import { drawBar, fmtTime, scaled, textScale } from "../core/gfx.js";

/** dB values that are really "nothing", so they read as a dash rather than -120. */
const DB_FLOOR = -119;

/**
 * Rows are declared, not hand-drawn, so adding a measurement is one entry here
 * rather than another block of layout arithmetic.
 *
 * `warn` marks a row that should shout when the value is bad. It returns a
 * string (the reason) or null, and only the returned reasons are ever coloured
 * — nothing is styled red just for being a number.
 */
const STAT_ROWS = [
    {
        label: "PEAK",
        get: b => fmtDb(b.peak_db),
        warn: b => (b.peak_db > 0
            ? `+${b.peak_db.toFixed(2)} dB over full scale`
            : null),
    },
    { label: "RMS", get: b => fmtDb(b.rms_db) },
    { label: "CREST", get: b => (b.crest_db == null ? "—" : `${b.crest_db.toFixed(2)} dB`) },
    {
        label: "CLIPPED",
        get: b => (b.clipped_samples
            ? `${b.clipped_samples} (${b.clipped_pct.toFixed(4)}%)`
            : "none"),
        warn: b => (b.over_fs
            ? `${b.over_fs} samples clipped by the WAV write`
            : null),
    },
    {
        label: "L/R CORR",
        get: b => (b.lr_corr == null ? "mono" : b.lr_corr.toFixed(3)),
        warn: b => (b.lr_corr != null && b.lr_corr < 0
            ? "out of phase"
            : null),
    },
    { label: "DC", get: b => (b.dc_offset == null ? "—" : b.dc_offset.toFixed(5)) },
];

const BANDS = [
    { key: "BASS", role: "band.bass",     hint: "0–250" },
    { key: "MID",  role: "band.mid",      hint: "250–2k" },
    { key: "PRES", role: "band.presence", hint: "2k–6k" },
    { key: "HF",   role: "band.hf",       hint: "6k+" },
];

function fmtDb(v) {
    if (v == null || v <= DB_FLOOR) return "—";
    return `${v > 0 ? "+" : ""}${v.toFixed(2)} dBFS`;
}

function fmtBytes(n) {
    if (!n) return null;
    const u = ["B", "kB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/**
 * Draw the strip.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} L        layout (needs benchTop / benchH / w)
 * @param {object} palette
 * @param {object} data     the node payload: filename, duration, sample_rate,
 *                          stereo, lufs, bench
 * @param {boolean} hoverGrip whether the pointer is over the resize edge
 */
export function drawBenchPanel(ctx, L, palette, data, hoverGrip = false) {
    if (!L.benchOpen || !L.benchTop) return;

    const x = 0, y = L.benchTop, w = L.w, h = L.benchH;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    ctx.fillStyle = palette.get("bench.bg");
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = palette.get("bench.rule");
    ctx.fillRect(x, y, w, 1);

    // Grab handle: three short lines centred on the top edge, so the strip
    // reads as draggable rather than as a fixed band with a mystery cursor.
    const gw = 22, gx = Math.round(x + w / 2 - gw / 2);
    ctx.fillStyle = palette.get(hoverGrip ? "hover.glow" : "bench.heading");
    for (let i = 0; i < 3; i++) ctx.fillRect(gx + i * 8, y + 2, 5, 1.5);

    const pad = L.padX;
    const colGap = 24;
    const half = Math.floor((w - pad * 2 - colGap) / 2);
    const leftX = pad;
    const rightX = pad + half + colGap;

    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";

    // Row heights and column offsets track the text. Scaling the glyphs alone
    // would just make them collide with the rows above and below.
    const S = textScale();
    const rowH = Math.round(12 * S);
    const valX = Math.round(62 * S);
    const reasonX = valX + Math.round(108 * S);
    const infoX = Math.round(74 * S);

    let hy = y + scaled(12);
    ctx.textAlign = "left";
    ctx.fillStyle = palette.get("bench.heading");
    ctx.fillText("BENCH METRICS", leftX, hy);
    ctx.fillText("FILE", rightX, hy);

    ctx.fillStyle = palette.get("bench.rule");
    ctx.fillRect(leftX, hy + scaled(7), half, 1);
    ctx.fillRect(rightX, hy + scaled(7), w - rightX - pad, 1);

    const bench = (data && data.bench) || null;
    let ry = hy + scaled(18);

    // ---- left: measurements ------------------------------------------------
    if (!bench) {
        ctx.fillStyle = palette.get("bench.label");
        ctx.fillText("no measurements — re-run the node", leftX, ry + 4);
    } else {
        for (const row of STAT_ROWS) {
            const reason = row.warn ? row.warn(bench) : null;
            ctx.textAlign = "left";
            ctx.fillStyle = palette.get("bench.label");
            ctx.fillText(row.label, leftX, ry);

            ctx.fillStyle = reason ? palette.get("bench.warn") : palette.get("bench.value");
            ctx.fillText(row.get(bench), leftX + valX, ry);

            if (reason) {
                ctx.fillStyle = palette.get("bench.warn");
                ctx.fillText(`◂ ${reason}`, leftX + reasonX, ry);
            }
            ry += rowH;
        }

        // Band shares: a stacked bar reads faster than four numbers, and the
        // numbers are right there under it anyway.
        ry += scaled(3);
        const barY = ry, barH = Math.round(8 * S), barW = half;
        let cx = leftX;
        const total = BANDS.reduce((t, b) => t + (bench.bands?.[b.key] ?? 0), 0) || 100;
        for (const band of BANDS) {
            const pct = bench.bands?.[band.key] ?? 0;
            const seg = (pct / total) * barW;
            drawBar(ctx, cx, barY, Math.max(0, seg - 1), barH,
                    palette.get(band.role), { vertical: false });
            cx += seg;
        }

        ry = barY + barH + scaled(10);
        ctx.textAlign = "left";
        let lx = leftX;
        for (const band of BANDS) {
            const pct = bench.bands?.[band.key] ?? 0;
            drawBar(ctx, lx, ry - scaled(4), scaled(6), scaled(6),
                    palette.get(band.role), { radius: scaled(1.5) });
            ctx.fillStyle = palette.get("bench.label");
            ctx.fillText(`${band.key} ${pct.toFixed(1)}%`, lx + scaled(10), ry);
            lx += Math.max(scaled(76), half / 4);
        }

        if (bench.hf_outliers) {
            ry += rowH;
            ctx.fillStyle = palette.get("bench.label");
            ctx.fillText(`HF outliers >16 kHz: ${bench.hf_outliers}`, leftX, ry);
        }
    }

    // ---- right: file and audio --------------------------------------------
    const info = [];
    if (data) {
        if (data.filename) info.push(["FILE", data.filename]);
        info.push(["FORMAT", `${data.sample_rate || "?"} Hz · ` +
                             `${data.stereo ? "stereo" : "mono"}` +
                             (bench?.channels ? ` · ${bench.channels} ch` : "")]);
        info.push(["LENGTH", data.duration ? `${fmtTime(data.duration)} (${data.duration.toFixed(2)} s)` : "—"]);
        if (bench?.samples) {
            info.push(["SAMPLES", bench.samples.toLocaleString()]);
        }
        if (data.lufs != null) info.push(["LOUDNESS", `${data.lufs.toFixed(1)} LUFS`]);
        const size = fmtBytes(data.filesize);
        if (size) info.push(["SIZE", size]);
    }

    let iy = hy + scaled(18);
    const availW = w - rightX - pad;
    for (const [k, v] of info) {
        ctx.textAlign = "left";
        ctx.fillStyle = palette.get("bench.label");
        ctx.fillText(k, rightX, iy);
        ctx.fillStyle = palette.get("bench.value");
        ctx.fillText(clip(ctx, String(v), availW - infoX), rightX + infoX, iy);
        iy += rowH;
    }

    ctx.restore();
}

/** Trim to fit, with an ellipsis, so a long filename cannot run off the panel. */
function clip(ctx, text, maxW) {
    if (maxW <= 0 || ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo) + "…";
}

/** The toggle button in the transport row. */
export function drawBenchButton(ctx, L, palette, hover, open) {
    if (L.benchBtnCX == null) return;
    const cx = L.benchBtnCX, cy = L.benchBtnCY, r = L.benchBtnR;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = open ? palette.get("btn.active") : palette.get("btn.bg");
    ctx.fill();
    if (hover) {
        ctx.strokeStyle = palette.get("hover.glow");
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Three descending bars: a readable "statistics" mark at 20 px.
    ctx.fillStyle = palette.get("btn.icon");
    const bw = 2, gap = 2;
    const heights = [4, 7, 10];
    let bx = cx - (bw * 3 + gap * 2) / 2;
    for (const bh of heights) {
        ctx.fillRect(bx, cy + 5 - bh, bw, bh);
        bx += bw + gap;
    }
    ctx.restore();
}
