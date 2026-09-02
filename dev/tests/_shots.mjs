// Where a suite's screenshots go.
//
// Four suites wrote to "/home/claude/shots/..." — an absolute path baked in
// from the container they were written in, exactly like the Playwright import
// _pw.mjs now resolves. On any other machine the run reached its last line and
// then died with ENOENT, AFTER printing every PASS, so `| tail -2` showed a
// Node stack trace and the suite looked broken when it had in fact passed.
//
// Resolution: $NOVA_SHOTS if set, else dev/tests/_shots/ inside the repo. The
// directory is created on demand; a screenshot is a debugging aid and must
// never be the thing that fails a run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.NOVA_SHOTS || path.join(HERE, "_shots");

/** Absolute path for a screenshot, with its directory guaranteed to exist. */
export function shot(name) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch { /* fall through — the caller handles a write failure */ }
  return path.join(DIR, name);
}

/** Screenshot a locator without letting a write failure end the run. */
export async function snap(locator, name) {
  try {
    await locator.screenshot({ path: shot(name) });
  } catch (e) {
    console.log(`  (screenshot ${name} skipped: ${e.message.split("\n")[0]})`);
  }
}
