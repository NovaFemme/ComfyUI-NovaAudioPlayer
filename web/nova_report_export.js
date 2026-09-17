// Nova Report Capture — export every view of a Nova report viewer as an image.
//
// WHY IT WORKS THIS WAY
// ---------------------
// A report viewer draws itself with HTML and CSS. The only way an exported image
// can look EXACTLY like the viewer is for the viewer itself to be the renderer —
// so this rasterises the live DOM the viewer already built, with the viewer's own
// stylesheet, rather than redrawing the layout a second time somewhere else.
//
// It also touches none of the three viewer modules. Everything it needs is read
// off the node through ComfyUI's own APIs:
//
//   * the element          — the widget created by addDOMWidget carries `.element`
//   * the list of views    — the `view_mode` widget's own options.values
//   * the redraw           — the viewer's existing "Apply View" button callback,
//                            which is frontend-only and never queues a prompt
//
// Consequences worth knowing: adding a view mode to a viewer needs no change
// here, because the list is read from the node; and no viewer file is edited,
// so nothing this does can alter how the viewers behave when it is not running.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "NovaAudio.ReportCapture";

// Bump on every change. Printed at load so the version actually running in the
// browser can be read off the console instead of inferred — browser caching of
// /extensions/ has already cost more debugging time here than the bugs did.
const VERSION = "v15 tiled fallback";
console.info(`[Nova Report Capture] ${VERSION} loaded`);

// The report viewers. Adding one here is the only change a third needs.
const VIEWER_NODES = new Set([
    "NovaMasterReportViewer",
    "NovaTrackInspectorReportViewer",
]);

// Views deliberately not exported. "Technical" is a raw JSON dump — useful on
// screen, pointless as a picture, and it is what the user asked to skip.
const SKIP_VIEWS = new Set(["Technical"]);

const DEFAULTS = {
    width: 1200,      // CSS px. Fixed, so output never depends on node size on screen.
    scale: 1.5,       // device-pixel multiplier
    subfolder: "NovaAudioMasters/ReportImages",
};

// ---------------------------------------------------------------------------
// Reading the node
// ---------------------------------------------------------------------------

/** The DOM element a viewer rendered into, via ComfyUI's addDOMWidget contract. */
function viewerElement(node) {
    const w = node?.widgets?.find?.((x) => x && x.element instanceof HTMLElement);
    return w?.element || node?.__novaReportRoot || null;
}

function widgetByName(node, name) {
    return node?.widgets?.find?.((w) => w?.name === name) || null;
}

/** Every view this viewer offers, minus the skipped ones. Read from the node. */
function exportableViews(node) {
    const w = widgetByName(node, "view_mode");
    const values = w?.options?.values;
    const list = Array.isArray(values) ? values : (typeof values === "function" ? values() : []);
    return (list || []).map(String).filter((v) => !SKIP_VIEWS.has(v));
}

/**
 * Redraw the viewer for the currently selected view, without queueing a prompt.
 * Prefers the viewer's own "Apply View" button; falls back to the widget
 * callback, which every viewer wires to the same local refresh.
 */
