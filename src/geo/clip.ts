// Integer polygon geometry on top of Clipper (GEN-004).
// A Shape is a set of rings in non-zero / even-odd normalized form, as produced by Clipper.
// Coordinates are integers in TUNE-GEOM-SCALE units per metre.
import ClipperLib from "clipper-lib";
import { TUNE } from "../tuning";

export type Pt = ClipperLib.IntPoint;
export type Ring = Pt[];
export type Shape = Ring[];
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const S = TUNE.GEOM_SCALE;
const ARC_TOLERANCE = 0.2 * S;
const MITER_LIMIT = 3;
const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType } = ClipperLib;

export const toI = (m: number) => Math.round(m * S);
export const toM = (i: number) => i / S;

export function ringFromMeters(pts: ArrayLike<number>[] | [number, number][]): Ring {
  const r: Ring = [];
  for (const p of pts as [number, number][]) r.push({ X: toI(p[0]), Y: toI(p[1]) });
  return r;
}

export function rect(b: BBox): Shape {
  return [
    [
      { X: b.minX, Y: b.minY },
      { X: b.maxX, Y: b.minY },
      { X: b.maxX, Y: b.maxY },
      { X: b.minX, Y: b.maxY },
    ],
  ];
}

export function circle(cx: number, cy: number, r: number, n = 32): Shape {
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push({ X: Math.round(cx + Math.cos(a) * r), Y: Math.round(cy + Math.sin(a) * r) });
  }
  return [ring];
}

function exec(ct: ClipperLib.ClipType, a: Shape, b: Shape | null): Shape {
  const c = new Clipper();
  c.AddPaths(a, PolyType.ptSubject, true);
  if (b) c.AddPaths(b, PolyType.ptClip, true);
  const out: Shape = [];
  c.Execute(ct, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return out;
}

export const isEmpty = (s: Shape | null | undefined) => !s || s.length === 0;

export function union(...shapes: Shape[]): Shape {
  const all: Shape = [];
  for (const s of shapes) for (const r of s) all.push(r);
  if (all.length === 0) return [];
  return exec(ClipType.ctUnion, all, null);
}

export function intersect(a: Shape, b: Shape): Shape {
  if (isEmpty(a) || isEmpty(b)) return [];
  if (!bboxOverlap(bbox(a), bbox(b))) return [];
  return exec(ClipType.ctIntersection, a, b);
}

export function difference(a: Shape, b: Shape): Shape {
  if (isEmpty(a)) return [];
  if (isEmpty(b) || !bboxOverlap(bbox(a), bbox(b))) return a;
  return exec(ClipType.ctDifference, a, b);
}

export type Join = "round" | "miter";

/** Closed-polygon offset by `deltaM` metres (negative shrinks). */
export function offset(s: Shape, deltaM: number, join: Join = "round"): Shape {
  if (isEmpty(s)) return [];
  if (deltaM === 0) return s;
  const co = new ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  co.AddPaths(s, join === "round" ? JoinType.jtRound : JoinType.jtMiter, EndType.etClosedPolygon);
  const out: Shape = [];
  co.Execute(out, deltaM * S);
  return out;
}

/** Buffers open polylines (integer coords) by `deltaM` metres with round caps and joins. */
export function bufferLines(lines: Ring[], deltaM: number): Shape {
  const co = new ClipperOffset(2, ARC_TOLERANCE);
  const dots: Shape[] = [];
  for (const l of lines) {
    if (l.length === 1) dots.push(circle(l[0].X, l[0].Y, deltaM * S, 32));
    else if (l.length > 1) co.AddPath(l, JoinType.jtRound, EndType.etOpenRound);
  }
  const out: Shape = [];
  co.Execute(out, deltaM * S);
  return dots.length ? union(out, ...dots) : out;
}

export const closing = (s: Shape, rM: number) => (rM <= 0 ? s : offset(offset(s, rM), -rM));

/**
 * Morphological opening, clipped back to the input so round-off never grows it.
 * With miter joins, corners of wide regions survive; only parts narrower than 2·r disappear.
 */
export function opening(s: Shape, rM: number, join: Join = "round"): Shape {
  if (rM <= 0) return s;
  const inner = offset(s, -rM, join);
  if (isEmpty(inner)) return [];
  return intersect(offset(inner, rM, join), s);
}

/** The parts of `s` narrower than 2·r (corners of wider parts excluded), as components. */
export function narrowParts(s: Shape, rM: number): Shape[] {
  const fat = opening(s, rM, "miter");
  // Drop crumbs left by integer round-off along the boundary of the fat part.
  return components(difference(s, offset(fat, 0.02, "miter"))).filter((c) => area(c) > 0.05);
}

export const containsDisc = (s: Shape, rM: number) => !isEmpty(offset(s, -rM));

/** Area in m² of a normalized shape. */
export function area(s: Shape): number {
  let a = 0;
  for (const r of s) a += Clipper.Area(r);
  return Math.abs(a) / (S * S);
}

export interface Component {
  outer: Ring;
  holes: Ring[];
}

/** Splits a shape into connected components (outer ring + its holes). */
export function components(s: Shape): Shape[] {
  if (isEmpty(s)) return [];
  const c = new Clipper();
  c.AddPaths(s, PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((ex) => [ex.outer, ...ex.holes]);
}

export function bbox(s: Shape): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of s)
    for (const p of r) {
      if (p.X < minX) minX = p.X;
      if (p.Y < minY) minY = p.Y;
      if (p.X > maxX) maxX = p.X;
      if (p.Y > maxY) maxY = p.Y;
    }
  return { minX, minY, maxX, maxY };
}

