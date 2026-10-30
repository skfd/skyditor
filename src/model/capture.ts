// One area taking another over (CAP-001..CAP-009): the only way two areas become one (OVL-005).
import {
  type Pt, type Shape, area, bbox, bboxOverlap, closing, components, difference, expandBBox, intersect, isEmpty, offset,
  opening, shapeCentroid, toI, toM, touches, union,
} from "../geo/clip";
import { CAPTURE_CITY, CAPTURE_LOCAL } from "../osm/classes";
import type { StrokeEvent } from "../paint/stroke";
import { TUNE } from "../tuning";
import type { Step } from "./history";
import { isResidential } from "./kinds";
import { type Atom, type Piece, type World, VOID_MIN_AREA, makePiece, normalize } from "./world";

export interface CapturePlan {
  source: Piece; // the source's piece the capture reaches out from
  target: Piece; // the target's piece it reaches
  fills: Map<Atom, Shape>; // CAP-008: gaps of empty land it takes, by block
  street: Shape; // CAP-008: street land it takes
  joins: readonly [number, number]; // the blocks the street land joins
}

const OVERLAP = 1; // m²; less than this in the way is round-off along shared edges, not something between

/** The piece a capture works from: on street land a capture took, the biggest piece of its area beside it. */
function anchor(world: World, p: Piece): Piece {
  const sides = world.atoms[p.atom].bridge;
  if (!sides) return p;
  const beside = sides.flatMap((id) => world.atoms[id].pieces.filter((q) => q.feature === p.feature));
  return beside.reduce((a, b) => (b.area > a.area ? b : a), beside[0] ?? p);
}

/**
 * CAP-007: what `from` capturing the area of `to` would take, or null when it may not. Both must be land
 * (not context, not void) of different areas, each loaded whole (LOAD-021); the caller treats the source's own
 * area as no target at all.
 */
export function planCapture(world: World, from: Piece, to: Piece): CapturePlan | null {
  if (from.kind === null || from.kind === "CTX" || to.kind === null || to.kind === "CTX") return null;
  if (!from.feature || from.feature === to.feature) return null;
  if (from.kind !== to.kind) return null; // two tiers are two kinds
  // LOAD-021: only areas loaded whole; painted ones (`new/N`) always are.
  if (world.loading.has(from.feature) || (to.feature && world.loading.has(to.feature))) return null;
  if (to.name !== undefined && to.name !== from.name) return null; // the target's name would be lost
  const mine = world.areaOf(from);
  if (mine.some((p) => p.rival) || world.areaOf(to).some((p) => p.rival)) return null;
  const t = anchor(world, to);
  // The source reaches out from whichever of its blocks lies nearest the target.
  const gap = (p: Piece) =>
    Math.max(p.bbox.minX - t.bbox.maxX, t.bbox.minX - p.bbox.maxX, 0) ** 2 + Math.max(p.bbox.minY - t.bbox.maxY, t.bbox.minY - p.bbox.maxY, 0) ** 2;
  const near = mine.filter((p) => !world.atoms[p.atom].bridge).sort((a, b) => gap(a) - gap(b)).slice(0, 3);
  for (const s of near) {
    const plan = planFrom(world, from, s, to, t);
    if (plan) return plan;
  }
  return null;
}