function applyView(node, viewWidget) {
    const button = node?.widgets?.find?.(
        (w) => w?.type === "button" && /apply view/i.test(String(w?.name || ""))
    );
    if (button?.callback) { button.callback.call(node, button.value, app.canvas, node); return; }
    if (viewWidget?.callback) viewWidget.callback.call(node, viewWidget.value, app.canvas, node);
    node?.setDirtyCanvas?.(true, true);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

/**
 * What to actually rasterise, and which document owns its styles.
 *
 * write straight into their DOM widget. Cloning an iframe copies the element but
 * NOT a rendered page: a nested browsing context is never loaded when an SVG is
 * rasterised, so the capture came out as an empty box at the iframe's visible
 * height instead of the report at its full height.
 *
 * Reaching through to the iframe's own document fixes both: the content is real
 * DOM that clones, and its height is the content height rather than the
 * viewport's. A srcdoc document inherits its parent's origin, so contentDocument
 * is readable; if that ever changes, this falls back to the element itself
 * rather than throwing.
 */
function resolveCaptureTarget(element) {
    try {
        const frame = element.tagName === "IFRAME" ? element : element.querySelector("iframe");
        if (frame) {
            const doc = frame.contentDocument;
            if (doc && doc.body && doc.body.childElementCount) {
                return { source: doc.body, doc, framed: true };
            }
        }
    } catch { /* cross-origin: fall through to the element itself */ }
    return { source: element, doc: document, framed: false };
}

/**
 * Tokens that identify this viewer's own CSS, taken FROM THE ELEMENT.
 *
 * Deriving these rather than hardcoding a prefix is the whole point. v7 kept
 * only rules containing "nova", on the strength of one viewer that happened to
 * use `nova-*` class names. The Track Inspector uses `nti-*` for every class and
 * every custom property, so its entire stylesheet was dropped and the export
 * came out as unstyled black-on-black markup.
 *
 * Reading the class names actually present means a viewer added later works
 * without anyone remembering this function exists.
 */
function selectorTokens(element) {
    const tokens = new Set();
    const add = (cls) => {
        if (!cls) return;
        tokens.add(cls);
        const head = String(cls).split("-")[0];
        if (head && head.length >= 2) tokens.add(head);
    };
    try {
        element.classList.forEach(add);
        element.querySelectorAll("[class]").forEach((n) => n.classList.forEach(add));
    } catch { /* a missing token only costs styling, never the capture */ }
    return tokens;
}

/** True for a stylesheet this pack serves, whatever it happens to be named. */
function ownedByPack(sheet) {
    try {
        if ((sheet.href || "").includes("/extensions/comfyui-novaaudioplayer/")) return true;
        const node = sheet.ownerNode;
        if (node && node.tagName === "STYLE" && /nova|nti/i.test(String(node.id || ""))) return true;
    } catch { /* cross-origin ownerNode access */ }
    return false;
}

/**
 * The CSS this report needs — not every stylesheet on the page.
 *
 * ComfyUI's own sheets are large and irrelevant here, and pulling them in also
 * risks their global resets reshaping the clone. So a rule is kept when it
 * comes from one of this pack's stylesheets, or mentions a token the element
 * actually uses, or defines a font.
 *
 * Reading `cssRules` throws on a cross-origin sheet, so each is tried on its own
 * and a failure skips that sheet rather than the whole capture.
 */
function collectCss(tokens, doc) {
    const out = [];
    const own = doc && doc !== document;      // a srcdoc exists only for this report
    for (const sheet of Array.from((doc || document).styleSheets || [])) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        const mine = own || ownedByPack(sheet);
        for (const rule of Array.from(rules)) {
            const text = rule.cssText;
            if (!text) continue;
            if (mine || text.startsWith("@font-face")) { out.push(text); continue; }
            const lower = text.toLowerCase();
            for (const t of tokens) {
                if (lower.includes(t.toLowerCase())) { out.push(text); break; }
            }
        }
    }
    return out.join("\n");
}

/**
 * Copy every resolved CSS custom property onto the clone.
 *
 * Custom properties inherit, so a palette declared on an ancestor OUTSIDE the
 * cloned element - or on :root - is simply absent once the element is lifted
 * into the off-screen stage, and every var() silently falls back to its initial
 * value. That is what turned the export black: the text colour was var(--nti-text)
 * with nothing to resolve against.
 *
 * Taking the COMPUTED values means it does not matter where they were declared,
 * whether by a stylesheet, an inline style, or JavaScript.
 */
function inheritCustomProperties(source, clone, doc) {
    const copy = (from) => {
        if (!from) return;
        let style;
        try { style = getComputedStyle(from); } catch { return; }
        for (let i = 0; i < style.length; i++) {
            const name = style[i];
            if (!name || !name.startsWith("--")) continue;
            const value = style.getPropertyValue(name);
            if (value) {
                try { clone.style.setProperty(name, value); } catch { /* ignore one bad property */ }
            }
        }
    };
    const d = doc || document;
    copy(d.documentElement);
    copy(d.body);
    copy(source);                      // nearest wins, applied last
}

