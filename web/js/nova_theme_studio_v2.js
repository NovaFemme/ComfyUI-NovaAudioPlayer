/**
 * Nova Theme Studio — Nodes 2.0 adapter.
 *
 * A SEPARATE FILE BECAUSE IT IS A DIFFERENT PROBLEM. The studio drives a
 * renderer whose behaviour has been measured: node bodies are painted on a
 * canvas from LiteGraph constants, and their alpha is discarded. Nodes 2.0
 * paints them as DOM from CSS, where alpha works normally and constants reach
 * nothing. Mixing the two in one file would put the working one at risk for the
 * sake of the new one; dropping this beside nova_theme_studio.js is enough for
 * it to be found, and deleting it is enough to be rid of it.
 *
 * IT DISCOVERS THE MARKUP RATHER THAN ASSUMING IT, and that is the whole design.
 * A beta's class names are not something to hard-code from a screenshot — this
 * pack already carries a comment about an afternoon lost to `getConnectionPos`
 * being reasoned about instead of measured. So instead of guessing a selector,
 * this converts a node's graph coordinates into screen coordinates, asks the
 * browser what element is actually at that point, walks up to the element whose
 * width matches the node's width, and builds its selector from what it finds.
 * Whatever Nodes 2.0 calls its node card, that is what gets styled.
 *
 * EVERYTHING IT DOES IS ONE <style> ELEMENT. Nothing is written onto node
 * objects, nothing is saved into a workflow, and `off()` removes the element.
 * A Vue renderer re-creates its DOM freely, which would wipe inline styles on
 * the next re-render; a stylesheet survives that, which is why it is done this
 * way rather than by setting styles on each card.
 *
 * ALPHA WORKS HERE. The classic renderer fills a node body opaquely and throws
 * the alpha away, so a glass finish has to mean `transparent` — the body simply
 * not drawn. CSS has no such limitation, so when a finish asks for glass this
 * gives the body a real low alpha instead, and the wallpaper shows through the
 * node rather than through a hole where the node used to be.
 */

const STYLE_ID = "nova-theme-studio-v2";
const LOG = "[Nova Theme Studio v2]";

// Classes that describe a node's STATE rather than what it is. Including them
// in the selector would style only the nodes that happen to be selected, or
// collapsed, or mid-drag.
const STATE_CLASS = /^(is-|has-|v-|.*-(selected|active|hover|dragging|collapsed|executing|error|pinned))$/i;
const STATE_WORDS = new Set([
    "selected", "active", "hover", "hovered", "dragging", "collapsed",
    "executing", "error", "pinned", "focused", "highlight", "highlighted",
]);

// How close an ancestor's width has to be to the node's width to be taken for
// the node's card. Generous enough for a border and a shadow, tight enough that
// a full-width container cannot pass for a node.
const WIDTH_TOLERANCE = 0.08;

let lastReport = null;
/** The page as it is WITHOUT this adapter: taken once, because taking it again
 *  means blanking the live stylesheet and letting the node flash. */
let baseline = null;
let applies = 0;

/* ----------------------------------------------------------- discovery -- */

/**
 * A node's pos / size, which are NOT plain arrays.
 *
 * LiteGraph keeps them in a Float32Array, and `Array.isArray` says no to one.
 * The studio's first probe on a real graph came back with no coordinates at all
 * for exactly this reason, and this file had inherited the same guard — it
 * would have reported "no element found at a node's position" on every node,
 * and looked like Nodes 2.0 hiding its markup rather than a typo here.
 */
const isPoint = (v) => !!v && typeof v === "object" && v.length >= 2 &&
    Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]));

function screenPointFor(node, canvas) {
    const ds = canvas?.ds;
    const el = canvas?.canvas;
    if (!ds || !el?.getBoundingClientRect) return null;
    if (!isPoint(node?.pos) || !isPoint(node?.size)) return null;

    const rect = el.getBoundingClientRect();
    const scale = Number(ds.scale) || 1;
    const off = isPoint(ds.offset) ? ds.offset : [0, 0];
    const w = Number(node.size[0]), h = Number(node.size[1]);
    return {
        x: (Number(node.pos[0]) + w / 2 + Number(off[0])) * scale + rect.left,
        // A little below the top edge: inside the body, clear of the title bar.
        y: (Number(node.pos[1]) + Math.min(28, h / 2) + Number(off[1])) * scale + rect.top,
        width: w * scale,
        scale,
    };
}

/**
 * The element that IS the node card.
 *
 * Hit-testing lands somewhere inside it — a widget row, a label — so the walk
 * goes upward and keeps the OUTERMOST ancestor whose width still matches the
 * node. Stopping at the first match would style an inner panel and leave the
 * card's own background showing around it.
 */
