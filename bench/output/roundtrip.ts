// Reads the written file back: the changes are applied to the loaded OSM data as the API would apply them,
// the result is loaded again like any file, and its land is compared with the land the user painted. What
// survives the round trip is what OSM will have (OUT-002, OUT-004).
import { type Shape, area, difference, intersect, isEmpty, rect, union } from "../../src/geo/clip";
import { buildLattice } from "../../src/lattice/build";
import { importLanduse } from "../../src/model/import";
import { type Kind, KINDS } from "../../src/model/kinds";
import { World } from "../../src/model/world";
import { extractFeatures } from "../../src/osm/features";
import { type OsmData, emptyOsm, parseOsm } from "../../src/osm/parse";
import type { Changes } from "../../src/output/changes";
import { toJosmXml } from "../../src/output/osmxml";

export interface KindMatch {
  kind: Kind;
  painted_m2: number; // in the edited world
  readback_m2: number; // in the world loaded from the result
  overlap_m2: number;
}

export interface RoundTrip {
  byKind: KindMatch[];
  painted_m2: number;
  readback_m2: number;
  overlap_m2: number;
  iou: number;
  /** Land of each kind the two worlds disagree on, for a picture: painted but not read back, and the reverse. */
  lost: Shape;
  gained: Shape;
}

/** The JOSM file read back and applied to `osm`: deleted elements gone, changed ones replaced, new ones added. */
export function applyFile(osm: OsmData, xml: string): OsmData {
  const file = parseOsm(xml); // skips action="delete"
  const out = emptyOsm();
  out.bounds = osm.bounds;
  const deleted = { node: new Set<number>(), way: new Set<number>(), relation: new Set<number>() };
  for (const m of xml.matchAll(/<(node|way|relation)\b([^>]*)action="delete"/g)) {
    const id = /\bid="(-?\d+)"/.exec(m[2]);
    if (id) deleted[m[1] as keyof typeof deleted].add(Number(id[1]));
  }
  for (const [id, p] of osm.nodes) if (!deleted.node.has(id)) out.nodes.set(id, p);
  for (const [id, t] of osm.nodeTags) if (!deleted.node.has(id)) out.nodeTags.set(id, t);
  for (const [id, w] of osm.ways) if (!deleted.way.has(id)) out.ways.set(id, w);
  for (const r of osm.relations) if (!deleted.relation.has(r.id)) out.relations.push(r);
  for (const [id, p] of file.nodes) out.nodes.set(id, p);
  for (const [id, t] of file.nodeTags) out.nodeTags.set(id, t);
  for (const [id, w] of file.ways) out.ways.set(id, w);
  for (const r of file.relations) {
    const i = out.relations.findIndex((x) => x.id === r.id);
    if (i >= 0) out.relations[i] = r;
    else out.relations.push(r);
  }
  return out;
}

/** The world a file gives when loaded on the same projection and frame as `like`. */
export function reload(osm: OsmData, like: World): World {
  const features = extractFeatures(osm, like.features.bounds, like.features.proj, like.features.style);
  const lattice = buildLattice(features);
  const world = new World(features, lattice.streets, lattice.water, lattice.atoms);
  world.source.add(osm);
  world.loaded = rect(features.frame);
  importLanduse(world, features.areas);
  world.source.snapshot(world.atoms);
  return world;
}

/** The land of each kind in a world, integer units. */
export function landByKind(world: World): Map<Kind, Shape> {
  const by = new Map<Kind, Shape[]>();
  for (const a of world.atoms)
    for (const p of a.pieces) {
      if (p.kind === null || p.kind === "CTX") continue;
      (by.get(p.kind) ?? by.set(p.kind, []).get(p.kind)!).push(p.shape);
    }
  return new Map([...by].map(([k, shapes]) => [k, union(...shapes)]));
}

/** Writes the changes, reads them back and compares the land kind by kind. R6 reads back as R5 (Q-002). */
export function roundTrip(edited: World, osm: OsmData, changes: Changes): RoundTrip {
  const back = reload(applyFile(osm, toJosmXml(changes)), edited);
  const a = fold(landByKind(edited)), b = fold(landByKind(back));
  const byKind: KindMatch[] = [];
  let painted = 0, readback = 0, overlap = 0;
  let lost: Shape = [], gained: Shape = [];
  for (const kind of new Set([...a.keys(), ...b.keys()])) {
    const pa = a.get(kind) ?? [], pb = b.get(kind) ?? [];
    const o = area(intersect(pa, pb));
    byKind.push({ kind, painted_m2: area(pa), readback_m2: area(pb), overlap_m2: o });
    painted += area(pa);
    readback += area(pb);
    overlap += o;
    const l = difference(pa, pb), g = difference(pb, pa);
    if (!isEmpty(l)) lost = union(lost, l);
    if (!isEmpty(g)) gained = union(gained, g);
  }
  byKind.sort((x, y) => y.painted_m2 - x.painted_m2);
  return { byKind, painted_m2: painted, readback_m2: readback, overlap_m2: overlap, iou: overlap / (painted + readback - overlap || 1), lost, gained };
}

/** Kinds that write the same tags count as one: R6 and R5 both write apartments, mixed and unspecified both plain residential. */
function fold(by: Map<Kind, Shape>): Map<Kind, Shape> {
  const out = new Map<Kind, Shape>();
  for (const [k, s] of by) {
    const tags = KINDS[k].tags;
    const same = ([...out.keys()] as Kind[]).find((o) => KINDS[o].tags.landuse === tags.landuse && KINDS[o].tags.residential === tags.residential);
    const key = same ?? k;
    out.set(key, out.has(key) ? union(out.get(key)!, s) : s);
  }
  return out;
}