/**
 * Wrap CSS so an XML parser leaves it alone.
 *
 * SVG is XML, and XML has no special case for <style>: a bare `&` or `<` in a
 * stylesheet is a fatal parse error, which is exactly how this failed the first
 * time. CDATA suspends that, and the only sequence that can end a CDATA section
 * is `]]>`, so that one is broken up.
 */
function cdata(text) {
    return "<![CDATA[" + String(text).replace(/\]\]>/g, "]]]]><![CDATA[>") + "]]>";
}

/**
 * Rasterise an element to a PNG data URL at a fixed CSS width.
 *
 * The clone is laid out off-screen at `width`, so the picture is the same
 * whatever size the node happens to be on canvas, and the height is whatever
 * the content needs — no fixed canvas, so nothing is clipped and there is no
 * dead space below short reports.
 *
 * Serialisation goes through XMLSerializer because an SVG foreignObject must
 * contain well-formed XML; innerHTML markup frequently is not.
 */
// A computed backgroundColor is the STRING "rgba(0, 0, 0, 0)" when nothing is
// painted, which is truthy. Any `|| fallback` after it is dead code — that is
// exactly how every export came to be written onto a transparent canvas.
function isTransparent(colour) {
    if (!colour) return true;
    const c = String(colour).trim().toLowerCase();
    if (c === "transparent" || c === "none") return true;
    const inside = c.match(/^rgba?\(([^)]+)\)$/);
    if (!inside) return false;                       // a hex or named colour is opaque
    // Both legacy `rgba(r, g, b, a)` and modern `rgb(r g b / a)` land here; a
    // missing fourth component means rgb(), which is opaque by definition.
    const parts = inside[1].split(/[,\/\s]+/).filter(Boolean);
    if (parts.length < 4) return false;
    return parseFloat(parts[3]) === 0;               // white at zero alpha is still nothing
}

function opaqueBackground(start, doc) {
    // The DOM-widget wrapper is usually transparent; the colour lives on the
    // report root beneath it, where `background: var(--nti-bg)` resolves and
    // follows the chosen theme for free. So look DOWN first, then up, and only
    // then at the page. The literal is the last resort, never the usual answer.
    const d = doc || document;
    const framed = d !== document;
    const seen = [];
    if (start) {
        // Only descend in the un-framed case. When the report is an iframe the
        // capture source is already that document's <body>, which carries the
        // page colour; descending from there would pick some inner panel.
        if (!framed) {
            const root = start.querySelector?.(".nti-root, .nova-report-root, [data-theme]");
            if (root) seen.push(root);
        }
        seen.push(start);
        for (let p = start.parentElement; p; p = p.parentElement) seen.push(p);
    }
    if (d.body) seen.push(d.body);
    if (d.documentElement) seen.push(d.documentElement);
    for (const el of seen) {
        let colour;
        try { colour = getComputedStyle(el).backgroundColor; } catch { continue; }
        if (!isTransparent(colour)) return colour;
    }
    return "#0a0e14";
}

// Switching view_mode empties the container and refills it, and the refill is
// not guaranteed to finish inside one frame. Capturing on a fixed `nextFrame()`
// therefore photographed the emptied box, which is why only the view already on
// screen when the export started came out with anything in it.
function renderState(element) {
    let source = element;
    try { ({ source } = resolveCaptureTarget(element)); } catch { /* use the element */ }
    let kids = 0, height = 0, length = 0;
    try {
        kids = source.childElementCount || 0;
        height = source.scrollHeight || 0;
        length = (source.innerHTML || "").length;
    } catch { /* an unreadable frame simply never settles; the timeout covers it */ }
    return { key: `${kids}|${height}|${length}`, kids };
}