function findCard(point, node) {
    const stack = document.elementsFromPoint?.(point.x, point.y) || [];
    const slack = Math.max(8, point.width * WIDTH_TOLERANCE);
    // The node's own name, stripped to words so an emoji cannot spoil the
    // match. A DOM WIDGET is also parented at the node's width, so width alone
    // would happily return a panel; only the real card contains the title.
    const title = String(node?.title || "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const needle = title.slice(0, 14);

    let best = null;
    for (const hit of stack) {
        if (hit.tagName === "CANVAS" || hit.closest?.(".nts")) continue;
        for (let el = hit; el && el !== document.body; el = el.parentElement) {
            const r = el.getBoundingClientRect();
            if (r.width > point.width + slack) break;        // past the card now
            if (Math.abs(r.width - point.width) > slack) continue;
            if (needle && !(el.textContent || "").includes(needle)) continue;
            best = el;                                       // keep the outermost
        }
        if (best) break;
    }
    return best;
}

const usableClasses = (el) => [...(el.classList || [])].filter(
    (c) => !STATE_CLASS.test(c) && !STATE_WORDS.has(c.toLowerCase()));

/** Every on-screen node paired with the element drawing it. Re-run rather than
 *  cached: the renderer replaces a card's element whenever it re-renders it. */
function pairsFor(nodes, canvas, limit) {
    const seen = [];
    const out = [];
    for (const node of nodes) {
        if (out.length >= limit) break;
        const p = screenPointFor(node, canvas);
        if (!p) continue;
        const el = findCard(p, node);
        if (el && !seen.includes(el)) { seen.push(el); out.push({ node, card: el }); }
    }
    return out;
}

/**
 * A selector matching EVERY node card, not just the one that was sampled.
 *
 * Built from the INTERSECTION of several cards' class lists, because a compound
 * of one card's classes is a trap: measured on a real graph, the selected node
 * carried `outline-node-component-outline` and the others did not, so a
 * selector demanding all of them styled exactly one node and left the rest
 * untouched. Anything not present on every card is state or decoration.
 *
 * From what survives, a single short class naming a node beats a pile of
 * layout utilities — `.lg-node` rather than twelve Tailwind fragments — so the
 * rule stays readable and does not break when a utility changes.
 */
function describeCards(cards) {
    let common = null;
    for (const el of cards) {
        const set = new Set(usableClasses(el));
        common = common === null ? [...set] : common.filter((c) => set.has(c));
    }
    common = common || [];

    // A class that names the thing, with no Tailwind punctuation in it.
    const named = common
        .filter((c) => /node/i.test(c) && !/[()/:[\]&]/.test(c))
        .sort((a, b) => a.length - b.length);

    if (named.length) {
        return { selector: `.${CSS.escape(named[0])}`, by: "shared class", classes: common };
    }
    if (common.length) {
        return { selector: common.map((c) => `.${CSS.escape(c)}`).join(""), by: "shared classes", classes: common };
    }
    for (const attr of ["data-node-id", "data-nodeid", "data-id", "data-testid"]) {
        if (cards[0]?.hasAttribute?.(attr)) return { selector: `[${attr}]`, by: "attribute", classes: [] };
    }
    return { selector: null, by: "nothing distinctive", classes: [] };
}

/**
 * The surfaces inside a card that actually carry paint.
 *
 * Colouring the card alone is not enough: on a real node the card itself is
 * transparent and an inner element holds an OPAQUE background, which sits on
 * top and hides whatever the card was given. Those inner surfaces announce
 * themselves — a background utility class, `bg-something` — so they are found
 * by that shape rather than by name, and each is matched to a role by what its
 * own class says it is.
 */
// TWO ROLES, NOT THREE. A title role was tried and removed: in the markup this
// was measured against, the title row carries no background utility at all, so
// the role existed only to be guessed at — and it mis-caught the first widget
// pill, which is also small and also near the top. What the DOM actually
// distinguishes is a surface that fills the card and everything else.
const ROLE_RANK = { widget: 0, body: 1 };

function findSurfaces(cards) {
    const roles = new Map();     // class -> "widget" | "body"
    const edgeVotes = new Map(); // class -> how often it is the outermost body

    for (const card of cards) {
        const cr = card.getBoundingClientRect();
        if (!cr.height) continue;

        let outermost = null, outermostDepth = Infinity;
        for (const el of [card, ...card.querySelectorAll("*")]) {
            const classes = usableClasses(el).filter((c) => /^bg-[a-z0-9-]+$/i.test(c));
            if (!classes.length) continue;
            const r = el.getBoundingClientRect();
            if (!r.height) continue;

            // ROLE BY SIZE, NOT BY NAME. Reading the word out of the class is
            // the obvious approach and it is wrong here: the element carrying
            // `bg-node-component-header-surface` is not a header at all, it
            // wraps the ENTIRE node and is the surface the card's colour has to
            // go on. Treating it as a title bar painted the whole node in the
            // title colour. How much of the card an element fills does not lie.
            const role = (r.height / cr.height) >= 0.6 ? "body" : "widget";
            for (const c of classes) {
                // The same utility can appear on a big surface and a small one;
                // the largest role it is ever seen in is the one that counts.
                const prev = roles.get(c);
                if (!prev || ROLE_RANK[role] > ROLE_RANK[prev]) roles.set(c, role);
            }

            if (role === "body") {
                let depth = 0;
                for (let n = el; n && n !== card; n = n.parentElement) depth++;
                if (depth < outermostDepth) { outermostDepth = depth; outermost = classes[0]; }
            }
        }
        if (outermost) edgeVotes.set(outermost, (edgeVotes.get(outermost) || 0) + 1);
    }

    // THE EDGE GOES ON THE FACE OF THE NODE, NOT ON THE CARD BEHIND IT.
    //
    // An inset shadow on the outer card is painted under its children, and the
    // surfaces fill the card completely — so the line came out as a single
    // muted pixel that reads as a soft edge and not as a border. Measured at
    // the card's left edge: (56, 34, 72) where the border colour is
    // (67, 42, 86). Putting it on the outermost surface puts it on top, where
    // it can actually be seen, and that surface carries the rounded corners so
    // the line follows them.
    let edgeClass = null, best = 0;
    for (const [c, n] of edgeVotes) if (n > best) { best = n; edgeClass = c; }

    return { roles, edgeClass };
}

/* ------------------------------------------------------------- colours -- */

const isBlank = (v) => !v || v === "transparent" || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(v);

/**
 * What the body should be under a DOM renderer.
 *
 * A palette built for the canvas says `transparent` for a glass body, because
 * there the alpha would have been discarded and the only way to see through a
 * node was for it not to be painted. Here the alpha is honoured, so the finish's
 * intent is rebuilt as a real translucent colour and the node keeps its edges.
 */
function bodyColour(palette, ctx) {
    const declared = palette?.colors?.litegraph_base?.NODE_DEFAULT_BGCOLOR;
    if (!isBlank(declared)) return declared;

    const theme = ctx?.THEMES?.find((t) => t.id === ctx?.preset?.theme);
    const finish = ctx?.FINISHES?.find((f) => f.id === ctx?.preset?.finish);
    if (!theme || !ctx?.rgba) return "transparent";

    // Glass and frosted asked for "not painted"; here that becomes "barely
    // painted", which is what they would have asked for if they could.
    const alpha = finish?.body == null
        ? (finish?.id === "glass" ? 0.14 : 0.30)
        : finish.body;
    return ctx.rgba(theme.ink, alpha);
}

/** Widget pills. Same story as the body: `transparent` on the canvas meant
 *  "not painted", and here it can be a real wash instead. */
function widgetColour(palette, ctx) {
    const declared = palette?.colors?.litegraph_base?.WIDGET_BGCOLOR;
    if (!isBlank(declared)) return declared;
    const theme = ctx?.THEMES?.find((t) => t.id === ctx?.preset?.theme);
    if (!theme || !ctx?.rgba) return null;
    // Glass and Frosted declare no widget colour. A field still needs a box a
    // label can be read on, so it gets the theme's field colour as a wash:
    // dark enough to carry light text over a bright wallpaper, and still
    // see-through. 0.22 was tried first and left values unreadable over white.
    const finish = ctx?.FINISHES?.find((f) => f.id === ctx?.preset?.finish);
    return ctx.rgba(theme.field, finish?.id === "glass" ? 0.55 : 0.70);
}


/* --------------------------------------------------------- content fit --- */

/**
 * The DOM widgets on a node — asked for by handle, not hunted for by class.
 *
 * `addDOMWidget` keeps the element it was given on the widget object, so there
 * is no guessing to do here at all: the widget IS the element. That matters
 * because every pack in this repo names its own root differently (`nts`, `nsq`,
 * `nfp`), and any class-based search would have had to know all of them and
 * would still miss the next one.
 */
function widgetElements(node) {
    const out = [];
    for (const w of node?.widgets || []) {
        const el = w?.element;
        if (el && el.nodeType === 1) out.push(el);
    }
    return out;
}

/**
 * Why the content does not follow the node.
 *
 * On the classic renderer a DOM widget is positioned absolutely and its size is
 * written from `node.size` on every draw, so dragging the node's corner moved
 * the panel with it. Nodes 2.0 puts the element in normal flow inside a wrapper
 * of its own instead, and that wrapper is sized to the widget's declared height
 * — so making the node taller adds empty space below the content rather than
 * giving the content more room.
 *
 * The fix is to let the wrapper grow, which means finding it. It is found by
 * walking UP from the widget element, which is a handle we already hold, and
 * intersecting the wrappers' classes across every DOM widget on every sampled
 * node — the same technique the card selector uses, and for the same reason: a
 * single sample's class list describes that sample, not the markup.
 *
 * The selector is then CHECKED against the card before it is used. A wrapper
 * whose only shared class is something like `flex` would also match the title
 * row, and stretching the title row would be worse than doing nothing.
 */
/**
 * One selector for a set of elements that were found by walking.
 *
 * The intersection of their classes, then CHECKED: every element the selector
 * reaches inside a card has to be one of the elements it was built from. A set
 * whose only shared class is something like `flex` would also match the title
 * row, and a rule aimed at the title row is worse than no rule at all, so a
 * selector that over-reaches is refused rather than narrowed by guesswork.
 */
function sharedSelector(elements, cards, what) {
    if (!elements.length) return { selector: null, why: `no ${what} found` };

    let common = null;
    for (const el of elements) {
        const set = new Set(usableClasses(el));
        common = common === null ? [...set] : common.filter((c) => set.has(c));
    }
    if (!common || !common.length) return { selector: null, why: `the ${what} share no class` };

    const selector = common.map((c) => `.${CSS.escape(c)}`).join("");
    for (const card of cards) {
        for (const hit of card.querySelectorAll(selector)) {
            if (!elements.includes(hit)) {
                return { selector: null, why: `“${selector}” also matches something that is not ${what}` };
            }
        }
    }
    return { selector };
}

function findHosts(pairs) {
    const hosts = [];
    let widgets = 0;
    for (const { node, card } of pairs) {
        for (const el of widgetElements(node)) {
            if (el === card || !card.contains(el)) continue;
            widgets++;
            const parent = el.parentElement;
            if (parent && parent !== card) hosts.push(parent);
        }
    }
    if (!hosts.length) {
        return { widgets, selector: null,
                 why: widgets ? "the widget sits directly on the card"
                              : "no DOM widgets on the sampled nodes" };
    }
    const r = sharedSelector(hosts, pairs.map((p) => p.card), "a widget wrapper");
    return { widgets, selector: r.selector, why: r.why, hosts };
}

/**
 * Rules that let a DOM widget take the height the node was given.
 *
 * Three things have to happen together, or the panel stays its old size:
 *  - every ancestor between the card and the wrapper has to be allowed to grow,
 *    selected with `:has()` so they need no names of their own;
 *  - the wrapper itself grows and becomes a column, so its child has somewhere
 *    to grow into;
 *  - `min-height: 0` throughout, because a flex item refuses by default to
 *    shrink below its content — which is what pins a scrollable panel to its
 *    natural height and leaves the node with a gap underneath.
 *
 * `height: auto` is there for a wrapper the renderer has given an explicit
 * height: as a flex item that height would otherwise act as the basis it never
 * grows beyond.
 */
function fitRules(card, host, bang) {
    const i = bang ? " !important" : "";
    return [
        `${card} *:has(${host}) { flex: 1 1 auto${i}; min-height: 0${i}; }`,
        `${card} ${host} { flex: 1 1 auto${i}; min-height: 0${i}; height: auto${i};`,
        `  display: flex${i}; flex-direction: column${i}; }`,
        // `--nova-min-h` is the minimum a Nova widget host declares for itself
        // (web/core/vue-size.js). Zero for every other pack's widgets.
        `${card} ${host} > * { flex: 1 1 auto${i}; min-height: var(--nova-min-h, 0px)${i}; }`,
    ].join("\n");
}

/* ------------------------------------------- collapsing the top panel --- */

const BUTTON = "nova-v2-collapse";

/**
 * THE FOLDED STATE LIVES ON THE PANEL, NOT ON THE CARD, and that is the whole
 * point of this constant.
 *
 * A Vue renderer re-creates a node's card whenever it re-renders it — selecting
 * another node is enough. The first version marked the CARD as folded, so every
 * rebuild produced a card without the mark: the node sprang open, and the
 * observer only folded it again on its next tick. Reported as "another node
 * flashes when I click anything", which is exactly what it was.
 *
 * The node's own panel element is not Vue's. It belongs to the widget, it is
 * moved rather than rebuilt, and it is the same element the pinned-panel fix
 * already relies on staying put. Marking it and selecting the card with
 * `:has()` means the CSS is true again the instant the card exists — there is
 * no window in which the node is drawn unfolded, and no JavaScript in the path
 * at all.
 */
const FOLD_MARK = "nova-v2-folded";

/** Node ids whose top panel is folded away, so the state survives the renderer
 *  re-creating a card — which it does freely, taking our class with it. */
const collapsedIds = new Set();

/** What the last apply worked out about folding. The button's click handler
 *  needs it, and the handler outlives the call that made it. */
let foldPlan = { hostSel: null, levels: [], canvas: null };


/**
 * THE FOLDED STATE, AND NOTHING ELSE.
 *
 * Folding used to take the node's height down by whatever the hidden rows had
 * occupied, so the panel kept its size and the node got shorter. That is not
 * what was wanted: the node's footprint moving means everything around it on
 * the canvas appears to shift, and the point of folding here is to give the
 * panel the room, not to reclaim it.
 *
 * So folding now touches `node.size` not at all. The rows go, the panel grows
 * into the space they were using, and the bottom edge stays exactly where it
 * was. That removes the height bookkeeping, the remembered folded and open
 * heights, the suspended widget minimum and the floor a node could be crushed
 * onto — every one of which existed only to move a bottom edge that no longer
 * moves. Unfolding is the same in reverse: the rows come back and take their
 * room from the panel.
 *
 * A folded node is still freely resizable, and its height is just its height —
 * saved with the workflow like any other node's, with no special case.
 */

/**
 * THE ONE THING THIS ADAPTER WRITES INTO A WORKFLOW, and only because it was
 * asked for.
 *
 * Everything else here is a stylesheet and a class, so nothing it does can
 * change a saved file. Whether a node is folded cannot be inferred from what
 * IS saved — the height is the height either way — so without this a folded
 * node reopened expanded, with its contents crammed into a node sized for less.
 */
const FOLD_PROP = "novaFold";

/** The element the mark goes on: the node's own panel, inside this card.
 *  Vue moves that element into a rebuilt card rather than re-creating it, which
 *  is why the mark survives a rebuild when a mark on the card would not. */
function markTarget(node, card) {
    if (!card) return null;
    return widgetElements(node).find((el) => card.contains(el)) || null;
}

const isFolded = (node, card) =>
    !!markTarget(node, card)?.classList.contains(FOLD_MARK);

function saveFold(node, folded) {
    if (!node || node.id == null) return;
    try {
        node.properties = node.properties || {};
        node.properties[FOLD_PROP] = { folded: !!folded };
    } catch { /* a node that will not take a property is not worth failing over */ }
}

/** Nodes that were folded when the workflow was saved, folded again on open. */
function restoreFolds(pairs) {
    let restored = 0;
    for (const { node, card } of pairs) {
        if (!node?.properties?.[FOLD_PROP]?.folded) continue;
        if (node.id == null || collapsedIds.has(node.id)) continue;
        const mark = markTarget(node, card);
        if (!mark) continue;
        collapsedIds.add(node.id);
        mark.classList.add(FOLD_MARK);
        restored++;
    }
    return restored;
}

/**
 * WHERE A FOLDED NODE'S LINKS ATTACH — AND WHY NOTHING HERE TOUCHES THEM.
 *
 * There used to be a `getConnectionPos` wrapper here that pulled a folded
 * node's slots up to its top edge. It was written when folding made the node
 * SHORTER: the slots kept the offsets they were given while the node was open,
 * so a node folded from 548 to 116 units still reported an input 436 units
 * below its top and the links were drawn hanging into empty canvas.
 *
 * Two separate things have since made that wrapper wrong to keep.
 *
 * Folding no longer changes `node.size` at all, so a folded node's slots are
 * still inside it and there is nothing to correct.
 *
 * And the pack's own notes record that ComfyUI frontend 1.45 replaced
 * LiteGraph's slot layout: `getConnectionPos` still exists and still returns
 * whatever it is made to return, but it drives neither layout nor drawing —
 * nodes now carry `arrange()`, `_measureSlots()`, `drawSlots()` and per-slot
 * `boundingRect`. An override there is inert at best, and at worst disagrees
 * with the renderer about where a link attaches. Measured on a live node in
 * this pack, an override was returning two-column coordinates while the node
 * drew one column.
 *
 * So the adapter states its position plainly: a folded node's geometry is the
 * renderer's business, and this file changes no node's reported geometry.
 */

/** Fold or unfold one node: the mark, the record, and the links.
 *
 *  `persist` is what separates the user folding a node from the feature being
 *  switched off underneath them. Switching off has to unfold everything — there
 *  would be no button left to do it with — but it is not the user saying they
 *  want those nodes open, so it must not overwrite what the workflow remembers.
 *  Switch the feature back on and the nodes fold again. */
function setFolded(node, card, want, persist = true) {
    const mark = markTarget(node, card);
    if (node?.id != null) {
        if (want) collapsedIds.add(node.id); else collapsedIds.delete(node.id);
    }
    mark?.classList.toggle(FOLD_MARK, !!want);
    if (persist) saveFold(node, want);
    // The links are still drawn on the canvas and the slots have just moved.
    try { foldPlan.canvas?.setDirty?.(true, true); } catch { }
}


const titleNeedle = (node) =>
    String(node?.title || "").replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 14);

