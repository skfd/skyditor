// What the user changed, as OSM elements (§18 Output). The lattice reshapes every imported outline for its own
// use (IMP-005 to IMP-012), so the baseline is not the OSM outline but what import made of it
// (Source.importedLand): the difference between that and the land now is the user's change, and only that is
// applied to the outline OSM has (OUT-002).
import {
  type Pt, type Ring, type Shape, area, bufferLines, components, difference, intersect, isEmpty, narrowParts, offset, toI, toM, touches,
  union,
} from "../geo/clip";
import type { Projection } from "../geo/project";
import { type Kind, KINDS } from "../model/kinds";
import type { World } from "../model/world";
import { type AreaFeature, assembleRings } from "../osm/features";
import type { OsmMember, OsmWay, Tags } from "../osm/parse";
import { Source } from "../osm/source";
import ClipperLib from "clipper-lib";

export interface OutNode {
  id: number; // negative = new (OUT-004)
  lon: number;
  lat: number;
  tags: Tags;
  version?: number; // existing elements only, filled in by verify (OUT-008)
}
export interface OutWay {
  id: number;
  nodes: number[];
  tags: Tags;
  version?: number;
}
export interface OutRelation {
  id: number;
  members: OsmMember[];
  tags: Tags;
  version?: number;
}
export interface Ref {
  type: "node" | "way" | "relation";
  id: number;
}

/** OUT-009: what the user is told. */
export interface Counts {
  changed: number; // areas written with a new outline or kind
  added: number; // new areas
  removed: number; // areas deleted
  buildings: number; // buildings typed
}

/** One area's part of the changes, for the counts and for OUT-008. */
export interface AreaChange {
  feature: string; // `way/1`, `relation/2` or `new/3`
  kind: Kind;
  land: Shape; // its land now, integer units
  elements: Ref[]; // every element written for it, nodes included
  what: "changed" | "added" | "removed";
}

export interface Changes {
  create: { nodes: OutNode[]; ways: OutWay[]; relations: OutRelation[] };
  modify: { nodes: OutNode[]; ways: OutWay[]; relations: OutRelation[] };
  delete: { nodes: OutNode[]; ways: OutWay[]; relations: OutRelation[] }; // as they were, so JOSM can show them
  /** Existing nodes the written ways still use, unchanged: JOSM wants them in the file (OUT-003). */
  context: OutNode[];
  areas: AreaChange[];
  buildings: string[]; // the buildings typed, by element
  counts: Counts;
}

export const isEmptyChanges = (c: Changes) =>
  c.counts.changed + c.counts.added + c.counts.removed + c.counts.buildings === 0;

const CRUMB = 1; // m²; land smaller than this between two states is round-off, not a change
const ON_EDGE = 1; // integer units; how far from an outline an original node may sit and still be on it
const REACH = 20; // m; how far past the block's edge an outline is followed into street space (the widest street)
const STEP = 0.2; // m; how far each side grows per round when the street space between them is divided
const SLIVER = 0.15; // m; half the width under which a strip left in an outline by the division is round-off

interface Land {
  shape: Shape;
  kind: Kind;
}

/** One imported area's reading, before anything is written. */
interface Reading {
  feature: string;
  ref: Ref;
  original: AreaFeature;
  importedKind: Kind;
  lands: Land[];
  current: Shape;
  taken: Shape; // what the user took away, reaching out through the outline's street space (OUT-002)
  out: Shape; // the outline to write
}

/**
 * OUT-002 to OUT-007. `skip` leaves out areas (by feature) OUT-008 found changed on the server.
 */