async function waitForRender(element, previousKey, timeoutMs = 2000) {
    const deadline = performance.now() + timeoutMs;
    let stableFor = 0;
    let lastKey = "";
    while (performance.now() < deadline) {
        await nextFrame();
        const { key, kids } = renderState(element);
        // An empty container is a render in progress, not a finished one.
        if (kids > 0 && key !== previousKey && key === lastKey) {
            if (++stableFor >= 2) return key;
        } else {
            stableFor = 0;
        }
        lastKey = key;
    }
    return renderState(element).key;   // proceed rather than abandon the export
}

async function rasterise(element, { width, scale, label, stripHeight }) {
    const { source, doc } = resolveCaptureTarget(element);
    // Resolved per view, from the capture source rather than the outer widget,
    // so a themed report and an iframed one both get their own page colour.
    const background = opaqueBackground(source, doc);
    const stage = document.createElement("div");
    stage.style.cssText =
        `position:fixed;left:-100000px;top:0;width:${width}px;` +
        `background:${background};pointer-events:none;z-index:-1;`;

    const clone = source.cloneNode(true);
    clone.style.width = `${width}px`;
    clone.style.maxWidth = "none";
    clone.style.height = "auto";
    clone.style.overflow = "visible";
    // Theme and font scale live on dataset/custom properties, not in the markup.
    if (element.dataset?.theme) clone.dataset.theme = element.dataset.theme;
    if (source !== element && source.dataset?.theme) clone.dataset.theme = source.dataset.theme;
    const fontScale = (source.style?.getPropertyValue?.("--nova-font-scale"))
                   || element.style?.getPropertyValue?.("--nova-font-scale");
    if (fontScale) clone.style.setProperty("--nova-font-scale", fontScale);
    // Must come after the theme attribute: a palette can be selected by it.
    inheritCustomProperties(source, clone, doc);

    stage.appendChild(clone);
    document.body.appendChild(stage);

    try {
        if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* non-fatal */ } }
        await nextFrame();

        const height = Math.max(1, Math.ceil(clone.scrollHeight || stage.scrollHeight));
        const xml = new XMLSerializer().serializeToString(clone);
        // No escaping needed here: the CSS goes inside CDATA, where the only
        // sequence with any meaning is ]]>, and cdata() handles that one.
        const css = collectCss(selectorTokens(source), doc);

        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
            `<foreignObject x="0" y="0" width="100%" height="100%">` +
            `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;background:${background}">` +
            `<style>${cdata(css)}</style>${xml}` +
            `</div></foreignObject></svg>`;

        // Parse it ourselves first. An <img> that fails to load an SVG reports
        // nothing but "error"; DOMParser names the line and the reason, which is
        // the difference between a fixable report and a shrug.
        // Printed for every view, because the two defects that produced blank
        // exports were both invisible in the image and obvious in these numbers.
        console.info(
            `[Nova Report Capture] ${label || "view"}: bg=${background} ` +
            `css=${css.length}B svg=${svg.length}B h=${height} kids=${clone.childElementCount}`);

        const probe = new DOMParser().parseFromString(svg, "image/svg+xml");
        const parseError = probe.querySelector("parsererror");
        if (parseError) {
            const detail = (parseError.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
            throw new Error(`the view produced invalid XML (${svg.length} bytes): ${detail}`);
        }

        // A data: URL, NOT a blob: URL.
        //
        // This looks like a detail and is not. In Chromium an SVG image loaded
        // from a blob: URL taints the canvas it is drawn onto, so the export
        // dies at toDataURL with "Tainted canvases may not be exported" — after
        // rendering perfectly. A data: URL is treated as same-origin and does
        // not taint, which is why every DOM-to-image library uses one. The size
        // ceiling that blob URLs avoid is not a problem here because collectCss
        // keeps the payload small.
        const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error(
                `the browser refused the rendered SVG (${svg.length} bytes, ` +
                `${css.length} bytes of CSS)`));
            img.src = url;
        });

        const deviceWidth = Math.round(width * scale);
        const deviceHeight = Math.round(height * scale);

        const paint = (target, offsetY) => {
            const ctx = target.getContext("2d");
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, target.width, target.height);
            // The report is always rendered at full size. Only the slice of it
            // that lands on this canvas changes, so a tiled export is pixel for
            // pixel the same picture as a whole-canvas one.
            ctx.setTransform(scale, 0, 0, scale, 0, -offsetY);
            ctx.drawImage(img, 0, 0);
        };

        if (!stripHeight || stripHeight >= deviceHeight) {
            const canvas = document.createElement("canvas");
            canvas.width = deviceWidth;
            canvas.height = deviceHeight;
            paint(canvas, 0);
            return { png: canvas.toDataURL("image/png") };
        }

        // Tiled fallback. A canvas this tall cannot be read back on this
        // machine, so it is read in bands that can be, and the server stitches
        // them. Nothing about the rendering changes.
        const strips = [];
        for (let y = 0; y < deviceHeight; y += stripHeight) {
            const band = Math.min(stripHeight, deviceHeight - y);
            const canvas = document.createElement("canvas");
            canvas.width = deviceWidth;
            canvas.height = band;
            paint(canvas, y);
            strips.push(canvas.toDataURL("image/png"));
        }
        console.info(
            `[Nova Report Capture] ${label || "view"}: tiled into ${strips.length} ` +
            `strips of ${stripHeight}px`);
        return { strips };
    } finally {
        stage.remove();
    }
}

