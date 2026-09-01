// Playwright, resolved wherever it happens to live.
//
// Every suite here used to `import pw from "/home/claude/.npm-global/lib/
// node_modules/playwright/index.js"` — an absolute path baked in from the
// container the tests were written in. That path exists on exactly one machine,
// so the whole browser suite failed to even load anywhere else, including on a
// fresh clone. Resolution order below: a local install, then an explicit
// PLAYWRIGHT_PATH, then the global npm root.
//
// Not imported by test_bench.py, which is deliberately dependency-free.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

function load(spec) {
  if (!spec) return null;
  try {
    return require(spec);
  } catch {
    return null;
  }
}

let pw = load("playwright");

if (!pw) pw = load(process.env.PLAYWRIGHT_PATH);

if (!pw) {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    if (root) pw = load(`${root}/playwright`);
  } catch {
    // npm not on PATH — fall through to the message below.
  }
}

if (!pw) {
  console.error(
    "playwright could not be resolved.\n" +
    "\n" +
    "  npm install -g playwright && npx playwright install chromium\n" +
    "\n" +
    "or point PLAYWRIGHT_PATH at the directory containing it.",
  );
  process.exit(2);
}

export default pw;