export function computeChanges(world: World, skip: ReadonlySet<string> = new Set()): Changes {
  const src = world.source;
  const w = new Writer(src, world.features.proj);
  const areas: AreaChange[] = [];

  // The land of every area now, by feature and kind. One area may hold two kinds after a density step on one of
  // its blocks (DENS-*); the kind holding most of its land keeps the element, the rest becomes areas of their own.
  const now = new Map<string, Map<Kind, Shape[]>>();
  const disputedNow = new Map<string, Shape[]>(); // OUT-007: parts still disputed, by the rival
  for (const atom of world.atoms)
    for (const p of atom.pieces) {
      if (p.rival?.source) (disputedNow.get(p.rival.source) ?? disputedNow.set(p.rival.source, []).get(p.rival.source)!).push(p.shape);
      if (p.kind === null || p.kind === "CTX" || !p.feature) continue;
      const byKind = now.get(p.feature) ?? now.set(p.feature, new Map()).get(p.feature)!;
      (byKind.get(p.kind) ?? byKind.set(p.kind, []).get(p.kind)!).push(p.shape);
    }
  const landsOf = (feature: string): Land[] => {
    const byKind = now.get(feature);
    if (!byKind) return [];
    return [...byKind].map(([kind, shapes]) => ({ kind, shape: union(...shapes) })).sort((a, b) => area(b.shape) - area(a.shape));
  };
  const originals = new Map(world.features.areas.map((a) => [a.id, a]));
  const land = union(...world.atoms.filter((a) => a.pieces.length).map((a) => a.shape)); // every block, bridges included

  // Imported areas: what each one keeps and gives up (OUT-002, OUT-006, OUT-007).
  const readings: Reading[] = [];
  for (const [feature, importedKind] of src.importedKind) {
    if (skip.has(feature)) continue;
    const imported = src.importedLand.get(feature) ?? [];
    const lands = landsOf(feature);
    const current = union(...lands.map((l) => l.shape));
    const removed = material(difference(imported, current));
    const settled = material(difference(src.disputed.get(feature) ?? [], union(...(disputedNow.get(feature) ?? [])))); // OUT-007
    const added = material(difference(current, imported));
    const kind = lands[0]?.kind ?? importedKind;
    if (isEmpty(removed) && isEmpty(settled) && isEmpty(added) && kind === importedKind && lands.length <= 1) continue;
    const original = originals.get(feature);
    const ref = Source.ref(feature);
    if (!original || !ref) continue;
    // OUT-002: the outline OSM has, less what the user took away, plus what they painted on. What is taken away
    // reaches out through the street space the outline covers beyond the block's edge (reachOut). Land import gave
    // the area beyond its outline (IMP-007 closes thin gaps against the block edge) is not written unless the user's
    // new land joins on to it: then it is the join.
    const taken = reachOut(union(removed, settled), current, original.shape, land);
    const absorbed = components(difference(imported, original.shape)).filter((c) => touches(c, added));
    const out = clean(union(difference(original.shape, taken), added, ...absorbed));
    readings.push({ feature, ref, original, importedKind, lands, current, taken, out });
  }

  // OUT-003: land that passed from one area to another takes the street space along with it, so the two still
  // meet along one line. Each area's outline gains, from every area that gave land up, the street space beside
  // its share of that land.
  const gain = (feature: string, shape: Shape): Shape => {
    let out: Shape = [];
    for (const r of readings) {
      if (r.feature === feature) continue;
      const share = material(intersect(shape, r.taken));
      if (isEmpty(share)) continue;
      const others = union(r.current, difference(intersect(r.taken, land), shape));
      out = union(out, difference(reachOut(share, others, r.original.shape, land, r.taken), land));
    }
    return out;
  };
  for (const r of readings) {
    const g = gain(r.feature, r.current);
    if (!isEmpty(g)) r.out = clean(union(r.out, g));
  }

  for (const r of readings) {
    const { feature, ref, original, importedKind, lands, current } = r;
    const kind = lands[0]?.kind ?? importedKind;
    // What is left of an outline inside the loaded land but holding none of the area's land now is the lattice's
    // reading of it (street space, slivers), not land the user kept: a captured or erased area goes whole (OUT-006).
    let out = components(r.out).filter((c) => !isEmpty(intersect(c, current)) || !inside(c, world.loaded)).flat();
    // A second kind in the area becomes an area of its own, with the original's tags but its own kind.
    for (const extra of lands.slice(1)) {
      const others = union(...lands.filter((l) => l !== extra).map((l) => l.shape));
      const parts = clean(intersect(out, reachOut(extra.shape, others, original.shape, land)));
      if (isEmpty(parts)) continue;
      out = clean(difference(out, parts));
      areas.push(w.createArea(`${feature}+${extra.kind}`, extra.kind, parts, retag(original.tags, extra.kind)));
    }
    if (isEmpty(out)) {
      areas.push(w.deleteArea(feature, ref, importedKind));
      continue;
    }
    const tags = retag(original.tags, kind);
    const change = w.modifyArea(feature, ref, kind, out, tags, !sameTags(tags, original.tags));
    if (change) areas.push(change);
  }

  // Painted areas (OUT-004).
  for (const feature of now.keys()) {
    if (!feature.startsWith("new/") || skip.has(feature)) continue;
    for (const l of landsOf(feature)) {
      const shape = clean(union(material(l.shape), gain(feature, l.shape)));
      if (isEmpty(shape)) continue;
      areas.push(w.createArea(feature, l.kind, shape, { ...KINDS[l.kind].tags }));
    }
  }

  // Buildings (OUT-005, TYPE-011).
  const buildings: string[] = [];
  for (const set of world.buildingSets())
    for (const b of set.items) {
      if (!b.modified) continue;
      const ref = Source.ref(b.geom.source);
      const way = ref && src.ways.get(ref.id);
      if (!way || skip.has(b.geom.source)) continue;
      w.modify.ways.push({ id: way.id, nodes: way.nodes, tags: b.tags });
      buildings.push(b.geom.source);
    }

  return w.finish(areas, buildings);
}

