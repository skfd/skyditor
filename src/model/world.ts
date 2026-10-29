// The editable model: atoms (the snapping lattice) fully divided into pieces (OVL-001).
import RBush from "rbush";
import {
  type BBox, type Ring, type Shape, area, bbox, bufferLines, components, contains, difference, expandBBox, shapeCentroid, toI, touches, union,
} from "../geo/clip";
import type { AreaFeature, Features } from "../osm/features";
import { type Building, type BuildingGeom, makeBuilding } from "./buildings";
import { type Guess, guess } from "./guess";
import type { CtxClass, Kind } from "./kinds";
import { TUNE } from "../tuning";

export interface Piece {
  readonly id: number;
  readonly atom: number;
  readonly kind: Kind | null; // null = void
  readonly ctx?: CtxClass; // colour class for CTX pieces
  readonly shape: Shape;
  readonly area: number; // m²
  readonly bbox: BBox;
  readonly source?: string; // IMP-008: originating OSM element
  readonly modified: boolean; // IMP-008 / OVL-004
  readonly drawn: boolean; // CORR-002: freeform paint drew part of its outline, so it is never a unit piece
  readonly rival?: Rival; // IMP-012: set while the piece is disputed
}

/** IMP-014: an area whose tags imply a landuse it does not carry. */
export interface TagIssue {
  readonly source: string; // OSM element, "way/123" | "relation/456"
  readonly tagged: string; // what it is tagged as, e.g. "amenity=school"
  readonly missing: string; // the landuse tag it lacks
  readonly at: [number, number]; // m; a point well inside its land (REN-016)
}

/** IMP-012: what the losing feature of a dispute said. */
export interface Rival {
  readonly kind: Kind;
  readonly ctx?: CtxClass;
  readonly source?: string; // the losing feature's OSM element, marked changed when the dispute settles (DISP-004)
}

export interface Atom {
  readonly id: number;
  readonly shape: Shape;
  readonly area: number;
  readonly bbox: BBox;
  pieces: Piece[];
}

interface AtomBox extends BBox {
  atom: Atom;
}

let nextPieceId = 1;

export function makePiece(
  atom: Atom | number,
  kind: Kind | null,
  shape: Shape,
  extra: { ctx?: CtxClass; source?: string; modified?: boolean; rival?: Rival; drawn?: boolean } = {},
): Piece {
  return {
    id: nextPieceId++,
    atom: typeof atom === "number" ? atom : atom.id,
    kind,
    ctx: extra.ctx,
    shape,
    area: area(shape),
    bbox: bbox(shape),
    source: extra.source,
    modified: extra.modified ?? false,
    rival: extra.rival,
    drawn: extra.drawn ?? false,
  };
}

export const isProtected = (p: Piece) => p.kind === "CTX"; // PAINT-004
// Disputed pieces never merge with undisputed ones, so a dispute keeps its own outline (REN-013).
export const groupKey = (p: Piece) => `${p.kind}|${p.ctx ?? ""}|${p.rival ? `${p.rival.kind}|${p.rival.ctx ?? ""}` : ""}`;
export const VOID_MIN_AREA = 0.5; // m²; cracks smaller than this are integer round-off, not land
export const SOFT_LINE_HALF_WIDTH = 0.25; // m; just enough to separate cells; swallowed again by SNAP-103, or along fences filled by SNAP-112

const floatRing = (pts: Float32Array): Ring => {
  const r: Ring = [];
  for (let i = 0; i < pts.length; i += 2) r.push({ X: toI(pts[i]), Y: toI(pts[i + 1]) });
  return r;
};

/**
 * OVL-001 / OVL-003: merges touching same-kind pieces and re-derives void pieces.
 * `merge=false` keeps same-kind neighbours separate (used on import, where they stem from different features).
 */
export function normalize(atom: Atom, pieces: Piece[], merge = true): Piece[] {
  const land = pieces.filter((p) => p.kind !== null && p.area > 0);
  const out: Piece[] = [];
  if (!merge) out.push(...land);
  else {
    const groups = new Map<string, Piece[]>();
    for (const p of land) {
      const g = groups.get(groupKey(p));
      if (g) g.push(p);
      else groups.set(groupKey(p), [p]);
    }
    for (const g of groups.values()) {
      if (g.length === 1) {
        out.push(g[0]);
        continue;
      }
      for (const cluster of touchClusters(g)) {
        if (cluster.length === 1) {
          out.push(cluster[0]);
          continue;
        }
        const biggest = cluster.reduce((a, b) => (b.area > a.area ? b : a));
        const sameSource = cluster.every((p) => p.source === biggest.source);
        for (const comp of components(union(...cluster.map((p) => p.shape)))) {
          out.push(
            makePiece(atom, biggest.kind, comp, {
              ctx: biggest.ctx,
              source: biggest.source,
              modified: cluster.some((p) => p.modified) || !sameSource,
              rival: biggest.rival,
              drawn: cluster.some((p) => p.drawn), // CORR-002
            }),
          );
        }
      }
    }
  }
  const prevVoids = atom.pieces.filter((p) => p.kind === null);
  // CORR-002: a changed void is drawn where it meets a drawn piece, or covers where one was.
  const drawn = [...out, ...atom.pieces].filter((p) => p.drawn);
  const voidShape = difference(atom.shape, union(...out.map((p) => p.shape)));
  for (const comp of components(voidShape)) {
    const a = area(comp);
    if (a < VOID_MIN_AREA) continue;
    const b = bbox(comp);
    // Keep the identity of unchanged voids so in-flight stroke coverage survives (SNAP-002).
    const same = prevVoids.find(
      (v) => Math.abs(v.area - a) < 0.01 && v.bbox.minX === b.minX && v.bbox.maxX === b.maxX &&
        v.bbox.minY === b.minY && v.bbox.maxY === b.maxY,
    );
    out.push(same ?? makePiece(atom, null, comp, { drawn: drawn.some((p) => touches(p.shape, comp)) }));
  }
  return out;
}

