// Snapping for open pieces (SNAP-101..SNAP-107) and the edits that apply a region to an atom.
import {
  type Ring, type Shape, area, bbox, bufferLines, closing, components, difference, expandBBox, intersect, isEmpty,
  narrowParts, offset, simplify, toI, touches, union,
} from "../geo/clip";
import { type Kind, type PaintKind, tierOf } from "../model/kinds";
import { type Atom, type Piece, SOFT_LINE_HALF_WIDTH, type World, isProtected, makePiece, normalize } from "../model/world";
import { TUNE } from "../tuning";
import { straighten } from "./straighten";

export type Tool =
  | { type: "paint"; kind: PaintKind }
  | { type: "erase" }
  | { type: "density"; dir: 1 | -1 }
  | { type: "agree" }; // TYPE-007: accepts the editor's guesses about buildings

/** TYPE-006: what the brush acts on. */
export type Target = "land" | "buildings";

/** Whether a stroke with this tool and target acts on buildings (TYPE-006, TYPE-007) rather than on land. */
export const onBuildings = (tool: Tool, target: Target) =>
  tool.type === "agree" || (target === "buildings" && (tool.type === "paint" || tool.type === "erase"));

export const toolKind = (t: Tool): Kind | null => (t.type === "paint" ? t.kind : null);

/** SNAP-001 */
export const unitLimit = (radiusM: number) =>
  Math.min(TUNE.UNIT_ABS_MAX, TUNE.UNIT_FACTOR * Math.PI * radiusM * radiusM);

/** SNAP-001 / CORR-002: whether `p` is all-or-nothing for a brush with this unit limit. NAME-002: a named area always is. */
export const isUnit = (p: Piece, limit: number) => !!p.whole || (!p.drawn && p.area <= limit);

/** NAME-003: a tool that would split or wipe out a named residential area; only a tier may change one. */
export const rejects = (tool: Tool, p: Piece | null) =>
  !!p?.whole && (tool.type === "erase" || (tool.type === "paint" && tierOf(tool.kind) === undefined));

/** Whether a paint/erase tool would change this piece at all (PAINT-004, PAINT-007, DISP-002, NAME-003). */
export function changes(tool: Tool, p: Piece): boolean {
  if (isProtected(p) || rejects(tool, p)) return false;
  if (tool.type === "paint") return p.kind !== tool.kind || !!p.rival;
  if (tool.type === "erase") return p.kind !== null;
  return false;
}

/** DISP-004: a tap on disputed context settles it for the context, with a paint tool or the eraser. */
export const settles = (tool: Tool, p: Piece | null): p is Piece =>
  (tool.type === "paint" || tool.type === "erase") && !!p && p.kind === "CTX" && !!p.rival;

/**
 * DISP-004: the context keeps the piece, undisputed, and every piece of the rival feature counts as
 * changed by the user. Returns the new piece list of each atom that changes.
 */
export function settleForContext(world: World, piece: Piece): Map<Atom, Piece[]> {
  const out = new Map<Atom, Piece[]>();
  const src = piece.rival?.source;
  if (src)
    for (const atom of world.atoms) {
      if (!atom.pieces.some((p) => p.source === src && !p.modified)) continue;
      out.set(atom, atom.pieces.map((p) => (p.source === src && !p.modified ? remake(atom, p, { modified: true }) : p)));
    }
  const atom = world.atoms[piece.atom];
  const pieces = (out.get(atom) ?? atom.pieces).filter((p) => p !== piece);
  out.set(atom, normalize(atom, [...pieces, remake(atom, piece, { rival: undefined })]));
  return out;
}

/** A copy of `p` with some fields changed (pieces are immutable). */
const remake = (atom: Atom, p: Piece, change: { modified?: boolean; rival?: undefined }) =>
  makePiece(atom, p.kind, p.shape, {
    ctx: p.ctx,
    source: p.source,
    feature: p.feature,
    modified: change.modified ?? p.modified,
    rival: "rival" in change ? change.rival : p.rival,
    drawn: p.drawn,
    name: p.name,
    whole: p.whole,
  });

/** SNAP-101: the trail (as one or more runs) buffered by the brush radius, then smoothed. */
export function strokeShape(runs: Ring[], radiusM: number): Shape {
  return closing(bufferLines(runs, radiusM), TUNE.SMOOTH_FACTOR * radiusM);
}

export interface Freeform {
  region: Shape; // what the stroke takes in this atom
  eligible: Shape; // the open pieces it may take from
}

/**
 * The snapped freeform result of a stroke shape inside one atom, built in this order: the stroke shape
 * within the open pieces (SNAP-102), whole cells (SNAP-108), straight free edges (SNAP-111), buildings
 * (SNAP-109), then leftover swallowing (SNAP-103, SNAP-104, SNAP-112).
 */
