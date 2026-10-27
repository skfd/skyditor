// Requirement traceability (REQUIREMENTS.md §0.4).
// Lists each requirement with where code cites it and which tests verify it.
// Fails when code or tests cite an ID that REQUIREMENTS.md does not define.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const reqText = readFileSync(join(root, "REQUIREMENTS.md"), "utf8");

const defined = new Map(); // id -> { section, retired }
let section = "";
for (const line of reqText.split("\n")) {
  const h = /^#{2,3}\s+(.*)/.exec(line);
  if (h) section = h[1];
  const m = /^(~~)?\*\*([A-Z]+-\d{3})\*\*/.exec(line);
  if (m) defined.set(m[2], { section, retired: !!m[1] });
}

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|mjs|js|css|html)$/.test(f) ? [p] : [];
  });

const cites = (files) => {
  const out = new Map();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\b([A-Z]{2,5}-\d{3})\b/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(relative(root, f));
    }
  }
  return out;
};

const code = cites([...walk(join(root, "src")), join(root, "index.html")]);
const tests = cites(walk(join(root, "tests")));

const unknown = [...new Set([...code.keys(), ...tests.keys()])].filter((id) => !defined.has(id));
const verbose = process.argv.includes("-v");
let lastSection = "";
let implemented = 0, tested = 0;
const rows = [];
for (const [id, { section: sec, retired }] of defined) {
  if (id.startsWith("Q-")) continue; // open questions are not requirements
  const c = code.get(id), t = tests.get(id);
  if (c) implemented++;
  if (t) tested++;
  if (sec !== lastSection) {
    rows.push(`\n${sec}`);
    lastSection = sec;
  }
  const mark = retired ? "retired" : `${c ? "code" : "    "} ${t ? "test" : "    "}`;
  rows.push(`  ${id.padEnd(10)} ${mark}${verbose && c ? `  ${[...c].join(", ")}` : ""}`);
}
console.log(rows.join("\n"));
const total = [...defined.keys()].filter((id) => !id.startsWith("Q-")).length;
console.log(`\n${total} requirements · ${implemented} cited in code · ${tested} cited in tests`);
if (unknown.length) {
  console.error(`\nUnknown requirement IDs cited: ${unknown.map((id) => `${id} (${[...(code.get(id) ?? tests.get(id))].join(", ")})`).join("; ")}`);
  process.exit(1);
}
