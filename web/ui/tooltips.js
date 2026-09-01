/**
 * tooltips.js — a hint for whatever the pointer is resting on.
 *
 * Keyed on exactly the strings `chrome.hitTest()` returns, so a control that
 * can be hovered can be described, and one that cannot never gets a stale hint.
 * Adding a control means adding its key here; forgetting to just means no
 * tooltip, never a wrong one.
 *
 * Drawn on the canvas rather than as a DOM node or a `title` attribute. Two
 * reasons: a `title` cannot be themed and takes a second to appear, and a DOM
 * overlay would sit in the post-transform pixel space while everything else
 * here is pre-transform — the exact mix that broke every control under graph
 * zoom once already. Canvas text is in the same space as the button it labels.
 */

import { rr, textScale } from "../core/gfx.js";

/**
 * Hint for a hover key.
 *
 * @param {string} key    what hitTest() returned
 * @param {object} state  { playing, looping, muted, volume, viewLabel, benchOpen }
 * @returns {string|null} null means "no tooltip for this"
 */
export function tipFor(key, state = {}) {
    switch (key) {
        case "play":     return state.playing ? "Pause" : "Play";
        case "skipBack": return "Back 10 seconds";
        case "skipFwd":  return "Forward 10 seconds";
        case "loop":     return state.looping ? "Loop on — click to disable"
                                              : "Loop off — click to enable";
        case "view":     return `View: ${state.viewLabel || "?"} — click to cycle`;
        case "speaker":  return state.muted ? "Unmute" : "Mute";
        case "volume":   return `Volume ${Math.round((state.volume ?? 0) * 100)}%`;
        case "scrub":    return "Click or drag to seek";
        case "bench":    return state.benchOpen ? "Hide bench metrics"
                                                : "Show bench metrics";
        case "benchGrip":return "Drag to resize the bench strip";
        case "download": return "Download this audio";
        case "settings": return "Settings, colours and theme";
        // The visualisation is a seek target, not a control, and a hint that
        // follows the pointer across the whole display would be noise.
        default:         return null;
    }
}

/**
 * Draw the hint near the pointer, clamped inside the node.
 *
 * Called last in the frame so it sits above the hover glow and the bench strip.
 */
export function drawTooltip(ctx, L, palette, text, ptr) {
    if (!text || !ptr) return;

    const S = textScale();
    const padX = Math.round(7 * S);
    const padY = Math.round(5 * S);
    const font = `${Math.round(10 * S)}px sans-serif`;

    ctx.save();
    // Set the font before measuring, or the box is sized for the previous one.
    ctx.font = font;
    const tw = ctx.measureText(text).width;
    const boxW = Math.ceil(tw + padX * 2);
    const boxH = Math.ceil(12 * S + padY * 2);

    // Above the pointer by default: a box below it sits under the cursor and
    // covers the thing being described.
    const gap = Math.round(12 * S);
    let x = Math.round(ptr.x - boxW / 2);
    let y = Math.round(ptr.y - gap - boxH);

    // Clamp inside the node. Flipping below is only for a control near the top
    // edge, where there is no room above.
    const margin = 4;
    if (y < margin) y = Math.round(ptr.y + gap);
    x = Math.max(margin, Math.min(x, L.w - boxW - margin));
    y = Math.max(margin, Math.min(y, L.h - boxH - margin));

    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.get("tooltip.bg");
    rr(ctx, x, y, boxW, boxH, Math.round(4 * S));
    ctx.fill();

    ctx.strokeStyle = palette.get("tooltip.border");
    ctx.lineWidth = 1;
    rr(ctx, x + 0.5, y + 0.5, boxW - 1, boxH - 1, Math.round(4 * S));
    ctx.stroke();

    ctx.fillStyle = palette.get("tooltip.text");
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + padX, y + boxH / 2);
    ctx.restore();
}

/** How long the pointer must rest before a hint appears. */
export const TOOLTIP_DELAY_MS = 450;
