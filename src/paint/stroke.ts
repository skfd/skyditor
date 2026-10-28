// One press–drag–release gesture (PAINT-*, SNAP-001..006, DENS-*), on land or on buildings (TYPE-007..TYPE-010).
import { type BBox, type Ring, type Shape, area, bbox, contains, expandBBox, intersect, isEmpty, shapeCentroid, toI, toM } from "../geo/clip";
import { type Building, statusOf, typeAs, untype } from "../model/buildings";
import { type BuildingLook, type Kind, KINDS, tierKind } from "../model/kinds";
import type { Step } from "../model/history";
import { type Atom, type BuildingSet, type Piece, World, makePiece, normalize } from "../model/world";
import { TUNE } from "../tuning";
import { distToSegment, samplesOf } from "./samples";
import {
  type Freeform, type Target, type Tool, applyRegion, changes, claimWhole, freeformIn, isUnit, onBuildings, settleForContext,
  settles, strokeShape, toolKind, unitLimit,
} from "./snap";

export type StrokeEvent =
  | { type: "claim"; piece: Piece | null; region: Shape; prevKind: Kind | null; at: [number, number]; whole: boolean }
  | { type: "tier"; piece: Piece; prevKind: Kind; at: [number, number] }
  | { type: "bump"; piece: Piece; at: [number, number] }
  | { type: "reject"; at: [number, number] }
  // TYPE-007 / TYPE-008 / TYPE-010: a building changed; TYPE-007: an unsure building was passed over.
  | { type: "typed"; building: Building; prevLook: BuildingLook | null; at: [number, number] }
  | { type: "skip"; building: Building; at: [number, number] };

interface Coverage {
  covered: Uint8Array;
  count: number;
}

export class Stroke {
  readonly trail: [number, number][] = []; // metres
  readonly preview = new Map<Atom, Freeform>(); // SNAP-105
  readonly coverage = new Map<Piece, Coverage>(); // SNAP-002
  private readonly before = new Map<Atom, Piece[]>(); // undo snapshots (PAINT-005)
  private readonly beforeB = new Map<BuildingSet, Building[]>(); // TYPE-011
  private readonly densityDone = new Set<Piece>();
  private readonly buildingsDone = new Set<number>(); // geom ids touched by this stroke (TYPE-007, TYPE-008)
  private readonly dirty = new Set<Atom>();
  private rejected = false;
  readonly limit: number;
  readonly onBuildings: boolean; // TYPE-006 / TYPE-007

