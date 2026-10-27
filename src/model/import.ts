// Interprets existing OSM landuse as pieces (IMP-004..IMP-008).
import {
  type Shape, area, bbox, components, containsDisc, difference, intersect, isEmpty, narrowParts, offset, union,
} from "../geo/clip";
import type { AreaFeature } from "../osm/features";
import { TUNE } from "../tuning";
import { type Atom, type Piece, World, makePiece, normalize } from "./world";

export function importLanduse(world: World, areas: AreaFeature[]): { pieces: number; dropped: number } {
  world.overlay = areas.filter((a) => a.klass.cls === "overlay");
  world.originals.push(...areas.filter((a) => a.klass.cls === "paintable"));

  // IMP-004: smaller features claim first; each later feature only gets what is left.
  const ranked = areas
    .filter((a) => a.klass.cls === "paintable" || a.klass.cls === "exclusive")
    .sort((a, b) => a.area - b.area);
  const perAtom = new Map<Atom, Piece[]>();
  let taken: Shape = [];
  let dropped = 0;
  for (const f of ranked) {
    const footprint = difference(f.shape, taken);
    taken = union(taken, f.shape);
    if (isEmpty(footprint)) continue;
    const kind = f.klass.cls === "paintable" ? f.klass.kind : "CTX";
    const ctx = f.klass.cls === "exclusive" ? f.klass.ctx : undefined;
    // IMP-005
    for (const atom of world.atomsIn(bbox(footprint))) {
      for (const frag of components(intersect(atom.shape, footprint))) {
        // IMP-006
        if (area(frag) < TUNE.IMPORT_MIN_FRAGMENT || !containsDisc(frag, TUNE.ATOM_MIN_RADIUS)) {
          dropped++;
          continue;
        }
        const list = perAtom.get(atom) ?? [];
        list.push(makePiece(atom, kind, frag, { ctx, source: f.id }));
        perAtom.set(atom, list);
      }
    }
  }

  let count = 0;
  for (const [atom, pieces] of perAtom) {
    atom.pieces = snapImported(atom, normalize(atom, pieces, false));
    count += pieces.length;
  }
  return { pieces: count, dropped };
}

/** IMP-007: narrow void next to imported paintable pieces closes up against the block edge. */
function snapImported(atom: Atom, pieces: Piece[]): Piece[] {
  const voids = pieces.filter((p) => p.kind === null);
  if (voids.length === 0) return pieces;
  let land = pieces.filter((p) => p.kind !== null);
  const paintable = () => land.filter((p) => p.kind !== "CTX");
  if (paintable().length === 0) return pieces;
  let changed = false;
  for (const v of voids) {
    for (const narrow of narrowParts(v.shape, TUNE.IMPORT_SNAP)) {
      const grown = offset(narrow, 0.1);
      let best: Piece | null = null;
      let bestA = 0;
      for (const p of paintable()) {
        const a = area(intersect(grown, p.shape));
        if (a > bestA) [best, bestA] = [p, a];
      }
      if (!best) continue;
      const merged = makePiece(atom, best.kind, union(best.shape, narrow), {
        source: best.source,
        modified: best.modified,
      });
      land = land.map((p) => (p === best ? merged : p));
      changed = true;
    }
  }
  if (!changed) return pieces;
  // Snapping can join two fragments of the same feature; that is still one untouched feature.
  const fresh = normalize({ ...atom, pieces }, land, false);
  return fresh.flatMap((p) => (p.kind !== null && p.kind !== "CTX" ? split(atom, p) : [p]));
}

const split = (atom: Atom, p: Piece) => {
  const comps = components(p.shape);
  return comps.length <= 1
    ? [p]
    : comps.map((c) => makePiece(atom, p.kind, c, { source: p.source, modified: p.modified }));
};
