// One press–drag–release gesture (PAINT-*, SNAP-001..006, DENS-*).
import { type BBox, type Ring, type Shape, area, bbox, contains, expandBBox, intersect, isEmpty, shapeCentroid, toI, toM } from "../geo/clip";
import { type Kind, KINDS, tierKind } from "../model/kinds";
import type { Step } from "../model/history";
import { type Atom, type Piece, World, makePiece, normalize } from "../model/world";
import { TUNE } from "../tuning";
import { distToSegment, samplesOf } from "./samples";
import {
  type Freeform, type Tool, applyRegion, changes, claimWhole, freeformIn, settleForContext, settles, strokeShape, toolKind,
  unitLimit,
} from "./snap";

export type StrokeEvent =
  | { type: "claim"; piece: Piece | null; region: Shape; prevKind: Kind | null; at: [number, number]; whole: boolean }
  | { type: "tier"; piece: Piece; prevKind: Kind; at: [number, number] }
  | { type: "bump"; piece: Piece; at: [number, number] }
  | { type: "reject"; at: [number, number] };

interface Coverage {
  covered: Uint8Array;
  count: number;
}

export class Stroke {
  readonly trail: [number, number][] = []; // metres
  readonly preview = new Map<Atom, Freeform>(); // SNAP-105
  readonly coverage = new Map<Piece, Coverage>(); // SNAP-002
  private readonly before = new Map<Atom, Piece[]>(); // undo snapshots (PAINT-005)
  private readonly densityDone = new Set<Piece>();
  private readonly dirty = new Set<Atom>();
  private rejected = false;
  readonly limit: number;

  constructor(
    readonly world: World,
    readonly tool: Tool,
    readonly radius: number, // m, fixed for the stroke (PAINT-001)
    x: number,
    y: number,
    readonly tapMove = 0, // m; how far the cursor may move while the stroke can still be a tap (DISP-004)
  ) {
    this.limit = unitLimit(radius);
    this.trail.push([x, y]);
  }

  /** Adds the first dab. Kept apart from the constructor so callers can collect its events. */
  start(): StrokeEvent[] {
    const [x, y] = this.trail[0];
    return this.segment(x, y, x, y);
  }

  /** PAINT-002 */
  move(x: number, y: number): StrokeEvent[] {
    const [lx, ly] = this.trail[this.trail.length - 1];
    if (Math.hypot(x - lx, y - ly) < TUNE.TRAIL_STEP * this.radius) return [];
    this.trail.push([x, y]);
    return this.segment(lx, ly, x, y);
  }

  private segment(ax: number, ay: number, bx: number, by: number): StrokeEvent[] {
    if (this.tool.type === "density") return this.densityAlong(ax, ay, bx, by);
    const events: StrokeEvent[] = [];
    // PAINT-009
    if (!this.rejected) {
      const p = this.world.pieceAt(toI(bx), toI(by));
      const onLand = p !== null || this.world.atomAt(toI(bx), toI(by)) !== null;
      // DISP-005: disputed context rejects only once the stroke can no longer be a settling tap (DISP-004).
      const [sx, sy] = this.trail[0];
      const mayTap = settles(this.tool, p) && Math.hypot(bx - sx, by - sy) <= this.tapMove;
      if ((p && p.kind === "CTX" && !mayTap) || (!onLand && contains(this.world.water, toI(bx), toI(by)))) {
        this.rejected = true;
        events.push({ type: "reject", at: [bx, by] });
      }
    }
    const r = this.radius;
    const box = expandBBox(
      { minX: toI(Math.min(ax, bx)), minY: toI(Math.min(ay, by)), maxX: toI(Math.max(ax, bx)), maxY: toI(Math.max(ay, by)) },
      toI(r),
    );
    for (const atom of this.world.atomsIn(box)) {
      this.dirty.add(atom);
      for (const p of atom.pieces) {
        if (p.area > this.limit || !changes(this.tool, p)) continue;
        if (p.bbox.maxX < box.minX || p.bbox.minX > box.maxX || p.bbox.maxY < box.minY || p.bbox.minY > box.maxY) continue;
        const s = samplesOf(p);
        let cov = this.coverage.get(p);
        if (!cov) {
          cov = { covered: new Uint8Array(s.length / 2), count: 0 };
          this.coverage.set(p, cov);
        }
        for (let i = 0; i < s.length; i += 2) {
          if (cov.covered[i / 2]) continue;
          if (distToSegment(s[i], s[i + 1], ax, ay, bx, by) <= r) {
            cov.covered[i / 2] = 1;
            cov.count++;
          }
        }
        // SNAP-003
        if (cov.count / cov.covered.length >= TUNE.CLAIM_COVERAGE) events.push(this.claim(atom, p));
      }
    }
    return events;
  }