/** OUT-005: the kind's tags replace `landuse` and `residential`; everything else stays. */
export function retag(tags: Tags, kind: Kind): Tags {
  const out: Tags = {};
  for (const [k, v] of Object.entries(tags)) if (k !== "landuse" && k !== "residential") out[k] = v;
  return { ...out, ...KINDS[kind].tags };
}

const sameTags = (a: Tags, b: Tags) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** Land big enough to be a change rather than integer round-off. */
const material = (s: Shape): Shape => components(s).filter((c) => area(c) >= CRUMB).flat();

/** An outline without the strips narrower than 2 × SLIVER that dividing street space leaves along a cut. */
const clean = (s: Shape): Shape => {
  const slivers = narrowParts(s, SLIVER);
  return material(slivers.length ? difference(s, union(...slivers)) : s);
};

/**
 * OUT-002: land `taken` from an area reaches out into the street space its outline covers beyond the block's
 * edge (the band), as far as the land the area `keeps` does not: where the cut between them meets the block's
 * edge, it carries straight on through the band; the whole overhang of a block that is gone goes with it; and
 * street space between a block that is gone and one that stays, with no cut between them, is divided down the
 * middle, in rounds of STEP as IMP-010 divides a drift strip.
 */
function reachOut(taken: Shape, keeps: Shape, outline: Shape, land: Shape, within?: Shape): Shape {
  if (isEmpty(taken)) return taken;
  let band = intersect(difference(outline, land), offset(taken, REACH, "miter"));
  if (within) band = intersect(band, within);
  if (isEmpty(band)) return taken;
  if (isEmpty(keeps)) return union(taken, band);
  const slits = bufferLines(cutLines(taken, keeps).map(extend), SLIT);
  const nearA = offset(taken, 0.1, "miter"), nearB = offset(keeps, 0.1, "miter");
  const mine: Shape[] = [];
  for (const part of components(slits.length ? difference(band, slits) : band)) {
    const a = area(intersect(part, nearA)) > 0.01, b = area(intersect(part, nearB)) > 0.01;
    if (a && b) mine.push(divide(part, taken, keeps));
    else if (a) mine.push(part);
  }
  if (mine.length === 0) return taken;
  // The slit along a cut goes to the taken side as far as its middle, so the cut line is the division.
  return union(taken, intersect(band, offset(union(...mine), SLIT, "miter")));
}