/**
 * The title row: the full-width row the node's name sits in.
 *
 * Not the element holding the text — that is usually a `<span>` partway across
 * the row, and a button appended to it would land in the middle of the title
 * rather than at the end of the bar. What is wanted is the deepest element that
 * still spans the card, which in a `justify-between` row puts an appended
 * button hard against the right edge with no positioning of our own.
 */
const TITLE_BAND = 48;   // how far below a card's top a title bar can begin

/**
 * Does this box hold the node's TITLE — as opposed to merely containing the
 * node's name somewhere inside it?
 *
 * The distinction is not pedantic. A panel that lists node names contains its
 * own node's name, so every box on the way down to that panel "contains the
 * title" by a plain text test. That wrongly identified the widget grid as the
 * box holding the title bar, and the fold stopped before it had folded
 * anything. A box that CONTAINS the panel is on the way to it, not the title.
 */
const holdsTitle = (el, needle, panels) =>
    !!needle && (el.textContent || "").includes(needle) &&
    !panels.some((p) => el === p || el.contains(p));

function findTitleRow(card, node) {
    const needle = titleNeedle(node);
    if (!needle) return null;
    const cr = card.getBoundingClientRect();
    if (cr.width < 1) return null;

    // THE NODE'S OWN PANEL IS NOT PART OF THE SEARCH, and leaving it in was a
    // real bug rather than a theoretical one. FlowPulse's panel lists every
    // node that ran — including itself — as a full-width table row, so "the
    // deepest full-width element containing the node's name" found that row and
    // put the fold button in the middle of the timings table. The table is
    // rebuilt four times a second, which destroyed the button, which woke the
    // observer, which put it back: the node visibly flashed the whole time.
    const panels = widgetElements(node).filter((el) => card.contains(el));
    const inPanel = (el) => panels.some((p) => p === el || p.contains(el));

    let best = null, bestDepth = -1;
    const walk = (el, depth) => {
        for (const child of el.children) {
            if (child.classList?.contains(BUTTON) || inPanel(child)) continue;
            const candidate = holdsTitle(child, needle, panels);
            if (!(child.textContent || "").includes(needle)) continue;
            const r = child.getBoundingClientRect();
            if (!candidate) { walk(child, depth + 1); continue; }
            // Full width, short, and at the TOP — a title bar is all three, and
            // the last of those is what any future look-alike will fail.
            if (Math.abs(r.width - cr.width) <= Math.max(8, cr.width * 0.12) &&
                r.height > 0 && r.height < Math.max(64, cr.width * 0.4) &&
                (r.top - cr.top) <= TITLE_BAND && depth > bestDepth) {
                best = child; bestDepth = depth;
            }
            walk(child, depth + 1);
        }
    };
    walk(card, 0);
    return best;
}