  constructor(
    readonly world: World,
    readonly tool: Tool,
    readonly radius: number, // m, fixed for the stroke (PAINT-001)
    x: number,
    y: number,
    readonly tapMove = 0, // m; how far the cursor may move while the stroke can still be a tap (DISP-004)
    readonly target: Target = "land",
  ) {
    this.limit = unitLimit(radius);
    this.onBuildings = onBuildings(tool, target);
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
    if (this.onBuildings) return this.buildingsAlong(ax, ay, bx, by);
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
        if (!isUnit(p, this.limit) || !changes(this.tool, p)) continue;
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
      if (next < 1 || next > 6) { // DENS-003: the ladder ends bump instead of wrapping
        events.push({ type: "bump", piece: p, at: [x, y] });
        continue;
      }
      const atom = this.world.atoms[p.atom];
      this.snapshot(atom);
      // DISP-001: a density step answers the dispute, so the stepped piece has no rival.
      const stepped = makePiece(atom, tierKind(next), p.shape, { source: p.source, modified: !!p.source, drawn: p.drawn });
      atom.pieces = normalize(atom, [...atom.pieces.filter((q) => q !== p), stepped]);
      const result = pieceCovering(atom, p, stepped.kind!);
      if (result) {
        this.densityDone.add(result);
        events.push({ type: "tier", piece: result, prevKind: p.kind, at: [x, y] });
      }
    }
    return events;
  }

  /** TYPE-007 / TYPE-008 / TYPE-010: every building whose centre the brush disc passes over, once per stroke. */
  private buildingsAlong(ax: number, ay: number, bx: number, by: number): StrokeEvent[] {
    const events: StrokeEvent[] = [];
    const r = this.radius;
    const box = expandBBox(
      { minX: toI(Math.min(ax, bx)), minY: toI(Math.min(ay, by)), maxX: toI(Math.max(ax, bx)), maxY: toI(Math.max(ay, by)) },
      toI(r),
    );
    for (const g of this.world.buildingsIn(box)) {
      if (this.buildingsDone.has(g.id)) continue;
      if (distToSegment(toM(g.cx), toM(g.cy), ax, ay, bx, by) > r) continue;
      events.push(...this.touchBuilding(this.world.building(g), [toM(g.cx), toM(g.cy)]));
    }
    return events;
  }

  /** What this stroke's tool does to one building. Reject feedback plays at most once per stroke (TYPE-009). */
  private touchBuilding(b: Building, at: [number, number]): StrokeEvent[] {
    this.buildingsDone.add(b.geom.id);
    const reject = (): StrokeEvent[] => {
      if (this.rejected) return [];
      this.rejected = true;
      return [{ type: "reject", at }];
    };
    const status = statusOf(b);
    let next: Building | null = null;
    if (this.tool.type === "agree") {
      // TYPE-007: only a guessed building takes an agree stroke; an unsure one is shown skipped.
      const g = this.world.guessOf(b);
      if (!g) return [];
      if (!g.look) return [{ type: "skip", building: b, at }];
      next = typeAs(b, g.look);
    } else if (this.tool.type === "paint") {
      if (status === "protected" || this.tool.kind === "R1") return reject(); // TYPE-009
      next = typeAs(b, this.tool.kind); // TYPE-008: null when it already is that kind
    } else if (this.tool.type === "erase") {
      if (status === "protected") return reject(); // TYPE-009
      next = untype(b); // TYPE-010
    }
    if (!next) return [];
    const set = this.world.setOf(b.geom);
    if (!this.beforeB.has(set)) this.beforeB.set(set, set.items); // TYPE-011
    set.items = set.items.map((o) => (o === b ? next! : o));
    return [{ type: "typed", building: next, prevLook: b.look, at }];
  }

  /**
   * SNAP-101 + SNAP-105: recomputes the freeform preview for atoms the stroke touched since last time.
   * Stops once `budgetMs` is spent; the remaining atoms stay dirty for the next call.
   */
  updatePreview(budgetMs = Infinity) {
    if (this.tool.type === "density" || this.onBuildings || this.dirty.size === 0) return;
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
    if (this.onBuildings) {
      // TYPE-007 / TYPE-008 / TYPE-010: a tap takes the building under it, however small the brush.
      const b = isTap ? this.world.buildingAt(toI(sx), toI(sy)) : null;
      if (b && !this.buildingsDone.has(b.geom.id)) events.push(...this.touchBuilding(b, [sx, sy]));
    } else if (this.tool.type !== "density") {
      const p = this.world.pieceAt(toI(sx), toI(sy));
      if (isTap && settles(this.tool, p)) {
        // DISP-004: a tap on disputed context settles it for the context, whatever its size, and does nothing else.
        events.push(this.settle(p));
        this.preview.clear();
      } else {
        // SNAP-004: a tap claims the whole unit piece under it.
        if (isTap && p && isUnit(p, this.limit) && changes(this.tool, p)) events.push(this.claim(this.world.atoms[p.atom], p));
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
    const buildings = this.buildingSteps();
    return { events, step: atoms.length || buildings.length ? { atoms, buildings } : null };
  }

  /** TYPE-011 */
  private buildingSteps() {
    return [...this.beforeB].filter(([s, b]) => s.items !== b).map(([set, before]) => ({ set, before, after: set.items }));
  }

  /** PAINT-010: reverts everything the stroke changed. Returns what was reverted, for the settle animation only. */
  cancel(): Step | null {
    const atoms = [...this.before].filter(([a, b]) => a.pieces !== b).map(([atom, before]) => ({ atom, before, after: atom.pieces }));
    for (const a of atoms) a.atom.pieces = a.before;
    const buildings = this.buildingSteps();
    for (const b of buildings) b.set.items = b.before;
    this.preview.clear();
    this.coverage.clear();
    this.dirty.clear();
    return atoms.length || buildings.length ? { atoms, buildings } : null;
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