const SLIT = 0.01; // m; half the width of the slit cut through the band along an extended cut line

/** The band `part` both sides reach, divided between them by growth in rounds. */
function divide(part: Shape, taken: Shape, keeps: Shape): Shape {
  const near = offset(part, 2 * STEP, "miter");
  const seedA = intersect(taken, near), seedB = intersect(keeps, near);
  let mine: Shape = [], rest = part;
  for (let d = STEP; d <= REACH && !isEmpty(rest); d += STEP) {
    const gA = intersect(rest, offset(seedA, d, "miter"));
    const gB = difference(intersect(rest, offset(seedB, d, "miter")), gA);
    mine = union(mine, gA);
    rest = difference(rest, union(gA, gB));
  }
  return mine;
}

/** The runs of edges of `taken` that lie along `keeps`: the cuts between them, as open polylines. */
function cutLines(taken: Shape, keeps: Shape): Ring[] {
  const verts = new Set<string>();
  for (const r of keeps) for (const p of r) verts.add(key(p));
  const nearKeeps = offset(keeps, 0.02, "miter");
  const out: Ring[] = [];
  for (const ring of taken) {
    const n = ring.length;
    const isCut = ring.map((a, i) => {
      const b = ring[(i + 1) % n];
      if (!verts.has(key(a)) || !verts.has(key(b))) return false;
      return containsPt(nearKeeps, { X: Math.round((a.X + b.X) / 2), Y: Math.round((a.Y + b.Y) / 2) });
    });
    if (isCut.every(Boolean)) continue; // an island inside the kept land: no cut reaches the edge
    // Chains of cut edges, starting after an edge that is not one.
    let start = isCut.findIndex((c) => !c);
    for (let k = 0; k < n; k++) {
      const i = (start + 1 + k) % n;
      if (!isCut[i]) continue;
      const chain: Ring = [ring[i]];
      while (isCut[(i + (chain.length - 1)) % n] && chain.length <= n) chain.push(ring[(i + chain.length) % n]);
      out.push(chain);
      k += chain.length - 1;
    }
  }
  return out;
}

/** A polyline carried on past both ends by REACH, in the direction of its end segments. */
function extend(line: Ring): Ring {
  if (line.length < 2) return line;
  const push = (from: Pt, to: Pt): Pt => {
    const d = Math.hypot(to.X - from.X, to.Y - from.Y) || 1;
    const k = toI(REACH) / d;
    return { X: Math.round(to.X + (to.X - from.X) * k), Y: Math.round(to.Y + (to.Y - from.Y) * k) };
  };
  return [push(line[1], line[0]), ...line, push(line[line.length - 2], line[line.length - 1])];
}

function containsPt(s: Shape, p: Pt): boolean {
  let inside = false;
  for (const r of s) if (ClipperLib.Clipper.PointInPolygon(p, r) !== 0) inside = !inside;
  return inside;
}

/** Whether a shape lies inside the loaded land. */
const inside = (s: Shape, loaded: Shape) => area(difference(s, loaded)) < CRUMB;

const key = (p: Pt) => `${p.X},${p.Y}`;

/**
 * Turns shapes into nodes, ways and relations. One node pool for the whole output, so areas meeting along one
 * edge share nodes (OUT-003), and an original node at a vertex is that vertex's node.
 */
