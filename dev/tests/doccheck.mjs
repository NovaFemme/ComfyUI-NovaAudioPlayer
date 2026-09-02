/**
 * The documented visualiser count must match the registry.
 *
 * This exists because the count has drifted twice. The README shipped claiming
 * fourteen when there were twelve, and the module docstring and the in-ComfyUI
 * help page both still said five — a number that was last true several
 * renderers ago. Nobody notices, because nothing breaks: the node works
 * perfectly while telling users something false.
 *
 * `registry.js` is the single source of truth for what exists. Everything that
 * states a number is checked against it here, so adding a renderer fails this
 * suite until the prose catches up.
 *
 * Deliberately dependency-free — no Playwright, no devserver. It is a text
 * check, and a text check that needs a browser will not get run.
 *
 * Run:  node dev/tests/doccheck.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => readFileSync(join(ROOT, p), "utf8");

let PASS = 0, FAIL = 0;
const ck = (name, ok, detail = "") => {
  ok ? PASS++ : FAIL++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
};

// -- the truth --------------------------------------------------------------
const registry = read("web/renderers/registry.js");
const block = registry.match(/export const RENDERERS = \[([\s\S]*?)\];/);
if (!block) {
  console.error("could not find the RENDERERS array in registry.js");
  process.exit(2);
}
const N = block[1].split(",").map(s => s.trim()).filter(Boolean).length;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven",
               "eight", "nine", "ten", "eleven", "twelve", "thirteen",
               "fourteen", "fifteen", "sixteen"];
const word = WORDS[N];

console.log(`documented counts vs registry\n\n  registry.js declares ${N} renderers ("${word}")\n`);

// -- everything that states a number ---------------------------------------
// Files describing the ORIGINAL pre-refactor widget are excluded on purpose:
// docs/design/*.md and web/docs/NovaAudioPlayer.md say "five" as history, and
// rewriting history to match the present would make those notes wrong.
const CLAIMS = [
  ["README.md", read("README.md")],
  ["__init__.py", read("__init__.py")],
  ["pyproject.toml", read("pyproject.toml")],
  ["web/docs/NovaPlayerNode/en.md", read("web/docs/NovaPlayerNode/en.md")],
  ["HANDOVER.md", read("HANDOVER.md")],
];

const COUNT_RE = new RegExp(
  `\\b(${WORDS.join("|")}|\\d+)\\b(?=[^.\\n]{0,40}\\b(?:live )?visualisers?\\b)`, "gi");

for (const [name, text] of CLAIMS) {
  const found = [...text.matchAll(COUNT_RE)].map(m => m[1].toLowerCase());
  if (found.length === 0) {
    ck(`${name} states no visualiser count`, true, "(nothing to drift)");
    continue;
  }
  const wrong = found.filter(f => f !== word && f !== String(N));
  ck(`${name} says "${word}"`, wrong.length === 0,
     wrong.length ? `found ${wrong.map(w => `"${w}"`).join(", ")} — registry has ${N}` : `${found.length} mention(s)`);
}

// The README's table of views is the other place the number lives, implicitly.
const readme = read("README.md");
const table = readme.match(/\|\s*\|\s*\|\n\|---\|---\|\n((?:\|.*\|\n)+)/);
if (table) {
  const rows = table[1].trim().split("\n").length;
  ck("the README's view table has one row per renderer", rows === N,
     `${rows} rows vs ${N} renderers`);
} else {
  ck("the README's view table was found", false, "table shape changed — update this check");
}

// -- Madow's parameter and output counts -------------------------------------
// The README said "23 outputs" for a release after the four file.* fields
// landed. The table in madow/params.py is the source of truth for both numbers.
const paramsPy = read("madow/params.py");
const KEY_COUNT = (paramsPy.match(/^\s*\("[a-z_]+\.[a-z_0-9]+",/gm) || []).length;
if (KEY_COUNT > 0) {
  console.log(`\nMadow counts (params.py declares ${KEY_COUNT})\n`);
  const readmeText = read("README.md");
  const params = [...readmeText.matchAll(/\*\*(\d+) parameters\*\*/g)].map(m => +m[1]);
  const outs = [...readmeText.matchAll(/(\d+) typed outputs/g)].map(m => +m[1]);
  // An empty match is reported as such rather than passing quietly: a check
  // that goes green because the README stopped using the phrase is worse than
  // no check, since it reads as verification.
  ck("README's parameter count matches params.py",
     params.every(v => v === KEY_COUNT),
     params.length ? `README says ${params.join(", ")}` : "(no count stated — check is idle)");
  // Unpack emits one output per parameter plus the derived file_path.
  ck("README's output count is parameters + file_path",
     outs.every(v => v === KEY_COUNT + 1),
     outs.length ? `README says ${outs.join(", ")}` : "(no count stated — check is idle)");
}

// -- display names -----------------------------------------------------------
// The node symbols were changed in the editor and the README kept the old ones
// for a release and a half. A display name is a string in exactly one place in
// Python and quoted verbatim in the docs, so drift between them is checkable.
const NAME_RE = /NODE_DISPLAY_NAME_MAPPINGS\s*=\s*\{([^}]*)\}/s;
const names = [];
for (const f of ["nova_player/node.py", "madow/node.py", "madow/unpack.py"]) {
  const m = read(f).match(NAME_RE);
  if (!m) continue;
  for (const nm of m[1].matchAll(/:\s*"([^"]+)"/g)) names.push([f, nm[1]]);
}
console.log("\ndisplay names vs the docs\n");
for (const [f, name] of names) {
  // The bare name without its symbol, to find the place the docs mention it.
  const bare = name.replace(/[^\x20-\x7e]/g, "").trim();
  const readmeText = read("README.md");
  const mentions = readmeText.includes(bare);
  if (!mentions) { ck(`README does not name "${bare}"`, true, "(nothing to drift)"); continue; }
  // Every mention that carries a symbol must carry the CODE's symbol.
  const re = new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*([^\\x00-\\x7f]+)", "g");
  const wrong = [...readmeText.matchAll(re)].map(m => m[1].trim()).filter(sym => !name.includes(sym));
  ck(`README's "${bare}" carries the code's symbol`, wrong.length === 0,
     wrong.length ? `found ${wrong.map(w => `"${w}"`).join(", ")} — ${f} says "${name}"` : name);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