  private snapshot(atom: Atom) {
    if (!this.before.has(atom)) this.before.set(atom, atom.pieces);
  }

  private claim(atom: Atom, p: Piece): StrokeEvent {
    this.snapshot(atom);
    const kind = toolKind(this.tool);
    atom.pieces = claimWhole(atom, p, kind);
    this.coverage.delete(p);
    this.dirty.add(atom);
    const [cx, cy] = shapeCentroid(p.shape);
    const piece = kind === null ? null : pieceCovering(atom, p, kind);
    return { type: "claim", piece, region: p.shape, prevKind: p.kind, at: [cx / TUNE.GEOM_SCALE, cy / TUNE.GEOM_SCALE], whole: true };
  }

  /** DISP-004 */
  private settle(p: Piece): StrokeEvent {
    for (const [atom, pieces] of settleForContext(this.world, p)) {
      this.snapshot(atom);
      atom.pieces = pieces;
    }
    const atom = this.world.atoms[p.atom];
    const piece = atom.pieces.find((q) => q.kind === "CTX" && !q.rival && overlaps(q, p.shape) && q.area >= p.area - 0.01) ?? null;
    const [cx, cy] = shapeCentroid(p.shape);
    return { type: "claim", piece, region: p.shape, prevKind: "CTX", at: [cx / TUNE.GEOM_SCALE, cy / TUNE.GEOM_SCALE], whole: true };
  }

