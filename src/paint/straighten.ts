// SNAP-111: the stretches of a freeform outline that follow nothing become straight lines with square corners.
import RBush from "rbush";
import { type Pt, type Ring, type Shape, isEmpty, toI, union } from "../geo/clip";

type Seg = { minX: number; minY: number; maxX: number; maxY: number; a: Pt; b: Pt };

const ON_EDGE = 0.1; // m; a vertex this close to an anchor's outline follows it
const SQUARE = (20 * Math.PI) / 180; // a corner within this of a right angle is made one

/**
 * Straightens every run of outline vertices of `s` that lies off the outlines of `anchors`. The vertices that
 * stay are the anchored ones at each end of the run, and any between that stray farther than `tolM` from the
 * line through the rest (Douglas–Peucker). A kept corner close to a right angle is made one.
 */
export function straighten(s: Shape, anchors: Shape[], tolM: number): Shape {
  if (isEmpty(s) || tolM <= 0) return s;
  const tree = new RBush<Seg>();
  const segs: Seg[] = [];
  for (const shape of anchors)
    for (const r of shape)
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        segs.push({ minX: Math.min(a.X, b.X), minY: Math.min(a.Y, b.Y), maxX: Math.max(a.X, b.X), maxY: Math.max(a.Y, b.Y), a, b });
      }
  tree.load(segs);
  const eps = toI(ON_EDGE);
  const anchored = (p: Pt) => {
    for (const g of tree.search({ minX: p.X - eps, minY: p.Y - eps, maxX: p.X + eps, maxY: p.Y + eps }))
      if (distToSeg(p, g.a, g.b) <= eps) return true;
    return false;
  };
  const tol = toI(tolM);
  let changed = false;
  const rings = s.map((r) => {
    const fixed = r.map(anchored);
    if (fixed.every(Boolean)) return r;
    changed = true;
    return straightenRing(r, fixed, tol);
  });
  return changed ? union(rings.filter((r) => r.length >= 3)) : s;
}

function straightenRing(r: Ring, fixed: boolean[], tol: number): Ring {
  const n = r.length;
  let start = fixed.indexOf(true);
  if (start < 0) {
    // Nothing anchors this ring: keep the two vertices farthest apart, and straighten both halves between them.
    let far = 0, best = -1;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(r[i].X - r[0].X, r[i].Y - r[0].Y);
      if (d > best) [far, best] = [i, d];
    }
    const half1 = r.slice(0, far + 1), half2 = [...r.slice(far), r[0]];
    return [...square(simplifyRun(half1, tol)).slice(0, -1), ...square(simplifyRun(half2, tol)).slice(0, -1)];
  }
  const out: Ring = [];
  let i = start;
  do {
    out.push(r[i]);
    let j = (i + 1) % n;
    if (!fixed[j]) {
      const run: Ring = [r[i]];
      while (!fixed[j]) {
        run.push(r[j]);
        j = (j + 1) % n;
      }
      run.push(r[j]);
      out.push(...square(simplifyRun(run, tol)).slice(1, -1));
    }
    i = j;
  } while (i !== start);
  return out;
}

/** Douglas–Peucker over an open run, keeping both ends. */
function simplifyRun(run: Ring, tol: number): Ring {
  const keep = new Uint8Array(run.length);
  keep[0] = keep[run.length - 1] = 1;
  const stack: [number, number][] = [[0, run.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, at = -1;
    for (let k = a + 1; k < b; k++) {
      const d = distToLine(run[k], run[a], run[b]);
      if (d > worst) [worst, at] = [d, k];
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return run.filter((_, k) => keep[k]);
}

/** Moves each inner corner that is nearly square onto the circle over its neighbours, which makes it square. */
function square(run: Ring): Ring {
  const out = run.slice();
  for (let k = 1; k < out.length - 1; k++) {
    const p = out[k - 1], v = out[k], q = out[k + 1];
    const a1 = Math.atan2(p.Y - v.Y, p.X - v.X), a2 = Math.atan2(q.Y - v.Y, q.X - v.X);
    let ang = Math.abs(a1 - a2);
    if (ang > Math.PI) ang = 2 * Math.PI - ang;
    if (Math.abs(ang - Math.PI / 2) > SQUARE) continue;
    const cx = (p.X + q.X) / 2, cy = (p.Y + q.Y) / 2;
    const rad = Math.hypot(q.X - p.X, q.Y - p.Y) / 2;
    const d = Math.hypot(v.X - cx, v.Y - cy);
    if (d === 0) continue;
    out[k] = { X: Math.round(cx + ((v.X - cx) * rad) / d), Y: Math.round(cy + ((v.Y - cy) * rad) / d) };
  }
  return out;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const ex = b.X - a.X, ey = b.Y - a.Y;
  const l2 = ex * ex + ey * ey;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.X - a.X) * ex + (p.Y - a.Y) * ey) / l2));
  return Math.hypot(p.X - (a.X + t * ex), p.Y - (a.Y + t * ey));
}

function distToLine(p: Pt, a: Pt, b: Pt): number {
  const ex = b.X - a.X, ey = b.Y - a.Y;
  const l = Math.hypot(ex, ey);
  if (l === 0) return Math.hypot(p.X - a.X, p.Y - a.Y);
  return Math.abs((p.X - a.X) * ey - (p.Y - a.Y) * ex) / l;
}
