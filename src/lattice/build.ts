// Builds street space, water and atoms from barrier features (LAT-003..LAT-007).
import {
  type Ring, type Shape, area, bufferLines, components, containsDisc, difference, intersect, rect, union,
} from "../geo/clip";
import type { Features } from "../osm/features";
import { TUNE } from "../tuning";

export interface Lattice {
  streets: Shape;
  water: Shape;
  atoms: Shape[];
}

export function buildLattice(f: Features): Lattice {
  const frame = rect(f.frame);

  // LAT-003: buffer each barrier by its class half-width. Grouping by width keeps offset calls few.
  const byWidth = new Map<number, Ring[]>();
  for (const b of f.barriers) {
    const g = byWidth.get(b.halfWidth);
    if (g) g.push(b.line);
    else byWidth.set(b.halfWidth, [b.line]);
  }
  const parts: Shape[] = [];
  for (const [hw, lines] of byWidth) parts.push(bufferLines(lines, hw));
  // LAT-004
  parts.push(...f.streetAreas);
  const streets = intersect(union(...parts), frame);

  // LAT-008
  const water = intersect(union(...f.areas.filter((a) => a.klass.cls === "water").map((a) => a.shape)), frame);

  // LAT-005 / LAT-007: connected parts of the rest. Dead ends are just notches; nothing splits along them.
  const land = difference(difference(frame, streets), water);
  // LAT-006
  const atoms = components(land).filter(
    (c) => area(c) >= TUNE.ATOM_MIN_AREA && containsDisc(c, TUNE.ATOM_MIN_RADIUS),
  );
  return { streets, water, atoms };
}
