// The editable model: atoms (the snapping lattice) fully divided into pieces (OVL-001).
import RBush from "rbush";
import {
  type BBox, type Ring, type Shape, area, bbox, bufferLines, components, contains, difference, toI, touches, union,
} from "../geo/clip";
import type { AreaFeature, Features } from "../osm/features";
import type { CtxClass, Kind } from "./kinds";

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
  readonly rival?: Rival; // IMP-012: set while the piece is disputed
}

/** IMP-012: what the losing feature of a dispute said. */
export interface Rival {
  readonly kind: Kind;
  readonly ctx?: CtxClass;
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
  extra: { ctx?: CtxClass; source?: string; modified?: boolean; rival?: Rival } = {},
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
  };
}

export const isProtected = (p: Piece) => p.kind === "CTX" && !p.rival; // PAINT-004, DISP-002
// Disputed pieces never merge with undisputed ones, so a dispute keeps its own outline (REN-013).
const groupKey = (p: Piece) => `${p.kind}|${p.ctx ?? ""}|${p.rival ? `${p.rival.kind}|${p.rival.ctx ?? ""}` : ""}`;
const VOID_MIN_AREA = 0.5; // m²; cracks smaller than this are integer round-off, not land
const SOFT_LINE_HALF_WIDTH = 0.25; // m; just enough to separate cells, swallowed again by SNAP-103

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
            }),
          );
        }
      }
    }
  }
  const prevVoids = atom.pieces.filter((p) => p.kind === null);
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
    out.push(same ?? makePiece(atom, null, comp));
  }
  return out;
}

function touchClusters(ps: Piece[]): Piece[][] {
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

export interface Building extends BBox {
  shape: Shape;
  area: number;
  yard?: Shape; // SNAP-109, computed on first use
}

export class World {
  readonly atoms: Atom[];
  readonly totalLand: number;
  private readonly index = new RBush<AtomBox>();
  private readonly buildingIndex = new RBush<Building>();
  private readonly softIndex = new RBush<BBox & { line: Ring }>();
  private readonly cellCache = new Map<number, Shape[]>();
  overlay: AreaFeature[] = []; // IMP-003, render only
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
    this.buildingIndex.load(
      features.buildings.map((b) => {
        const shape = union([floatRing(b.ring)]);
        return { ...bbox(shape), shape, area: area(shape) };
      }),
    );
    // SNAP-108
    this.softIndex.load(
      features.minorLines.map((l) => {
        const line = floatRing(l.pts);
        return { ...bbox([line]), line };
      }),
    );
  }

  /** SNAP-109: buildings overlapping a box. */
  buildingsIn(b: BBox): Building[] {
    return this.buildingIndex.search(b);
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

  /** Land area per kind ("void" for none), for the district mix (HUD-003). */
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