/**
 * WHAT "THE TOP PANEL" ACTUALLY IS, in markup terms.
 *
 * Everything between the title bar and the node's own panel: the slot rows and
 * the plain widgets. No class names that region, and there was no point
 * inventing one — it is defined by what it is NOT. Walking up from the DOM
 * widget gives the chain of boxes it lives in; at each level, the boxes BESIDE
 * that chain are the top panel, and they are what folds away.
 *
 * The walk stops at the level that holds the title, and that is the guard that
 * matters: the title row is a sibling of the node's body, so one level further
 * up, "everything beside the chain" would have taken the title bar with it —
 * and the button to unfold it.
 */
function collapseLevels(pairs) {
    const byDepth = [];
    for (const { node, card } of pairs) {
        const needle = titleNeedle(node);
        const widget = widgetElements(node).find((el) => card.contains(el));
        // THE WALK STARTS ONE BOX OUT. The box the widget sits directly in is
        // its wrapper, and folding "everything beside the panel" inside the
        // wrapper would fold the panel itself — measured, that is exactly what
        // happened: the slots stayed and the panel vanished.
        const start = widget?.parentElement;
        if (!start || start === card) continue;

        const panels = widgetElements(node).filter((el) => card.contains(el));
        let depth = 0;
        for (let a = start; a?.parentElement && a.parentElement !== card; a = a.parentElement) {
            const parent = a.parentElement;
            // The title lives in this box — stop before folding its neighbours.
            if ([...parent.children].some((c) => c !== a && holdsTitle(c, needle, panels))) break;
            (byDepth[depth] ||= []).push(parent);
            depth++;
        }
    }

    const out = [];
    for (let depth = 0; depth < byDepth.length; depth++) {
        const group = byDepth[depth];
        if (!group) continue;
        let common = null;
        for (const el of group) {
            const set = new Set(usableClasses(el));
            common = common === null ? [...set] : common.filter((c) => set.has(c));
        }
        if (!common?.length) continue;
        const selector = common.map((c) => `.${CSS.escape(c)}`).join("");

        // NOT THE SAME CHECK THE WRAPPER GETS, because this is not the same
        // kind of rule. A wrapper selector is refused when it reaches anything
        // beyond the wrappers, since it restyles whatever it touches. A fold is
        // scoped to one folded card and only ever hides children that do NOT
        // lead to the panel, so reaching the sibling rows of the same node is
        // the entire point. The one thing it must never reach is a box holding
        // the title bar — that would fold away the button that unfolds it.
        let safe = true;
        for (const { node, card } of pairs) {
            const needle = titleNeedle(node);
            if (!needle) continue;
            const panels = widgetElements(node).filter((el) => card.contains(el));
            for (const hit of card.querySelectorAll(selector)) {
                if ([...hit.children].some((c) => holdsTitle(c, needle, panels))) safe = false;
            }
        }
        // Depth 0 is the panel's OWN row, and it is treated differently — see
        // `collapseRules`, which folds every level's neighbours except that
        // one's.
        if (safe) out.push({ selector, depth });
    }
    return out;
}

