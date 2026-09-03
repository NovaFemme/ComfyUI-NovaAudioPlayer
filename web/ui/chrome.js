/**
 * chrome.js — everything on the canvas that is not a visualiser.
 *
 * Info badge, clip LED, level meter, time labels, scrub bar, volume, transport
 * buttons, the view pill, the settings gear, the click ripple and the hover
 * glow. All of it reads colours from the palette, so a theme change repaints
 * the controls too, not just the visualisation.
 *
 * hitTest() is the single source of truth for what is under the pointer. The
 * original had the same geometry written twice — once in a _hitTest() used for
 * hover, and again as a chain of if-statements inside mouse() — so a control
 * could glow on hover and then not respond to a click.
 */

import { drawBar, drawGear, drawSpeaker, fmtTime, rr } from "../core/gfx.js";
import { getRenderer, measurePillWidth, modeRole } from "../renderers/registry.js";

const METER_BARS = 20;

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/**
 * What is at (mx, my)?
 * Returns a hover key, or null. Order matters: buttons win over the zones they
 * sit inside.
 */
export function hitTest(mx, my, L) {
    if (Math.hypot(mx - L.btnCX, my - L.btnCY) < L.playR + 4) return "play";
    if (Math.hypot(mx - L.skipBackCX, my - L.btnCY) < L.skipR + 4) return "skipBack";
    if (Math.hypot(mx - L.skipFwdCX, my - L.btnCY) < L.skipR + 4) return "skipFwd";
    if (Math.hypot(mx - L.loopCX, my - L.loopCY) < L.skipR + 4) return "loop";
    // Before the buttons: the grip band overlaps nothing, but it is a drag
    // target and must win over the visualisation behind it.
    if (L.benchOpen && L.benchGripTop != null &&
        my >= L.benchGripTop && my <= L.benchGripTop + L.benchGripH) return "benchGrip";
    if (L.benchBtnCX != null &&
        Math.hypot(mx - L.benchBtnCX, my - L.benchBtnCY) < L.benchBtnR + 4) return "bench";
    if (Math.hypot(mx - L.dlBtnCX, my - L.dlBtnCY) < L.dlBtnR + 4) return "download";
    if (L.hasGear && Math.hypot(mx - L.gearCX, my - L.gearCY) < L.gearR + 4) return "settings";

    if (mx >= L.viewBtnX - 45 && mx <= L.viewBtnX + 45 &&
        my >= L.btnCY - 10 && my <= L.btnCY + 10) return "view";

    if (Math.hypot(mx - L.spkX, my - L.spkY) < 12) return "speaker";
    if (my >= L.volY - 10 && my <= L.volY + 10 &&
        mx >= L.volX - L.knobR && mx <= L.volX + L.volW + L.knobR) return "volume";

    if (my >= L.scrubTop - 8 && my <= L.scrubTop + L.scrubH + 8 &&
        mx >= L.scrubX && mx <= L.scrubX + L.scrubW) return "scrub";

    if (my >= L.wfTop && my <= L.wfBottom &&
        mx >= L.wfX && mx <= L.wfX + L.totalW) return "visualisation";

    return null;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export function drawBackground(ctx, L, palette) {
    ctx.fillStyle = palette.get("surface");
    rr(ctx, 2, 2, L.w - 4, L.h - 4, 10);
    ctx.fill();
}

export function drawBadge(ctx, L, palette, data) {
    ctx.fillStyle = palette.get("text.dim");
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const lufs = data.lufs !== undefined ? `  ·  ${data.lufs} LUFS` : "";
    ctx.fillText(
        `${data.sample_rate} Hz · ${data.stereo ? "Stereo" : "Mono"}${lufs}`,
        10, 20,
    );
}

/**
 * The badge row for a node that has no audio yet.
 *
 * Same row, same type size, different content: the pack's name and a line that
 * changes every few seconds. A node sitting in the library is a shop window
 * before it is a tool, and an empty row there says nothing about what the
 * thing does.
 */
export function drawIdleBadge(ctx, L, palette, text) {
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = palette.get("text");
    ctx.font = "10px sans-serif";
    const name = "NOVA AUDIO PLAYER";
    ctx.fillText(name, 10, 20);

    ctx.fillStyle = palette.get("text.dim");
    ctx.font = "10px sans-serif";
    ctx.fillText(`  ·  ${text}`, 10 + ctx.measureText(name).width, 20);
}

/**
 * Clip indicator.
 *
 * Lives in the info-badge row, NOT inside the visualisation rect.
 *
 * It used to be centred vertically between the two waveform channels, which
 * reads fine over a waveform but is simply "somewhere in the middle of the
 * view" for every other renderer — so on the band views it landed on top of a
 * percentage readout, and on the spectrogram it sat over the field. The badge
 * row is chrome that no renderer draws into and whose right-hand half is
 * always free, so the indicator can never collide with content there however
 * many view modes get added.
 */
export function drawClipLed(ctx, L, palette) {
    ctx.save();
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Badge row: drawBadge() writes left-aligned at x = 10, baseline y = 20.
    const cy = 16;
    const x = L.w - L.padX;
    const dotR = 4;
    const led = palette.get("clip.led");

    ctx.shadowColor = led;
    ctx.shadowBlur = 8;
    ctx.fillStyle = led;
    ctx.beginPath();
    ctx.arc(x - dotR, cy, dotR, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = palette.get("clip.highlight");
    ctx.beginPath();
    ctx.arc(x - dotR * 1.2, cy - dotR * 0.25, dotR * 0.35, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 6;
    ctx.shadowColor = led;
    ctx.fillStyle = led;
    ctx.fillText("CLIP", x - dotR * 2 - 3, cy);
    ctx.restore();
}

export function drawMeter(ctx, L, palette, sig) {
    const segW = Math.floor((L.w - 16) / METER_BARS);
    const gap = 2;
    const y = L.meterY;

    const lit = {
        green: palette.get("meter.green.lit"),
        yellow: palette.get("meter.yellow.lit"),
        red: palette.get("meter.red.lit"),
    };
    const dim = {
        green: palette.get("meter.green.dim"),
        yellow: palette.get("meter.yellow.dim"),
        red: palette.get("meter.red.dim"),
    };

    for (let i = 0; i < METER_BARS; i++) {
        const x = 8 + i * segW;
        const zoneFrac = (i + 1) / METER_BARS;
        const barFrac = i / METER_BARS;
        const zone = zoneFrac < 0.65 ? "green" : zoneFrac < 0.85 ? "yellow" : "red";

        // Horizontal relief on a 3 px segment: shallow, but it is what makes a
        // lit segment read as a lamp rather than a painted rectangle.
        drawBar(ctx, x, y, segW - gap, 3,
                sig.levelL > barFrac ? lit[zone] : dim[zone],
                { vertical: false, radius: 1 });
        drawBar(ctx, x, y + 4, segW - gap, 3,
                sig.levelR > barFrac ? lit[zone] : dim[zone],
                { vertical: false, radius: 1 });
    }

    if (sig.peakHold > 0) {
        const idx = Math.max(0, Math.ceil(sig.peakHold * METER_BARS) - 1);
        const peakW = 6;
        const x = 8 + idx * segW + (segW - gap) - peakW;

        ctx.save();
        ctx.shadowColor = palette.get("meter.peak");
        ctx.shadowBlur = 6;
        ctx.fillStyle = palette.get("meter.peak");
        ctx.fillRect(x, y, peakW, 3);
        ctx.fillRect(x, y + 4, peakW, 3);
        ctx.restore();
    }
}

export function drawTimeLabels(ctx, L, palette, currentTime, duration, scrubbing) {
    ctx.fillStyle = palette.get("text");
    ctx.font = "11px monospace";
    ctx.textBaseline = "middle";

    ctx.textAlign = "left";
    ctx.fillText(fmtTime(currentTime, scrubbing), 13, L.timeY);

    ctx.textAlign = "right";
    ctx.fillText(fmtTime(duration), L.w - 15, L.timeY);
}

export function drawScrub(ctx, L, palette, progress) {
    ctx.fillStyle = palette.get("scrub.bg");
    rr(ctx, L.scrubX, L.scrubTop, L.scrubW, L.scrubH, L.scrubH / 2);
    ctx.fill();

    if (progress > 0) {
        ctx.fillStyle = palette.get("scrub.fill");
        rr(ctx, L.scrubX, L.scrubTop, L.scrubW * progress, L.scrubH, L.scrubH / 2);
        ctx.fill();
    }

    ctx.fillStyle = palette.get("scrub.fill");
    ctx.beginPath();
    ctx.arc(L.scrubX + L.scrubW * progress, L.scrubTop + L.scrubH / 2, 5, 0, Math.PI * 2);
    ctx.fill();
}

export function drawVolume(ctx, L, palette, volume, muted) {
    drawSpeaker(ctx, L.spkX, L.spkY, 7, muted,
                palette.get("text.dim"), palette.get("speaker.muted"));

    const vol = muted ? 0 : volume;

    ctx.fillStyle = palette.get("vol.track");
    rr(ctx, L.volX, L.volY - L.volH / 2, L.volW, L.volH, L.volH / 2);
    ctx.fill();

    ctx.fillStyle = palette.get("vol.fill");
    rr(ctx, L.volX, L.volY - L.volH / 2, L.volW * vol, L.volH, L.volH / 2);
    ctx.fill();

    ctx.fillStyle = palette.get("vol.knob");
    ctx.beginPath();
    ctx.arc(L.volX + L.volW * vol, L.volY, L.knobR, 0, Math.PI * 2);
    ctx.fill();
}

export function drawTransport(ctx, L, palette, { playing, looping }) {
    const icon = palette.get("btn.icon");

    // Play / pause
    ctx.fillStyle = playing ? palette.get("btn.active") : palette.get("btn.bg");
    ctx.beginPath();
    ctx.arc(L.btnCX, L.btnCY, L.playR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = icon;
    if (playing) {
        ctx.fillRect(L.btnCX - 6, L.btnCY - 7, 4, 14);
        ctx.fillRect(L.btnCX + 2, L.btnCY - 7, 4, 14);
    } else {
        ctx.beginPath();
        ctx.moveTo(L.btnCX - 5, L.btnCY - 8);
        ctx.lineTo(L.btnCX + 9, L.btnCY);
        ctx.lineTo(L.btnCX - 5, L.btnCY + 8);
        ctx.closePath();
        ctx.fill();
    }

    // Skip back  |<<
    ctx.fillStyle = palette.get("btn.bg");
    ctx.beginPath();
    ctx.arc(L.skipBackCX, L.btnCY, L.skipR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = icon;
    ctx.fillRect(L.skipBackCX - 5, L.btnCY - 4, 2, 8);
    triangle(ctx, L.skipBackCX + 2, L.btnCY, -4);
    triangle(ctx, L.skipBackCX + 6, L.btnCY, -4);

    // Skip forward  >>|
    ctx.fillStyle = palette.get("btn.bg");
    ctx.beginPath();
    ctx.arc(L.skipFwdCX, L.btnCY, L.skipR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = icon;
    triangle(ctx, L.skipFwdCX - 6, L.btnCY, 4);
    triangle(ctx, L.skipFwdCX - 2, L.btnCY, 4);
    ctx.fillRect(L.skipFwdCX + 3, L.btnCY - 4, 2, 8);

    // Loop
    ctx.fillStyle = looping ? palette.get("btn.active") : palette.get("btn.bg");
    ctx.beginPath();
    ctx.arc(L.loopCX, L.loopCY, L.skipR, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(L.loopCX, L.loopCY);
    ctx.strokeStyle = icon;
    ctx.fillStyle = icon;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 5, -Math.PI * 0.2, Math.PI * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(3, -5); ctx.lineTo(0, -2);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 5, Math.PI * 0.8, Math.PI * 1.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 8); ctx.lineTo(-3, 5); ctx.lineTo(0, 2);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // Download
    ctx.fillStyle = palette.get("btn.bg");
    ctx.beginPath();
    ctx.arc(L.dlBtnCX, L.dlBtnCY, L.dlBtnR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = icon;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("⬇", L.dlBtnCX, L.dlBtnCY + 1);

    // Settings
    if (L.hasGear) {
        ctx.fillStyle = palette.get("btn.bg");
        ctx.beginPath();
        ctx.arc(L.gearCX, L.gearCY, L.gearR, 0, Math.PI * 2);
        ctx.fill();
        drawGear(ctx, L.gearCX, L.gearCY, L.gearR * 0.72, icon);
    }
}

function triangle(ctx, x, cy, dir) {
    ctx.beginPath();
    ctx.moveTo(x, cy - 4);
    ctx.lineTo(x, cy + 4);
    ctx.lineTo(x + dir, cy);
    ctx.closePath();
    ctx.fill();
}

/**
 * The view-mode pill.
 * Label, colour and width all come from the registry, so a new renderer gets a
 * correctly-sized button with no edit here.
 */
export function drawViewPill(ctx, L, palette, viewMode) {
    const renderer = getRenderer(viewMode);
    const w = measurePillWidth(ctx, viewMode);
    const h = L.viewBtnH;

    ctx.fillStyle = palette.get(modeRole(viewMode));
    ctx.strokeStyle = palette.get("mode.border");
    ctx.lineWidth = 1;
    rr(ctx, L.viewBtnX - w / 2, L.btnCY - h / 2, w, h, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = palette.get("mode.text");
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(renderer.label, L.viewBtnX, L.btnCY);

    return w;
}

export function drawRipple(ctx, ripple) {
    if (!ripple || ripple.alpha <= 0) return false;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, 20 + (1 - ripple.alpha) * 40, 0, Math.PI * 2);
    ctx.strokeStyle = ripple.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = ripple.alpha;
    ctx.stroke();
    ctx.restore();

    ripple.alpha = Math.max(0, ripple.alpha - 0.05);
    return ripple.alpha > 0;
}

/**
 * Neon hover ring, drawn last so it always sits above the button it marks.
 * Stroke only — a fill would hide the icon underneath.
 */
export function drawHoverGlow(ctx, L, palette, hovered, { volume, muted, progress, viewPillW }) {
    if (!hovered || hovered === "visualisation") return;

    const glow = palette.get("hover.glow");
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 18;

    const ring = (cx, cy, r, alpha = 0.55, width = 2.5) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = palette.alpha("hover.glow", alpha);
        ctx.lineWidth = width;
        ctx.stroke();
    };

    switch (hovered) {
        case "play":     ring(L.btnCX, L.btnCY, L.playR + 2); break;
        case "skipBack": ring(L.skipBackCX, L.btnCY, L.skipR + 1); break;
        case "skipFwd":  ring(L.skipFwdCX, L.btnCY, L.skipR + 1); break;
        case "loop":     ring(L.loopCX, L.loopCY, L.skipR + 1); break;
        case "bench": ring(L.benchBtnCX, L.benchBtnCY, L.benchBtnR + 1); break;
        case "download": ring(L.dlBtnCX, L.dlBtnCY, L.dlBtnR + 1); break;
        case "settings": ring(L.gearCX, L.gearCY, L.gearR + 1); break;
        case "speaker":  ring(L.spkX, L.spkY, 10, 0.4, 1.5); break;
        case "view": {
            rr(ctx, L.viewBtnX - viewPillW / 2, L.btnCY - L.viewBtnH / 2,
               viewPillW, L.viewBtnH, 4);
            ctx.strokeStyle = palette.alpha("hover.glow", 0.55);
            ctx.lineWidth = 2;
            ctx.stroke();
            break;
        }
        case "volume": {
            const vol = muted ? 0 : volume;
            ring(L.volX + L.volW * vol, L.volY, L.knobR + 3);
            ctx.shadowBlur = 10;
            rr(ctx, L.volX, L.volY - L.volH / 2 - 1, L.volW, L.volH + 2, L.volH / 2 + 1);
            ctx.strokeStyle = palette.alpha("hover.glow", 0.28);
            ctx.lineWidth = 1.5;
            ctx.stroke();
            break;
        }
        case "scrub":
            ring(L.scrubX + L.scrubW * progress, L.scrubTop + L.scrubH / 2, 7);
            break;
    }

    ctx.restore();
}
