// From OSM text to a ready World (LOAD-*, LAT-*, IMP-*). Stages are reported for LOAD-007.
import { buildLattice } from "../lattice/build";
import { extractFeatures, type Features } from "../osm/features";
import { parseOsm } from "../osm/parse";
import type { LonLatBounds } from "../geo/project";
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
): Promise<{ world: World; report: LoadReport }> {
  const t0 = performance.now();
  onStage("reading");
  await tick();
  const features = extractFeatures(parseOsm(text), bounds);
  onStage("blocks");
  await tick();
  return finish(features, onStage, t0);
}

async function finish(features: Features, onStage: (s: Stage) => void, t0: number) {
  const lattice = buildLattice(features);
  const world = new World(features, lattice.streets, lattice.water, lattice.atoms);
  onStage("landuse");
  await tick();
  const imp = importLanduse(world, features.areas);
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
