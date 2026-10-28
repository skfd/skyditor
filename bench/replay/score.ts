// Scores a painted square against its truth, and the truth against the same yardsticks, so the editor's
// numbers always sit next to what careful mappers drew. Metrics follow research/landuse-edges/analyze.py.
import RBush from "rbush";
import { type Shape, area, bbox, intersect, isEmpty, simplify, toI, toM, union } from "../../src/geo/clip";
import type { PaintKind } from "../../src/model/kinds";
import { CORE_HALF, type Square } from "./square";

const STEP = 2; // m between boundary samples
const EDGE_MARGIN = 1; // m; samples this close to the core edge are where clipping drew the edge
const INNER = 20; // m from every barrier centreline for an edge to count as inside the block
const BIN = 0.25; // m, histogram bin
const CAP = 50; // m, farthest distance measured
const FENCE = new Set(["fence", "wall", "hedge", "retaining_wall", "city_wall"]);

/** What an edge sample runs along, first match wins (as in analyze.py). */
const TARGETS = [
  ["fence", 1],
  ["building", 1],
  ["context", 0.5],
  ["minor way", 1],
  ["street", 0.5],
] as const;
export type Target = (typeof TARGETS)[number][0] | "nothing";

export type Hist = Record<number, number>;

export interface EdgeScore {
  edge_m: number;
  inner_m: number;
  follows: Partial<Record<Target, number>>; // inner samples by first match
  nothing_turns: number; // vertices turning ≥ 5° on inner edges that follow nothing
  turns: number; // all vertices turning ≥ 5°
  buildings: { touching: number; split: number };
}

export interface Score {
  truth_m2: number;
  result_m2: number;
  overlap_m2: number;
  d_result: Hist; // result edge → nearest truth edge of the same kind
  d_truth: Hist; // truth edge → nearest result edge of the same kind
  result: EdgeScore;
  truth: EdgeScore;
}

type Seg = { minX: number; minY: number; maxX: number; maxY: number; ax: number; ay: number; bx: number; by: number };

/** Nearest distance from a point to a set of line segments, in metres. */
class Lines {
  private tree = new RBush<Seg>();
  constructor(lines: [number, number][][]) {
    const segs: Seg[] = [];
    for (const l of lines)
      for (let i = 1; i < l.length; i++) {
        const [ax, ay] = l[i - 1], [bx, by] = l[i];
        segs.push({ minX: Math.min(ax, bx), minY: Math.min(ay, by), maxX: Math.max(ax, bx), maxY: Math.max(ay, by), ax, ay, bx, by });
      }
    this.tree.load(segs);
  }
  /** Infinity when nothing lies within `max`. */
  dist(x: number, y: number, max = CAP): number {
    for (let r = Math.min(2, max); ; r = Math.min(r * 4, max)) {
      let best = Infinity;
      for (const s of this.tree.search({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r }))
        best = Math.min(best, segDist(x, y, s));
      if (best <= r) return best;
      if (r >= max) return Infinity;
    }
  }
}

function segDist(px: number, py: number, s: Seg) {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / l2)) : 0;
  return Math.hypot(s.ax + t * dx - px, s.ay + t * dy - py);
}

const ringsM = (s: Shape): [number, number][][] =>
  s.map((r) => {
    const pts = r.map((p) => [toM(p.X), toM(p.Y)] as [number, number]);
    pts.push(pts[0]);
    return pts;
  });

const floatLine = (a: Float32Array): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
  return out;
};

const inCore = (x: number, y: number) => Math.abs(x) < CORE_HALF - EDGE_MARGIN && Math.abs(y) < CORE_HALF - EDGE_MARGIN;

/** Boundary samples every STEP metres, inside the core. */
function samples(s: Shape): [number, number][] {
  const out: [number, number][] = [];
  for (const ring of ringsM(s))
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STEP));
      for (let k = 0; k < n; k++) {
        const x = ax + ((bx - ax) * (k + 0.5)) / n, y = ay + ((by - ay) * (k + 0.5)) / n;
        if (inCore(x, y)) out.push([x, y]);
      }
    }
  return out;
}

const addHist = (h: Hist, d: number) => {
  const b = Math.min(Math.floor(d / BIN), CAP / BIN);
  h[b] = (h[b] ?? 0) + 1;
};

export interface Yardsticks {
  targets: [Target, Lines, number][];
  barriers: Lines;
  buildings: { shape: Shape; area: number; x: number; y: number }[];
}

