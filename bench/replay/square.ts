// One answer-key square: the editor's world loaded without its paintable landuse, which becomes the truth.
import { type Shape, area, components, difference, intersect, rect, toI, touches, union } from "../../src/geo/clip";
import { squareAround } from "../../src/geo/project";
import { buildLattice } from "../../src/lattice/build";
import { importLanduse } from "../../src/model/import";
import { PAINT_KINDS, type PaintKind } from "../../src/model/kinds";
import { World } from "../../src/model/world";
import { type AreaFeature, type Features, extractFeatures } from "../../src/osm/features";
import { type OsmData, parseOsm } from "../../src/osm/parse";

export const SQUARE_SIDE = 700; // m; research/landuse-edges/grid.py cuts squares this wide
export const CORE_HALF = 300; // m; scored like analyze.py: the central 600 m
const MIN_TRUTH = 50; // m² inside the core; smaller truth is not worth a stroke

export interface SquareMeta {
  name: string;
  lat: number;
  lon: number;
  city?: string;
  country?: string;
  style?: string;
}

export interface Truth {
  feature: AreaFeature;
  shape: Shape; // inside the core
  full: Shape; // the whole feature, less context
  kind: PaintKind; // stand-in kind for scoring; touching truths never share one
}

export interface Square {
  meta: SquareMeta;
  osm: OsmData;
  features: Features;
  world: World;
  truth: Truth[];
  core: Shape;
}

export function loadSquare(text: string, meta: SquareMeta): Square {
  const osm = parseOsm(text);
  const features = extractFeatures(osm, squareAround(meta.lat, meta.lon, SQUARE_SIDE));
  const kept = { ...features, areas: features.areas.filter((a) => a.klass.cls !== "paintable") };
  const lattice = buildLattice(kept);
  const world = new World(kept, lattice.streets, lattice.water, lattice.atoms);
  importLanduse(world, kept.areas);

  const h = toI(CORE_HALF);
  const core = rect({ minX: -h, minY: -h, maxX: h, maxY: h });
  // Context is protected (PAINT-004), so landuse under a park is out of reach: it nests the park (CORR-001).
  const context = union(
    ...world.atoms.flatMap((a) => a.pieces.filter((p) => p.kind === "CTX").map((p) => p.shape)),
  );
  const truth: Truth[] = [];
  for (const f of features.areas) {
    if (f.klass.cls !== "paintable") continue;
    const full = difference(f.shape, context);
    const shape = intersect(full, core);
    if (area(shape) < MIN_TRUTH) continue;
    truth.push({ feature: f, shape, full, kind: PAINT_KINDS[0] });
  }
  // Painted in this order, so smaller truth lands on top of larger truth it overlaps.
  truth.sort((a, b) => area(b.shape) - area(a.shape));
  colour(truth);
  return { meta, osm, features, world, truth, core };
}

/**
 * Same-kind pieces merge, so a shared edge between two truths would vanish if both were painted one kind.
 * Greedy colouring over the paint kinds keeps touching truths apart.
 */
function colour(truth: Truth[]) {
  const done: Truth[] = [];
  for (const t of truth) {
    const used = new Set(done.filter((d) => touches(d.shape, t.shape, 1)).map((d) => d.kind));
    t.kind = PAINT_KINDS.find((k) => !used.has(k)) ?? PAINT_KINDS[done.length % PAINT_KINDS.length];
    done.push(t);
  }
}

/** Components of a truth shape, largest first. */
export const truthParts = (t: Truth) => components(t.shape).sort((a, b) => area(b) - area(a));