export const bboxOverlap = (a: BBox, b: BBox) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export const expandBBox = (b: BBox, d: number): BBox => ({
  minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d,
});

/** Point (integer coords) inside a normalized shape (even-odd over its rings). */
export function contains(s: Shape, x: number, y: number): boolean {
  let inside = false;
  const pt = { X: x, Y: y };
  for (const r of s) if (Clipper.PointInPolygon(pt, r) !== 0) inside = !inside;
  return inside;
}

/** True when the shapes overlap or come within `gapM` metres of each other. */
export function touches(a: Shape, b: Shape, gapM = 0.05): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  if (!bboxOverlap(expandBBox(bbox(a), gapM * S), bbox(b))) return false;
  return !isEmpty(intersect(offset(a, gapM), b));
}

/** Simplifies ring vertices within `tolM` metres and re-normalizes the result. */
export function simplify(s: Shape, tolM: number): Shape {
  if (isEmpty(s)) return s;
  const rings = s.map((r) => ClipperLib.JS.Lighten(r, tolM * S)).filter((r) => r.length >= 3);
  const cleaned = Clipper.CleanPolygons(rings, 0.05 * S);
  return union(cleaned.filter((r) => r.length >= 3));
}

export function shapeCentroid(s: Shape): [number, number] {
  // Area-weighted centroid in integer units, falling back to the bbox centre.
  let a = 0, cx = 0, cy = 0;
  for (const r of s) {
    for (let i = 0, n = r.length; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n];
      const f = p.X * q.Y - q.X * p.Y;
      a += f;
      cx += (p.X + q.X) * f;
      cy += (p.Y + q.Y) * f;
    }
  }
  if (Math.abs(a) < 1e-9) {
    const b = bbox(s);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** A point well inside `s`, in integer units: the centre of its deepest inset, found by bisection (REN-016). */
export function interiorPoint(s: Shape): [number, number] {
  const b = bbox(s);
  let lo = 0, hi = Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2 / S;
  let deepest = s;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const inset = offset(s, -mid);
    if (isEmpty(inset)) hi = mid;
    else [lo, deepest] = [mid, inset];
  }
  const core = components(deepest).reduce((a, c) => (area(c) > area(a) ? c : a));
  const c = shapeCentroid(core);
  return contains(s, c[0], c[1]) ? c : [core[0][0].X, core[0][0].Y];
}

/** Total length in metres of the open polylines `lines` (integer coords) that lies inside `s`. */
export function lengthInside(lines: Ring[], s: Shape): number {
  if (lines.length === 0 || isEmpty(s)) return 0;
  const c = new Clipper();
  c.AddPaths(lines, PolyType.ptSubject, false);
  c.AddPaths(s, PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipType.ctIntersection, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  let len = 0;
  for (const l of Clipper.OpenPathsFromPolyTree(tree))
    for (let i = 1; i < l.length; i++) len += Math.hypot(l[i].X - l[i - 1].X, l[i].Y - l[i - 1].Y);
  return len / S;
}
