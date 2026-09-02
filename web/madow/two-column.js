/**
 * two-column.js — lay a long output list into two columns.
 *
 * WHY. Madow has 30 outputs and one input, so LiteGraph sizes the slot region
 * at max(inputs, outputs) = 30 rows — about 600px of node height, 29 rows of
 * which have an empty left-hand column. Two columns halve that.
 *
 * HOW, AND WHY IT IS SAFE ENOUGH. LiteGraph asks the node where each slot lives
 * through `getConnectionPos(isInput, slot, out)`, and uses the answer for three
 * things: drawing the dot, drawing the label, and hit-testing a link drag. All
 * three follow from one override, so the slots stay draggable and the links
 * stay attached — nothing here reimplements rendering or input handling.
 *
 * THIS IS STILL FRONTEND INTERNALS. `getConnectionPos` is not a documented
 * extension point and a frontend update could move it. So:
 *
 *   - every requirement is checked before anything is patched, and a missing
 *     one means the node renders normally rather than half-patched;
 *   - the patch is reversible, and `restore()` puts the originals back;
 *   - it is togglable per node from the right-click menu, so a user hitting a
 *     rendering bug can turn it off without editing files or losing work.
 *
 * A tall node is a nuisance. A node that will not render is a broken workflow,
 * and that asymmetry is what the guard is for.
 */

const MIN_OUTPUTS = 12;      // below this, one column is not a problem
const COLUMN_X_FRACTION = 0.58;

/** Everything this module needs from LiteGraph, checked before use. */
export function canApply(node, LiteGraph) {
    if (!node || !LiteGraph) return false;
    if (typeof node.getConnectionPos !== "function") return false;
    if (typeof node.computeSize !== "function") return false;
    if (!Number.isFinite(LiteGraph.NODE_SLOT_HEIGHT)) return false;
    if (!Array.isArray(node.outputs)) return false;
    return node.outputs.length >= MIN_OUTPUTS;
}

/**
 * Geometry, separated from the patching so it can be reasoned about and
 * tested without a canvas.
 *
 * Column-major: the first half fills the left column top to bottom, so
 * neighbouring outputs stay neighbours and a related group does not get split
 * across columns by alternation.
 */
export function layout(count, slotH, nodeWidth) {
    const rows = Math.ceil(count / 2);
    return {
        rows,
        slotFor(i) {
            const col = i < rows ? 0 : 1;
            const row = i < rows ? i : i - rows;
            return {
                col,
                row,
                // The right column keeps LiteGraph's own inset so single-column
                // nodes and this one line up in a graph.
                x: col === 1 ? nodeWidth - 10
                             : Math.round(nodeWidth * COLUMN_X_FRACTION),
                y: slotH * 0.5 + row * slotH,
            };
        },
    };
}

/**
 * Patch `node`. Returns a restore function, or null if it could not be applied.
 */
export function applyTwoColumnOutputs(node, LiteGraph) {
    if (!canApply(node, LiteGraph)) return null;

    const slotH = LiteGraph.NODE_SLOT_HEIGHT;
    const origGetConnectionPos = node.getConnectionPos;
    const origComputeSize = node.computeSize;

    try {
        node.getConnectionPos = function (isInput, slot, out) {
            const res = out || new Float32Array(2);

            // Inputs, a collapsed node, and anything out of range stay with
            // LiteGraph: this module has an opinion about output columns only.
            if (isInput || this.flags?.collapsed ||
                !this.outputs || slot >= this.outputs.length) {
                return origGetConnectionPos.call(this, isInput, slot, out);
            }

            const L = layout(this.outputs.length, slotH, this.size[0]);
            const s = L.slotFor(slot);
            res[0] = this.pos[0] + s.x;
            res[1] = this.pos[1] + s.y;
            return res;
        };

        node.computeSize = function (out) {
            const size = origComputeSize.apply(this, arguments);
            try {
                const n = this.outputs?.length || 0;
                const inputs = this.inputs?.length || 0;
                // LiteGraph sized the slot region at max(inputs, outputs) rows.
                // Two columns need half as many, but never fewer than the
                // inputs, which are still one per row down the left edge.
                const was = Math.max(inputs, n);
                const now = Math.max(inputs, Math.ceil(n / 2));
                size[1] -= (was - now) * slotH;
            } catch {
                // Height is cosmetic; a failure here must not stop the node
                // reporting a size at all.
            }
            return size;
        };
    } catch {
        node.getConnectionPos = origGetConnectionPos;
        node.computeSize = origComputeSize;
        return null;
    }

    return function restore() {
        node.getConnectionPos = origGetConnectionPos;
        node.computeSize = origComputeSize;
    };
}