// ---------------------------------------------------------------------------
// The export run
// ---------------------------------------------------------------------------

/**
 * Progress and results.
 *
 * There is deliberately no widget to write into — see the registration block for
 * why nothing is added to these nodes. Uses the frontend's toast when it exists
 * and the console otherwise, so this works across frontend versions without
 * assuming either is present.
 */
function toast(node, text, error) {
    const severity = error ? "error" : "info";
    try {
        const t = app?.extensionManager?.toast;
        if (t?.add) {
            t.add({ severity, summary: "Nova Report Capture", detail: text, life: error ? 8000 : 3000 });
        }
    } catch { /* toast is a convenience, never a requirement */ }
    if (error) console.error("[Nova Report Capture]", text, error);
    else console.info("[Nova Report Capture]", text);
}

/**
 * Nodes feeding this one, nearest first.
 *
 * Breadth-first so the CLOSEST loader wins when a graph has several — which is
 * the one whose audio this report is actually about.
 */
function upstreamNodes(node, maxDepth = 12) {
    const seen = new Set([node?.id]);
    const found = [];
    let frontier = [node];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
        const next = [];
        for (const n of frontier) {
            const count = n?.inputs?.length || 0;
            for (let i = 0; i < count; i++) {
                let origin = null;
                try { origin = n.getInputNode?.(i); } catch { /* unlinked slot */ }
                if (origin && !seen.has(origin.id)) {
                    seen.add(origin.id);
                    found.push(origin);
                    next.push(origin);
                }
            }
        }
        frontier = next;
    }
    return found;
}

/**
 * The name of the audio this report came from, for use as a filename prefix.
 *
 * The report payload itself cannot supply this — it carries a SHA-256 of the
 * source PCM under `identity`, but never the file's name. So the loader is
 * found by walking the graph instead.
 *
 * `file_path` is preferred over the `audio` dropdown because that is the
 * precedence Nova Load Audio itself applies: a non-empty file_path overrides
 * the dropdown, so reading the dropdown would name the export after a file that
 * was not the one loaded. Returns "" when nothing is found, and the caller
 * falls back to the node-type name.
 */
function sourceStem(node) {
    const widget = (n, name) => n?.widgets?.find?.((w) => w?.name === name);
    for (const n of upstreamNodes(node)) {
        const path = String(widget(n, "file_path")?.value ?? "").trim();
        const picked = String(widget(n, "audio")?.value ?? "").trim();
        const raw = path || picked;
        if (!raw) continue;
        const base = raw.split(/[\\/]/).pop();
        const stem = base.replace(/\.[^.]+$/, "").trim();
        if (stem) return stem;
    }
    return "";
}

