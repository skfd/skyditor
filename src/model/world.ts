// The editable model: atoms (the snapping lattice) fully divided into pieces (OVL-001).
import RBush from "rbush";
import {
  type BBox, type Ring, type Shape, area, bbox, bufferLines, components, contains, difference, expandBBox, interiorPoint, intersect,
  offset, shapeCentroid, toI, toM, touches, union,
} from "../geo/clip";
import type { AreaFeature, BuildingFeature, Features, MinorLine } from "../osm/features";
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
  // OVL-005: the landuse area the piece belongs to: its OSM element, or `new/N` for one the user painted. Unset on
  // void, and on fresh paint until normalize() gives it an area (OVL-006).
  readonly feature?: string;
  readonly modified: boolean; // IMP-008 / OVL-004
  readonly drawn: boolean; // CORR-002: freeform paint drew part of its outline, so it is never a unit piece
  readonly rival?: Rival; // IMP-012: set while the piece is disputed
  readonly name?: string; // NAME-008: the name of the area `source`
  readonly whole?: true; // NAME-001: part of a named residential area, which changes whole
}

/** IMP-014: an area whose tags imply a landuse it does not carry. */
export interface TagIssue {
  readonly source: string; // OSM element, "way/123" | "relation/456"
  readonly tagged: string; // what it is tagged as, e.g. "amenity=school"
  readonly missing: string; // the landuse tag it lacks
  readonly at: [number, number]; // m; a point well inside its land (REN-016)
}

/** NAME-005: a named residential area still unspecified, and where its badge goes. */
export interface Quest {
  readonly source: string; // the area's OSM element
  readonly name: string;
  readonly at: [number, number]; // m; a point well inside its biggest part
}

/** NAME-008: a named area's label, on one of its parts: every block it covers has one, so zoomed in it still shows. */
export interface Label extends Quest {
  readonly width: number; // m; how wide this part is, which the label must fit in (NAME-009)
  readonly area: number; // m²; all the area's land: a bigger area's label has the first claim to room (NAME-009)
  readonly part: number; // m²; this part's land: within one area, the biggest part's label comes first
  readonly quest: boolean; // NAME-005: the biggest part of an area that still asks what it is, with the badge
}

// Pieces are immutable, so a piece's label point never changes; working one out takes a few offsets.
const labelPoints = new WeakMap<Piece, [number, number]>();
const labelPoint = (p: Piece): [number, number] => {
  let at = labelPoints.get(p);
  if (!at) {
    const [x, y] = interiorPoint(p.shape);
    at = [toM(x), toM(y)];
    labelPoints.set(p, at);
  }
  return at;
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
  /**
   * CAP-008: street land a capture took, joining the two atoms named here. It holds land of one area, in pieces
   * that cover it whole, or no pieces at all while it is street again (undone, or given back).
   */
  readonly bridge?: readonly [number, number];
}

interface AtomBox extends BBox {
  atom: Atom;
}

let nextPieceId = 1;

export function makePiece(
  atom: Atom | number,
  kind: Kind | null,
  shape: Shape,
  extra: {
    ctx?: CtxClass; source?: string; feature?: string; modified?: boolean; rival?: Rival; drawn?: boolean; name?: string; whole?: boolean;
  } = {},
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
    feature: extra.feature ?? extra.source,
    modified: extra.modified ?? false,
    rival: extra.rival,
    drawn: extra.drawn ?? false,
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    ...(extra.whole ? { whole: true as const } : {}),
  };
}

export const isProtected = (p: Piece) => p.kind === "CTX"; // PAINT-004
// Disputed pieces never merge with undisputed ones, so a dispute keeps its own outline (REN-013). A named area
// merges only with itself, so it keeps its outline too and stays one place (NAME-001).
export const groupKey = (p: Piece) =>
  `${p.kind}|${p.ctx ?? ""}|${p.rival ? `${p.rival.kind}|${p.rival.ctx ?? ""}` : ""}|${p.whole ? p.source : ""}`;
export const VOID_MIN_AREA = 0.5; // m²; cracks smaller than this are integer round-off, not land
export const SOFT_LINE_HALF_WIDTH = 0.25; // m; just enough to separate cells; swallowed again by SNAP-103, or along fences filled by SNAP-112

const floatRing = (pts: Float32Array): Ring => {
  const r: Ring = [];
  for (let i = 0; i < pts.length; i += 2) r.push({ X: toI(pts[i]), Y: toI(pts[i + 1]) });
  return r;
};

