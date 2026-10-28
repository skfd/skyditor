// Rough strokes a mapper might paint inside a truth polygon: an outline pass a brush radius in from the
// edge, then rows across the middle, the whole trail wobbled by a smooth random field.
import { type Shape, area, components, contains, isEmpty, offset, toI, toM } from "../../src/geo/clip";

export type Pt = [number, number];

export interface StrokeOptions {
  /** Brush radius for a part of this area (m²), in metres. */
  radius: (areaM2: number) => number;
  /** Wobble of the trail, × brush radius (RMS per axis). */
  jitter: number;
  /** Typical wavelength of the wobble, m. */
  wavelength: number;
}

export const DEFAULT_STROKES: StrokeOptions = {
  radius: (a) => Math.max(4, Math.min(15, 0.1 * Math.sqrt(a))),
  jitter: 0.3,
  wavelength: 60,
};

const MIN_RADIUS = 2; // m; a mapper zooms in no further than this for a thin strip
const ROW_SPACING = 1.5; // × radius

export interface Plan {
  radius: number;
  trails: Pt[][];
}

/** Strokes for one connected truth part, or null when no brush fits inside it. */
export function planPart(part: Shape, opts: StrokeOptions, rand: () => number): Plan | null {
  let r = opts.radius(area(part));
  let inner = offset(part, -r);
  while (isEmpty(inner) && r > MIN_RADIUS) {
    r = Math.max(MIN_RADIUS, r / 1.5);
    inner = offset(part, -r);
  }
  if (isEmpty(inner)) return null;
  const wobble = field(rand, opts.jitter * r, opts.wavelength);
  const trails: Pt[][] = [];
  // Outline: the brush edge runs along the truth edge.
  for (const ring of inner) {
    const pts = ring.map((p) => [toM(p.X), toM(p.Y)] as Pt);
    pts.push(pts[0]);
    trails.push(pts);
  }
  // Rows across what the outline pass leaves, joined where the join stays inside.
  const middle = offset(part, -2 * r);
  const joinable = offset(part, -0.5 * r);
  let cur: Pt[] | null = null;
  let flip = false;
  for (const c of components(middle)) {
    const ys = rowsOf(c, ROW_SPACING * r);
    for (const y of ys) {
      const runs = scan(c, y);
      if (flip) runs.reverse().forEach((s) => s.reverse());
      flip = !flip;
      for (const [a, b] of runs) {
        const pa: Pt = [a, y], pb: Pt = [b, y];
        if (cur && inside(joinable, cur[cur.length - 1], pa)) cur.push(pa, pb);
        else {
          cur = [pa, pb];
          trails.push(cur);
        }
      }
    }
  }
  return { radius: r, trails: trails.map((t) => t.map(wobble)) };
}

function rowsOf(s: Shape, step: number): number[] {
  let lo = Infinity, hi = -Infinity;
  for (const r of s) for (const p of r) [lo, hi] = [Math.min(lo, toM(p.Y)), Math.max(hi, toM(p.Y))];
  const n = Math.max(1, Math.round((hi - lo) / step));
  return Array.from({ length: n }, (_, i) => lo + ((i + 0.5) * (hi - lo)) / n);
}

/** Even-odd intervals of a horizontal line through the shape, west to east. */
function scan(s: Shape, y: number): [number, number][] {
  const Y = toI(y) + 0.5; // never exactly on a vertex
  const xs: number[] = [];
  for (const r of s)
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      if (p.Y < Y !== q.Y < Y) xs.push(toM(p.X + ((Y - p.Y) * (q.X - p.X)) / (q.Y - p.Y)));
    }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 0.5) out.push([xs[i], xs[i + 1]]);
  return out;
}

function inside(s: Shape, a: Pt, b: Pt): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
  for (let i = 0; i <= n; i++)
    if (!contains(s, toI(a[0] + ((b[0] - a[0]) * i) / n), toI(a[1] + ((b[1] - a[1]) * i) / n))) return false;
  return true;
}

/** A smooth displacement field: three plane waves per axis, RMS `amp` per axis. */
function field(rand: () => number, amp: number, wavelength: number): (p: Pt) => Pt {
  const waves = (n: number) =>
    Array.from({ length: n }, () => {
      const dir = rand() * Math.PI * 2;
      const k = (Math.PI * 2) / (wavelength * (0.5 + rand() * 0.5));
      return { kx: Math.cos(dir) * k, ky: Math.sin(dir) * k, ph: rand() * Math.PI * 2 };
    });
  const wx = waves(3), wy = waves(3);
  const a = amp * Math.sqrt(2 / 3);
  const at = (ws: typeof wx, x: number, y: number) => ws.reduce((s, w) => s + Math.sin(w.kx * x + w.ky * y + w.ph), 0);
  return ([x, y]) => [x + a * at(wx, x, y), y + a * at(wy, x, y)];
}

export function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
