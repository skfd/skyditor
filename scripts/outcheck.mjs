// Output check on real data (bench/output/run.ts): loads each square or file, makes a mapper's edits, writes the
// changes, checks them as JOSM's validator would, and reads the file back. Usage:
//   node scripts/outcheck.mjs [files...] [--squares dir] [--list file] [--only a,b] [--limit n] [--svg] [--out dir] [--jobs n]
// --jobs runs the squares in n processes at once and reports them together.
// With no files it runs the bundled fixtures: the demo district and the replay square. --squares runs the
// replay squares of research/landuse-edges (work/squares, cut by grid.py), like scripts/replay.mjs.
import { runnerImport } from "vite";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const jobs = Math.min(Number(opt("jobs", 1)), inputs.length);
if (jobs > 1) {
  // Each process takes every jobs-th input and writes its results to a file of its own; the order is kept.
  const own = args.filter((a, i) => !["--jobs", "--only", "--limit"].includes(a) && !["--jobs", "--only", "--limit"].includes(args[i - 1]) && !files.includes(a));
  const parts = await Promise.all(
    Array.from({ length: jobs }, (_, k) => {
      const mine = inputs.filter((_, i) => i % jobs === k);
      const part = join(out, `results.part${k}.json`);
      const childArgs = mine.length && files.length ? [...mine.map((x) => x.file), ...own] : [...own, "--only", mine.map((x) => x.name).join(",")];
      return new Promise((done, fail) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs, "--part", part], { stdio: ["ignore", "ignore", "inherit"] });
        child.on("exit", (code) => (code === 0 ? done(part) : fail(new Error(`job ${k} exited with ${code}`))));
      });
    }),
  );
  const byName = new Map(parts.flatMap((p) => JSON.parse(readFileSync(p, "utf8"))).map((r) => [r.name, r]));
  for (const p of parts) rmSync(p);
  results.push(...inputs.map((x) => byName.get(x.name)).filter(Boolean));
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
  console.log(module.report(results));
  process.stderr.write(`files in ${out}
`);
  process.exit(0);
}
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
if (opt("part", null)) {
  writeFileSync(opt("part"), JSON.stringify(results));
  process.exit(0);
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
console.log(module.report(results));
process.stderr.write(`files in ${out}\n`);