/**
 * OVL-001 / OVL-005: merges touching same-kind pieces of one area and re-derives void pieces.
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
    for (const g of groups.values()) out.push(...mergeAreas(atom, g));
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

let nextFeatureId = 1;
const EDGE_PROBE = 0.5; // m; how far past a shape to look when measuring the edge it shares with another

/**
 * OVL-005 / OVL-006: merges the pieces of one kind in an atom (one groupKey). Pieces of one area that touch
 * become one piece; two areas never merge. Fresh paint (no area yet) joins the touching area it shares the
 * longest edge with, measured as the strip of that area within EDGE_PROBE of it, or else becomes a new area.
 */
function mergeAreas(atom: Atom, group: Piece[]): Piece[] {
  if (group.length === 1 && group[0].feature) return group;
  const clusters = touchClusters(group, (a, b) => a.feature === b.feature);
  const areas = clusters.filter((c) => c[0].feature);
  const shapes = areas.map((c) => union(...c.map((p) => p.shape)));
  for (const fresh of clusters.filter((c) => !c[0].feature)) {
    const shape = union(...fresh.map((p) => p.shape));
    const probe = offset(shape, EDGE_PROBE);
    let best = -1;
    let bestEdge = 0;
    shapes.forEach((s, i) => {
      if (!touches(shape, s)) return;
      const edge = area(intersect(probe, s));
      if (edge > bestEdge) [best, bestEdge] = [i, edge];
    });
    if (best >= 0) areas[best].push(...fresh);
    else areas.push(fresh);
  }
  const out: Piece[] = [];
  for (const c of areas) {
    if (c.length === 1 && c[0].feature) {
      out.push(c[0]);
      continue;
    }
    const own = c.filter((p) => p.feature);
    const base = (own.length ? own : c).reduce((a, b) => (b.area > a.area ? b : a));
    const feature = base.feature ?? `new/${nextFeatureId++}`;
    for (const comp of components(union(...c.map((p) => p.shape)))) {
      out.push(
        makePiece(atom, base.kind, comp, {
          ctx: base.ctx,
          source: base.source,
          feature,
          modified: c.some((p) => p.modified || p.source !== base.source), // OVL-004: paint added to an imported area
          rival: base.rival,
          drawn: c.some((p) => p.drawn), // CORR-002
          name: base.name,
          whole: base.whole,
        }),
      );
    }
  }
  return out;
}

