// Checks a set of changes (§18 Output) the way JOSM's validator and OSM's API would, before either sees them:
// every reference resolves, every outline is a simple closed ring, multipolygons assemble, no street node is
// taken (OUT-003), deleted elements are used by nothing, untouched areas are absent (OUT-002), and tags the
// editor does not own are kept (OUT-005). Used by `npm run outcheck` and tests/output-real.test.ts.
import { type Pt, type Shape, area, intersect, toI, union } from "../../src/geo/clip";
import type { World } from "../../src/model/world";
import { assembleRings } from "../../src/osm/features";
import type { OsmWay } from "../../src/osm/parse";
import type { Changes, OutNode, OutRelation, OutWay } from "../../src/output/changes";

export interface Problem {
  rule: string; // the requirement, or the validator's rule
  element: string; // `way/-3`
  detail: string;
}

/** Tags the editor owns (OUT-005): the rest of a changed element's tags must be as they were. */
const OWNED = new Set(["landuse", "residential", "building"]);
const CRUMB = 1; // m²; land below this between two readings is round-off

/**
 * `painted`: the land the user's strokes changed, integer units. Every changed area must hold some of it, and
 * every area that holds none must be absent (OUT-002). Pass null when it is unknown.
 */
export function checkChanges(world: World, c: Changes, painted: Shape | null): Problem[] {
  const out: Problem[] = [];
  const src = world.source;
  const proj = world.features.proj;
  const bad = (rule: string, element: string, detail: string) => out.push({ rule, element, detail });

  // Every node the file holds, by id, with its position in integer units.
  const nodes = new Map<number, Pt>();
  const nodeOf = (n: OutNode) => ({ X: toI(proj.x(n.lon)), Y: toI(proj.y(n.lat)) });
  for (const n of [...c.context, ...c.create.nodes, ...c.modify.nodes]) {
    if (nodes.has(n.id)) bad("file", `node/${n.id}`, "written twice");
    nodes.set(n.id, nodeOf(n));
  }
  const deletedNodes = new Set(c.delete.nodes.map((n) => n.id));
  const deletedWays = new Set(c.delete.ways.map((w) => w.id));
  const deletedRels = new Set(c.delete.relations.map((r) => r.id));
  const writtenWays = new Map<number, OutWay>();
  for (const w of [...c.create.ways, ...c.modify.ways]) {
    if (writtenWays.has(w.id)) bad("file", `way/${w.id}`, "written twice");
    writtenWays.set(w.id, w);
  }
  const writtenRels = new Map<number, OutRelation>();
  for (const r of [...c.create.relations, ...c.modify.relations]) {
    if (writtenRels.has(r.id)) bad("file", `relation/${r.id}`, "written twice");
    writtenRels.set(r.id, r);
  }

  // Ids: new ones negative and unique, changed and deleted ones known.
  const newIds = new Set<number>();
  const fresh = (kind: string, id: number) => {
    if (id >= 0) bad("OUT-004", `${kind}/${id}`, "a new element with a positive id");
    if (newIds.has(id)) bad("file", `${kind}/${id}`, "new id used twice");
    newIds.add(id);
  };
  for (const n of c.create.nodes) fresh("node", n.id);
  for (const w of c.create.ways) fresh("way", w.id);
  for (const r of c.create.relations) fresh("relation", r.id);
  for (const n of [...c.modify.nodes, ...c.delete.nodes]) if (!src.nodes.has(n.id)) bad("OUT-001", `node/${n.id}`, "changed or deleted but never loaded");
  for (const w of [...c.modify.ways, ...c.delete.ways]) if (!src.ways.has(w.id)) bad("OUT-001", `way/${w.id}`, "changed or deleted but never loaded");
  for (const r of [...c.modify.relations, ...c.delete.relations]) if (!src.relations.has(r.id)) bad("OUT-001", `relation/${r.id}`, "changed or deleted but never loaded");
  for (const n of c.context) {
    const have = src.nodes.get(n.id);
    if (!have) bad("OUT-001", `node/${n.id}`, "a kept node that was never loaded");
    else if (have[0] !== n.lon || have[1] !== n.lat) bad("OUT-001", `node/${n.id}`, "a kept node written at another position");
  }

  // Street nodes (OUT-003): nodes of highways, railways and waterways, which an outline may keep but never take.
  const street = new Set<number>();
  const usedBy = new Map<number, Set<number>>();
  for (const w of src.ways.values()) {
    const line = !!(w.tags.highway || w.tags.railway || w.tags.waterway);
    for (const n of w.nodes) {
      if (line) street.add(n);
      (usedBy.get(n) ?? usedBy.set(n, new Set()).get(n)!).add(w.id);
    }
  }

  // Ways: whole, closed, simple, and not on a street's nodes.
  const isBuilding = (w: OutWay) => !!w.tags.building;
  for (const w of writtenWays.values()) {
    const id = `way/${w.id}`;
    const before = src.ways.get(w.id);
    const ring: Pt[] = [];
    let whole = true;
    for (const n of w.nodes) {
      const p = nodes.get(n);
      if (!p) {
        bad("JOSM-001", id, `node ${n} is not in the file`);
        whole = false;
      } else ring.push(p);
      if (deletedNodes.has(n)) bad("OUT-004", id, `uses node ${n}, which is deleted`);
      if (n > 0 && street.has(n) && !(before?.nodes.includes(n) ?? false)) bad("OUT-003", id, `takes street node ${n}`);
    }
    if (w.nodes.length < 4) bad("geometry", id, `${w.nodes.length} nodes`);
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) bad("geometry", id, "not closed");
    for (let i = 1; i < w.nodes.length; i++) if (w.nodes[i] === w.nodes[i - 1]) bad("geometry", id, `node ${w.nodes[i]} twice in a row`);
    const seen = new Set<number>();
    for (const n of w.nodes.slice(0, -1)) {
      if (seen.has(n)) bad("geometry", id, `node ${n} visited twice`);
      seen.add(n);
    }
    if (whole && w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1]) {
      const open = ring.slice(0, -1);
      const cross = selfIntersection(open);
      if (cross) bad("geometry", id, `self-intersects at (${(cross.X / 100).toFixed(1)}, ${(cross.Y / 100).toFixed(1)}) m`);
      if (Math.abs(area([open])) < CRUMB && !isBuilding(w)) bad("geometry", id, "no area");
    }
    if (before) {
      if (isBuilding(w) && !sameNodes(before.nodes, w.nodes)) bad("TYPE-011", id, "a building's outline changed");
      for (const [k, v] of Object.entries(before.tags)) if (!OWNED.has(k) && w.tags[k] !== v) bad("OUT-005", id, `tag ${k}=${v} lost or changed`);
      for (const k of Object.keys(w.tags)) if (!OWNED.has(k) && !(k in before.tags)) bad("OUT-005", id, `tag ${k} added`);
    }
  }

  // Relations: multipolygons that assemble into rings, inner inside outer, tags on the relation.
  const wayNodes = (ref: number): OsmWay | undefined => writtenWays.get(ref) ?? (deletedWays.has(ref) ? undefined : src.ways.get(ref));
  for (const r of writtenRels.values()) {
    const id = `relation/${r.id}`;
    if (r.tags.type !== "multipolygon") bad("OUT-004", id, `type=${r.tags.type}`);
    const before = src.relations.get(r.id);
    if (before) {
      for (const [k, v] of Object.entries(before.tags)) if (!OWNED.has(k) && r.tags[k] !== v) bad("OUT-005", id, `tag ${k}=${v} lost or changed`);
    }
    const byRole = { outer: [] as number[][], inner: [] as number[][] };
    for (const m of r.members) {
      if (m.type !== "way") continue;
      if (m.role !== "outer" && m.role !== "inner") {
        bad("OUT-004", id, `member way ${m.ref} has role "${m.role}"`);
        continue;
      }
      const w = wayNodes(m.ref);
      if (!w) {
        bad("JOSM-001", id, `member way ${m.ref} is not in the file nor loaded`);
        continue;
      }
      byRole[m.role].push(w.nodes);
    }
    if (byRole.outer.length === 0) bad("OUT-004", id, "no outer ring");
    const outers = assembleRings(byRole.outer), inners = assembleRings(byRole.inner);
    if (outers.open) bad("geometry", id, `${outers.open} outer ring(s) do not close`);
    if (inners.open) bad("geometry", id, `${inners.open} inner ring(s) do not close`);
    const toRing = (ids: number[]): Pt[] | null => {
      const pts: Pt[] = [];
      for (const n of ids.slice(0, -1)) {
        const p = nodes.get(n) ?? point(src.nodes.get(n), proj);
        if (!p) return null;
        pts.push(p);
      }
      return pts;
    };
    const outerRings = outers.rings.map(toRing).filter((x): x is Pt[] => !!x);
    for (const ring of inners.rings) {
      const pts = toRing(ring);
      if (!pts) continue;
      const inside = outerRings.some((o) => area(intersect([o], [pts])) >= area([pts]) - CRUMB);
      if (!inside) bad("geometry", id, "an inner ring lies outside every outer ring");
    }
  }

  // Deleted elements: used by nothing that stands.
  for (const n of c.delete.nodes) {
    if (src.nodeTags.has(n.id)) bad("OUT-004", `node/${n.id}`, "deleted although tagged");
    for (const wid of usedBy.get(n.id) ?? []) {
      if (deletedWays.has(wid)) continue;
      const w = writtenWays.get(wid) ?? src.ways.get(wid)!;
      if (w.nodes.includes(n.id)) bad("OUT-004", `node/${n.id}`, `deleted but way ${wid} still uses it`);
    }
  }
  for (const w of c.delete.ways) {
    for (const r of src.relations.values()) {
      if (deletedRels.has(r.id)) continue;
      const now = writtenRels.get(r.id) ?? r;
      if (now.members.some((m) => m.type === "way" && m.ref === w.id)) bad("OUT-004", `way/${w.id}`, `deleted but relation ${r.id} still uses it`);
    }
  }
  for (const w of c.delete.ways)
    for (const n of w.nodes) {
      if (deletedNodes.has(n) || src.nodeTags.has(n)) continue;
      // A node the deleted way let go of must still be in use somewhere, else it is an orphan (OUT-004).
      const users = [...(usedBy.get(n) ?? [])].filter((id) => !deletedWays.has(id) && (writtenWays.get(id) ?? src.ways.get(id)!).nodes.includes(n));
      const inWritten = [...writtenWays.values()].some((x) => x.nodes.includes(n));
      if (users.length === 0 && !inWritten) bad("OUT-004", `node/${n}`, `orphaned by deleting way ${w.id}`);
    }

  // Areas: counts are the areas (OUT-009), every changed one holds painted land, no untouched one is written.
  const counts = { changed: 0, added: 0, removed: 0 };
  for (const a of c.areas) counts[a.what]++;
  if (counts.changed !== c.counts.changed || counts.added !== c.counts.added || counts.removed !== c.counts.removed)
    bad("OUT-009", "counts", `${JSON.stringify(c.counts)} against ${JSON.stringify(counts)} areas`);
  if (painted) {
    for (const a of c.areas) {
      const feature = a.feature.replace(/\+\w+$/, "");
      const imported = src.importedLand.get(feature);
      if (!imported) continue; // a painted area: land of its own, by definition inside the strokes
      if (area(intersect(imported, painted)) < CRUMB && area(intersect(a.land, painted)) < CRUMB)
        bad("OUT-002", feature, `${a.what} although no stroke touched it`);
    }
    const written = new Set(c.areas.map((a) => a.feature.replace(/\+\w+$/, "")));
    for (const [feature, imported] of src.importedLand) {
      if (written.has(feature) || area(intersect(imported, painted)) >= CRUMB) continue;
      const ref = refOf(feature);
      const touched = ref && (ref.type === "way" ? writtenWays.has(ref.id) || deletedWays.has(ref.id) : writtenRels.has(ref.id) || deletedRels.has(ref.id));
      if (touched) bad("OUT-002", feature, "written although untouched");
    }
  }
  return out;
}