function collapseRules(card, hostSel, levels) {
    if (!hostSel || !levels.length) return "";
    const out = [
        // SIZED TO BE FOUND. The first version was an 11px character at 55%
        // opacity with no margin, which put it inside the card's corner radius
        // — magnified from a screen recording it is a grey smudge three pixels
        // across, and it was reported twice as "no button". A 16px box, 80%
        // opacity and a gap from the edge make it a control rather than a mark.
        // A BIGGER TARGET, THE SAME SIZE GLYPH. The node is drawn at the
        // canvas's zoom, so a 16px control is 10px on screen at 64% — and
        // folding is most useful when zoomed out, which is exactly when it was
        // hardest to hit. Growing the chevron instead would make it heavy in a
        // title bar at 100%, so the padding grows the clickable box to 26px and
        // the negative margin keeps the row's own layout and the gap from the
        // edge exactly where they were.
        `.${BUTTON} { all: unset; cursor: pointer; flex: 0 0 auto;`,
        `  display: inline-flex; align-items: center; justify-content: center;`,
        `  box-sizing: border-box; width: 26px; height: 26px; flex-shrink: 0;`,
        `  padding: 0; margin: -5px 1px -5px 3px; border-radius: 6px;`,
        `  color: inherit; opacity: 0.8;`,
        `  transition: opacity .12s, background-color .12s, transform .12s; }`,
        `.${BUTTON}:hover { opacity: 1; background: rgba(128, 128, 128, 0.28);`,
        `  background: color-mix(in srgb, currentColor 22%, transparent); }`,
        // Down when open, right when folded — the disclosure arrow everyone
        // already knows, so the state is readable without a tooltip.
        `${card}:has(.${FOLD_MARK}) .${BUTTON} { transform: rotate(-90deg); }`,
    ];
    for (const { selector: level, depth } of levels) {
        // THE ROW TEMPLATE GOES. THE COLUMNS STAY.
        //
        // A grid row template is positional: hide the rows above the panel and
        // the panel inherits the track that used to belong to the first of
        // them. Measured on a grid whose last track was the flexible one, the
        // panel went from 338px to zero the moment its neighbours were folded.
        //
        // The first fix for that was to flatten these boxes to a flex column,
        // which has no positional tracks to inherit. It also has no COLUMNS,
        // and that was a bug: the real widget grid is
        // `grid-cols-[min-content_minmax(80px,min-content)_minmax(125px,1fr)]
        // pr-3` — its left inset is that first min-content track and its right
        // inset is padding. Flattening the box destroyed the track and kept the
        // padding, so a folded node's panel sat hard against its left border
        // with 13px still held on the right. Reported, measured, reproduced.
        //
        // Clearing just the row template does the original job without that
        // cost: there are no explicit row tracks left to inherit, the one
        // remaining item takes an implicit auto row, and `align-content:
        // stretch` grows that row into the height the folded rows freed. On a
        // level that is not a grid at all, both declarations are inert.
        out.push(`${card}:has(.${FOLD_MARK}) ${level}` +
                 ` { grid-template-rows: none !important;` +
                 ` grid-auto-rows: auto !important;` +
                 ` align-content: stretch !important; }`);
        // NOTHING IS HIDDEN INSIDE THE PANEL'S OWN ROW (depth 0), and that is
        // not a special case so much as the rule stated honestly: folding
        // reclaims HEIGHT, and everything in the panel's own row already shares
        // that row's height. Hiding the row's other cells frees nothing — and
        // it costs the panel its place. The real widget row is a subgrid whose
        // first cell holds the panel clear of the node's left edge; take that
        // cell out of the layout and the panel auto-places into column 1,
        // landing hard against the border and, in a three-column grid, coming
        // back narrower than it was. Both were measured.
        if (depth === 0) continue;

        // Everything beside the chain that leads to the node's own panel.
        //
        // `:not(${hostSel})` is not redundant next to the `:has()`. `:has()`
        // asks about DESCENDANTS and never matches the element itself, so the
        // wrapper — which IS the thing being kept — failed its own test and
        // was folded away with the rest. Both halves are needed: the box that
        // is the panel's wrapper, and any box that contains one.
        out.push(`${card}:has(.${FOLD_MARK}) ${level} > *:not(${hostSel}):not(:has(${hostSel}))` +
                 ` { display: none !important; }`);
    }
    return out.join("\n");
}

/** The button — created once per card, and put back if the renderer re-creates
 *  the title bar underneath it. Idempotent on purpose: it is called from a
 *  MutationObserver, and a version that rewrote attributes every time would
 *  keep waking the observer it is answering. */
function ensureButton(card, node, on) {
    // ALL OF THEM, NOT THE FIRST OF THEM.
    //
    // This used to ask `querySelector`, which answers with one button however
    // many there are. A second button could therefore never be found, never be
    // removed, and never be recognised as already present — so the next pass
    // added a third. Reported as the fold arrow appearing two or three times
    // in a title bar after a reload.
    //
    // A renderer that rebuilds a card while the observer is mid-pass can leave
    // a button behind in a detached row that is then re-attached, which is one
    // way a second arrives; rather than chase every such path, this counts what
    // is actually there and reduces it to one.
    const found = [...card.querySelectorAll(`.${BUTTON}`)];
    const keepOnly = (keep) => { for (const b of found) if (b !== keep) b.remove(); };

    if (!on) { keepOnly(null); return false; }

    const row = findTitleRow(card, node);
    // No title row RIGHT NOW is usually a card mid-rebuild, so the button is
    // left alone rather than flickering — but never more than one of it.
    if (!row) { keepOnly(found[0] || null); return found.length > 0; }

    const mine = found.find((b) => b.parentElement === row) || null;
    keepOnly(mine);
    if (mine) return true;

    const b = document.createElement("button");
    b.className = BUTTON;
    b.type = "button";
    // A DRAWN CHEVRON, NOT A CHARACTER. `▾` renders at whatever size and weight
    // the node's font gives it, which here was a three-pixel smudge; a stroked
    // path is the same crisp shape at any font, and takes the title colour
    // through `currentColor` so it still belongs to the theme.
    b.innerHTML =
        '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
        '<path d="M3 4.5 L6 8 L9 4.5" fill="none" stroke="currentColor" ' +
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.title = "Fold the slots and widgets away, keeping this node's own panel";
    // Not a node drag, and not a click that reaches the canvas underneath.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const now = !isFolded(node, card);
        setFolded(node, card, now);
        // The links are still drawn on the canvas and their ends have just
        // moved; without this they stay where the slots used to be.
        try { (foldPlan.canvas || window.app?.canvas)?.setDirty?.(true, true); } catch { }
    });
    row.appendChild(b);
    return true;
}

/** Put the button and the folded state back on every card that should have
 *  them. Cheap, idempotent, and safe to call from an observer. */
/** One button per row, everywhere on the page.
 *
 *  `ensureButton` keeps the cards it is given to one button each, but it only
 *  ever sees the cards in `pairs` — the nodes on screen. A card that has
 *  scrolled out of view, or one the renderer left behind, is never visited and
 *  can keep a duplicate indefinitely, ready to be seen again the moment it
 *  scrolls back. Grouping by the row itself needs no selector and no knowledge
 *  of which card anything belongs to. */
function dedupeButtons() {
    const rows = new Set();
    for (const b of document.querySelectorAll(`.${BUTTON}`)) {
        if (b.parentElement) rows.add(b.parentElement);
    }
    let removed = 0;
    for (const row of rows) {
        const inRow = row.querySelectorAll(`:scope > .${BUTTON}`);
        for (let i = 1; i < inRow.length; i++) { inRow[i].remove(); removed++; }
    }
    return removed;
}

function decorate(pairs, on) {
    if (on) restoreFolds(pairs);
    let buttons = 0;
    for (const { node, card } of pairs) {
        const hasPanel = widgetElements(node).some((el) => card.contains(el));
        if (ensureButton(card, node, on && hasPanel)) buttons++;
        // Normally a no-op: the mark is on an element the renderer does not
        // rebuild, so it is still right. Kept as a belt-and-braces
        // reconciliation for the day a panel element IS replaced.
        const want = !!(on && hasPanel && node?.id != null && collapsedIds.has(node.id));
        const mark = markTarget(node, card);
        if (mark && mark.classList.contains(FOLD_MARK) !== want) {
            mark.classList.toggle(FOLD_MARK, want);
        }
    }
    dedupeButtons();
    return buttons;
}

/**
 * Re-decorating after the renderer rebuilds a card.
 *
 * A Vue renderer owns this DOM and re-creates it whenever it likes, taking the
 * button and the folded class with it. Watching for that is the only way a
 * button added from outside stays added. The callback is debounced and does
 * nothing when nothing has changed, so it cannot chase its own mutations.
 */