/** A setting value, across both the old and new settings APIs. */
function setting(id, fallback) {
    try {
        const v = app?.extensionManager?.setting?.get?.(id);
        if (v !== undefined && v !== null) return v;
    } catch { /* fall through */ }
    try {
        const v = app?.ui?.settings?.getSettingValue?.(id, fallback);
        if (v !== undefined && v !== null) return v;
    } catch { /* fall through */ }
    return fallback;
}

// ---------------------------------------------------------------------------
// Canvas read-back probe
// ---------------------------------------------------------------------------
//
// Anti-fingerprinting protection blocks a page from reading its own canvas
// back. Firefox's `privacy.resistFingerprinting` does it SILENTLY when no
// prompt is shown: toDataURL still returns a valid PNG, of the right size, with
// every pixel transparent. Chromium-based browsers with tracker/fingerprint
// blocking behave the same way. Nothing throws, nothing is logged, and the
// rasteriser cannot tell — which is how a whole export run comes back blank and
// looks like a rendering bug for two days.
//
// So the export asks first, on a 2x2 canvas, and refuses to write files it
// already knows will be empty.
const PROBE_COLOUR = [13, 17, 23];
const isBlankPixel = (px) =>
    !px || px[3] === 0 || (px[0] === 0 && px[1] === 0 && px[2] === 0);

// Decodes a PNG the export just produced and reports whether it is entirely
// transparent. This is the check that cannot be fooled by a size threshold,
// because it inspects the real image at its real size rather than a stand-in.
// The PNG is drawn down into a small canvas to read it: small canvases are the
// ones protection tools leave alone, which is exactly why the sampling works.
async function pngIsBlank(dataUrl) {
    try {
        const img = new Image();
        const loaded = await new Promise((resolve) => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = dataUrl;
        });
        if (!loaded) return false;              // unreadable is a different fault
        const n = 48;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = n;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, n, n);
        const data = ctx.getImageData(0, 0, n, n).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
        return true;
    } catch {
        return false;                           // never block a save on the check
    }
}

// Candidate canvas heights, largest first. The first one that survives a read
// back is used; on a healthy browser that is the first entry and nothing below
// this line changes behaviour at all.
const STRIP_CANDIDATES = [1400, 1024, 768, 512, 384, 256, 192, 128, 96, 64];