function planFrom(world: World, from: Piece, s: Piece, to: Piece, t: Piece): CapturePlan | null {
  const same = s.atom === t.atom;
  const reach = same ? TUNE.CAPTURE_GAP : TUNE.CAPTURE_REACH;
  if (!bboxOverlap(expandBBox(s.bbox, toI(reach)), t.bbox)) return null;
  const plan: CapturePlan = { source: from, target: to, fills: new Map(), street: [], joins: [s.atom, t.atom] };
  if (same && touches(s.shape, t.shape)) return plan;

  // CAP-008: one outline round both: what closes between them, near both, and nowhere else. Only gaps narrower
  // than `reach` close, so a wide lot between two areas in one block is never taken.
  const both = union(s.shape, t.shape);
  const between = intersect(
    intersect(closing(both, reach / 2 + 0.05), offset(s.shape, reach)),
    offset(t.shape, reach),
  );
  const fill = union(
    ...components(difference(between, both)).filter((c) => touches(c, s.shape, 0.1) && touches(c, t.shape, 0.1)),
  );
  if (isEmpty(fill)) return null;

  const ours = (p: Piece) => p.feature === from.feature || p.feature === to.feature;
  const blocks = same ? [world.atoms[s.atom]] : [world.atoms[s.atom], world.atoms[t.atom]];
  for (const atom of blocks) {
    const part = intersect(fill, atom.shape);
    if (isEmpty(part)) continue;
    // CAP-007: nothing between them but empty land.
    if (atom.pieces.some((p) => p.kind !== null && !ours(p) && area(intersect(p.shape, part)) > OVERLAP)) return null;
    const voids = union(...atom.pieces.filter((p) => p.kind === null).map((p) => p.shape));
    const empty = intersect(part, voids);
    // CAP-007: only gaps narrower than TUNE-CAPTURE-GAP; wider empty land is the user's to paint first.
    let narrow = difference(empty, opening(empty, TUNE.CAPTURE_GAP / 2));
    if (area(narrow) < VOID_MIN_AREA) continue;
    // The rounded ends of the closing leave crumbs at the corners of the gap: slivers join it, as after paint
    // (SNAP-107).
    const crumbs = components(difference(voids, narrow)).filter((c) => area(c) < TUNE.SLIVER_AREA && touches(c, narrow, 0.1));
    if (crumbs.length) narrow = union(narrow, ...crumbs);
    plan.fills.set(atom, narrow);
  }

  if (!same) {
    let street = difference(fill, union(...blocks.map((a) => a.shape)));
    if (area(intersect(street, world.water)) > OVERLAP) return null;
    for (const atom of world.atomsIn(bbox(street))) {
      if (blocks.includes(atom) || !atom.pieces.length) continue;
      if (area(intersect(atom.shape, street)) <= OVERLAP) continue;
      // Street land this area already took is its own; any other land is in the way.
      if (!atom.bridge || !atom.pieces.every(ours)) return null;
      street = difference(street, atom.shape);
    }
    if (!crossable(world, s, t)) return null;
    plan.street = street;
  }

  // The result is one outline (no multipolygons): the source, the target and what lies between, connected.
  const all = union(s.shape, t.shape, ...plan.fills.values(), plan.street);
  if (components(offset(all, 0.05)).length !== 1) return null;
  return plan;
}

/**
 * CAP-009: whether the streets between `s` and `t` are ones their kind may capture across, and at most one
 * street. The streets crossed are the barriers the shortest line between the two pieces crosses; two ways
 * with one name (dual carriageways, a street split into several ways) are one street.
 */
function crossable(world: World, s: Piece, t: Piece): boolean {
  const [a, b] = closestPair(s.shape, t.shape);
  const may = isResidential(s.kind) ? CAPTURE_LOCAL : CAPTURE_CITY;
  const box = { minX: Math.min(a.X, b.X), minY: Math.min(a.Y, b.Y), maxX: Math.max(a.X, b.X), maxY: Math.max(a.Y, b.Y) };
  const streets = new Set<string>();
  for (const barrier of world.features.barriers) {
    if (!bboxOverlap(bbox([barrier.line]), box)) continue;
    let crosses = false;
    for (let i = 1; i < barrier.line.length && !crosses; i++) crosses = segmentsCross(a, b, barrier.line[i - 1], barrier.line[i]);
    if (!crosses) continue;
    if (!may.has(barrier.cls)) return false;
    streets.add(barrier.name ?? barrier.id);
  }
  return streets.size <= 1;
}