  /** DENS-002..DENS-005 */
  private densityAlong(ax: number, ay: number, bx: number, by: number): StrokeEvent[] {
    if (this.tool.type !== "density") return [];
    const dir = this.tool.dir;
    const events: StrokeEvent[] = [];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 1));
    for (let i = 0; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n, y = ay + ((by - ay) * i) / n;
      const p = this.world.pieceAt(toI(x), toI(y));
      if (!p || p.kind === null || this.densityDone.has(p)) continue;
      this.densityDone.add(p);
      const tier = KINDS[p.kind].tier;
      // DENS-004 / DISP-005: disputed context is rejected like any other non-residential land.
      if (tier === undefined) {
        if (!this.rejected) events.push({ type: "reject", at: [x, y] });
        this.rejected = true;
        continue;
      }
      const next = tier + dir;
      if (next < 1 || next > 6) {
        events.push({ type: "bump", piece: p, at: [x, y] });
        continue;
      }
      const atom = this.world.atoms[p.atom];
      this.snapshot(atom);
      // DISP-001: a density step answers the dispute, so the stepped piece has no rival.
      const stepped = makePiece(atom, tierKind(next), p.shape, { source: p.source, modified: !!p.source });
      atom.pieces = normalize(atom, [...atom.pieces.filter((q) => q !== p), stepped]);
      const result = pieceCovering(atom, p, stepped.kind!);
      if (result) {
        this.densityDone.add(result);
        events.push({ type: "tier", piece: result, prevKind: p.kind, at: [x, y] });
      }
    }
    return events;
  }

  /**
   * SNAP-101 + SNAP-105: recomputes the freeform preview for atoms the stroke touched since last time.
   * Stops once `budgetMs` is spent; the remaining atoms stay dirty for the next call.
   */
  updatePreview(budgetMs = Infinity) {
    if (this.tool.type === "density" || this.dirty.size === 0) return;
    const t0 = performance.now();
    for (const atom of this.dirty) {
      const shape = this.strokeShapeNear(atom.bbox);
      const ff = shape.length ? freeformIn(this.world, atom, shape, this.tool, this.radius) : null;
      if (ff) this.preview.set(atom, ff);
      else this.preview.delete(atom);
      this.dirty.delete(atom);
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  get previewPending() {
    return this.dirty.size > 0;
  }

  /**
   * SNAP-101, built only from the trail runs that come near `b`: smoothing reaches no further than
   * the brush radius plus the smoothing radius, so the far parts of a long stroke cannot matter.
   */
  strokeShapeNear(b: BBox): Shape {
    const reach = toI(this.radius * (1 + TUNE.SMOOTH_FACTOR) + 1);
    const box = expandBBox(b, reach);
    const near = (x: number, y: number) => {
      const X = toI(x), Y = toI(y);
      return X >= box.minX && X <= box.maxX && Y >= box.minY && Y <= box.maxY;
    };
    const runs: Ring[] = [];
    let run: Ring | null = null;
    const t = this.trail;
    for (let i = 0; i < t.length; i++) {
      // A segment counts if its bbox meets the box; keep both of its ends.
      const prev = t[i - 1], cur = t[i];
      const segNear =
        i === 0
          ? near(cur[0], cur[1])
          : !(Math.max(prev[0], cur[0]) < toM(box.minX) || Math.min(prev[0], cur[0]) > toM(box.maxX) ||
              Math.max(prev[1], cur[1]) < toM(box.minY) || Math.min(prev[1], cur[1]) > toM(box.maxY));
      if (segNear) {
        if (!run) {
          run = i > 0 ? [{ X: toI(prev[0]), Y: toI(prev[1]) }] : [];
          runs.push(run);
        }
        run.push({ X: toI(cur[0]), Y: toI(cur[1]) });
      } else run = null;
    }
    return runs.length ? strokeShape(runs, this.radius) : [];
  }

  /** PAINT-005 / SNAP-004 / SNAP-006 / SNAP-106: commits and returns the undo step (or null, PAINT-006). */
  end(isTap: boolean): { events: StrokeEvent[]; step: Step | null } {
    const events: StrokeEvent[] = [];
    const kind = toolKind(this.tool);
    const [sx, sy] = this.trail[0];
    if (this.tool.type !== "density") {
      const p = this.world.pieceAt(toI(sx), toI(sy));
      if (isTap && settles(this.tool, p)) {
        // DISP-004: a tap on disputed context settles it for the context, whatever its size, and does nothing else.
        events.push(this.settle(p));
        this.preview.clear();
      } else {
        // SNAP-004: a tap claims the whole unit piece under it.
        if (isTap && p && p.area <= this.limit && changes(this.tool, p)) events.push(this.claim(this.world.atoms[p.atom], p));
        // DISP-005: a press held on disputed context without moving is no tap, and changes nothing there.
        if (!isTap && !this.rejected && settles(this.tool, p)) {
          this.rejected = true;
          events.push({ type: "reject", at: [sx, sy] });
        }
        this.updatePreview();
      }
      for (const [atom, ff] of this.preview) {
        if (isEmpty(ff.region)) continue;
        this.snapshot(atom);
        const prev = atom.pieces;
        const { pieces, region } = applyRegion(atom, ff, kind);
        atom.pieces = pieces;
        const [cx, cy] = shapeCentroid(region);
        const covering = kind === null ? null : pieces.find((p) => p.kind === kind && overlaps(p, region)) ?? null;
        const prevKind = dominantKind(prev, region);
        events.push({ type: "claim", piece: covering, region, prevKind, at: [cx / TUNE.GEOM_SCALE, cy / TUNE.GEOM_SCALE], whole: false });
      }
      this.preview.clear();
    }
    this.coverage.clear(); // SNAP-006
    const atoms = [...this.before].filter(([a, b]) => a.pieces !== b).map(([atom, before]) => ({ atom, before, after: atom.pieces }));
    return { events, step: atoms.length ? { atoms } : null };
  }

  /** PAINT-010: reverts everything the stroke changed. Returns what was reverted, for the settle animation only. */
  cancel(): Step | null {
    const atoms = [...this.before].filter(([a, b]) => a.pieces !== b).map(([atom, before]) => ({ atom, before, after: atom.pieces }));
    for (const a of atoms) a.atom.pieces = a.before;
    this.preview.clear();
    this.coverage.clear();
    this.dirty.clear();
    return atoms.length ? { atoms } : null;
  }
}

const overlaps = (p: Piece, region: Shape) => {
  const b = bbox(region);
  return p.bbox.minX <= b.maxX && p.bbox.maxX >= b.minX && p.bbox.minY <= b.maxY && p.bbox.maxY >= b.minY;
};

/** The piece of `kind` in `atom` that now covers where `old` was. */
function pieceCovering(atom: Atom, old: Piece, kind: Kind): Piece | null {
  return atom.pieces.find((p) => p.kind === kind && overlaps(p, old.shape) && p.area >= old.area - 0.01) ?? null;
}

/** The kind that held most of `region` before the change (for the pop's starting height). */
function dominantKind(pieces: Piece[], region: Shape): Kind | null {
  let best: Kind | null = null;
  let bestA = 0;
  for (const p of pieces) {
    if (!overlaps(p, region)) continue;
    const a = area(intersect(p.shape, region));
    if (a > bestA) [best, bestA] = [p.kind, a];
  }
  return best;
}