/** Groups of pieces that touch, through pieces that touch; `joins` limits which touching pairs count. */
export function touchClusters(ps: Piece[], joins: (a: Piece, b: Piece) => boolean = () => true): Piece[][] {
  const parent = ps.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++)
      if (find(i) !== find(j) && joins(ps[i], ps[j]) && touches(ps[i].shape, ps[j].shape)) parent[find(i)] = find(j);
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
  readonly atoms: Atom[] = [];
  readonly bridges: Atom[] = []; // CAP-008, also in `atoms`
  totalLand = 0;
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

  /** `buildings` are the ones to show; on a live map that is fewer than it has fetched (LOAD-011). */
  constructor(
    readonly features: Features,
    public streets: Shape,
    public water: Shape,
    atomShapes: Shape[],
    buildings: BuildingFeature[] = features.buildings,
  ) {
    this.addAtoms(atomShapes);
    this.addBuildings(buildings);
    this.addMinorLines(features.minorLines);
  }

  /** LOAD-011 / LOAD-013: new atoms join after the ones already there, which stay as they are. */
  addAtoms(shapes: Shape[]): Atom[] {
    const added = shapes.map((shape) => {
      const atom: Atom = { id: this.atoms.length, shape, area: area(shape), bbox: bbox(shape), pieces: [] };
      atom.pieces = [makePiece(atom, null, shape)];
      this.atoms.push(atom);
      return atom;
    });
    this.index.load(added.map((a) => ({ ...a.bbox, atom: a })));
    this.totalLand += added.reduce((s, a) => s + a.area, 0);
    return added;
  }

  /**
   * SNAP-109; BLD-006: the footprint only, never the look. Each building joins the set of the atom it stands in.
   * Returns the ones that joined a set that already existed (LOAD-013: undo must learn about them).
   */
  addBuildings(bs: BuildingFeature[]): { set: BuildingSet; items: Building[] }[] {
    const start = this.geoms.length;
    const geoms = bs.map((b, k): BuildingGeom => {
      const id = start + k;
      const shape = union([floatRing(b.ring)]);
      const [cx, cy] = shapeCentroid(shape);
      return { ...bbox(shape), id, source: b.source, ring: b.ring, shape, area: area(shape), cx, cy, atom: this.atomAt(cx, cy)?.id ?? -1, cluster: id, clusterSize: 1 };
    });
    this.geoms.push(...geoms);
    this.buildingIndex.load(geoms);
    this.clusterBuildings();
    this.guesses.clear(); // TYPE-002: a new neighbour can change a cluster
    const byAtom = new Map<number, Building[]>();
    bs.forEach((b, k) => {
      const g = geoms[k];
      const list = byAtom.get(g.atom) ?? [];
      list.push(makeBuilding(g, b.tags, { look: b.look }));
      byAtom.set(g.atom, list);
    });
    const joined: { set: BuildingSet; items: Building[] }[] = [];
    for (const [atom, items] of byAtom) {
      const set = this.sets.get(atom);
      if (!set) this.sets.set(atom, { atom, items });
      else {
        set.items = [...set.items, ...items]; // replaced, never mutated: undo holds the old arrays
        joined.push({ set, items });
      }
    }
    return joined;
  }

  /** SNAP-108 */
  addMinorLines(lines: MinorLine[]) {
    this.softIndex.load(
      lines.map((l) => {
        const line = floatRing(l.pts);
        return { ...bbox([line]), line, fence: !!l.fence };
      }),
    );
  }

  /** The point a building stands at, as addBuildings places it. */
  static buildingCentre(b: BuildingFeature): [number, number] {
    return shapeCentroid(union([floatRing(b.ring)]));
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

  /** The atom under a point. A bridge that is street again is not land (CAP-008). */
  atomAt(x: number, y: number): Atom | null {
    for (const a of this.atomsIn({ minX: x, minY: y, maxX: x, maxY: y }))
      if (a.pieces.length && contains(a.shape, x, y)) return a;
    return null;
  }

  /** CAP-008: a new bridge, street until a step gives it pieces. It stays in the world for undo and redo. */
  addBridge(shape: Shape, joins: readonly [number, number]): Atom {
    const atom: Atom = { id: this.atoms.length, shape, area: area(shape), bbox: bbox(shape), pieces: [], bridge: joins };
    this.atoms.push(atom);
    this.bridges.push(atom);
    this.index.insert({ ...atom.bbox, atom });
    return atom;
  }

  /** CAP-002: every piece of the area `p` belongs to, in every block. */
  areaOf(p: Piece): Piece[] {
    if (!p.feature) return [p];
    const out: Piece[] = [];
    for (const atom of this.atoms) for (const q of atom.pieces) if (q.feature === p.feature) out.push(q);
    return out;
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

  /** NAME-001: every piece of the named residential area `source`, with its atom. */
  wholeOf(source: string): { atom: Atom; piece: Piece }[] {
    const out: { atom: Atom; piece: Piece }[] = [];
    for (const atom of this.atoms) for (const piece of atom.pieces) if (piece.whole && piece.source === source) out.push({ atom, piece });
    return out;
  }

  /**
   * NAME-008: a label candidate on each part of a named area (its biggest piece in each block); NAME-009 shows
   * one where they crowd. NAME-005: the biggest part of a named residential area still unspecified asks what it is.
   */
  labels(): Label[] {
    const by = new Map<string, { parts: Piece[]; area: number }>();
    for (const a of this.atoms) {
      const inAtom = new Map<string, Piece>();
      for (const p of a.pieces) {
        if (p.name === undefined || !p.source) continue;
        const q = inAtom.get(p.source);
        if (!q || p.area > q.area) inAtom.set(p.source, p);
        const b = by.get(p.source) ?? { parts: [], area: 0 };
        b.area += p.area;
        by.set(p.source, b);
      }
      for (const [source, p] of inAtom) by.get(source)!.parts.push(p);
    }
    const out: Label[] = [];
    for (const [source, { parts, area }] of by) {
      const biggest = parts.reduce((x, y) => (y.area > x.area ? y : x));
      for (const p of parts)
        out.push({
          source,
          name: p.name!,
          at: labelPoint(p),
          width: toM(p.bbox.maxX - p.bbox.minX),
          area,
          part: p.area,
          quest: p === biggest && !!p.whole && p.kind === "RU",
        });
    }
    return out;
  }

  /** NAME-005: the named residential areas still unspecified. */
  quests(): Label[] {
    return this.labels().filter((l) => l.quest);
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
