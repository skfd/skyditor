// The live map: land loaded tile by tile as the user moves (LOAD-010..LOAD-014).
//
// Each tile is fetched with TUNE-LOAD-MARGIN around it and built on its own, in the map's one projection. Only
// the blocks that close inside what has been loaded join the world (LOAD-011). The others wait, as land, until
// a later tile closes them; the parts of one block from different tiles overlap, so their union is the block.
// Blocks already in the world are never rebuilt or touched (LOAD-013): a new block is only ever what is left of
// a candidate after the loaded land is taken out of it.
import {
  type BBox, type Shape, area, bbox, bboxOverlap, components, contains, containsDisc, difference, intersect, isEmpty, offset, rect, toM, union,
} from "../geo/clip";
import { type Tile, TileGrid, tileKey } from "../geo/tiles";
import { buildLattice } from "../lattice/build";
import { type BuildingFeature, type Features, extractFeatures, mergeFeatures } from "../osm/features";
import { parseOsm } from "../osm/parse";
import { TUNE } from "../tuning";
import type { Building } from "./buildings";
import { importLanduse } from "./import";
import { type Atom, type BuildingSet, World } from "./world";

// How far in from the edge of a download its blocks can be trusted, m. A way just outside the download still
// reaches this far in with its street space and sidewalks (LAT-003), so the frame a tile is built in stops short.
const TRUST = 40;
// How far past a waiting block to look for the edge of the loaded land, m.
const EDGE_PROBE = 1;
// Land of an area outside the loaded land that still counts as round-off, m².
const SOME_LAND = 1;
// The most tiles fetched ahead of the view to complete one area (LOAD-015): a bigger area loads as the user moves.
const MAX_AREA_TILES = 12;

export interface Grown {
  world: World;
  atoms: Atom[]; // the blocks that just loaded
  joined: { set: BuildingSet; items: Building[] }[]; // buildings that joined a set undo may hold (History.include)
}

export interface LiveOptions {
  margin: number; // TUNE-LOAD-MARGIN
  blockWait: number; // TUNE-BLOCK-WAIT
}

/** LAT-006: big enough, and thick enough, to be land anyone paints. */
const keep = (s: Shape) => area(s) >= TUNE.ATOM_MIN_AREA && containsDisc(s, TUNE.ATOM_MIN_RADIUS);

export class LiveMap {
  world: World | null = null;
  readonly tiles = new Set<string>();
  private store: Features | null = null; // every feature fetched so far, each once
  private trusted: Shape = []; // where blocks are known (the tiles' frames)
  private waiting: Shape[] = []; // LOAD-011: land of blocks not loaded whole yet
  private pool = new Map<string, { b: BuildingFeature; at: [number, number] }>(); // fetched, not shown yet
  private shown = new Set<string>();

  constructor(
    readonly grid: TileGrid,
    readonly opts: LiveOptions = { margin: TUNE.LOAD_MARGIN, blockWait: TUNE.BLOCK_WAIT },
  ) {}

  /** What to fetch for a tile (LOAD-011). */
  fetchBounds(t: Tile) {
    return this.grid.fetchBounds(t, this.opts.margin);
  }

