// One press–drag–release gesture (PAINT-*, SNAP-001..006, DENS-*), on land or on buildings (TYPE-007..TYPE-010).
import { type BBox, type Ring, type Shape, area, bbox, contains, expandBBox, intersect, isEmpty, shapeCentroid, toI, toM } from "../geo/clip";
import { type Building, statusOf, typeAs, untype } from "../model/buildings";
import { type BuildingLook, type Kind, KINDS, tierKind } from "../model/kinds";
import { settleBridges } from "../model/capture";
import type { Step } from "../model/history";
import { type Atom, type BuildingSet, type Piece, World, makePiece, normalize } from "../model/world";
import { TUNE } from "../tuning";
import { distToSegment, samplesOf } from "./samples";
import {
  type Freeform, type Target, type Tool, applyRegion, changes, claimWhole, freeformIn, isUnit, onBuildings, rejects,
  settleForContext, settles, stillLoading, strokeShape, toolKind, unitLimit, wholeAs,
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

type BuildingEffect = Building | "reject" | "skip" | null;

/** What `tool` does to one building: its changed copy, a reject (TYPE-009), a skip (TYPE-007), or nothing. */
function buildingEffect(world: World, tool: Tool, b: Building): BuildingEffect {
  const status = statusOf(b);
  if (tool.type === "agree") {
    // TYPE-007: only a guessed building takes an agree stroke; an unsure one is shown skipped.
    const g = world.guessOf(b);
    if (!g) return null;
    return g.look ? typeAs(b, g.look) : "skip";
  }
  if (tool.type === "paint") {
    if (status === "protected" || tool.kind === "R1") return "reject"; // TYPE-009
    return typeAs(b, tool.kind); // TYPE-008: null when it already is that kind
  }
  if (tool.type === "erase") {
    if (status === "protected") return "reject"; // TYPE-009
    return untype(b); // TYPE-010
  }
  return null;
}

/** CORR-004: whether a tap with `tool` would change `b`, so pointing at it should light it up. */
export function changesBuilding(world: World, tool: Tool, b: Building): boolean {
  const e = buildingEffect(world, tool, b);
  return e !== null && typeof e === "object";
}

export class Stroke {
  readonly trail: [number, number][] = []; // metres
  readonly preview = new Map<Atom, Freeform>(); // SNAP-105
  readonly coverage = new Map<Piece, Coverage>(); // SNAP-002
  private readonly before = new Map<Atom, Piece[]>(); // undo snapshots (PAINT-005)
  private readonly beforeB = new Map<BuildingSet, Building[]>(); // TYPE-011
  private readonly densityDone = new Set<Piece>();
  private readonly wholes = new Map<string, { pieces: Piece[]; total: number }>(); // NAME-002: samples of each named area
  private readonly wholesDone = new Set<string>(); // NAME-002: named areas this stroke has claimed
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
    readonly mark = 0, // m; the radius of an unsure building's mark, which a tap lands in too (CORR-005)
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
      // NAME-003: a tool that would split a named residential area rejects like protected land. LOAD-015: so
      // does any paint on one still loading; a tap rejects here too, at its first dab.
      if ((p && p.kind === "CTX" && !mayTap) || rejects(this.tool, p, this.world.loading) || (!onLand && contains(this.world.water, toI(bx), toI(by)))) {
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
      if (atom.bridge) continue; // CAP-008: street land is never painted; end() gives it back instead
      this.dirty.add(atom);
      for (const p of atom.pieces) {
        if (!isUnit(p, this.limit) || !changes(this.tool, p, this.world.loading)) continue; // LOAD-015: never charged
        if (p.whole && this.wholesDone.has(p.source!)) continue; // NAME-002: already claimed whole
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
        if (this.charge(p) >= TUNE.CLAIM_COVERAGE) events.push(...this.claim(atom, p));
      }
    }
    return events;
  }

  private snapshot(atom: Atom) {
    if (!this.before.has(atom)) this.before.set(atom, atom.pieces);
  }

  /** NAME-002: the pieces of the named area `p` belongs to, and their sample count; null for any other piece. */
  private whole(p: Piece) {
    if (!p.whole || !p.source) return null;
    let w = this.wholes.get(p.source);
    if (!w) {
      const pieces = this.world.wholeOf(p.source).map((x) => x.piece);
      w = { pieces, total: pieces.reduce((n, q) => n + samplesOf(q).length / 2, 0) };
      this.wholes.set(p.source, w);
    }
    return w;
  }

  /** SNAP-002: the covered fraction of a unit piece. NAME-002: a named area charges as one, over all its pieces. */
  private charge(p: Piece): number {
    const w = this.whole(p);
    if (!w) {
      const cov = this.coverage.get(p);
      return cov ? cov.count / cov.covered.length : 0;
    }
    let n = 0;
    for (const q of w.pieces) n += this.coverage.get(q)?.count ?? 0;
    return w.total > 0 ? n / w.total : 0;
  }

  /** SNAP-005: each charging unit piece and its covered fraction; a named area's pieces all charge together (NAME-002). */
  *charging(): Iterable<[Piece, number]> {
    const seen = new Set<string>();
    for (const [p, cov] of this.coverage) {
      if (cov.count === 0) continue;
      const w = this.whole(p);
      if (!w) {
        yield [p, cov.count / cov.covered.length];
        continue;
      }
      if (seen.has(p.source!)) continue;
      seen.add(p.source!);
      const k = this.charge(p);
      for (const q of w.pieces) yield [q, k];
    }
  }

  private claim(atom: Atom, p: Piece): StrokeEvent[] {
    if (p.whole && p.source) return this.claimNamed(p);
    this.snapshot(atom);
    const kind = toolKind(this.tool);
    atom.pieces = claimWhole(atom, p, kind);
    this.coverage.delete(p);
    this.dirty.add(atom);
    const [cx, cy] = shapeCentroid(p.shape);
    const piece = kind === null ? null : pieceCovering(atom, p, kind);
    return [{ type: "claim", piece, region: p.shape, prevKind: p.kind, at: [cx / TUNE.GEOM_SCALE, cy / TUNE.GEOM_SCALE], whole: true }];
  }

  /** NAME-002: claims the whole named area `p` is part of, in every block it covers. */
  private claimNamed(p: Piece): StrokeEvent[] {
    const kind = toolKind(this.tool)!;
    const source = p.source!;
    this.wholesDone.add(source);
    this.wholes.delete(source);
    return this.replaceWhole(wholeAs(this.world, source, kind), kind, (q, now) => {
      this.coverage.delete(q);
      const [cx, cy] = shapeCentroid(q.shape);
      return { type: "claim", piece: now, region: q.shape, prevKind: q.kind, at: [toM(cx), toM(cy)], whole: true };
    });
  }

  /** NAME-001: commits the new piece lists of a named area's atoms, with one event per piece that changed. */
  private replaceWhole(
    changed: Map<Atom, Piece[]>,
    kind: Kind,
    event: (old: Piece, now: Piece | null) => StrokeEvent,
  ): StrokeEvent[] {
    for (const atom of changed.keys()) {
      this.snapshot(atom);
      this.dirty.add(atom);
    }
    return commitWhole(changed, kind).flatMap((c) => c.gone.map(([old, now]) => event(old, now)));
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
      // CAP-008: street land a capture took follows the land beside it (settleBridges).
      if (!p || p.kind === null || this.densityDone.has(p) || this.world.atoms[p.atom].bridge) continue;
      this.densityDone.add(p);
      const tier = KINDS[p.kind].tier;
      // DENS-004 / DISP-005: disputed context is rejected like any other non-residential land.
      // LOAD-015: so is a named residential area still loading.
      if (tier === undefined || stillLoading(p, this.world.loading)) {
        if (!this.rejected) events.push({ type: "reject", at: [x, y] });
        this.rejected = true;
        continue;
      }
      const next = tier + dir;
      const whole = p.whole && p.source ? this.world.wholeOf(p.source).map((w) => w.piece) : null;
      if (whole) for (const q of whole) this.densityDone.add(q); // NAME-004: one step for the whole area
      if (next < 1 || next > 6) { // DENS-003: the ladder ends bump instead of wrapping
        events.push({ type: "bump", piece: p, at: [x, y] });
        continue;
      }
      if (whole) {
        // NAME-004: the whole named area moves one tier.
        const kind = tierKind(next);
        events.push(
          ...this.replaceWhole(wholeAs(this.world, p.source!, kind), kind, (q, now) => {
            if (now) this.densityDone.add(now);
            return now ? { type: "tier", piece: now, prevKind: q.kind!, at: [x, y] } : { type: "bump", piece: q, at: [x, y] };
          }),
        );
        continue;
      }
      const atom = this.world.atoms[p.atom];
      this.snapshot(atom);
      // DISP-001: a density step answers the dispute, so the stepped piece has no rival.
      const stepped = makePiece(atom, tierKind(next), p.shape, { source: p.source, feature: p.feature, modified: !!p.source, drawn: p.drawn });
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
    const next = buildingEffect(this.world, this.tool, b);
    if (next === "reject") return reject();
    if (next === "skip") return [{ type: "skip", building: b, at }];
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
      const b = isTap ? this.world.buildingHit(toI(sx), toI(sy), toI(this.mark)) : null; // CORR-005
      if (b && !this.buildingsDone.has(b.geom.id)) events.push(...this.touchBuilding(b, [sx, sy]));
    } else if (this.tool.type !== "density") {
      const p = this.world.pieceAt(toI(sx), toI(sy));
      if (isTap && settles(this.tool, p)) {
        // DISP-004: a tap on disputed context settles it for the context, whatever its size, and does nothing else.
        events.push(this.settle(p));
        this.preview.clear();
      } else {
        // SNAP-004: a tap claims the whole unit piece under it. CAP-008: never street land a capture took.
        if (isTap && p && !this.world.atoms[p.atom].bridge && isUnit(p, this.limit) && changes(this.tool, p, this.world.loading))
          events.push(...this.claim(this.world.atoms[p.atom], p));
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
    if (!this.onBuildings) events.push(...this.settleBridges());
    this.coverage.clear(); // SNAP-006
    const atoms = [...this.before].filter(([a, b]) => a.pieces !== b).map(([atom, before]) => ({ atom, before, after: atom.pieces }));
    const buildings = this.buildingSteps();
    return { events, step: atoms.length || buildings.length ? { atoms, buildings } : null };
  }

  /** CAP-008: street land goes back to being street where paint or the eraser reached it, or its sides left. */
  private settleBridges(): StrokeEvent[] {
    const events: StrokeEvent[] = [];
    const reached = (b: Atom, p: Piece) =>
      (this.tool.type === "paint" || this.tool.type === "erase") && changes(this.tool, p, this.world.loading) &&
      !isEmpty(intersect(this.strokeShapeNear(b.bbox), b.shape));
    for (const [atom, pieces] of settleBridges(this.world, reached)) {
      this.snapshot(atom);
      const old = atom.pieces;
      atom.pieces = pieces;
      if (pieces.length) continue;
      const [cx, cy] = shapeCentroid(atom.shape);
      events.push({ type: "claim", piece: null, region: atom.shape, prevKind: old[0].kind, at: [toM(cx), toM(cy)], whole: true });
    }
    return events;
  }

  /** TYPE-011 */
  private buildingSteps() {
    return [...this.beforeB].filter(([s, b]) => s.items !== b).map(([set, before]) => ({ set, before, after: set.items }));
  }
}

/**
 * NAME-006: the whole named area `source` takes `kind` at once, outside any stroke: one undo step, and a claim
 * event per piece for the pop (FEEL-001). Null step when nothing changes, or while it is still loading (LOAD-015).
 */
export function answerWhole(world: World, source: string, kind: Kind): { events: StrokeEvent[]; step: Step | null } {
  if (world.loading.has(source)) return { events: [], step: null }; // LOAD-015
  const committed = commitWhole(wholeAs(world, source, kind), kind);
  const events: StrokeEvent[] = committed.flatMap((c) =>
    c.gone.map(([old, now]): StrokeEvent => {
      const [cx, cy] = shapeCentroid(old.shape);
      return { type: "claim", piece: now, region: old.shape, prevKind: old.kind, at: [toM(cx), toM(cy)], whole: true };
    }),
  );
  const atoms = committed.map((c) => ({ atom: c.atom, before: c.before, after: c.atom.pieces }));
  return { events, step: atoms.length ? { atoms } : null };
}

/** NAME-001: puts a named area's new piece lists in place; returns each atom's old list and which pieces became which. */
function commitWhole(changed: Map<Atom, Piece[]>, kind: Kind) {
  const out: { atom: Atom; before: Piece[]; gone: [Piece, Piece | null][] }[] = [];
  for (const [atom, pieces] of changed) {
    const before = atom.pieces;
    atom.pieces = pieces;
    const gone = before
      .filter((q) => q.whole && !pieces.includes(q))
      .map((q): [Piece, Piece | null] => [
        q,
        pieces.find((n) => n.kind === kind && n.source === q.source && n.whole && overlaps(n, q.shape)) ?? null,
      ]);
    out.push({ atom, before, gone });
  }
  return out;
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