let unobserve = null;
function watchCards(getPairs, isOn) {
    if (unobserve) return;
    const OPTS = { childList: true, subtree: true };
    let timer = null;
    const ob = new MutationObserver(() => {
        if (timer) return;
        // SHORT, because all this has left to do is put the button back — the
        // folded state itself is carried by CSS off an element the renderer
        // does not rebuild, so nothing about the layout is waiting on this.
        timer = setTimeout(() => {
            timer = null;
            if (!unobserve) return;
            // DEAF WHILE IT WORKS. Re-adding a button is itself a mutation, and
            // an observer that hears its own edits wakes itself forever.
            ob.disconnect();
            try { decorate(getPairs(), isOn()); } catch { /* mid-rebuild */ }
            if (unobserve) ob.observe(document.body, OPTS);
        }, 32);
    });
    ob.observe(document.body, OPTS);
    unobserve = () => { ob.disconnect(); if (timer) clearTimeout(timer); };
}

/** Everything folded, put back. Switching the feature off with nodes still
 *  folded would otherwise leave them showing only a panel, with no button to
 *  bring the rest back. The workflow's record of which nodes were folded is
 *  deliberately left alone, so switching the feature on again restores them. */
function undecorate(pairs = []) {
    for (const { node, card } of pairs) {
        if (isFolded(node, card)) setFolded(node, card, false, false);
    }
    for (const b of document.querySelectorAll(`.${BUTTON}`)) b.remove();
    for (const c of document.querySelectorAll(`.${FOLD_MARK}`)) c.classList.remove(FOLD_MARK);
    collapsedIds.clear();
}


/* ------------------------------------------------- the pinned panel --- */

const FILL_CLASS = "nova-v2-fill";

/**
 * THE REAL REASON THE CONTENT DOES NOT FOLLOW THE NODE — and it is ours.
 *
 * Every Nova node builds its DOM widget the same way: a pass-through host at
 * 100%/100%, and inside it the visible panel, positioned ABSOLUTELY with a
 * width and a height in pixels. Those two numbers are then rewritten from
 * `node.size` on every `onDrawForeground`, which is how the panel used to
 * follow the node — and `onDrawForeground` is a canvas-renderer idea. Under
 * Nodes 2.0 there is no such pass, so the panel keeps the size it was born
 * with: measured here, 54% of the node's width and 49% of its height on a node
 * that had been dragged larger, which is exactly the gap in the screenshots.
 *
 * It also explains why every flex and grid rule aimed at the wrapper did
 * nothing at all. An absolutely-positioned box with a pixel width is out of
 * flow: `flex: 1`, `align-self: stretch` and a `1fr` track have no reach into
 * it. Measured, all five of those candidates left the panel at 54% × 49%.
 *
 * `inset: 0` with `width: auto` and `height: auto` gives the panel the host's
 * full box instead of its remembered one — 100% × 100% in the same test.
 *
 * The panel is found by what it IS rather than by what it is called: a child of
 * a DOM widget element, absolutely positioned, carrying an inline pixel size.
 * `.nts`, `.nsq` and `.nfp` would all have had to be listed by name otherwise,
 * and the next pack would have been missed.
 */
/**
 * The panel inside a DOM widget host — and NOT the pop-out beside it.
 *
 * The host exists to be a positioning context, so its absolutely-positioned
 * children are the panel and whatever floats over it: this pack's nodes put a
 * custom pop-out in there too. Stretching a pop-out to `inset: 0` would blow it
 * up to the size of the node the moment it opened, so the panel is taken as the
 * LARGEST one that is currently drawn. A closed pop-out has no box at all and
 * is skipped; an open one is smaller than the panel it sits on.
 */
function pinnedChild(el) {
    let best = null, area = 0;
    for (const child of el.children || []) {
        if (getComputedStyle(child).position !== "absolute") continue;
        const r = child.getBoundingClientRect();
        const a = r.width * r.height;
        if (a <= 0 || a < area) continue;
        best = child; area = a;
    }
    return best;
}

function markPinned(nodes) {
    let found = 0, marked = 0;
    for (const node of nodes) {
        for (const el of widgetElements(node)) {
            const child = pinnedChild(el);
            if (!child) continue;
            found++;
            if (!child.classList.contains(FILL_CLASS)) { child.classList.add(FILL_CLASS); marked++; }
        }
    }
    return { found, marked };
}

function unmarkPinned() {
    for (const el of document.querySelectorAll(`.${FILL_CLASS}`)) el.classList.remove(FILL_CLASS);
}

/** ALWAYS `!important`, and this is the one place that is right. What it has to
 *  outrank is an INLINE style — the width and height written onto the element
 *  by the node's own code — and no ordinary rule outranks an inline one. */
const pinnedRule = () =>
    `.${FILL_CLASS} { position: absolute !important; inset: 0 !important;` +
    ` width: auto !important; height: auto !important; }`;

/** The face of a DOM widget: the pinned panel if there is one, since that is
 *  the part with the wrong size. Measuring the host instead would read 100%
 *  and report success while the panel sat at half the node's width. */
function visibleFace(el) {
    return el.querySelector(`.${FILL_CLASS}`) || pinnedChild(el) || el;
}

/** How much of the card the content actually reaches, across and down, 0..1.
 *  The number this returns is the whole point of the exercise, so it is
 *  measured rather than assumed — and it decides whether the rules worked. */
function fillRatio(pairs) {
    let w = 1, h = 1;
    for (const { node, card } of pairs) {
        const cr = card.getBoundingClientRect();
        if (cr.height < 1 || cr.width < 1) continue;
        for (const el of widgetElements(node)) {
            if (!card.contains(el)) continue;
            const r = visibleFace(el).getBoundingClientRect();
            if (!r.width && !r.height) continue;
            w = Math.min(w, r.width / cr.width);
            h = Math.min(h, (r.bottom - cr.top) / cr.height);
        }
    }
    return { w, h, worst: Math.min(w, h) };
}

const pct = (f) => `${Math.round(f.w * 100)}% x ${Math.round(f.h * 100)}%`;

/**
 * A node added AFTER the theme was applied.
 *
 * The colours and the edge need no help — they are a stylesheet, and a new card
 * matches it the moment it exists. The pinned panel does: it is found by
 * measuring the element, so a node that did not exist when the measuring
 * happened has a panel nobody has looked at. The graph is hooked once, and the
 * hook is put back exactly as it was by `off()` — including when something else
 * has hooked it since, in which case ours is left in place rather than tearing
 * out whatever wrapped it.
 */
let unwatch = null;
function watchNodes(graph) {
    if (!graph || unwatch) return;
    const prev = graph.onNodeAdded;
    const mine = function (node) {
        const r = prev?.apply(this, arguments);
        // LATE, AND MORE THAN ONCE. The renderer has not built this node's DOM
        // when the graph says it has arrived, and a node whose panel is built
        // on a later frame — which is how this pack builds them, deliberately,
        // so the widget exists before the node is sized — is not there to be
        // measured on the first look either. The first look that finds it
        // cancels the rest.
        let done = false;
        for (const wait of [50, 200, 600, 1500]) {
            setTimeout(() => {
                if (done || !unwatch) return;              // found, or off() since
                try { if (markPinned([node]).found) done = true; } catch { /* gone */ }
            }, wait);
        }
        return r;
    };
    graph.onNodeAdded = mine;
    unwatch = () => { if (graph.onNodeAdded === mine) graph.onNodeAdded = prev; };
}


/* -------------------------------------------------------------- apply --- */

function sheet() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
    }
    // MOVED TO THE END OF <head> ON EVERY APPLY. Between two rules of equal
    // weight the later one wins, so a stylesheet the renderer adds after this
    // one — on a lazy-loaded chunk, say — would quietly outrank it even with
    // !important on both sides. Re-appending costs nothing and settles ties.
    document.head.appendChild(el);
    return el;
}