/** The nearest points of two shapes, vertex to edge both ways. */
function closestPair(p: Shape, q: Shape): [Pt, Pt] {
  let best: [Pt, Pt] = [p[0][0], q[0][0]];
  let bestD = Infinity;
  const scan = (from: Shape, to: Shape, flip: boolean) => {
    for (const ring of from)
      for (const v of ring)
        for (const r of to)
          for (let i = 0; i < r.length; i++) {
            const e0 = r[i], e1 = r[(i + 1) % r.length];
            const ex = e1.X - e0.X, ey = e1.Y - e0.Y;
            const l2 = ex * ex + ey * ey;
            const k = l2 ? Math.max(0, Math.min(1, ((v.X - e0.X) * ex + (v.Y - e0.Y) * ey) / l2)) : 0;
            const f = { X: e0.X + k * ex, Y: e0.Y + k * ey };
            const d = (v.X - f.X) ** 2 + (v.Y - f.Y) ** 2;
            if (d < bestD) [bestD, best] = [d, flip ? [f, v] : [v, f]];
          }
  };
  scan(p, q, false);
  scan(q, p, true);
  return best;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => Math.sign((q.X - p.X) * (r.Y - p.Y) - (q.Y - p.Y) * (r.X - p.X));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

/**
 * CAP-005: carries out a plan as one undo step. Every piece of the target's area, in every block, and the land
 * between becomes the source's: its kind, name and OSM element. Returns a claim per block for the pop.
 */
export function applyCapture(world: World, plan: CapturePlan): { events: StrokeEvent[]; step: Step } {
  const { source: s, target: t } = plan;
  const kind = s.kind!;
  const as = (atom: Atom, shape: Shape, drawn: boolean) =>
    makePiece(atom, kind, shape, { source: s.source, feature: s.feature, name: s.name, whole: s.whole, modified: true, drawn });
  const changed = new Map<Atom, Piece[]>();
  const taken = new Map<Atom, Shape>();
  for (const atom of world.atoms) {
    const fill = plan.fills.get(atom);
    const theirs = atom.pieces.filter((p) => p.feature === t.feature);
    if (!fill && !theirs.length) continue;
    const pieces = atom.pieces.map((p) => (p.feature === t.feature ? as(atom, p.shape, p.drawn) : p));
    if (fill) pieces.push(as(atom, fill, true));
    taken.set(atom, union(...theirs.map((p) => p.shape), ...(fill ? [fill] : [])));
    // A bridge holds only land, so there is no void to work out.
    changed.set(atom, atom.bridge ? pieces : normalize(atom, pieces));
  }
  if (!isEmpty(plan.street)) {
    const bridge = world.addBridge(plan.street, plan.joins);
    changed.set(bridge, components(plan.street).map((c) => as(bridge, c, true)));
    taken.set(bridge, plan.street);
  }
  const step: Step = { atoms: [...changed].map(([atom, after]) => ({ atom, before: atom.pieces, after })) };
  const events: StrokeEvent[] = [];
  for (const [atom, after] of changed) {
    atom.pieces = after;
    const region = taken.get(atom)!;
    const b = bbox(region);
    const piece = after.find((p) => p.feature === s.feature && bboxOverlap(p.bbox, b)) ?? null;
    const [cx, cy] = shapeCentroid(region);
    // FEEL-001: the target rises from its own height; street land from the ground.
    events.push({ type: "claim", piece, region, prevKind: atom.bridge ? null : kind, at: [toM(cx), toM(cy)], whole: true });
  }
  return { events, step };
}

/**
 * CAP-008: street land a capture took goes back to being street when either side no longer holds its area
 * beside it, or when `reached` says paint or the eraser came to it. While both sides agree on a tier, it takes
 * theirs (a density step moves the land, the street with it). Returns the new piece lists of bridges that change.
 */
export function settleBridges(world: World, reached: (bridge: Atom, p: Piece) => boolean): Map<Atom, Piece[]> {
  const out = new Map<Atom, Piece[]>();
  for (const bridge of world.bridges) {
    const p = bridge.pieces[0];
    if (!p) continue;
    const sides = bridge.bridge!.map((id) =>
      world.atoms[id].pieces.filter((q) => q.feature === p.feature && touches(q.shape, bridge.shape, 0.1)),
    );
    if (reached(bridge, p) || sides.some((side) => side.length === 0)) {
      out.set(bridge, []);
      continue;
    }
    const kinds = new Set(sides.flat().map((q) => q.kind));
    const [kind] = kinds;
    if (kinds.size === 1 && kind !== p.kind) {
      const like = sides[0][0];
      out.set(
        bridge,
        bridge.pieces.map((q) =>
          makePiece(bridge, kind, q.shape, {
            source: q.source, feature: q.feature, name: like.name, whole: like.whole, modified: true, drawn: true,
          }),
        ),
      );
    }
  }
  return out;
}
