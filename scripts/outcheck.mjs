// Output check on real data (bench/output/run.ts): loads each square or file, makes a mapper's edits, writes the
// changes, checks them as JOSM's validator would, and reads the file back. Usage:
//   node scripts/outcheck.mjs [files...] [--squares dir] [--list file] [--only a,b] [--limit n] [--svg] [--out dir]
// With no files it runs the bundled fixtures: the demo district and the replay square. --squares runs the
// replay squares of research/landuse-edges (work/squares, cut by grid.py), like scripts/replay.mjs.
import { runnerImport } from "vite";
import { gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const study = join(root, "research/landuse-edges");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (!["svg"].includes(args[i].slice(2))) i++;
    continue;
  }
  files.push(args[i]);
}

const read = (file) => {
  const raw = readFileSync(file);
  return (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
};

let inputs = [];
if (opt("squares", null) || opt("list", null)) {
  const list = opt("list", join(study, "replay-squares.txt"));
  const squares = opt("squares", join(study, "work/squares"));
  const only = opt("only", null)?.split(",");
  let metas = readFileSync(list, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim().split(/\s+/)[0]);
  if (only) metas = metas.filter((m) => only.includes(m));
  if (opt("limit", null)) metas = metas.slice(0, Number(opt("limit")));
  inputs = metas.map((name) => ({ name, file: join(squares, `${name}.osm.gz`) }));
} else if (files.length) {
  inputs = files.map((f) => ({ name: basename(f).replace(/\.(osm|json|xml)(\.gz)?$/, ""), file: f }));
} else {
  inputs = [
    { name: "demo-tallinn", file: join(root, "public/fixtures/demo-tallinn.json") },
    { name: "turku_4_0", file: join(root, "tests/fixtures/replay-turku_4_0.osm.gz") },
  ];
}

const out = opt("out", join(study, "work/outcheck"));
const svg = flag("svg");
mkdirSync(out, { recursive: true });
const { module } = await runnerImport(join(root, "bench/output/run.ts"));
const results = [];
for (const { name, file } of inputs) {
  if (!existsSync(file)) {
    process.stderr.write(`${name}: no file ${file}\n`);
    continue;
  }
  try {
    const r = await module.outcheck(read(file), name, svg);
    results.push(r.result);
    writeFileSync(join(out, `${name}.osm`), r.xml);
    if (r.svg) writeFileSync(join(out, `${name}.svg`), r.svg);
    process.stderr.write(`${name}: ${r.result.problems.length} problems, iou ${r.result.roundtrip.iou.toFixed(3)}\n`);
  } catch (e) {
    process.stderr.write(`${name}: ${e.stack ?? e}\n`);
    results.push({ name, ms: {}, areas: 0, untouchedWrites: 0, edits: [], counts: { changed: 0, added: 0, removed: 0, buildings: 0 }, elements: { create: 0, modify: 0, delete: 0, context: 0 }, problems: [{ rule: "crash", element: name, detail: String(e.message ?? e) }], roundtrip: { byKind: [], painted_m2: 0, readback_m2: 0, overlap_m2: 0, iou: 0 }, xmlBytes: 0 });
  }
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
console.log(module.report(results));
process.stderr.write(`files in ${out}\n`);