  /** Adds one fetched tile. The world, once made, only ever grows. */
  add(t: Tile, text: string): Grown {
    this.tiles.add(tileKey(t));
    const bounds = this.grid.fetchBounds(t, this.opts.margin - TRUST);
    const osm = parseOsm(text);
    const f = extractFeatures(osm, bounds, this.grid.proj, this.store?.style); // LAT-009: decided once
    const lattice = buildLattice(f);
    this.trusted = union(this.trusted, rect(f.frame));

    let world = this.world;
    if (!world || !this.store) {
      this.store = f;
      world = this.world = new World(f, lattice.streets, lattice.water, [], []);
    } else {
      const fresh = mergeFeatures(this.store, f);
      world.addMinorLines(fresh.minorLines);
      world.streets = union(world.streets, lattice.streets);
      world.water = union(world.water, lattice.water);
    }
    world.source.add(osm); // OUT-001
    world.loaded = this.trusted;

    // LOAD-013: what is new of each candidate block; LOAD-011: it joins the land still waiting.
    const parts: Shape[] = [];
    for (const c of lattice.atoms) {
      const loaded = world.atomsIn(bbox(c)).filter((a) => !a.bridge).map((a) => a.shape);
      const rest = loaded.length ? difference(c, union(...loaded)) : c;
      parts.push(...components(rest).filter(keep));
    }
    const closed: Shape[] = [];
    const groups = components(union(...this.waiting, ...parts));
    this.waiting = [];
    for (const g of groups) {
      if (!keep(g)) continue;
      const open = !isEmpty(difference(offset(g, EDGE_PROBE), this.trusted));
      const b = bbox(g);
      const across = Math.max(toM(b.maxX - b.minX), toM(b.maxY - b.minY));
      if (!open || across >= this.opts.blockWait) closed.push(g); // LOAD-014: too big to wait for
      else this.waiting.push(g);
    }
    const atoms = world.addAtoms(closed);

    // IMP-*: landuse for the new blocks only.
    if (atoms.length) {
      const box = atoms.map((a) => a.bbox).reduce((p, q) => ({
        minX: Math.min(p.minX, q.minX), minY: Math.min(p.minY, q.minY), maxX: Math.max(p.maxX, q.maxX), maxY: Math.max(p.maxY, q.maxY),
      }));
      importLanduse(world, this.store.areas.filter((a) => bboxOverlap(bbox(a.shape), box)), new Set(atoms));
      world.source.snapshot(atoms); // OUT-002
    }

    // LOAD-011: a building shows with its block; one standing in no block shows once no waiting block holds it.
    for (const b of f.buildings)
      if (!this.shown.has(b.source) && !this.pool.has(b.source)) this.pool.set(b.source, { b, at: World.buildingCentre(b) });
    const ready: BuildingFeature[] = [];
    for (const [source, { b, at }] of this.pool) {
      const ok = !!world.atomAt(at[0], at[1]) ||
        (contains(this.trusted, at[0], at[1]) && !this.waiting.some((w) => contains(w, at[0], at[1])));
      if (!ok) continue;
      ready.push(b);
      this.pool.delete(source);
      this.shown.add(source);
    }
    const joined = world.addBuildings(ready);

    // LOAD-015 / LOAD-021: which landuse areas near the new land are still not loaded whole.
    const near = [rect(f.frame), ...atoms.map((a) => a.shape)].map(bbox);
    for (const a of this.store.areas) {
      if (a.klass.cls !== "paintable") continue;
      const box = bbox(a.shape);
      if (!near.some((n) => bboxOverlap(n, box))) continue;
      const out = area(difference(a.shape, this.trusted)) +
        this.waiting.reduce((s, w) => s + (bboxOverlap(bbox(w), box) ? area(intersect(w, a.shape)) : 0), 0);
      if (out > SOME_LAND) world.loading.add(a.id);
      else world.loading.delete(a.id);
    }
    return { world, atoms, joined };
  }

  /** LOAD-015 / LOAD-021: the tiles still to load for an area to be whole, nearest its middle first. */
  tilesFor(id: string): Tile[] {
    const a = this.store?.areas.find((x) => x.id === id);
    if (!a) return [];
    const b = bbox(a.shape);
    const view = { minX: toM(b.minX), minY: toM(b.minY), maxX: toM(b.maxX), maxY: toM(b.maxY) };
    return this.grid.around(view, 0).filter((t) => !this.tiles.has(tileKey(t))).slice(0, MAX_AREA_TILES);
  }

  /**
   * LOAD-015: the named residential areas not loaded whole, reaching into `near` (integer units) when given; their
   * rest loads before other land. Only areas near the view count, or each would pull in the next one.
   */
  namedLoading(near?: BBox): string[] {
    const w = this.world;
    if (!w || !this.store) return [];
    return this.store.areas
      .filter((a) => w.loading.has(a.id) && a.klass.cls === "paintable" && a.klass.whole && (!near || bboxOverlap(bbox(a.shape), near)))
      .map((a) => a.id);
  }
}