/** The painted land: everything the strokes changed, as the union of the regions their events claimed. */
export const paintedLand = (regions: Shape[]): Shape => (regions.length ? union(...regions) : []);

const point = (ll: [number, number] | undefined, proj: { x: (lon: number) => number; y: (lat: number) => number }): Pt | null =>
  ll ? { X: toI(proj.x(ll[0])), Y: toI(proj.y(ll[1])) } : null;

const sameNodes = (a: number[], b: number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

const refOf = (feature: string) => {
  const m = /^(way|relation)\/(\d+)$/.exec(feature);
  return m ? { type: m[1] as "way" | "relation", id: Number(m[2]) } : null;
};

/** Where two non-adjacent edges of a closed ring cross, or null. Touching at a shared vertex is not a crossing. */
export function selfIntersection(ring: Pt[]): Pt | null {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent across the closure
      const c = ring[j], d = ring[(j + 1) % n];
      const hit = segmentsCross(a, b, c, d);
      if (hit) return hit;
    }
  }
  return null;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2);
    return { X: Math.round(a.X + (b.X - a.X) * t), Y: Math.round(a.Y + (b.Y - a.Y) * t) };
  }
  // Collinear overlap of two edges counts too: the ring runs back over itself.
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    const lo = Math.min(a.X, b.X), hi = Math.max(a.X, b.X), lo2 = Math.min(c.X, d.X), hi2 = Math.max(c.X, d.X);
    const loY = Math.min(a.Y, b.Y), hiY = Math.max(a.Y, b.Y), lo2Y = Math.min(c.Y, d.Y), hi2Y = Math.max(c.Y, d.Y);
    if (Math.min(hi, hi2) > Math.max(lo, lo2) || Math.min(hiY, hi2Y) > Math.max(loY, lo2Y)) return c;
  }
  return null;
}

const cross = (o: Pt, a: Pt, b: Pt) => Math.sign((a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X));

/** How a problem list reads. */
export const formatProblems = (ps: Problem[]) => ps.map((p) => `${p.rule}  ${p.element}: ${p.detail}`).join("\n");

