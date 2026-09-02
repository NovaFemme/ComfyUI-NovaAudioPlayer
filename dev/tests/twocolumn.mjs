/**
 * Two-column output layout: the geometry, and the guard.
 *
 * No browser. The module is deliberately split so the arithmetic and the
 * bail-out conditions can be checked directly against a stand-in node — the
 * part that needs a canvas is the drawing, and the drawing is LiteGraph's.
 *
 * The guard is what most of this tests. The layout being wrong makes a node
 * look odd; the guard being wrong makes a node fail to render, and a workflow
 * that will not open is a different order of problem.
 *
 * Run:  node dev/tests/twocolumn.mjs
 */
import { applyTwoColumnOutputs, canApply, layout } from "../../web/madow/two-column.js";

let PASS = 0, FAIL = 0;
const ck = (n, ok, note = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${note ? "   " + note : ""}`);
  ok ? PASS++ : FAIL++;
};

const LG = { NODE_SLOT_HEIGHT: 20 };

function fakeNode(outputs = 30, inputs = 1) {
  return {
    pos: [100, 50],
    size: [400, 900],
    flags: {},
    inputs: Array.from({ length: inputs }, (_, i) => ({ name: `in${i}` })),
    outputs: Array.from({ length: outputs }, (_, i) => ({ name: `out${i}` })),
    getConnectionPos(isInput, slot, out) {
      const res = out || new Float32Array(2);
      res[0] = this.pos[0] + (isInput ? 10 : this.size[0] - 10);
      res[1] = this.pos[1] + 20 * (slot + 0.5);
      return res;
    },
    computeSize() {
      const rows = Math.max(this.inputs.length, this.outputs.length);
      return [this.size[0], rows * 20 + 200];
    },
    setSize(s) { this.size = s; },
    setDirtyCanvas() {},
  };
}

console.log("two-column outputs\n");

// -- geometry ---------------------------------------------------------------
const L = layout(30, 20, 400);
ck("30 outputs become 15 rows", L.rows === 15, String(L.rows));
ck("an odd count rounds up rather than dropping one",
   layout(29, 20, 400).rows === 15, String(layout(29, 20, 400).rows));
ck("column-major: the first half fills the left column",
   L.slotFor(0).col === 0 && L.slotFor(14).col === 0 &&
   L.slotFor(15).col === 1 && L.slotFor(29).col === 1);
ck("neighbouring outputs stay neighbours within a column",
   L.slotFor(1).y - L.slotFor(0).y === 20);
ck("both columns start at the same height",
   L.slotFor(0).y === L.slotFor(15).y);
ck("the right column keeps LiteGraph's inset, so nodes line up",
   L.slotFor(15).x === 400 - 10, String(L.slotFor(15).x));
ck("the left column sits inside the node, clear of the edge",
   L.slotFor(0).x > 0 && L.slotFor(0).x < 400 - 10, String(L.slotFor(0).x));
ck("columns track the node width when it is resized",
   layout(30, 20, 600).slotFor(15).x === 590);

// -- applied to a node -------------------------------------------------------
const node = fakeNode();
const before = node.computeSize()[1];
const restore = applyTwoColumnOutputs(node, LG);
ck("it applies to a node with many outputs", typeof restore === "function");

const after = node.computeSize()[1];
ck("the node gets shorter by the reclaimed rows",
   before - after === 15 * 20, `${before} -> ${after}`);

const p0 = node.getConnectionPos(false, 0);
const p15 = node.getConnectionPos(false, 15);
ck("output 0 and output 15 are on the same row, different columns",
   p0[1] === p15[1] && p0[0] !== p15[0], `${p0[0]} vs ${p15[0]}`);
ck("positions are absolute — node position is included",
   p0[1] === node.pos[1] + 10, String(p0[1]));

const inp = node.getConnectionPos(true, 0);
ck("INPUTS are left to LiteGraph, untouched",
   inp[0] === node.pos[0] + 10, String(inp[0]));

node.flags.collapsed = true;
const col = node.getConnectionPos(false, 20);
ck("a collapsed node falls through to the original layout",
   col[0] === node.pos[0] + node.size[0] - 10, String(col[0]));
node.flags.collapsed = false;

ck("an out-of-range slot does not throw",
   (() => { try { node.getConnectionPos(false, 999); return true; } catch { return false; } })());

restore();
ck("restore puts the original layout back",
   node.getConnectionPos(false, 0)[1] === node.pos[1] + 10 &&
   node.computeSize()[1] === before);

// -- the guard ---------------------------------------------------------------
ck("a node with few outputs is left alone",
   canApply(fakeNode(6), LG) === false);
ck("a missing getConnectionPos means no patch",
   applyTwoColumnOutputs({ ...fakeNode(), getConnectionPos: undefined }, LG) === null);
ck("a missing computeSize means no patch",
   applyTwoColumnOutputs({ ...fakeNode(), computeSize: undefined }, LG) === null);
ck("a missing NODE_SLOT_HEIGHT means no patch",
   applyTwoColumnOutputs(fakeNode(), {}) === null);
ck("no LiteGraph at all means no patch",
   applyTwoColumnOutputs(fakeNode(), null) === null);
ck("a node with no outputs array means no patch",
   applyTwoColumnOutputs({ ...fakeNode(), outputs: null }, LG) === null);

// A node where inputs dominate must not be shrunk below its inputs.
const wide = fakeNode(14, 40);
const wBefore = wide.computeSize()[1];
applyTwoColumnOutputs(wide, LG);
ck("a node with more inputs than output-rows keeps its height",
   wide.computeSize()[1] === wBefore, `${wBefore} -> ${wide.computeSize()[1]}`);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