class Writer {
  readonly create = { nodes: [] as OutNode[], ways: [] as OutWay[], relations: [] as OutRelation[] };
  readonly modify = { nodes: [] as OutNode[], ways: [] as OutWay[], relations: [] as OutRelation[] };
  readonly delete = { nodes: [] as OutNode[], ways: [] as OutWay[], relations: [] as OutRelation[] };
  private nextId = -1;
  private readonly pool = new Map<string, number>(); // integer coordinate -> node id
  private readonly points = new Map<number, Pt>(); // node id -> integer coordinate
  private readonly usedBy = new Map<number, number[]>(); // node -> source ways using it
  private readonly street = new Set<number>(); // nodes of streets, never shared (OUT-003)
  private readonly written = new Map<number, OutWay>(); // ways written, by id
  private readonly removedWays = new Set<number>();
  private readonly removedRelations = new Set<number>();

  constructor(readonly src: Source, readonly proj: Projection) {
    for (const [id, [lon, lat]] of src.nodes) {
      const p = { X: toI(proj.x(lon)), Y: toI(proj.y(lat)) };
      this.points.set(id, p);
      if (!this.pool.has(key(p))) this.pool.set(key(p), id);
    }
    for (const w of src.ways.values()) {
      const line = !!(w.tags.highway || w.tags.railway || w.tags.waterway);
      for (const n of w.nodes) {
        (this.usedBy.get(n) ?? this.usedBy.set(n, []).get(n)!).push(w.id);
        if (line) this.street.add(n);
      }
    }
  }

  /** The node for a vertex: an existing one standing exactly there, unless it is a street's, else a new one. */
  private nodeAt(p: Pt): number {
    const k = key(p);
    const have = this.pool.get(k);
    if (have !== undefined && !this.street.has(have)) return have;
    const id = this.nextId--;
    this.pool.set(k, id);
    this.points.set(id, p);
    this.create.nodes.push({ id, lon: round(this.proj.lon(toM(p.X))), lat: round(this.proj.lat(toM(p.Y))), tags: {} });
    return id;
  }

  /** A ring's node ids, closed, with the original's nodes put back where the outline still passes through them. */
  private ringNodes(ring: Ring, original: number[]): number[] {
    // The original's own nodes stay its nodes, even where it shared them with a street (OUT-003 forbids taking
    // a street's node, not keeping one).
    const own = new Map<string, number>();
    for (const id of original) {
      const p = this.points.get(id);
      if (p) own.set(key(p), id);
    }
    const pts = withOriginals(ring, original.map((id) => this.points.get(id)).filter((p): p is Pt => !!p));
    const ids = pts.map((p) => own.get(key(p)) ?? this.nodeAt(p));
    // The original's first node and direction, so the diff reads as a small edit.
    const start = original.find((id) => ids.includes(id));
    if (start !== undefined) {
      const i = ids.indexOf(start);
      let seq = [...ids.slice(i), ...ids.slice(0, i)];
      const next = original.find((id, k) => k > 0 && id !== start && seq.includes(id));
      if (next !== undefined && seq.indexOf(next) > seq.length / 2) seq = [seq[0], ...seq.slice(1).reverse()];
      return [...seq, seq[0]];
    }
    return [...ids, ids[0]];
  }

  createArea(feature: string, kind: Kind, land: Shape, tags: Tags): AreaChange {
    const elements: Ref[] = [];
    for (const comp of components(land)) {
      const [outer, ...holes] = comp;
      const outerWay = this.newWay(this.ringNodes(outer, []), holes.length ? {} : tags, elements);
      if (holes.length) {
        const members: OsmMember[] = [{ type: "way", ref: outerWay.id, role: "outer" }];
        for (const h of holes) members.push({ type: "way", ref: this.newWay(this.ringNodes(h, []), {}, elements).id, role: "inner" });
        const rel: OutRelation = { id: this.nextId--, members, tags: { type: "multipolygon", ...tags } };
        this.create.relations.push(rel);
        elements.push({ type: "relation", id: rel.id });
      }
    }
    return { feature, kind, land, elements: this.withNodes(elements), what: "added" };
  }

