// Builds street space, water and atoms from barrier features (LAT-003..LAT-009).
import RBush from "rbush";
import {
  type Pt, type Ring, type Shape, area, bufferLines, components, containsDisc, difference, intersect, rect, toI, union,
} from "../geo/clip";
import { type Barrier, type Features, halfWidth } from "../osm/features";
import { BARRIER_RAILWAY, BARRIER_WATERWAY } from "../osm/classes";
import { TUNE } from "../tuning";

export interface Lattice {
  streets: Shape;
  water: Shape;
  atoms: Shape[];
}

export function buildLattice(f: Features): Lattice {
  const frame = rect(f.frame);

  // LAT-003 / LAT-009: each barrier buffered to the kerb, and in property-line style on to the property line,
  // which stops at building walls: a building standing on the property line keeps its footprint.
  const parts: Shape[] = [buffered(f.barriers, (b) => halfWidth(b.cls, b.width, "kerb"))];
  if (f.style === "property_line") {
    const beyond = union(buffered(f.barriers, (b) => halfWidth(b.cls, b.width, "property_line")), sidewalkSpace(f.sidewalks, f.barriers));
    const footprints = union(f.buildings.map((b) => {
      const r: Ring = [];
      for (let i = 0; i < b.ring.length; i += 2) r.push({ X: toI(b.ring[i]), Y: toI(b.ring[i + 1]) });
      return r;
    }));
    parts.push(difference(beyond, footprints));
  }
  // LAT-004
  parts.push(...f.streetAreas);
  const streets = intersect(union(...parts), frame);

  // LAT-008
  const water = intersect(union(...f.areas.filter((a) => a.klass.cls === "water").map((a) => a.shape)), frame);

  // LAT-005 / LAT-007: connected parts of the rest. Dead ends are just notches; nothing splits along them.
  const land = difference(difference(frame, streets), water);
  // LAT-006
  const atoms = components(land).filter(
    (c) => area(c) >= TUNE.ATOM_MIN_AREA && containsDisc(c, TUNE.ATOM_MIN_RADIUS),
  );
  return { streets, water, atoms };
}

/** Barriers buffered by their half-widths. Grouping by width keeps offset calls few. */
function buffered(barriers: Barrier[], hw: (b: Barrier) => number): Shape {
  const byWidth = new Map<number, Ring[]>();
  for (const b of barriers) {
    const w = hw(b);
    const g = byWidth.get(w);
    if (g) g.push(b.line);
    else byWidth.set(w, [b.line]);
  }
  return union(...[...byWidth].map(([w, lines]) => bufferLines(lines, w)));
}

type Seg = { minX: number; minY: number; maxX: number; maxY: number; a: Pt; b: Pt };

const SIDEWALK_STEP = 3; // m between sidewalk points matched to their street
const PARALLEL = Math.sin((30 * Math.PI) / 180); // a sidewalk turning further from its street has left it

/**
 * LAT-003: the land from a street's centreline to TUNE-SIDEWALK-MARGIN past each sidewalk running along it.
 * Each sidewalk point within TUNE-SIDEWALK-REACH of a street centreline, and running parallel to it, is
 * matched to its foot on the centreline; consecutive matches fill the quad between them. A sidewalk that
 * runs along no street (along a service road, across a park) is not street space.
 */
function sidewalkSpace(sidewalks: Ring[], barriers: Barrier[]): Shape {
  const tree = new RBush<Seg>();
  const segs: Seg[] = [];
  for (const b of barriers) {
    if (BARRIER_RAILWAY.has(b.cls) || BARRIER_WATERWAY.has(b.cls)) continue;
    for (let i = 1; i < b.line.length; i++) {
      const a = b.line[i - 1], c = b.line[i];
      segs.push({ minX: Math.min(a.X, c.X), minY: Math.min(a.Y, c.Y), maxX: Math.max(a.X, c.X), maxY: Math.max(a.Y, c.Y), a, b: c });
    }
  }
  if (segs.length === 0) return [];
  tree.load(segs);
  const reach = toI(TUNE.SIDEWALK_REACH);

  const quads: Shape = [];
  const runs: Ring[] = [];
  for (const sw of sidewalks) {
    const pts = densify(sw, toI(SIDEWALK_STEP));
    let prev: { p: Pt; foot: Pt } | null = null;
    let run: Ring | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d0 = pts[Math.max(0, i - 1)], d1 = pts[Math.min(pts.length - 1, i + 1)];
      const foot = footOn(tree, p, d1.X - d0.X, d1.Y - d0.Y, reach);
      // A foot that jumps (to another street) starts a new run rather than filling across the corner.
      if (foot && prev && Math.hypot(foot.X - prev.foot.X, foot.Y - prev.foot.Y) > 3 * toI(SIDEWALK_STEP)) prev = null;
      if (!foot) {
        prev = null;
        run = null;
        continue;
      }
      if (prev) {
        quads.push([prev.p, p, foot, prev.foot]);
        run!.push(p);
      } else runs.push((run = [p]));
      prev = { p, foot };
    }
  }
  return union(quads, bufferLines(runs, TUNE.SIDEWALK_MARGIN));
}

/** The nearest point within `reach` on a street centreline running parallel to direction (dx, dy). */
function footOn(tree: RBush<Seg>, p: Pt, dx: number, dy: number, reach: number): Pt | null {
  const dl = Math.hypot(dx, dy);
  if (dl === 0) return null;
  let best: Pt | null = null;
  let bestD = reach;
  for (const s of tree.search({ minX: p.X - reach, minY: p.Y - reach, maxX: p.X + reach, maxY: p.Y + reach })) {
    const ex = s.b.X - s.a.X, ey = s.b.Y - s.a.Y;
    const el = Math.hypot(ex, ey);
    if (el === 0 || Math.abs(ex * dy - ey * dx) / (el * dl) > PARALLEL) continue;
    const t = Math.max(0, Math.min(1, ((p.X - s.a.X) * ex + (p.Y - s.a.Y) * ey) / (el * el)));
    const fx = s.a.X + t * ex, fy = s.a.Y + t * ey;
    const d = Math.hypot(p.X - fx, p.Y - fy);
    if (d <= bestD) [best, bestD] = [{ X: Math.round(fx), Y: Math.round(fy) }, d];
  }
  return best;
}

function densify(line: Ring, step: number): Ring {
  const out: Ring = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.X - a.X, b.Y - a.Y) / step));
    for (let k = 1; k <= n; k++) out.push({ X: Math.round(a.X + ((b.X - a.X) * k) / n), Y: Math.round(a.Y + ((b.Y - a.Y) * k) / n) });
  }
  return out;
}