async function canvasWorksAt(deviceWidth, deviceHeight) {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(deviceWidth);
        canvas.height = Math.round(deviceHeight);
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;
        ctx.fillStyle = `rgb(${PROBE_COLOUR.join(", ")})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const mid = ctx.getImageData(
            Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        if (isBlankPixel(mid)) return false;
        const url = canvas.toDataURL("image/png");
        if (!/^data:image\/png/i.test(url || "")) return false;
        return !(await pngIsBlank(url));
    } catch {
        return false;
    }
}

// The tallest canvas at this width whose pixels actually come back. Returns 0
// when nothing works, which is the only case that still refuses the export.
async function usableCanvasHeight(deviceWidth) {
    for (const height of STRIP_CANDIDATES) {
        if (await canvasWorksAt(deviceWidth, height)) return height;
    }
    return 0;
}

const READBACK_HELP =
    "Every exported image would be empty, so nothing was written. The report " +
    "on screen is never affected. The usual cause is the browser's " +
    "GPU-accelerated 2D canvas: small canvases stay in software and large ones " +
    "are promoted to the GPU, and on some Linux/AMD driver combinations the " +
    "read back from a GPU surface comes back empty. Firefox: open about:config " +
    "and set gfx.canvas.accelerated to false, then restart. Chromium and Opera: " +
    "open chrome://flags, set \"Accelerated 2D canvas\" to Disabled, then " +
    "relaunch. If that changes nothing, a privacy extension may be replacing " +
    "the canvas export instead - check " +
    "HTMLCanvasElement.prototype.toDataURL.toString() in the console, where " +
    "anything other than \"[native code]\" is a hook.";

async function exportViews(node) {
    const element = viewerElement(node);
    if (!element) { toast(node, "no rendered report found"); return; }

    const viewWidget = widgetByName(node, "view_mode");
    const views = exportableViews(node);
    if (!views.length) { toast(node, "this viewer offers no exportable views"); return; }

    const reference =
        sourceStem(node) ||
        `nova_${String(node.type || "report").replace(/^Nova/, "").toLowerCase()}`;

    const width = Number(setting("NovaAudio.ReportCapture.Width", DEFAULTS.width)) || DEFAULTS.width;
    const scale = Number(setting("NovaAudio.ReportCapture.Scale", DEFAULTS.scale)) || DEFAULTS.scale;
    const deviceWidth = Math.round(width * scale);
    const stripHeight = await usableCanvasHeight(deviceWidth);
    if (!stripHeight) {
        const why = `no canvas ${deviceWidth}px wide can be read back at any height`;
        toast(node, `cannot export: ${why}. ${READBACK_HELP}`, new Error(why));
        return;
    }
    const tiled = stripHeight < STRIP_CANDIDATES[0];
    if (tiled) {
        toast(node, `this browser can only read back ${stripHeight}px at a time, ` +
                    `so the export is being tiled - the images are unaffected`);
    }
    console.info(
        `[Nova Report Capture] ${VERSION} exporting ${views.length} views at ` +
        `${width}px x${scale}; usable canvas height ${stripHeight}px` +
        (tiled ? " (tiled)" : ""));
    const original = viewWidget ? viewWidget.value : null;
    const images = [];
    let settled = renderState(element).key;

    try {
        for (let i = 0; i < views.length; i++) {
            const view = views[i];
            toast(node, `rendering ${i + 1}/${views.length}: ${view}`);
            if (viewWidget) { viewWidget.value = view; applyView(node, viewWidget); }
            settled = await waitForRender(element, settled);
            const shot = await rasterise(element, { width, scale, label: view, stripHeight });
            // The last line of defence on this side. Whatever the probe decided,
            // an image with nothing in it is never written and never saved. A
            // single strip may legitimately be empty, so a tiled view is judged
            // on whether ANY strip carries pixels.
            if (shot.png) {
                if (await pngIsBlank(shot.png)) {
                    toast(node,
                        `cannot export: "${view}" rendered but came back as an ` +
                        `empty image. ${READBACK_HELP}`, new Error("blank render"));
                    return;
                }
                images.push({ view, png: shot.png });
            } else {
                const blankness = await Promise.all(shot.strips.map(pngIsBlank));
                if (blankness.every(Boolean)) {
                    toast(node,
                        `cannot export: "${view}" rendered but every strip came ` +
                        `back empty. ${READBACK_HELP}`, new Error("blank render"));
                    return;
                }
                images.push({ view, strips: shot.strips });
            }
        }
    } catch (err) {
        toast(node, `failed: ${err?.message || err}`, err);
        return;
    } finally {
        // Always put the viewer back the way the user left it, even on failure.
        if (viewWidget && original !== null) { viewWidget.value = original; applyView(node, viewWidget); }
    }

    toast(node, `saving ${images.length}…`);
    try {
        const res = await api.fetchApi("/nova_report_capture/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                reference,
                subfolder: DEFAULTS.subfolder,
                // Stamped by default: a re-master is a different master, and
                // silently overwriting the images of the previous one loses the
                // before. Turn the stamp off to keep one current set per track.
                overwrite: setting("NovaAudio.ReportCapture.Timestamp", true) === false,
                images,
            }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        toast(node, `saved ${data.count} to ${DEFAULTS.subfolder}`);
        console.info("[Nova Report Capture] saved:", data.saved.map((s) => s.path));
    } catch (err) {
        toast(node, `save failed: ${err?.message || err}`, err);
    }
}

// ---------------------------------------------------------------------------
// Registration — scoped to the viewer node types only, never the prototype
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
//
// NOTHING IS ADDED TO THE NODE. That is the whole point of this shape, and it
// was arrived at by breaking the viewers twice:
//
//   1. Widgets appended after the DOM widget made the node grow a tall empty
//      band, because the viewers' computeSize expects the DOM widget last.
//   2. Widgets anywhere on the node re-introduced the resize feedback loop the
//      viewers' own comment records having already fixed once — "computeSize
//      reads only our stored viewport height. It never reads node.size
//      directly, preventing the old resize feedback loop." Height we add is
//      height that calculation was written not to see.
//
// A context-menu entry has none of those failure modes: it changes no layout,
// takes no position in widgets_values, and leaves the node identical to how it
// looks with this extension uninstalled.

const MENU_LABEL = "Export views → images";

app.registerExtension({
    name: EXT_NAME,

    // Exposed in Settings rather than on the node, for the same reason.
    settings: [
        {
            id: "NovaAudio.ReportCapture.Scale",
            name: "Report export scale",
            tooltip: "Pixel multiplier. 1.5 gives a crisp image at a sensible file size.",
            type: "slider",
            attrs: { min: 0.5, max: 4, step: 0.5 },
            defaultValue: DEFAULTS.scale,
            category: ["Nova Audio", "Report Capture", "Scale"],
        },
        {
            // Deliberately NOT the old "Overwrite" id: that shipped defaulting
            // to true, and a stored value would have survived this change and
            // silently kept overwriting.
            id: "NovaAudio.ReportCapture.Timestamp",
            name: "Add a date-time stamp",
            tooltip: "On: <track>_<view>_YYYYMMDD-HHMMSS.png, so every export is kept. Off: <track>_<view>.png, and re-exporting replaces the previous set.",
            type: "boolean",
            defaultValue: true,
            category: ["Nova Audio", "Report Capture", "Timestamp"],
        },
        {
            id: "NovaAudio.ReportCapture.Width",
            name: "Report export width (px)",
            tooltip: "Layout width the report is rendered at. Height follows the content, so this sets the shape.",
            type: "number",
            attrs: { min: 400, max: 4000, step: 100 },
            defaultValue: DEFAULTS.width,
            category: ["Nova Audio", "Report Capture", "Width"],
        },
    ],

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!VIEWER_NODES.has(nodeData?.name)) return;

        // A visible hint in the TITLE BAR.
        //
        // A context menu is the safe place to put the action, but it is also
        // invisible — nothing on the node says the export exists. Drawing into
        // the title bar solves that without reopening the problem that put the
        // action in a menu to begin with: onDrawForeground paints onto the
        // canvas and contributes no height, so computeSize never sees it and
        // the viewers' sizing is untouched. The title bar specifically, because
        // the node body is covered by the DOM widget, which would hide it.
        const originalDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            const r = originalDraw?.apply(this, arguments);
            if (this.flags?.collapsed) return r;
            try {
                const count = exportableViews(this).length;
                if (!count) return r;
                const ready = !!viewerElement(this);
                ctx.save();
                ctx.font = "bold 10px system-ui, sans-serif";
                ctx.textAlign = "right";
                ctx.textBaseline = "middle";
                // Muted until there is something to export, so it reads as a
                // hint rather than a button that does nothing.
                ctx.fillStyle = ready ? "#7fb0ff" : "rgba(255,255,255,0.32)";
                const titleHeight = (window.LiteGraph?.NODE_TITLE_HEIGHT) || 30;
                ctx.fillText(`Right-click \u2192 Export ${count} views`,
                             this.size[0] - 12, -titleHeight / 2);
                ctx.restore();
            } catch { /* a hint must never break drawing the node */ }
            return r;
        };

        const original = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const r = original?.apply(this, arguments);
            try {
                const node = this;
                const views = exportableViews(node);
                const count = views.length;
                options.push({
                    content: count ? `${MENU_LABEL} (${count})` : MENU_LABEL,
                    disabled: !count || !viewerElement(node),
                    callback: () => { exportViews(node); },
                });
            } catch (err) {
                console.error("[Nova Report Capture] could not add the menu entry", err);
            }
            return r;
        };
    },
});