  private newWay(nodes: number[], tags: Tags, elements: Ref[]): OutWay {
    const way: OutWay = { id: this.nextId--, nodes, tags };
    this.create.ways.push(way);
    this.written.set(way.id, way);
    elements.push({ type: "way", id: way.id });
    return way;
  }

  /** OUT-002: an outline rewritten. `retagged` says whether the tags changed as well. */
  modifyArea(feature: string, ref: Ref, kind: Kind, out: Shape, tags: Tags, retagged: boolean): AreaChange | null {
    const elements: Ref[] = [];
    const comps = components(out);
    if (ref.type === "way") {
      const way = this.src.ways.get(ref.id)!;
      // The biggest part keeps the way; any other part is an area of its own with the same tags.
      comps.sort((a, b) => area(b) - area(a));
      comps.forEach(([outer, ...holes], i) => {
        const outerNodes = this.ringNodes(outer, i === 0 ? way.nodes : []);
        if (holes.length) {
          // A way with holes is a multipolygon: the way becomes its outer, the tags move to the relation.
          const outerWay = i === 0 ? this.rewrite(way, outerNodes, {}, elements) : this.newWay(outerNodes, {}, elements);
          const members: OsmMember[] = [{ type: "way", ref: outerWay.id, role: "outer" }];
          for (const h of holes) members.push({ type: "way", ref: this.newWay(this.ringNodes(h, []), {}, elements).id, role: "inner" });
          const rel: OutRelation = { id: this.nextId--, members, tags: { type: "multipolygon", ...tags } };
          this.create.relations.push(rel);
          elements.push({ type: "relation", id: rel.id });
        } else if (i === 0) this.rewrite(way, outerNodes, tags, elements, retagged);
        else this.newWay(outerNodes, tags, elements);
      });
    } else {
      this.modifyRelation(ref.id, comps, tags, elements, retagged);
    }
    if (elements.length === 0) return null; // nothing to write: mixed on unspecified land says the same (Q-011)
    return { feature, kind, land: out, elements: this.withNodes(elements), what: "changed" };
  }

  /** A way with new nodes, or with new tags only; left alone when neither changed. */
  private rewrite(way: OsmWay, nodes: number[], tags: Tags, elements: Ref[], retagged = true): OutWay {
    const same = nodes.length === way.nodes.length && nodes.every((n, i) => n === way.nodes[i]);
    const out: OutWay = { id: way.id, nodes, tags };
    if (!same || retagged) {
      this.modify.ways.push(out);
      elements.push({ type: "way", id: way.id });
    }
    this.written.set(way.id, out);
    return out;
  }