export function touchClusters(ps: Piece[]): Piece[][] {
  const parent = ps.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++)
      if (find(i) !== find(j) && touches(ps[i].shape, ps[j].shape)) parent[find(i)] = find(j);
  const m = new Map<number, Piece[]>();
  ps.forEach((p, i) => {
    const r = find(i);
    const g = m.get(r);
    if (g) g.push(p);
    else m.set(r, [p]);
  });
  return [...m.values()];
}

/** TYPE-011: the buildings standing in one atom (or outside every atom, `atom` -1), replaced as a whole on change. */
export interface BuildingSet {
  readonly atom: number;
  items: Building[];
}

export class World {
  readonly atoms: Atom[];
  readonly totalLand: number;
  private readonly index = new RBush<AtomBox>();
  private readonly geoms: BuildingGeom[] = [];
  private readonly buildingIndex = new RBush<BuildingGeom>();
  private readonly sets = new Map<number, BuildingSet>();
  private readonly guesses = new Map<number, { items: Building[]; by: Map<Building, Guess | null> }>();
  private readonly softIndex = new RBush<BBox & { line: Ring; fence: boolean }>();
  private readonly cellCache = new Map<number, Shape[]>();
  private readonly fenceCache = new Map<number, Shape>();
  overlay: AreaFeature[] = []; // IMP-003, render only
  issues: TagIssue[] = []; // IMP-014, render only
  readonly originals: AreaFeature[] = []; // IMP-009, render only

  constructor(
    readonly features: Features,
    readonly streets: Shape,
    readonly water: Shape,
    atomShapes: Shape[],
  ) {
    this.atoms = atomShapes.map((shape, id) => {
      const atom: Atom = { id, shape, area: area(shape), bbox: bbox(shape), pieces: [] };
      atom.pieces = [makePiece(atom, null, shape)];
      return atom;
    });
    this.index.load(this.atoms.map((a) => ({ ...a.bbox, atom: a })));
    this.totalLand = this.atoms.reduce((s, a) => s + a.area, 0);
    // SNAP-109; BLD-006: the footprint only, never the look.
    this.geoms = features.buildings.map((b, id) => {
      const shape = union([floatRing(b.ring)]);
      const [cx, cy] = shapeCentroid(shape);
      return { ...bbox(shape), id, source: b.source, ring: b.ring, shape, area: area(shape), cx, cy, atom: this.atomAt(cx, cy)?.id ?? -1, cluster: id, clusterSize: 1 };
    });
    this.buildingIndex.load(this.geoms);
    this.clusterBuildings();
    for (const [i, b] of features.buildings.entries()) {
      const g = this.geoms[i];
      const set = this.sets.get(g.atom) ?? { atom: g.atom, items: [] };
      set.items.push(makeBuilding(g, b.tags, { look: b.look }));
      this.sets.set(g.atom, set);
    }
    // SNAP-108
    this.softIndex.load(
      features.minorLines.map((l) => {
        const line = floatRing(l.pts);
        return { ...bbox([line]), line, fence: !!l.fence };
      }),
    );
  }

  /** TYPE-002: footprints that share a wall (within TUNE-GUESS-TOUCH) form one cluster. */
  private clusterBuildings() {
    const parent = this.geoms.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const gap = toI(TUNE.GUESS_TOUCH);
    for (const g of this.geoms)
      for (const o of this.buildingIndex.search(expandBBox(g, gap))) {
        if (o.id <= g.id || find(o.id) === find(g.id)) continue;
        if (touches(g.shape, o.shape, TUNE.GUESS_TOUCH)) parent[find(o.id)] = find(g.id);
      }
    const sizes = new Map<number, number>();
    for (const g of this.geoms) {
      g.cluster = find(g.id);
      sizes.set(g.cluster, (sizes.get(g.cluster) ?? 0) + 1);
    }
    for (const g of this.geoms) g.clusterSize = sizes.get(g.cluster)!;
  }

  /** SNAP-109: building footprints overlapping a box. */
  buildingsIn(b: BBox): BuildingGeom[] {
    return this.buildingIndex.search(b);
  }

