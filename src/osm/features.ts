// Turns raw OSM data into the features the lattice and the importer need (LOAD-005/006, LAT-001..004).
import { type BBox, type Ring, type Shape, area as shapeArea, toI, union } from "../geo/clip";
import { Projection, type LonLatBounds } from "../geo/project";
import { type AreaClass, type BuildingLook, EDUCATION_AMENITY, buildingLook, classifyArea } from "../model/kinds";
import { TUNE } from "../tuning";
import ClipperLib from "clipper-lib";
import { dataBounds, type OsmData, type OsmWay, type Tags } from "./parse";

export interface AreaFeature {
  id: string; // "way/123" | "relation/456"
  tags: Tags;
  shape: Shape;
  area: number; // m², whole feature
  klass: AreaClass;
}
export interface Barrier {
  id: string;
  line: Ring;
  halfWidth: number; // m
}
export interface BuildingFeature {
  ring: Float32Array; // closed ring, x,y metres
  look: BuildingLook | null; // BLD-001
}
export interface MinorLine {
  pts: Float32Array; // x,y metres
  major: boolean;
}
export interface Features {
  bounds: LonLatBounds;
  proj: Projection;
  frame: BBox; // integer units
  barriers: Barrier[];
  streetAreas: Shape[];
  areas: AreaFeature[];
  buildings: BuildingFeature[];
  minorLines: MinorLine[];
  report: { skippedRings: number; ways: number; relations: number };
}

const BARRIER_HIGHWAY = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
  "pedestrian", "road",
]);
const BARRIER_RAILWAY = new Set(["rail", "light_rail", "narrow_gauge"]);
const BARRIER_WATERWAY = new Set(["river", "canal"]);
const MINOR_HIGHWAY = new Set(["service", "footway", "path", "cycleway", "track", "steps", "bridleway"]);

/** LAT-001/LAT-002: the barrier class of a way, or null. */
export function barrierClass(tags: Tags): string | null {
  if (tags.tunnel && tags.tunnel !== "no") return null;
  if (tags.covered === "yes") return null;
  if (tags.area === "yes") return null;
  const hw = tags.highway;
  if (hw) {
    if (BARRIER_HIGHWAY.has(hw)) return hw;
    if (hw.endsWith("_link") && BARRIER_HIGHWAY.has(hw.slice(0, -5))) return "link";
    return null;
  }
  if (tags.railway && BARRIER_RAILWAY.has(tags.railway)) return tags.railway;
  if (tags.waterway && BARRIER_WATERWAY.has(tags.waterway)) return tags.waterway;
  return null;
}

/** TUNE-HALFWIDTH, with `width=*` overriding. */
export function halfWidth(cls: string, tags: Tags): number {
  const w = Number((tags.width ?? "").trim().replace(/\s*m$/, ""));
  if (tags.width && Number.isFinite(w) && w > 0 && w < 200) return w / 2;
  return TUNE.HALFWIDTH[cls] ?? 5;
}

const isAreaish = (t: Tags) =>
  !!(t.landuse || t.leisure || t.building || t.amenity === "parking" || EDUCATION_AMENITY.has(t.amenity ?? "") ||
    t["area:highway"] || t.area === "yes" ||
    (t.natural && t.natural !== "coastline" && t.natural !== "tree_row") || t.waterway === "riverbank");

