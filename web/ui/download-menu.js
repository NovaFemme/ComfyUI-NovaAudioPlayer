/**
 * download-menu.js — the format picker.
 *
 * Ported with its behaviour intact; the visual styling now comes from the
 * theme's panel.* roles rather than six hardcoded hex values, so the menu
 * matches whatever theme is active.
 */

const MENU_ID = "nova-dl-menu";

function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function fetchFormat(filename, fmt, extraQuery = "") {
    // download=1 asks for the attachment disposition. Without it the route
    // serves inline, which is what the player wants when it streams the same
    // file — see audioUrl() in audio-engine.js.
    const resp = await fetch(
        `/nova_player/audio/${encodeURIComponent(filename)}` +
        `?fmt=${fmt}&download=1${extraQuery}`,
    );
    if (!resp.ok) throw new Error(await resp.text());
    return resp.arrayBuffer();
}

// The three formats soundfile can write. mp3, m4a, opus and webm needed
// ffmpeg, and the subprocess call that reached it was removed for the registry
// — see nova_player/routes.py for the whole story.
const MIME = {
    wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg",
};

export function closeDownloadMenu() {
    document.getElementById(MENU_ID)?.remove();
}

export function isDownloadMenuOpen() {
    return !!document.getElementById(MENU_ID);
}

export function showDownloadMenu(filename, palette, clientX, clientY) {
    closeDownloadMenu();

    const menu = document.createElement("div");
    menu.id = MENU_ID;
    Object.assign(menu.style, {
        position: "fixed",
        left: "-9999px",
        top: "-9999px",
        background: palette.get("panel.surface"),
        border: `1px solid ${palette.get("panel.border")}`,
        borderRadius: "8px",
        padding: "4px 0",
        zIndex: "9999",
        minWidth: "190px",
        boxShadow: "0 4px 16px rgba(0,0,0,.5)",
        fontFamily: "sans-serif",
        fontSize: "13px",
    });

    const status = document.createElement("div");
    Object.assign(status.style, {
        padding: "4px 14px",
        color: palette.get("panel.text.dim"),
        fontSize: "11px",
        display: "none",
    });
    menu.appendChild(status);

    const addItem = (label, onClick) => {
        const item = document.createElement("div");
        item.textContent = "♪  " + label;
        Object.assign(item.style, {
            padding: "8px 14px",
            color: palette.get("panel.text"),
            cursor: "pointer",
            whiteSpace: "nowrap",
        });
        item.onmouseenter = () => { item.style.background = palette.alpha("panel.accent", 0.22); };
        item.onmouseleave = () => { item.style.background = ""; };
        item.onclick = onClick;
        menu.appendChild(item);
    };

    const addSeparator = (label) => {
        const sep = document.createElement("div");
        sep.textContent = label;
        Object.assign(sep.style, {
            padding: "6px 14px 2px",
            color: palette.get("panel.text.dim"),
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            borderTop: `1px solid ${palette.get("panel.border")}`,
            marginTop: "2px",
        });
        menu.appendChild(sep);
    };

    const asyncItem = (label, fmt, query = "", outName = null) => {
        addItem(label, async () => {
            status.style.display = "block";
            status.textContent = `Encoding ${fmt.toUpperCase()}…`;
            try {
                const buf = await fetchFormat(filename, fmt, query);
                triggerDownload(new Blob([buf], { type: MIME[fmt] }),
                                outName || `audio_output.${fmt}`);
                menu.remove();
            } catch (e) {
                status.textContent = "Error: " + e.message;
                setTimeout(() => menu.remove(), 3000);
            }
        });
    };

    addSeparator("Lossless");
    asyncItem("Download WAV", "wav");
    asyncItem("Download FLAC", "flac");

    addSeparator("Lossy");
    asyncItem("Download OGG (Vorbis)", "ogg");

    document.body.appendChild(menu);

    // Position after layout so the measured size is real.
    requestAnimationFrame(() => {
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let left = clientX - mw, top = clientY - mh;
        if (left < 4) left = clientX;
        if (top < 4) top = clientY + 4;
        left = Math.min(left, window.innerWidth - mw - 4);
        top = Math.min(top, window.innerHeight - mh - 4);
        menu.style.left = left + "px";
        menu.style.top = top + "px";
    });

    const close = (e) => {
        if (menu.contains(e.target)) return;
        menu.remove();
        document.removeEventListener("pointerdown", close, true);
    };
    document.addEventListener("pointerdown", close, true);
}