export function yardsticks(sq: Square): Yardsticks {
  const { features: f, osm, world } = sq;
  const fences: [number, number][][] = [];
  for (const w of osm.ways.values()) {
    if (!FENCE.has(w.tags.barrier ?? "")) continue;
    const pts: [number, number][] = [];
    for (const id of w.nodes) {
      const n = osm.nodes.get(id);
      if (n) pts.push([f.proj.x(n[0]), f.proj.y(n[1])]);
    }
    if (pts.length >= 2) fences.push(pts);
  }
  const ctx = world.features.areas.filter((a) => a.klass.cls === "exclusive" || a.klass.cls === "overlay");
  const lines: Record<string, [number, number][][]> = {
    fence: fences,
    building: f.buildings.map((b) => floatLine(b.ring)),
    context: ctx.flatMap((a) => ringsM(a.shape)),
    "minor way": f.minorLines.map((l) => floatLine(l.pts)),
    street: [...ringsM(world.streets), ...ringsM(world.water)],
  };
  const buildings = f.buildings.flatMap((b) => {
    const shape = union([floatLine(b.ring).map(([x, y]) => ({ X: toI(x), Y: toI(y) }))]);
    const bb = bbox(shape);
    const x = toM((bb.minX + bb.maxX) / 2), y = toM((bb.minY + bb.maxY) / 2);
    return inCore(x, y) && !isEmpty(shape) ? [{ shape, area: area(shape), x, y }] : [];
  });
  return {
    targets: TARGETS.map(([t, tol]) => [t, new Lines(lines[t]), tol]),
    barriers: new Lines(f.barriers.map((b) => ringsM([b.line])[0].slice(0, -1))),
    buildings,
  };
}

/** Edge, turn and building yardsticks for one set of landuse shapes, one per kind. */
function edgeScore(byKind: Map<PaintKind, Shape>, y: Yardsticks): EdgeScore {
  const sc: EdgeScore = { edge_m: 0, inner_m: 0, follows: {}, nothing_turns: 0, turns: 0, buildings: { touching: 0, split: 0 } };
  const classify = (x: number, yy: number): Target => {
    for (const [t, lines, tol] of y.targets) if (lines.dist(x, yy, tol) <= tol) return t;
    return "nothing";
  };
  for (const shape of byKind.values()) {
    for (const [x, yy] of samples(shape)) {
      sc.edge_m += STEP;
      if (y.barriers.dist(x, yy, INNER) < INNER) continue;
      sc.inner_m += STEP;
      const t = classify(x, yy);
      sc.follows[t] = (sc.follows[t] ?? 0) + STEP;
    }
    for (const ring of simplify(shape, 0.1)) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[(i + ring.length - 1) % ring.length], q = ring[i], r = ring[(i + 1) % ring.length];
        const x = toM(q.X), yy = toM(q.Y);
        if (!inCore(x, yy)) continue;
        const a1 = Math.atan2(q.Y - p.Y, q.X - p.X), a2 = Math.atan2(r.Y - q.Y, r.X - q.X);
        let turn = Math.abs(a2 - a1);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < (5 * Math.PI) / 180) continue;
        sc.turns++;
        if (y.barriers.dist(x, yy, INNER) >= INNER && classify(x, yy) === "nothing") sc.nothing_turns++;
      }
    }
  }
  // Buildings split: touched by landuse with between 5% and 95% of the footprint inside one kind.
  for (const b of y.buildings) {
    let touching = false, split = false;
    for (const shape of byKind.values()) {
      const f = area(intersect(b.shape, shape)) / b.area;
      if (f > 0.001) touching = true;
      if (f > 0.05 && f < 0.95) split = true;
    }
    if (touching) sc.buildings.touching++;
    if (split) sc.buildings.split++;
  }
  return sc;
}

export function score(sq: Square, y: Yardsticks): Score {
  const truthByKind = new Map<PaintKind, Shape>();
  const truthFull = new Map<PaintKind, Shape>();
  for (const t of sq.truth) {
    truthByKind.set(t.kind, union(truthByKind.get(t.kind) ?? [], t.shape));
    truthFull.set(t.kind, union(truthFull.get(t.kind) ?? [], t.full));
  }
  const resultFull = new Map<PaintKind, Shape>();
  for (const a of sq.world.atoms)
    for (const p of a.pieces)
      if (p.kind && truthByKind.has(p.kind as PaintKind))
        resultFull.set(p.kind as PaintKind, union(resultFull.get(p.kind as PaintKind) ?? [], p.shape));
  const resultByKind = new Map([...resultFull].map(([k, s]) => [k, intersect(s, sq.core)]));

  const s: Score = {
    truth_m2: 0, result_m2: 0, overlap_m2: 0, d_result: {}, d_truth: {},
    result: edgeScore(resultByKind, y),
    truth: edgeScore(truthByKind, y),
  };
  for (const [k, t] of truthByKind) {
    const r = resultByKind.get(k) ?? [];
    s.truth_m2 += area(t);
    s.result_m2 += area(r);
    s.overlap_m2 += area(intersect(t, r));
    const tl = new Lines(ringsM(truthFull.get(k)!));
    for (const [x, yy] of samples(r)) addHist(s.d_result, tl.dist(x, yy));
    const rl = new Lines(ringsM(resultFull.get(k) ?? []));
    for (const [x, yy] of samples(t)) addHist(s.d_truth, isEmpty(r) ? CAP : rl.dist(x, yy));
  }
  return s;
}
