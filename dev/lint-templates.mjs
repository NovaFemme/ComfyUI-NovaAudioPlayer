/**
 * Guards against a mistake made twice in this codebase: writing a backtick
 * inside a CSS comment in a template literal, which silently terminates the
 * string and turns the whole module into a syntax error at load time.
 *
 *   node dev/lint-templates.mjs
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === "lib" || name === "node_modules") continue;
        const p = join(dir, name);
        statSync(p).isDirectory() ? walk(p) : name.endsWith(".js") && files.push(p);
    }
})("web");

let bad = 0;
for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Find the body of every `style.textContent = \`...\`` block and check the
    // CSS comments inside it for stray backticks.
    const re = /textContent\s*=\s*`([\s\S]*?)`;/g;
    let m;
    while ((m = re.exec(src))) {
        const comments = m[1].match(/\/\*[\s\S]*?\*\//g) || [];
        for (const c of comments) {
            if (c.includes("`")) {
                console.error(`${file}: backtick inside a CSS comment in a template literal:\n  ${c.trim().slice(0, 90)}`);
                bad++;
            }
        }
    }
}
console.log(bad ? `FAIL: ${bad} problem(s)` : `OK: ${files.length} modules clean`);
process.exit(bad ? 1 : 0);
