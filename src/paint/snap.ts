// Snapping for open pieces (SNAP-101..SNAP-107) and the edits that apply a region to an atom.
import {
  type Ring, type Shape, area, bbox, bufferLines, closing, components, difference, expandBBox, intersect, isEmpty,
  narrowParts, offset, simplify, toI, touches, union,
} from "../geo/clip";
import type { Kind, PaintKind } from "../model/kinds";
import { type Atom, type Piece, type World, isProtected, makePiece, normalize } from "../model/world";
import { TUNE } from "../tuning";

export type Tool =
  | { type: "paint"; kind: PaintKind }
  | { type: "erase" }
  | { type: "density"; dir: 1 | -1 };

export const toolKind = (t: Tool): Kind | null => (t.type === "paint" ? t.kind : null);

/** SNAP-001 */
export const unitLimit = (radiusM: number) =>
  Math.min(TUNE.UNIT_ABS_MAX, TUNE.UNIT_FACTOR * Math.PI * radiusM * radiusM);

/** Whether a paint/erase tool would change this piece at all (PAINT-004, PAINT-007). */
export function changes(tool: Tool, p: Piece): boolean {
  if (isProtected(p)) return false;
  if (tool.type === "paint") return p.kind !== tool.kind;
  if (tool.type === "erase") return p.kind !== null;
  return false;
}

/** SNAP-101: the trail (as one or more runs) buffered by the brush radius, then smoothed. */
export function strokeShape(runs: Ring[], radiusM: number): Shape {
  return closing(bufferLines(runs, radiusM), TUNE.SMOOTH_FACTOR * radiusM);
}

export interface Freeform {
  region: Shape; // what the stroke takes in this atom
  eligible: Shape; // the open pieces it may take from
}

/** SNAP-110: the snapped freeform result of a stroke shape inside one atom. */
export function freeformIn(world: World, atom: Atom, stroke: Shape, tool: Tool, radiusM: number): Freeform | null {
  const limit = unitLimit(radiusM);
  // SNAP-102: only open pieces the stroke touches, never context, never pieces already of the kind.
  const open = atom.pieces.filter(
    (p) => p.area > limit && changes(tool, p) && !isEmpty(intersect(stroke, p.shape)),
  );
  if (open.length === 0) return null;
  const eligible = union(...open.map((p) => p.shape));
  let painted = intersect(stroke, eligible);
  if (area(painted) < 1) return null;

  // SNAP-108: mostly covered cells are taken whole.
  const taken: Shape[] = [];
  for (const cell of world.cellsOf(atom)) {
    const inCell = intersect(painted, cell);
    if (isEmpty(inCell)) continue;
    if (area(inCell) >= TUNE.CELL_TAKE * area(cell)) taken.push(intersect(cell, eligible));
  }
  if (taken.length) painted = union(painted, ...taken);

  // SNAP-109: whole buildings in, or whole buildings out, each with a yard.
  const m = TUNE.BUILDING_MARGIN;
  const near = world.buildingsIn(expandBBox(bbox(painted), toI(m)));
  if (near.length) {
    const keep: Shape[] = [];
    const yardsIn: Shape[] = [];
    const yardsOut: Shape[] = [];
    for (const b of near) {
      const yard = (b.yard ??= offset(b.shape, m));
      if (isEmpty(intersect(yard, painted))) continue;
      const inside = area(intersect(b.shape, painted));
      if (inside >= 0.5 * b.area) {
        keep.push(b.shape);
        yardsIn.push(yard);
      } else yardsOut.push(yard);
    }
    const grown = union(painted, ...yardsIn);
    const cut = difference(union(...yardsOut), union(...keep));
    painted = intersect(difference(grown, cut), eligible);
    if (isEmpty(painted)) return null;
  }

  // SNAP-103 / SNAP-104: narrow leftovers that touch the paint are swallowed; corners of wide ones are not.
  const leftover = difference(eligible, painted);
  const swallowed = narrowParts(leftover, TUNE.SNAP_FACTOR * radiusM).filter((c) => touches(c, painted, 0.1));
  return { region: union(painted, ...swallowed), eligible };
}

/** Replaces a whole piece with `kind` (null = erase). Returns the new piece list for the atom. */
export function claimWhole(atom: Atom, piece: Piece, kind: Kind | null): Piece[] {
  const rest = atom.pieces.filter((p) => p !== piece);
  if (kind === null) return normalize(atom, rest);
  const claimed = makePiece(atom, kind, piece.shape, { source: piece.source, modified: !!piece.source });
  return normalize(atom, [...rest, claimed]);
}

/**
 * OVL-002 + SNAP-106 + SNAP-107: gives `region` to `kind` (or void), shrinking everything else that is
 * not protected, then merges slivers left touching the region.
 */
export function applyRegion(atom: Atom, ff: Freeform, kind: Kind | null): { pieces: Piece[]; region: Shape } {
  // SNAP-106: simplified, but never spilling outside the open pieces it came from.
  const region = intersect(simplify(ff.region, TUNE.SIMPLIFY), ff.eligible);
  const shrink = (pieces: Piece[], take: Shape) =>
    pieces.flatMap((p) => {
      if (p.kind === null || isProtected(p)) return [p];
      const rest = difference(p.shape, take);
      if (Math.abs(area(rest) - p.area) < 0.01) return [p];
      return components(rest).map((c) =>
        makePiece(atom, p.kind, c, { ctx: p.ctx, source: p.source, modified: !!p.source }),
      );
    });
  const build = (take: Shape) => {
    const kept = shrink(atom.pieces, take).filter((p) => p.kind !== null);
    const added = kind === null ? [] : components(take).map((c) => makePiece(atom, kind, c));
    return normalize(atom, [...kept, ...added]);
  };
  let pieces = build(region);
  // SNAP-107
  const slivers = pieces.filter(
    (p) => !isProtected(p) && p.kind !== kind && p.area < TUNE.SLIVER_AREA && touches(p.shape, region, 0.1),
  );
  if (slivers.length === 0) return { pieces, region };
  const grown = union(region, ...slivers.map((p) => p.shape));
  pieces = build(grown);
  return { pieces, region: grown };
}
