// Loads one square or file as the editor does, makes the edits of bench/output/edit.ts, writes the changes and
// checks them (check.ts), then reads the file back (roundtrip.ts). `npm run outcheck` runs it on real data;
// tests/output-real.test.ts on the bundled fixtures.
import { type Shape, area, toM } from "../../src/geo/clip";
import { KINDS } from "../../src/model/kinds";
import { worldFromText } from "../../src/model/load";
import type { World } from "../../src/model/world";
import { parseOsm } from "../../src/osm/parse";
import { type Changes, computeChanges, isEmptyChanges } from "../../src/output/changes";
import { toJosmXml } from "../../src/output/osmxml";
import { type Problem, checkChanges } from "./check";
import { type Edit, editWorld } from "./edit";
import { type RoundTrip, roundTrip } from "./roundtrip";

export interface OutcheckResult {
  name: string;
  ms: { load: number; edit: number; write: number; check: number; readback: number };
  areas: number; // imported paintable areas
  untouchedWrites: number; // elements written for the untouched map: must be 0 (OUT-002)
  edits: Edit[];
  counts: Changes["counts"];
  elements: { create: number; modify: number; delete: number; context: number };
  problems: Problem[];
  roundtrip: Omit<RoundTrip, "lost" | "gained">;
  xmlBytes: number;
}

export async function outcheck(text: string, name: string, svg = false): Promise<{ result: OutcheckResult; xml: string; svg?: string }> {
  let t = performance.now();
  const lap = () => {
    const now = performance.now();
    const d = Math.round(now - t);
    t = now;
    return d;
  };
  const { world } = await worldFromText(text);
  const osm = parseOsm(text);
  const msLoad = lap();

  // OUT-002 / IMP-008: the map as loaded writes nothing.
  const before = computeChanges(world);
  const untouchedWrites = isEmptyChanges(before) ? 0 : count(before);
  lap();

  const { edits, painted } = editWorld(world);
  const msEdit = lap();
  const changes = computeChanges(world);
  const xml = toJosmXml(changes);
  const msWrite = lap();
  const problems = checkChanges(world, changes, painted);
  const msCheck = lap();
  const rt = roundTrip(world, osm, changes);
  const msReadback = lap();
  const { lost, gained, ...roundtrip } = rt;
  const result: OutcheckResult = {
    name,
    ms: { load: msLoad, edit: msEdit, write: msWrite, check: msCheck, readback: msReadback },
    areas: world.source.importedKind.size,
    untouchedWrites,
    edits,
    counts: changes.counts,
    elements: {
      create: changes.create.nodes.length + changes.create.ways.length + changes.create.relations.length,
      modify: changes.modify.nodes.length + changes.modify.ways.length + changes.modify.relations.length,
      delete: changes.delete.nodes.length + changes.delete.ways.length + changes.delete.relations.length,
      context: changes.context.length,
    },
    problems,
    roundtrip,
    xmlBytes: xml.length,
  };
  return { result, xml, svg: svg ? drawSvg(world, painted, lost, gained, changes) : undefined };
}

const count = (c: Changes) =>
  c.create.nodes.length + c.create.ways.length + c.create.relations.length + c.modify.nodes.length + c.modify.ways.length + c.modify.relations.length + c.delete.nodes.length + c.delete.ways.length + c.delete.relations.length;

