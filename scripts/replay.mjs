// Replay benchmark (research/landuse-edges/README.md): paints rough strokes inside careful mappers' landuse
// and scores the snapped result against it. Usage:
//   node scripts/replay.mjs [--only a,b] [--limit n] [--svg] [--jobs n] [--out dir] [--squares dir] [--list file]
//   node scripts/replay.mjs --report results.json[.gz]
// --tune KEY=value[,KEY=value] overrides tuning knobs (src/tuning.ts) for a what-if run.
import { runnerImport } from "vite";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const study = join(root, "research/landuse-edges");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};

if (isMainThread && opt("report", null)) {
  const raw = readFileSync(opt("report"));
  console.log(report(JSON.parse((opt("report").endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"))));
} else if (isMainThread) {
  const list = opt("list", join(study, "replay-squares.txt"));
  const squares = opt("squares", join(study, "work/squares"));
  const out = opt("out", join(study, "work/replay"));
  const only = opt("only", null)?.split(",");
  const svg = args.includes("--svg");
  const tune = Object.fromEntries((opt("tune", "") || "").split(",").filter(Boolean).map((kv) => {
    const [k, v] = kv.split("=");
    return [k, Number(v)];
  }));
  let metas = readFileSync(list, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
    const [name, lat, lon, city, country, style] = l.trim().split(/\s+/);
    return { name, lat: +lat, lon: +lon, city, country, style };
  });
  if (only) metas = metas.filter((m) => only.includes(m.name));
  const limit = Number(opt("limit", 0));
  if (limit) metas = metas.slice(0, limit);
  const jobs = Math.min(metas.length, Number(opt("jobs", Math.max(1, availableParallelism() - 2))));
  mkdirSync(out, { recursive: true });

  const results = [];
  let next = 0, done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: jobs }, () => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { squares, out, svg, tune } });
    const feed = () => (next < metas.length ? w.postMessage(metas[next++]) : w.postMessage(null));
    w.on("message", (m) => {
      if (m === "ready") return feed();
      results.push(m);
      done++;
      const s = m.error ? `ERROR ${m.error}` : `${m.ms} ms, iou ${iou(m).toFixed(3)}`;
      process.stderr.write(`[${done}/${metas.length}] ${m.name}: ${s}\n`);
      feed();
    });
    w.on("error", reject);
    w.on("exit", resolve);
  })));
  results.sort((a, b) => a.name.localeCompare(b.name));
  const file = join(out, "results.json");
  writeFileSync(file, JSON.stringify(results));
  process.stderr.write(`${results.length} squares in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${file}\n`);
  console.log(report(results));
} else {
  parentPort.on("message", async (meta) => {
    if (!meta) return process.exit(0);
    try {
      // A fresh module graph per square: piece ids seed coverage samples, so they must not depend on
      // which squares a worker happened to replay before.
      const { module } = await runnerImport(join(root, "bench/replay/run.ts"));
      module.setTune(workerData.tune);
      const text = gunzipSync(readFileSync(join(workerData.squares, `${meta.name}.osm.gz`))).toString("utf8");
      const { result, svg } = module.replay(text, meta, undefined, workerData.svg);
      if (svg) writeFileSync(join(workerData.out, `${meta.name}.svg`), svg);
      parentPort.postMessage(result);
    } catch (e) {
      parentPort.postMessage({ name: meta.name, error: String(e?.stack ?? e) });
    }
  });
  parentPort.postMessage("ready");
}

function iou(m) {
  const s = m.score;
  return s.overlap_m2 / Math.max(1, s.truth_m2 + s.result_m2 - s.overlap_m2);
}

/** Pooled scores, all squares and by street style. Result and truth side by side wherever both apply. */
function report(results) {
  const ok = results.filter((r) => !r.error);
  const out = [];
  const groups = [["all", ok], ...["kerb", "property_line", "unknown"].map((st) => [st, ok.filter((r) => r.style === st)])];
  const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");
  const sum = (rs, f) => rs.reduce((s, r) => s + f(r), 0);
  const hist = (rs, key) => {
    const h = new Map();
    for (const r of rs) for (const [b, n] of Object.entries(r.score[key])) h.set(+b, (h.get(+b) ?? 0) + n);
    const bins = [...h].sort((a, b) => a[0] - b[0]);
    const total = bins.reduce((s, [, n]) => s + n, 0);
    const q = (p) => {
      let acc = 0;
      for (const [b, n] of bins) if ((acc += n) >= p * total) return ((b + 0.5) * 0.25).toFixed(1);
      return "-";
    };
    const within = (m) => bins.filter(([b]) => (b + 1) * 0.25 <= m).reduce((s, [, n]) => s + n, 0);
    return `median ${q(0.5)} m, p90 ${q(0.9)} m, within 1 m ${pct(within(1), total)}, within 3 m ${pct(within(3), total)}`;
  };
  const side = (rs, w) => {
    const e = (f) => sum(rs, (r) => f(r.score[w]));
    const inner = e((s) => s.inner_m), nothing = e((s) => s.follows.nothing ?? 0);
    const follows = ["fence", "building", "context", "minor way", "street", "nothing"]
      .map((t) => `${t} ${pct(e((s) => s.follows[t] ?? 0), inner)}`).join(", ");
    return [
      `inner edges ${(inner / 1000).toFixed(1)} km: ${follows}`,
      `vertices turning >= 5 deg: ${((100 * e((s) => s.turns)) / Math.max(1, e((s) => s.edge_m))).toFixed(1)} per 100 m of edge, ` +
        `${((100 * e((s) => s.nothing_turns)) / Math.max(1, nothing)).toFixed(1)} per 100 m of inner edge that follows nothing`,
      `buildings split: ${pct(e((s) => s.buildings.split), e((s) => s.buildings.touching))} of ${e((s) => s.buildings.touching)} touching landuse`,
    ];
  };
  const secs = sum(ok, (r) => r.ms) / Math.max(1, ok.length) / 1000;
  out.push(`${ok.length} squares replayed, ${results.length - ok.length} failed; ${secs.toFixed(1)} s per square.`);
  for (const [name, rs] of groups) {
    if (!rs.length) continue;
    const t = sum(rs, (r) => r.score.truth_m2), res = sum(rs, (r) => r.score.result_m2), o = sum(rs, (r) => r.score.overlap_m2);
    const painted = sum(rs, (r) => r.whole_m2 + r.freeform_m2);
    out.push("", `== ${name} (${rs.length} squares, ${(t / 1e6).toFixed(2)} km² of truth)`);
    out.push(`Overlap: IoU ${(o / (t + res - o)).toFixed(3)}; truth missed ${pct(t - o, t)}, result outside truth ${pct(res - o, res)}.`);
    out.push(`Strokes: ${sum(rs, (r) => r.strokes)}; claimed whole ${pct(sum(rs, (r) => r.whole_m2), painted)} of painted area; ` +
      `truth no brush fits ${pct(sum(rs, (r) => r.unreached_m2), t)}.`);
    out.push(`Result edge to truth edge: ${hist(rs, "d_result")}.`);
    out.push(`Truth edge to result edge: ${hist(rs, "d_truth")}.`);
    for (const w of ["result", "truth"]) out.push(...side(rs, w).map((l) => `${w.padEnd(6)}  ${l}`));
  }
  return out.join("\n");
}
