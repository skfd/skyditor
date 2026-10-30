// Edits a mapper might make on a loaded square, deterministic for the square, so the output can be checked
// (bench/output/check.ts) and read back (bench/output/roundtrip.ts). Every fourth imported area is left alone
// on purpose: the check wants areas that must not be written.
import { type Shape, area, bbox, components, interiorPoint, isEmpty, toM, union } from "../../src/geo/clip";
import { type Kind, type PaintKind, tierOf } from "../../src/model/kinds";
import type { World } from "../../src/model/world";
import { type Tool } from "../../src/paint/snap";
import { Stroke, type StrokeEvent } from "../../src/paint/stroke";
import { TUNE } from "../../src/tuning";

export interface Edit {
  feature: string; // the area edited, or `block/N` for empty land
  what: "repaint" | "erase" | "density" | "paint" | "untouched";
  tool: string;
  rejected: boolean; // the stroke was refused (protected or named land), so it changed nothing
  changed: number; // m² the stroke's events claimed
}

export interface Edited {
  edits: Edit[];
  painted: Shape; // everything the strokes changed, integer units
}

const MIN_AREA = 400; // m²; smaller areas are not worth a stroke
const EMPTY_BLOCK = 2000; // m²; empty land this big gets painted

/** Edits the world in place. */
export function editWorld(world: World): Edited {
  const edits: Edit[] = [];
  const regions: Shape[] = [];
  const features = [...world.source.importedLand]
    .map(([feature, land]) => ({ feature, land, kind: world.source.importedKind.get(feature)! }))
    .filter((f) => area(f.land) >= MIN_AREA)
    .sort((a, b) => area(b.land) - area(a.land) || (a.feature < b.feature ? -1 : 1));

  features.forEach((f, i) => {
    const part = components(f.land).sort((a, b) => area(b) - area(a))[0];
    const b = bbox(part);
    const w = toM(b.maxX - b.minX), h = toM(b.maxY - b.minY);
    const r = Math.max(3, Math.min(12, 0.15 * Math.min(w, h)));
    const x0 = toM(b.minX), y0 = toM(b.minY);
    const mode = (i + 1) % 4; // the third largest is the first left alone, so a square of three areas has one
    if (mode === 3) {
      edits.push({ feature: f.feature, what: "untouched", tool: "", rejected: false, changed: 0 });
      return;
    }
    let tool: Tool, what: Edit["what"], pts: Pt2[];
    if (mode === 0) {
      tool = { type: "paint", kind: other(f.kind) };
      what = "repaint";
      const y = y0 + 0.3 * h;
      pts = [[x0 + r, y], [x0 + w - r, y]];
    } else if (mode === 1) {
      tool = { type: "erase" };
      what = "erase";
      const x = x0 + 0.25 * w;
      pts = [[x, y0 + r], [x, y0 + h - r]];
    } else if (tierOf(f.kind) !== undefined && tierOf(f.kind)! < 6) {
      tool = { type: "density", dir: 1 };
      what = "density";
      const [ix, iy] = interiorPoint(part);
      pts = [[toM(ix), toM(iy)]];
    } else {
      tool = { type: "paint", kind: "RET" };
      what = "repaint";
      const y = y0 + 0.7 * h;
      pts = [[x0 + r, y], [x0 + w - r, y]];
    }
    const { events, rejected } = stroke(world, tool, r, pts, what === "density");
    const changed = claimed(events);
    regions.push(...changed);
    edits.push({ feature: f.feature, what, tool: describe(tool), rejected, changed: changed.reduce((s, c) => s + area(c), 0) });
  });

  // Empty land: every other block with a big empty part gets a stroke of its own kind across that part.
  const kinds: PaintKind[] = ["R2", "COM", "R5", "IND", "R4", "RET"];
  let k = 0;
  for (const atom of world.atoms) {
    if (atom.bridge) continue;
    const voids = atom.pieces.filter((p) => p.kind === null).map((p) => p.shape);
    if (voids.length === 0) continue;
    const empty = components(union(...voids)).sort((a, b) => area(b) - area(a))[0];
    if (area(empty) < EMPTY_BLOCK) continue;
    if (k++ % 2) continue;
    const b = bbox(empty);
    const w = toM(b.maxX - b.minX), h = toM(b.maxY - b.minY);
    const r = Math.max(3, Math.min(15, 0.2 * Math.min(w, h)));
    const [ix, iy] = interiorPoint(empty);
    const tool: Tool = { type: "paint", kind: kinds[k % kinds.length] };
    const pts: Pt2[] = [[toM(b.minX) + r, toM(iy)], [toM(ix), toM(iy)], [toM(b.maxX) - r, toM(iy)]];
    const { events, rejected } = stroke(world, tool, r, pts, false);
    const changed = claimed(events);
    regions.push(...changed);
    edits.push({ feature: `block/${atom.id}`, what: "paint", tool: describe(tool), rejected, changed: changed.reduce((s, c) => s + area(c), 0) });
  }
  return { edits, painted: regions.length ? union(...regions) : [] };
}

type Pt2 = [number, number];

/** Another kind than `k`, so a repaint is a change: non-residential for a tier, a tier for the rest. */
const other = (k: Kind): PaintKind => (tierOf(k) !== undefined || k === "RU" || k === "RM" ? "COM" : "R2");

const describe = (t: Tool) => (t.type === "paint" ? `paint ${t.kind}` : t.type === "density" ? `density ${t.dir > 0 ? "up" : "down"}` : t.type);

function stroke(world: World, tool: Tool, r: number, pts: Pt2[], tap: boolean) {
  const s = new Stroke(world, tool, r, pts[0][0], pts[0][1]);
  const events: StrokeEvent[] = [...s.start()];
  for (const p of densify(pts, r * TUNE.TRAIL_STEP * 0.5).slice(1)) events.push(...s.move(p[0], p[1]));
  events.push(...s.end(tap).events);
  return { events, rejected: events.some((e) => e.type === "reject") };
}

/** The land the events changed. */
function claimed(events: StrokeEvent[]): Shape[] {
  const out: Shape[] = [];
  for (const e of events) {
    if (e.type === "claim" && !isEmpty(e.region)) out.push(e.region);
    else if (e.type === "tier") out.push(e.piece.shape);
  }
  return out;
}

function densify(pts: Pt2[], step: number): Pt2[] {
  const out: Pt2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}