  /** The current state of a building, by its footprint. */
  building(g: BuildingGeom): Building {
    return this.sets.get(g.atom)!.items.find((b) => b.geom === g)!;
  }

  /** The building set a footprint belongs to (TYPE-011). */
  setOf(g: BuildingGeom): BuildingSet {
    return this.sets.get(g.atom)!;
  }

  buildingSets(): Iterable<BuildingSet> {
    return this.sets.values();
  }

  /** TYPE-007 / TYPE-008: the building under a point, if any. */
  buildingAt(x: number, y: number): Building | null {
    for (const g of this.buildingIndex.search({ minX: x, minY: y, maxX: x, maxY: y }))
      if (contains(g.shape, x, y)) return this.building(g);
    return null;
  }

  /** CORR-005: the unsure building whose mark (`mark` units round its centre) covers a point, nearest first. */
  markAt(x: number, y: number, mark: number): Building | null {
    let best: Building | null = null;
    let bestD = mark * mark;
    if (mark > 0)
      for (const g of this.buildingIndex.search({ minX: x - mark, minY: y - mark, maxX: x + mark, maxY: y + mark })) {
        const d = (g.cx - x) ** 2 + (g.cy - y) ** 2;
        if (d > bestD) continue;
        const b = this.building(g);
        const guess = this.guessOf(b);
        if (guess && !guess.look) [best, bestD] = [b, d];
      }
    return best;
  }

  /** CORR-005: the building a tap or the pointer at a point lands on: a mark covering it wins over a footprint. */
  buildingHit(x: number, y: number, mark = 0): Building | null {
    return this.markAt(x, y, mark) ?? this.buildingAt(x, y);
  }

  /** TYPE-001..TYPE-003: what the editor guesses about a building, or null when it is typed or protected. */
  guessOf(b: Building): Guess | null {
    const set = this.sets.get(b.geom.atom)!;
    let c = this.guesses.get(set.atom);
    if (!c || c.items !== set.items) {
      c = { items: set.items, by: new Map() };
      this.guesses.set(set.atom, c);
    }
    let g = c.by.get(b);
    if (g === undefined) {
      g = guess(b, set.items);
      c.by.set(b, g);
    }
    return g;
  }

  /** TYPE-012: every guessed or unsure building, north to south, then west to east. */
  toDecide(): Building[] {
    const out: Building[] = [];
    for (const s of this.sets.values()) for (const b of s.items) if (this.guessOf(b)) out.push(b);
    return out.sort((a, b) => a.geom.minY - b.geom.minY || a.geom.minX - b.geom.minX);
  }

  /** SNAP-108: the cells minor ways cut an atom into; empty when they don't split it. */
  cellsOf(atom: Atom): Shape[] {
    let cells = this.cellCache.get(atom.id);
    if (!cells) {
      const lines = this.softIndex.search(atom.bbox).map((x) => x.line);
      cells = [];
      if (lines.length) {
        const parts = components(difference(atom.shape, bufferLines(lines, SOFT_LINE_HALF_WIDTH)));
        if (parts.length > 1) cells = parts;
      }
      this.cellCache.set(atom.id, cells);
    }
    return cells;
  }

  /** SNAP-112: thin slits along the fences, walls and hedges in an atom's area, whether or not they divide it. */
  fencesOf(atom: Atom): Shape {
    let slits = this.fenceCache.get(atom.id);
    if (!slits) {
      const lines = this.softIndex.search(atom.bbox).filter((x) => x.fence).map((x) => x.line);
      slits = lines.length ? bufferLines(lines, SOFT_LINE_HALF_WIDTH) : [];
      this.fenceCache.set(atom.id, slits);
    }
    return slits;
  }

  atomsIn(b: BBox): Atom[] {
    return this.index.search(b).map((x) => x.atom);
  }

  atomAt(x: number, y: number): Atom | null {
    for (const a of this.atomsIn({ minX: x, minY: y, maxX: x, maxY: y })) if (contains(a.shape, x, y)) return a;
    return null;
  }

  pieceAt(x: number, y: number): Piece | null {
    const a = this.atomAt(x, y);
    if (!a) return null;
    for (const p of a.pieces) {
      if (x < p.bbox.minX || x > p.bbox.maxX || y < p.bbox.minY || y > p.bbox.maxY) continue;
      if (contains(p.shape, x, y)) return p;
    }
    return null;
  }

  /** HUD-009 / HUD-010: every disputed piece, north to south, then west to east. */
  disputed(): Piece[] {
    const out: Piece[] = [];
    for (const a of this.atoms) for (const p of a.pieces) if (p.rival) out.push(p);
    return out.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
  }

  /** Land area per kind ("void" for none), for the district mix (HUD-003). BLD-006 / TYPE-014: buildings play no part. */
  mix(): Record<string, number> {
    const m: Record<string, number> = {};
    for (const a of this.atoms)
      for (const p of a.pieces) {
        const k = p.kind ?? "void";
        m[k] = (m[k] ?? 0) + p.area;
      }
    return m;
  }
}