export function extractFeatures(osm: OsmData, boundsOverride?: LonLatBounds): Features {
  const bounds = boundsOverride ?? dataBounds(osm);
  if (!bounds) throw new Error("The data has no nodes");
  const proj = Projection.centredOn(bounds);
  const frame: BBox = {
    minX: toI(proj.x(bounds.minLon)),
    maxX: toI(proj.x(bounds.maxLon)),
    minY: toI(proj.y(bounds.maxLat)),
    maxY: toI(proj.y(bounds.minLat)),
  };
  const f: Features = {
    bounds, proj, frame, barriers: [], streetAreas: [], areas: [], buildings: [], minorLines: [],
    report: { skippedRings: 0, ways: osm.ways.size, relations: osm.relations.length },
  };

  const coords = (w: OsmWay): [number, number][] | null => {
    const out: [number, number][] = [];
    for (const id of w.nodes) {
      const n = osm.nodes.get(id);
      if (!n) return null;
      out.push([proj.x(n[0]), proj.y(n[1])]);
    }
    return out;
  };
  const partialCoords = (w: OsmWay) => {
    const out: [number, number][] = [];
    for (const id of w.nodes) {
      const n = osm.nodes.get(id);
      if (n) out.push([proj.x(n[0]), proj.y(n[1])]);
    }
    return out;
  };
  const toRing = (pts: [number, number][]): Ring => pts.map(([x, y]) => ({ X: toI(x), Y: toI(y) }));
  const isClosed = (w: OsmWay) => w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];

  const addArea = (id: string, tags: Tags, rings: Ring[]) => {
    const klass = classifyArea(tags);
    if (!klass || rings.length === 0) return;
    const shape = evenOdd(rings);
    const a = shapeArea(shape);
    if (a <= 0) return;
    f.areas.push({ id, tags, shape, area: a, klass });
  };

  for (const w of osm.ways.values()) {
    const t = w.tags;
    const bc = barrierClass(t);
    if (bc) {
      const pts = partialCoords(w);
      if (pts.length >= 2) f.barriers.push({ id: `way/${w.id}`, line: toRing(pts), halfWidth: halfWidth(bc, t) });
      continue;
    }
    // LAT-004: highway areas of a barrier class join street space.
    const areaHw = t["area:highway"] ?? (t.area === "yes" ? t.highway : undefined);
    if (areaHw && (BARRIER_HIGHWAY.has(areaHw) || areaHw.endsWith("_link")) && isClosed(w)) {
      const pts = coords(w);
      if (pts) f.streetAreas.push(evenOdd([toRing(pts)]));
      continue;
    }
    if (t.highway && MINOR_HIGHWAY.has(t.highway) && !(t.tunnel && t.tunnel !== "no")) {
      const pts = partialCoords(w);
      if (pts.length >= 2) f.minorLines.push({ pts: new Float32Array(pts.flat()), major: t.highway === "service" });
      continue;
    }
    if (!isClosed(w) || !isAreaish(t)) continue;
    const pts = coords(w);
    if (!pts) continue;
    if (t.building && t.building !== "no") {
      f.buildings.push({ ring: new Float32Array(pts.flat()), look: buildingLook(t) });
      continue;
    }
    addArea(`way/${w.id}`, t, [toRing(pts)]);
  }

  // LOAD-005/006: multipolygons from member ways.
  for (const r of osm.relations) {
    if (r.tags.type !== "multipolygon" || !classifyArea(r.tags)) continue;
    const parts: number[][] = [];
    for (const m of r.members) {
      if (m.type !== "way") continue;
      const w = osm.ways.get(m.ref);
      if (w && w.nodes.length >= 2) parts.push(w.nodes);
      else f.report.skippedRings++;
    }
    const { rings, open } = assembleRings(parts);
    f.report.skippedRings += open;
    const intRings: Ring[] = [];
    for (const ring of rings) {
      const pts: [number, number][] = [];
      let ok = true;
      for (const id of ring) {
        const n = osm.nodes.get(id);
        if (!n) {
          ok = false;
          break;
        }
        pts.push([proj.x(n[0]), proj.y(n[1])]);
      }
      if (ok) intRings.push(toRing(pts));
      else f.report.skippedRings++;
    }
    addArea(`relation/${r.id}`, r.tags, intRings);
  }
  return f;
}

function evenOdd(rings: Ring[]): Shape {
  const c = new ClipperLib.Clipper();
  c.AddPaths(rings, ClipperLib.PolyType.ptSubject, true);
  const out: Shape = [];
  c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return union(out);
}

/** Joins way node lists end to end into closed rings. Returns closed rings and the count of open leftovers. */
export function assembleRings(parts: number[][]): { rings: number[][]; open: number } {
  const rings: number[][] = [];
  const pool = parts.map((p) => p.slice());
  let open = 0;
  while (pool.length) {
    let cur = pool.shift()!;
    let grew = true;
    while (cur[0] !== cur[cur.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const end = cur[cur.length - 1];
        const start = cur[0];
        if (p[0] === end) cur = cur.concat(p.slice(1));
        else if (p[p.length - 1] === end) cur = cur.concat(p.slice(0, -1).reverse());
        else if (p[p.length - 1] === start) cur = p.concat(cur.slice(1));
        else if (p[0] === start) cur = p.slice().reverse().concat(cur.slice(1));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur.length >= 4 && cur[0] === cur[cur.length - 1]) rings.push(cur);
    else open++;
  }
  return { rings, open };
}
