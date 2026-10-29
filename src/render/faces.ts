// REN-004: the top faces of an atom's pieces, as the renderer draws them.
import { type Shape, fillHoles, intersect, offset, union } from "../geo/clip";
import { type Piece, VOID_MIN_AREA, groupKey, touchClusters } from "../model/world";

export interface Face {
  /** The piece's own part of the drawn surface. */
  top: Shape;
  /**
   * The whole surface of the touching pieces of one kind this piece belongs to, when there are several.
   * They are drawn as one, so no seam shows between them.
   */
  group: Shape | null;
}

/**
 * REN-004: touching pieces of one kind form one surface, inset by half the gap where it meets anything else.
 * Holes too small to be land (the model drops them as round-off) are filled, not widened into dots.
 */
export function faces(pieces: readonly Piece[], gap: number): Map<Piece, Face> {
  const out = new Map<Piece, Face>();
  const groups = new Map<string, Piece[]>();
  for (const p of pieces) {
    if (p.kind === null) out.set(p, { top: p.shape, group: null });
    else groups.set(groupKey(p), [...(groups.get(groupKey(p)) ?? []), p]);
  }
  for (const g of groups.values())
    for (const cluster of touchClusters(g)) {
      const whole = fillHoles(union(...cluster.map((p) => p.shape)), VOID_MIN_AREA);
      const inset = offset(whole, -gap / 2);
      const surface = inset.length ? inset : whole; // a sliver thinner than the gap keeps its full shape
      if (cluster.length === 1) {
        out.set(cluster[0], { top: surface, group: null });
        continue;
      }
      for (const p of cluster) {
        const top = intersect(surface, p.shape);
        out.set(p, { top: top.length ? top : p.shape, group: surface });
      }
    }
  return out;
}