  /**
   * A multipolygon rewritten ring by ring. A ring that was one way is that way, rewritten. A ring of several
   * ways keeps the members the new outline still runs along whole, and each changed stretch becomes one new way
   * (Q-014). Rings gone are dropped, their ways deleted unless tagged or used elsewhere.
   */
  private modifyRelation(id: number, comps: Shape[], tags: Tags, elements: Ref[], retagged: boolean) {
    const rel = this.src.relations.get(id)!;
    const memberWays = rel.members.filter((m) => m.type === "way").map((m) => this.src.ways.get(m.ref)).filter((w): w is OsmWay => !!w);
    const oldRings = assembleRings(memberWays.map((w) => w.nodes)).rings;
    const ringWays = (ring: number[]) => memberWays.filter((w) => w.nodes.every((n) => ring.includes(n)));
    const members: OsmMember[] = [];
    const used = new Set<number>();
    const place = (ring: Ring, role: string) => {
      // The old ring sharing most nodes with this one.
      const pts = ring.map(key);
      let best: number[] | null = null, bestN = 0;
      for (const r of oldRings) {
        const n = r.filter((nid) => pts.includes(key(this.points.get(nid)!))).length;
        if (n > bestN) [best, bestN] = [r, n];
      }
      const ways = best ? ringWays(best).filter((w) => !used.has(w.id)) : [];
      const nodes = this.ringNodes(ring, best ?? []);
      if (ways.length === 1) {
        used.add(ways[0].id);
        members.push({ type: "way", ref: this.rewrite(ways[0], nodes, ways[0].tags, elements, false).id, role });
        return;
      }
      if (ways.length === 0) {
        members.push({ type: "way", ref: this.newWay(nodes, {}, elements).id, role });
        return;
      }
      // Several ways: keep those the ring still runs along whole, and write each stretch between them anew.
      const open = nodes.slice(0, -1);
      const covered = new Array<boolean>(open.length).fill(false);
      for (const w of ways) {
        const run = runOf(open, w.nodes);
        if (!run) continue;
        used.add(w.id);
        members.push({ type: "way", ref: w.id, role });
        this.written.set(w.id, { id: w.id, nodes: w.nodes, tags: w.tags });
        for (const i of run) covered[i] = true;
      }
      // Stretches: maximal runs of uncovered nodes, with the covered node at each end as the joint.
      let i = covered.findIndex((c) => c);
      if (i < 0) {
        members.push({ type: "way", ref: this.newWay(nodes, {}, elements).id, role });
        return;
      }
      const n = open.length;
      let k = i;
      do {
        const next = (k + 1) % n;
        if (!covered[next]) {
          const stretch = [open[k]];
          let j = next;
          while (!covered[j]) {
            stretch.push(open[j]);
            j = (j + 1) % n;
          }
          stretch.push(open[j]);
          members.push({ type: "way", ref: this.newWay(stretch, {}, elements).id, role });
          k = j;
        } else k = next;
      } while (k !== i);
    };
    for (const [outer, ...holes] of comps) {
      place(outer, "outer");
      for (const h of holes) place(h, "inner");
    }
    // Members that are not ways (rare) stay.
    for (const m of rel.members) if (m.type !== "way") members.push(m);
    for (const w of memberWays) if (!used.has(w.id)) this.dropWay(w, elements);
    const same = !retagged && members.length === rel.members.length && members.every((m, i) => m.ref === rel.members[i].ref && m.role === rel.members[i].role);
    if (!same) {
      this.modify.relations.push({ id, members, tags: { ...tags, type: "multipolygon" } });
      elements.push({ type: "relation", id });
    }
  }

  /** OUT-004 / OUT-006: an area gone. */
  deleteArea(feature: string, ref: Ref, kind: Kind): AreaChange {
    const elements: Ref[] = [];
    if (ref.type === "way") {
      const way = this.src.ways.get(ref.id)!;
      this.dropWay(way, elements, true);
    } else {
      const rel = this.src.relations.get(ref.id)!;
      this.delete.relations.push({ id: rel.id, members: rel.members, tags: rel.tags });
      this.removedRelations.add(rel.id);
      elements.push({ type: "relation", id: rel.id });
      for (const m of rel.members) {
        const w = m.type === "way" ? this.src.ways.get(m.ref) : undefined;
        if (w) this.dropWay(w, elements);
      }
    }
    return { feature, kind, land: [], elements: this.withNodes(elements), what: "removed" };
  }

  /** A way no area needs: deleted when it carries nothing of its own and no other element uses it. */
  private dropWay(way: OsmWay, elements: Ref[], own = false) {
    if (!own && (Object.keys(way.tags).length || this.usedElsewhere(way.id))) return;
    this.delete.ways.push({ id: way.id, nodes: way.nodes, tags: way.tags });
    this.removedWays.add(way.id);
    elements.push({ type: "way", id: way.id });
  }

  private usedElsewhere(wayId: number): boolean {
    for (const r of this.src.relations.values())
      if (!this.removedRelations.has(r.id) && r.members.some((m) => m.type === "way" && m.ref === wayId)) return true;
    return false;
  }

