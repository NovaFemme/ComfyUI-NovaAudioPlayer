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

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