/** Where the edge line has to be drawn, and how round it is.
 *
 *  Measured, not assumed. Two things had to be established on the real markup:
 *
 *  - Whether an absolutely-positioned `::after` on the card will be contained
 *    by the card. It is, as long as the card establishes a containing block —
 *    which it does when it is not statically positioned. Nodes 2.0 places the
 *    cards itself, so in practice they already are; the check is there so that
 *    `position: relative` is only ever added when it is genuinely needed, since
 *    adding it to a static card could reparent a descendant's positioning.
 *  - The radius. `border-radius: inherit` is wrong here: the card is often
 *    square and the rounding lives on the surface painted inside it, so an
 *    inherited radius would cut the corners off square over rounded ones. The
 *    real corner values are read off whichever element actually has them. */
function edgeGeometry(card, surfaces) {
    const cs = getComputedStyle(card);
    const corners = (el) => {
        const s = getComputedStyle(el);
        return [s.borderTopLeftRadius, s.borderTopRightRadius,
                s.borderBottomRightRadius, s.borderBottomLeftRadius];
    };
    const rounded = (list) => list.some((v) => parseFloat(v) > 0);

    let radius = corners(card);
    if (!rounded(radius)) {
        // THE CARD IS SQUARE, SO THE SHAPE COMES FROM THE SURFACE PAINTED IN IT
        // — and it has to be the surface that IS the node's face, not merely
        // one that happens to sit low in it.
        //
        // The first version took the top corners from the topmost rounded box
        // and the bottom corners from the bottommost, which sounds reasonable
        // and is wrong: the bottommost rounded box on a real node is a widget
        // pill with a 4px radius, so the outline came out `12px 12px 4px 4px`
        // and left two faint square corners along the bottom of every node.
        //
        // The surface covering the most of the card is the node's face, and its
        // corners are the node's corners.
        const cr = card.getBoundingClientRect();
        let best = null, bestArea = 0;
        for (const el of card.querySelectorAll("*")) {
            const c = corners(el);
            if (!rounded(c)) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            // Must actually cover the card, not just be large.
            if (r.width < cr.width * 0.8 || r.height < cr.height * 0.6) continue;
            if (area > bestArea) { best = c; bestArea = area; }
        }
        if (best) radius = best;
    }
    return { positioned: cs.position !== "static", radius: radius.join(" ") };
}

function rules(card, surfaces, colours, bang, geom) {
    const i = bang ? " !important" : "";
    const { roles } = surfaces;
    // THE FRONTEND'S OWN VARIABLES, SET ON THE CARD.
    //
    // `color` on the card does not reach the text that matters. Widget labels
    // and slot names carry their own colour class, `text-node-component-slot-text`,
    // which reads `--node-component-slot-text`; an element that sets its own
    // colour ignores one inherited from the card. Measured on frontend 1.53.6
    // under Midnight + Glass: the card said rgb(195, 203, 230) and every label
    // stayed rgb(160, 160, 160), grey on a see-through body, which is the
    // unreadable text of the Layer 1 report (B-01).
    //
    // Widget fields are the same story (B-12): they take their box from
    // `--component-node-widget-background`, not from any class this adapter
    // can name, so the finish's widget colour never arrived and an empty text
    // field had no visible edge.
    //
    // Setting the variables is sturdier than naming classes: they are the
    // frontend's own contract, and every element that uses them follows.
    const out = [
        `${card} {`,
        `  background-color: ${colours.body}${i};`,
        colours.text ? `  color: ${colours.text}${i};` : "",
        colours.text ? `  --node-component-slot-text: ${colours.text}${i};` : "",
        colours.text ? `  --component-node-foreground: ${colours.text}${i};` : "",
        colours.widget ? `  --component-node-widget-background: ${colours.widget}${i};` : "",
        `}`,
    ].filter(Boolean);

    const forRole = { body: colours.body, widget: colours.widget };
    for (const [cls, role] of roles) {
        const value = forRole[role];
        if (!value) continue;
        // Scoped under the card so this cannot reach a background utility of
        // the same name somewhere else in the app.
        out.push(`${card} .${CSS.escape(cls)} { background-color: ${value}${i}; }`);
    }

    // THE EDGE. Three things were tried against the real markup, and only the
    // third draws a line the eye can see on an unselected node:
    //
    //   border-color alone   nothing — the card has no border-width to colour
    //   inset box-shadow     blended away; an inset shadow paints *below* the
    //                        element's own children, and the surface filling
    //                        the card paints straight over it (measured: the
    //                        pixel came back part-way between wash and line
    //                        instead of the line colour)
    //   ::after overlay      drawn at full strength — an absolutely-positioned
    //                        pseudo-element paints above the children
    //
    // `outline` would also draw, but it is deliberately left untouched: that is
    // the property the renderer uses for its own selection ring, which already
    // works, and taking it over would mean fighting it on every select.
    if (colours.border) {
        if (geom && !geom.positioned) out.push(`${card} { position: relative${i}; }`);
        out.push(
            `${card}::after {`,
            `  content: ""${i};`,
            `  position: absolute${i};`,
            `  inset: 0${i};`,
            `  border: 1px solid ${colours.border}${i};`,
            `  border-radius: ${geom?.radius || "inherit"}${i};`,
            // Above the surfaces painted inside the card, and inert to the mouse
            // so dragging, wiring and every click still land on the node.
            `  z-index: 10${i};`,
            `  pointer-events: none${i};`,
            `}`,
        );
    }
    return out.join("\n");
}

/**
 * THE GRAPH, WITHOUT ASKING FOR IT TOO EARLY.
 *
 * `app.graph` is a getter that logs "ComfyApp graph accessed before
 * initialization" when it is read before the app has finished starting — an
 * error in the console, from us, on every reload that got in ahead of the
 * frontend. It also has nothing to give at that point, so the read is pure
 * cost.
 *
 * The canvas holds the same graph and carries no such guard, so it is asked
 * first. `app.graph` is only touched once a canvas exists, which is the point
 * after which the question is a fair one.
 */
/** Nodes on a graph, across every shape `_nodes` has had. */
function countNodes(graph) {
    if (!graph) return 0;
    const n = graph._nodes;
    if (Array.isArray(n)) return n.length;
    if (n && typeof n.values === "function") return [...n.values()].length;
    const m = graph.nodes;
    if (Array.isArray(m)) return m.length;
    if (m && typeof m.values === "function") return [...m.values()].length;
    return 0;
}

function liveGraph(app) {
    // Nothing is asked of either until a canvas exists: `app.graph` is a
    // getter that logs "ComfyApp graph accessed before initialization" when
    // read too early, and has nothing to give then anyway.
    if (!app?.canvas) return null;

    const viaCanvas = app.canvas.graph || null;
    let viaApp = null;
    try { viaApp = app.graph || null; } catch { /* still not ready */ }

    // WHICHEVER ACTUALLY HAS NODES — not whichever is merely present. Taking
    // the canvas's graph the moment it was truthy meant that, on a frontend
    // with a root graph and subgraphs, an empty one could be picked while the
    // workflow restored into the other. This then reported "no nodes on the
    // canvas to learn the markup from" on a page full of nodes, and the theme
    // never applied. Measured from a live log doing exactly that.
    if (countNodes(viaCanvas)) return viaCanvas;
    if (countNodes(viaApp)) return viaApp;
    return viaCanvas || viaApp;          // both empty: either will do
}