  /** Nodes written for an area are part of its change, so OUT-008 can leave the whole area out. */
  private withNodes(elements: Ref[]): Ref[] {
    const out = [...elements];
    for (const e of elements) {
      const w = e.type === "way" ? this.written.get(e.id) : undefined;
      if (w) for (const n of w.nodes) if (n < 0) out.push({ type: "node", id: n });
    }
    return out;
  }

  /** OUT-003 / OUT-004: context nodes and the nodes nobody uses any more. */
  finish(areas: AreaChange[], buildings: string[]): Changes {
    const referenced = new Set<number>(); // by anything still standing after the change
    for (const w of [...this.create.ways, ...this.modify.ways, ...this.written.values()]) for (const n of w.nodes) referenced.add(n);
    const touched = new Set<number>([...this.modify.ways.map((w) => w.id), ...this.delete.ways.map((w) => w.id)]);
    const context: OutNode[] = [];
    const seen = new Set<number>();
    for (const w of [...this.create.ways, ...this.modify.ways])
      for (const n of w.nodes) {
        if (n < 0 || seen.has(n)) continue;
        seen.add(n);
        const [lon, lat] = this.src.nodes.get(n)!;
        context.push({ id: n, lon, lat, tags: this.src.nodeTags.get(n) ?? {} });
      }
    // Nodes a rewritten or deleted way let go of, untagged and used by no other element, are deleted.
    const dropped = new Set<number>();
    for (const w of [...this.modify.ways, ...this.delete.ways]) {
      const before = this.src.ways.get(w.id);
      if (!before) continue;
      for (const n of before.nodes) {
        if (referenced.has(n) || dropped.has(n) || this.src.nodeTags.has(n)) continue;
        if ((this.usedBy.get(n) ?? []).some((id) => !touched.has(id))) continue;
        dropped.add(n);
        const [lon, lat] = this.src.nodes.get(n)!;
        this.delete.nodes.push({ id: n, lon, lat, tags: {} });
      }
    }
    for (const a of areas) for (const n of dropped) if (a.elements.some((e) => e.type === "way" && (this.src.ways.get(e.id)?.nodes.includes(n) ?? false))) a.elements.push({ type: "node", id: n });
    const counts: Counts = {
      changed: areas.filter((a) => a.what === "changed").length,
      added: areas.filter((a) => a.what === "added").length,
      removed: areas.filter((a) => a.what === "removed").length,
      buildings: buildings.length,
    };
    return { create: this.create, modify: this.modify, delete: this.delete, context, areas, buildings, counts };
  }
}

const round = (v: number) => Math.round(v * 1e7) / 1e7;

/** Original nodes that lie on an edge of `ring` but are not its vertices any more (Clipper drops collinear points), put back. */
function withOriginals(ring: Ring, originals: Pt[]): Pt[] {
  const have = new Set(ring.map(key));
  const out = ring.slice();
  for (const p of originals) {
    if (have.has(key(p))) continue;
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      if (onSegment(p, a, b)) {
        out.splice(i + 1, 0, p);
        have.add(key(p));
        break;
      }
    }
  }
  return out;
}

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  const dx = b.X - a.X, dy = b.Y - a.Y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return false;
  const t = ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len2;
  if (t <= 0 || t >= 1) return false;
  const cross = Math.abs((p.X - a.X) * dy - (p.Y - a.Y) * dx) / Math.sqrt(len2);
  return cross <= ON_EDGE;
}

/** The indices of `cycle` that `nodes` runs along in order (either direction), or null when it does not. */
function runOf(cycle: number[], nodes: number[]): number[] | null {
  const n = cycle.length;
  const first = cycle.indexOf(nodes[0]);
  if (first < 0) return null;
  for (const dir of [1, -1]) {
    const idx: number[] = [];
    let ok = true;
    for (let k = 0; k < nodes.length; k++) {
      const i = (((first + dir * k) % n) + n) % n;
      if (cycle[i] !== nodes[k]) {
        ok = false;
        break;
      }
      idx.push(i);
    }
    if (ok) return idx;
  }
  return null;
}
