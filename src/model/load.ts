// From OSM text to a ready World (LOAD-*, LAT-*, IMP-*). Stages are reported for LOAD-007.
import { rect } from "../geo/clip";
import { buildLattice } from "../lattice/build";
import { extractFeatures, type Features } from "../osm/features";
import { type OsmData, parseOsm } from "../osm/parse";
import type { LonLatBounds, Projection } from "../geo/project";
import { importLanduse } from "./import";
import { World } from "./world";

export type Stage = "fetching" | "reading" | "blocks" | "landuse";
export interface LoadReport {
  atoms: number;
  pieces: number;
  droppedFragments: number;
  skippedRings: number;
  ms: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function worldFromText(
  text: string,
  onStage: (s: Stage) => void = () => {},
  bounds?: LonLatBounds,
  proj?: Projection,
): Promise<{ world: World; report: LoadReport }> {
  const t0 = performance.now();
  onStage("reading");
  await tick();
  const osm = parseOsm(text);
  const features = extractFeatures(osm, bounds, proj);
  onStage("blocks");
  await tick();
  return finish(osm, features, onStage, t0);
}

async function finish(osm: OsmData, features: Features, onStage: (s: Stage) => void, t0: number) {
  const lattice = buildLattice(features);
  const world = new World(features, lattice.streets, lattice.water, lattice.atoms);
  world.source.add(osm); // OUT-001
  world.loaded = rect(features.frame);
  onStage("landuse");
  await tick();
  const imp = importLanduse(world, features.areas);
  world.source.snapshot(world.atoms); // OUT-002
  return {
    world,
    report: {
      atoms: world.atoms.length,
      pieces: imp.pieces,
      droppedFragments: imp.dropped,
      skippedRings: features.report.skippedRings,
      ms: performance.now() - t0,
    },
  };
}