/** One line per square, and the problems under it. */
export function report(results: OutcheckResult[]): string {
  const lines: string[] = [];
  const head = `${"square".padEnd(22)} ${"areas".padStart(5)} ${"edits".padStart(5)} ${"chg".padStart(4)} ${"new".padStart(4)} ${"del".padStart(4)} ${"elems".padStart(6)} ${"untouched".padStart(9)} ${"problems".padStart(8)} ${"iou".padStart(6)} ${"ms".padStart(6)}`;
  lines.push(head);
  for (const r of results) {
    const e = r.elements.create + r.elements.modify + r.elements.delete;
    const ms = Object.values(r.ms).reduce((s, x) => s + x, 0);
    const edits = r.edits.filter((x) => x.what !== "untouched" && !x.rejected && x.changed > 0).length;
    lines.push(
      `${r.name.padEnd(22)} ${String(r.areas).padStart(5)} ${String(edits).padStart(5)} ${String(r.counts.changed).padStart(4)} ${String(r.counts.added).padStart(4)} ${String(r.counts.removed).padStart(4)} ${String(e).padStart(6)} ${String(r.untouchedWrites).padStart(9)} ${String(r.problems.length).padStart(8)} ${r.roundtrip.iou.toFixed(3).padStart(6)} ${String(ms).padStart(6)}`,
    );
    for (const p of r.problems.slice(0, 20)) lines.push(`    ${p.rule.padEnd(9)} ${p.element.padEnd(16)} ${p.detail}`);
    if (r.problems.length > 20) lines.push(`    … and ${r.problems.length - 20} more`);
    const low = r.roundtrip.byKind.filter((k) => k.painted_m2 > 100 && k.overlap_m2 / Math.max(k.painted_m2, k.readback_m2) < 0.98);
    for (const k of low) lines.push(`    readback ${k.kind}: painted ${Math.round(k.painted_m2)} m², read back ${Math.round(k.readback_m2)} m², shared ${Math.round(k.overlap_m2)} m²`);
  }
  const all = results.flatMap((r) => r.problems);
  const byRule = new Map<string, number>();
  for (const p of all) byRule.set(p.rule, (byRule.get(p.rule) ?? 0) + 1);
  lines.push("");
  lines.push(`${results.length} squares, ${all.length} problems${all.length ? ": " + [...byRule].map(([r, n]) => `${r} ×${n}`).join(", ") : ""}`);
  const iou = results.reduce((s, r) => s + r.roundtrip.overlap_m2, 0) / (results.reduce((s, r) => s + r.roundtrip.painted_m2 + r.roundtrip.readback_m2 - r.roundtrip.overlap_m2, 0) || 1);
  lines.push(`land read back as painted: IoU ${iou.toFixed(4)}`);
  return lines.join("\n");
}

const path = (s: Shape) => s.map((r) => "M" + r.map((p) => `${toM(p.X).toFixed(1)} ${toM(p.Y).toFixed(1)}`).join("L") + "Z").join("");

/** Streets, the land by kind, the strokes' land, the written outlines and where the read-back disagrees. */
function drawSvg(world: World, painted: Shape, lost: Shape, gained: Shape, c: Changes): string {
  const f = world.features.frame;
  const w = toM(f.maxX - f.minX), h = toM(f.maxY - f.minY);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${toM(f.minX)} ${toM(f.minY)} ${w} ${h}" width="${2 * w}" height="${2 * h}">`,
    `<rect x="${toM(f.minX)}" y="${toM(f.minY)}" width="${w}" height="${h}" fill="#fff"/>`,
    `<path d="${path(world.streets)}" fill="#ddd" fill-rule="evenodd"/>`,
  ];
  for (const a of world.atoms)
    for (const p of a.pieces) {
      if (!p.kind) continue;
      const fill = p.kind === "CTX" ? "#b8dca0" : KINDS[p.kind].color;
      out.push(`<path d="${path(p.shape)}" fill="${fill}" fill-opacity="0.7" fill-rule="evenodd"/>`);
    }
  out.push(`<path d="${path(painted)}" fill="none" stroke="#c00" stroke-width="0.5" stroke-dasharray="2 1" fill-rule="evenodd"/>`);
  const proj = world.features.proj;
  const pos = new Map<number, [number, number]>();
  for (const n of [...c.context, ...c.create.nodes, ...c.modify.nodes]) pos.set(n.id, [proj.x(n.lon), proj.y(n.lat)]);
  for (const way of [...c.create.ways, ...c.modify.ways]) {
    const pts = way.nodes.map((n) => pos.get(n)).filter((p): p is [number, number] => !!p);
    out.push(`<path d="M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}" fill="none" stroke="${way.id < 0 ? "#06c" : "#000"}" stroke-width="0.6"/>`);
    for (const n of way.nodes) {
      const p = pos.get(n);
      if (p) out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="0.7" fill="${n < 0 ? "#06c" : "#000"}"/>`);
    }
  }
  out.push(`<path d="${path(lost)}" fill="#f0f" fill-opacity="0.8" fill-rule="evenodd"/>`);
  out.push(`<path d="${path(gained)}" fill="#0cc" fill-opacity="0.8" fill-rule="evenodd"/>`);
  out.push(`<text x="${toM(f.minX) + 4}" y="${toM(f.minY) + 10}" font-size="8" font-family="sans-serif">black: changed outlines · blue: new · red dashes: strokes · magenta: painted but not read back (${Math.round(area(lost))} m²) · cyan: read back but not painted (${Math.round(area(gained))} m²)</text>`);
  out.push(`</svg>`);
  return out.join("\n");
}