export function freeformIn(world: World, atom: Atom, stroke: Shape, tool: Tool, radiusM: number): Freeform | null {
  const limit = unitLimit(radiusM);
  // SNAP-102: only open pieces the stroke touches, never context, never pieces already of the kind.
  const open = atom.pieces.filter(
    (p) => !isUnit(p, limit) && changes(tool, p) && !isEmpty(intersect(stroke, p.shape)),
  );
  if (open.length === 0) return null;
  const eligible = union(...open.map((p) => p.shape));
  let painted = intersect(stroke, eligible);
  if (area(painted) < 1) return null;

  // SNAP-108: mostly covered cells are taken whole.
  const cells = world.cellsOf(atom);
  const taken: Shape[] = [];
  for (const cell of cells) {
    const inCell = intersect(painted, cell);
    if (isEmpty(inCell)) continue;
    if (area(inCell) >= TUNE.CELL_TAKE * area(cell)) taken.push(intersect(cell, eligible));
  }
  if (taken.length) painted = union(painted, ...taken);

  // SNAP-111: stretches that follow neither the open pieces' outline nor a cell's become straight. Before
  // buildings, so a straight line that crosses one still leaves it whole (SNAP-109).
  painted = intersect(straighten(painted, [eligible, ...cells], TUNE.STRAIGHTEN * radiusM), eligible);
  if (isEmpty(painted)) return null;

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
  // CORR-003: only near the paint. Clipped after narrowParts, so the cut makes no new narrow bits.
  // SNAP-112: fence slits only shape the leftover; the region is never clipped by them, so no crack is left.
  const fences = world.fencesOf(atom);
  const leftover = difference(eligible, painted);
  const reach = offset(painted, TUNE.SWALLOW_REACH * radiusM);
  let narrow = narrowParts(leftover, TUNE.SNAP_FACTOR * radiusM);
  if (!isEmpty(fences)) {
    // SNAP-112: narrow leftovers stop at fences, and a gap narrower than TUNE-FENCE-SNAP up to a fence is
    // narrow too. That distance is shorter than the snap distance: a fence in the middle of a wide gap must
    // not split it into two halves that each close.
    const cut = difference(leftover, fences);
    narrow = [
      ...narrow.flatMap((c) => components(difference(c, fences))),
      ...narrowParts(cut, TUNE.FENCE_SNAP * radiusM),
    ];
  }
  const swallowed = narrow
    .flatMap((c) => components(intersect(c, reach)))
    .filter((c) => touches(c, painted, 0.1));
  let region = union(painted, ...swallowed);
  // The half of a slit next to the region joins it, a little past the fence's centreline, so paint on either
  // side of a fence meets there, whichever stroke came first.
  if (!isEmpty(fences))
    region = union(region, intersect(intersect(offset(region, SOFT_LINE_HALF_WIDTH + 0.05), fences), eligible));
  return { region, eligible };
}

/** Replaces a whole piece with `kind` (null = erase). Returns the new piece list for the atom. */
export function claimWhole(atom: Atom, piece: Piece, kind: Kind | null): Piece[] {
  const rest = atom.pieces.filter((p) => p !== piece);
  if (kind === null) return normalize(atom, rest);
  // OVL-005: a claimed piece stays in its area; claimed void is fresh paint, which joins one (OVL-006).
  const claimed = makePiece(atom, kind, piece.shape, {
    source: piece.source, feature: piece.feature, modified: !!piece.source, name: piece.name, whole: piece.whole,
  });
  return normalize(atom, [...rest, claimed]);
}

/**
 * NAME-001: gives every piece of the named residential area `source` the kind `kind`, in every block it covers.
 * Returns the new piece list of each atom that changes.
 */
export function wholeAs(world: World, source: string, kind: Kind): Map<Atom, Piece[]> {
  const out = new Map<Atom, Piece[]>();
  for (const { atom, piece } of world.wholeOf(source)) {
    if (piece.kind === kind && !piece.rival) continue;
    const rest = (out.get(atom) ?? atom.pieces).filter((p) => p !== piece);
    out.set(atom, [...rest, makePiece(atom, kind, piece.shape, { source, modified: true, name: piece.name, whole: true })]);
  }
  for (const [atom, pieces] of out) out.set(atom, normalize(atom, pieces));
  return out;
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
      // DISP-001: what the region leaves of a disputed piece stays disputed. CORR-002: its outline is drawn now.
      return components(rest).map((c) =>
        makePiece(atom, p.kind, c, {
          ctx: p.ctx, source: p.source, feature: p.feature, modified: !!p.source, rival: p.rival, drawn: true, name: p.name, whole: p.whole,
        }),
      );
    });
  const build = (take: Shape) => {
    const kept = shrink(atom.pieces, take).filter((p) => p.kind !== null);
    const added = kind === null ? [] : components(take).map((c) => makePiece(atom, kind, c, { drawn: true })); // CORR-002
    return normalize(atom, [...kept, ...added]);
  };
  let pieces = build(region);
  // SNAP-107
  const tool: Tool = kind === null ? { type: "erase" } : { type: "paint", kind: kind as PaintKind };
  // NAME-002: a named area is never a sliver; it changes whole or not at all.
  const slivers = pieces.filter(
    (p) => changes(tool, p) && !p.whole && p.area < TUNE.SLIVER_AREA && touches(p.shape, region, 0.1),
  );
  if (slivers.length === 0) return { pieces, region };
  const grown = union(region, ...slivers.map((p) => p.shape));
  pieces = build(grown);
  return { pieces, region: grown };
}