function apply(palette, ctx) {
    const app = ctx?.app || window.app || window.comfyAPI?.app?.app;
    const canvas = app?.canvas;
    const graph = liveGraph(app);
    const nodes = graph?._nodes?.length ? graph._nodes
        : (typeof graph?.nodes?.values === "function" ? [...graph.nodes.values()] : graph?.nodes || []);

    if (!nodes.length) {
        lastReport = { ok: false, why: "no nodes on the canvas to learn the markup from" };
        return lastReport;
    }

    // SEVERAL CARDS, NOT ONE. The intersection of their classes is what makes
    // the selector match every node instead of whichever happened to be
    // sampled — and a selected node looks different from an unselected one.
    // ALL OF THEM, re-found each time. The selector work needs only a handful,
    // but the fold button has to be put on every node that is on screen — and
    // put BACK when the renderer rebuilds a card, which replaces the element,
    // so a list captured once goes stale the first time a node re-renders.
    const allPairs = pairsFor(nodes, canvas, 64);
    const pairs = allPairs.slice(0, 3);
    const cards = pairs.map((p) => p.card);
    if (!cards.length) {
        lastReport = { ok: false, why: "no element found at a node's position — is it on screen?" };
        return lastReport;
    }

    const described = describeCards(cards);
    if (!described.selector) {
        lastReport = { ok: false, why: "the node cards carry nothing to select them by",
                       tag: cards[0].tagName.toLowerCase() };
        return lastReport;
    }

    const surfaces = findSurfaces(cards);
    const lg = palette?.colors?.litegraph_base || {};
    const colours = {
        body: bodyColour(palette, ctx),
        widget: widgetColour(palette, ctx),
        border: isBlank(lg.NODE_DEFAULT_BOXCOLOR) ? null : lg.NODE_DEFAULT_BOXCOLOR,
        text: isBlank(lg.NODE_TEXT_COLOR) ? null : lg.NODE_TEXT_COLOR,
    };
    const card = cards[0];

    const geom = edgeGeometry(card, surfaces);
    const host = findHosts(pairs);

    // MEASURED ONCE, WITH OUR OWN WORK SWITCHED OFF — and then remembered.
    //
    // The baseline has to be taken with the adapter's CSS gone, or re-applying
    // a theme reads the LAST apply's stretched panel as the node's natural
    // state and concludes that nothing needs doing. But doing that on EVERY
    // apply means blanking the live stylesheet each time, and that is not free:
    // the panel springs back to the width its own code pins it to, the table
    // inside it reflows, and the node flashes. Invisible when it happens once
    // at startup; very visible when something re-applies while you watch.
    //
    // So it is taken on the first apply that can take it, and reused after.
    // What it is used for — deciding whether the polite rules were enough —
    // does not change as the graph does.
    if (!baseline) {
        sheet().textContent = "";
        unmarkPinned();
        baseline = { fit: fillRatio(pairs), colour: getComputedStyle(card).backgroundColor };
    }
    const fitBefore = baseline.fit;

    const pinned = markPinned(nodes);
    watchNodes(graph);

    const collapsible = !!ctx?.preset?.collapsible;
    const levels = collapsible ? collapseLevels(pairs) : [];

    const write = (bang, withFit) => {
        let css = rules(described.selector, surfaces, colours, bang, geom);
        if (withFit) {
            if (host.selector) css += "\n" + fitRules(described.selector, host.selector, bang);
            if (pinned.found) css += "\n" + pinnedRule();
        }
        if (collapsible) css += "\n" + collapseRules(described.selector, host.selector, levels);
        sheet().textContent = css;
    };

    // WRITTEN WITHOUT !important FIRST, then checked. A renderer whose own
    // rules are weak takes the polite version; only one that outranks it gets
    // the heavy hammer, so this stays as well-behaved as the page allows.
    const before = baseline.colour;
    write(false, true);
    const after = getComputedStyle(card).backgroundColor;
    let forced = false;
    if (after === before) {
        write(true, true);
        forced = true;
    }

    // The fit is escalated on its own evidence rather than on the colour's: a
    // wrapper's height can be inline even when the colours went in politely.
    let fitAfter = fillRatio(pairs);
    let fitForced = forced;
    if (host.selector && !forced && fitAfter.worst < 0.9 && fitAfter.worst <= fitBefore.worst + 0.01) {
        write(true, true);
        fitAfter = fillRatio(pairs);
        fitForced = true;
    }
    // A fit that made things WORSE is undone. Stretching is a convenience; a
    // node whose panel has collapsed is a regression, and the colours — which
    // are what the studio is for — should not go down with it.
    let fitWhy = host.selector ? undefined : host.why;
    if (fitAfter.worst < fitBefore.worst - 0.02) {
        host.selector = null;
        unmarkPinned();
        write(forced, false);
        fitWhy = "stretching shrank the content, so it was rolled back";
        fitAfter = fillRatio(pairs);
    }

    // The button and the folded state, after the rules that make them mean
    // something. A card the renderer rebuilds later is caught by the observer.
    foldPlan = { hostSel: host.selector, levels, canvas };
    let buttons = 0;
    if (collapsible) {
        buttons = decorate(allPairs, true);
        watchCards(() => pairsFor(nodes, canvas, 64), () => true);
    } else {
        try { unobserve?.(); } catch { }
        unobserve = null;
        undecorate(allPairs);
    }

    applies++;
    lastReport = {
        applies,        // climbing on its own means something is re-applying
        ok: getComputedStyle(card).backgroundColor !== before || colours.body === before,
        selector: described.selector,
        selectorBy: described.by,
        sharedClasses: described.classes,
        surfaces: [...surfaces.roles].map(([c, r]) => `${c} -> ${r}`),
        edge: colours.border
            ? `${described.selector}::after, radius ${geom.radius}` +
              (geom.positioned ? "" : " (position: relative added)")
            : "none",
        outermostSurface: surfaces.edgeClass,
        content: {
            domWidgets: host.widgets,
            wrapper: host.selector || null,
            why: fitWhy,
            pinnedPanels: pinned.found,
            fills: `${pct(fitBefore)} -> ${pct(fitAfter)} of the node (width x height)`,
            forced: fitForced,
        },
        collapse: collapsible
            ? { buttons, folds: levels.map((l) => l.selector), folded: collapsedIds.size,
                why: levels.length ? undefined : "no box beside the panel could be named" }
            : "off",
        cardsSampled: cards.length,
        forced,
        applied: colours,
        cardTag: card.tagName.toLowerCase(),
        computedBefore: before,
        computedAfter: getComputedStyle(card).backgroundColor,
        nodesSeen: nodes.length,
    };
    return lastReport;
}

function off() {
    document.getElementById(STYLE_ID)?.remove();
    // The stylesheet going is not enough on its own: the marker class is on the
    // packs' own elements, and leaving it there would have the classic renderer
    // matching a rule that no longer exists the next time this file loads.
    unmarkPinned();
    try {
        const app = window.app || window.comfyAPI?.app?.app;
        const graph = liveGraph(app);
        const list = graph?._nodes?.length ? graph._nodes : [...(graph?.nodes?.values?.() || [])];
        undecorate(pairsFor(list, app?.canvas, 64));
    } catch { undecorate(); }
    try { unwatch?.(); } catch { /* the graph went away */ }
    try { unobserve?.(); } catch { /* nothing observing */ }
    unwatch = null;
    unobserve = null;
    baseline = null;
    lastReport = { ok: false, why: "removed" };
}

function report() {
    console.log(`${LOG} ` + JSON.stringify(lastReport, null, 2));
    return lastReport;
}

window.novaThemeRenderers = window.novaThemeRenderers || {};
window.novaThemeRenderers.v2 = {
    apply, off, report,
    // The same answer without the console line. `report()` exists to be read
    // by a person and prints itself; something that asks four times a second
    // whether the theme is in place yet needs the answer, not the noise.
    status: () => lastReport,
    /** Test hook: forget which nodes are folded, as a page reload does. */
    forgetFolds() { collapsedIds.clear(); },
};

console.log(`${LOG} adapter registered — the studio will use it when Nodes 2.0 is active`);
