// Requirement traceability (REQUIREMENTS.md §0.4).
// Lists each requirement with where code cites it and which tests verify it.
// Fails when code or tests cite an ID that REQUIREMENTS.md does not define, and when a
// requirement without a `Trace:` line is cited nowhere in the code.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const reqText = readFileSync(join(root, "REQUIREMENTS.md"), "utf8");

const MARKERS = ["manual", "policy"]; // §0.4
const defined = new Map(); // id -> { section, retired, trace }
const badMarkers = [];
let section = "";
let current = null;
for (const line of reqText.split("\n")) {
  const h = /^#{2,3}\s+(.*)/.exec(line);
  if (h) section = h[1];
  const m = /^(~~)?\*\*([A-Z]+-\d{3})\*\*/.exec(line);
  if (m) {
    current = { section, retired: !!m[1], trace: "" };
    defined.set(m[2], current);
    continue;
  }
  const t = /^\s+Trace:\s*(\S+)/.exec(line);
  if (t && current) {
    if (!MARKERS.includes(t[1])) badMarkers.push(`${t[1]} (${[...defined.keys()].pop()})`);
    current.trace = t[1];
  }
  if (line.trim() === "") current = null; // a block ends at the blank line
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
let implemented = 0, tested = 0, policy = 0, manual = 0;
const uncited = [], untested = [];
const rows = [];
for (const [id, { section: sec, retired, trace }] of defined) {
  if (id.startsWith("Q-")) continue; // open questions are not requirements
  const c = code.get(id), t = tests.get(id);
  if (c) implemented++;
  if (t) tested++;
  if (!retired) {
    if (trace === "policy") policy++;
    else if (trace === "manual") manual++;
    if (!c && trace !== "policy") uncited.push(id);
    if (!t && !trace) untested.push(id);
  }
  if (sec !== lastSection) {
    rows.push(`\n${sec}`);
    lastSection = sec;
  }
  const mark = retired ? "retired" : `${c ? "code" : "    "} ${t ? "test" : "    "}${trace ? `  ${trace}` : ""}`;
  rows.push(`  ${id.padEnd(10)} ${mark}${verbose && c ? `  ${[...c].join(", ")}` : ""}`);
}
console.log(rows.join("\n"));
const total = [...defined.keys()].filter((id) => !id.startsWith("Q-")).length;
console.log(
  `\n${total} requirements · ${implemented} cited in code · ${tested} cited in tests · ${policy} policy · ${manual} manual`,
);
if (untested.length) console.log(`Testable, untested (${untested.length}): ${untested.join(", ")}`);

let failed = false;
const fail = (msg) => {
  console.error(`\n${msg}`);
  failed = true;
};
if (unknown.length) {
  fail(`Unknown requirement IDs cited: ${unknown.map((id) => `${id} (${[...(code.get(id) ?? tests.get(id))].join(", ")})`).join("; ")}`);
}
if (badMarkers.length) fail(`Unknown Trace markers (expected ${MARKERS.join(" or ")}): ${badMarkers.join("; ")}`);
if (uncited.length) {
  fail(`Requirements cited nowhere in the code (implement and cite them, or add a \`Trace: policy\` line): ${uncited.join(", ")}`);
}
if (failed) process.exit(1);
