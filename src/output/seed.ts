// SEED-001 / SEED-002: copies the main database's data for an area to the test server, as new elements.
import type { LonLatBounds } from "../geo/project";
import { fetchArea } from "../osm/fetch";
import { type OsmData, parseOsm } from "../osm/parse";
import { SERVERS, type Server } from "../osm/server";
import type { OutNode, OutRelation, OutWay } from "./changes";
import { changesetXml, parseDiffResult } from "./upload";
import { toOsmChange } from "./osmxml";
import type { Fetch } from "./verify";

const CHUNK = 4000; // elements per changeset: under the server's limit, and a changeset the server answers quickly

export type Stage = "fetching" | "checking" | "uploading";

/** SEED-002: whether the test server already has ways in the area. */
export async function hasLand(server: Server, b: LonLatBounds, fetchFn: Fetch = fetch): Promise<boolean> {
  const res = await fetchFn(`${server.api}/api/0.6/map.json?bbox=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`);
  if (!res.ok) throw new Error(`${server.name}: HTTP ${res.status}`);
  const doc = (await res.json()) as { elements?: { type: string }[] };
  return (doc.elements ?? []).some((e) => e.type === "way");
}

/** The data as new elements: every id a placeholder, references renumbered with them. */
export function renumber(d: OsmData): { nodes: OutNode[]; ways: OutWay[]; relations: OutRelation[] } {
  const nodeId = new Map<number, number>(), wayId = new Map<number, number>(), relId = new Map<number, number>();
  let next = -1;
  const nodes: OutNode[] = [];
  for (const [id, [lon, lat]] of d.nodes) {
    nodeId.set(id, next);
    nodes.push({ id: next--, lon, lat, tags: d.nodeTags.get(id) ?? {} });
  }
  const ways: OutWay[] = [];
  for (const w of d.ways.values()) {
    if (!w.nodes.every((n) => nodeId.has(n))) continue; // cut by the download's edge
    wayId.set(w.id, next);
    ways.push({ id: next--, nodes: w.nodes.map((n) => nodeId.get(n)!), tags: w.tags });
  }
  const relations: OutRelation[] = [];
  for (const r of d.relations) {
    const members = r.members
      .filter((m) => (m.type === "node" ? nodeId.has(m.ref) : m.type === "way" ? wayId.has(m.ref) : false))
      .map((m) => ({ ...m, ref: m.type === "node" ? nodeId.get(m.ref)! : wayId.get(m.ref)! }));
    if (members.length === 0) continue;
    relId.set(r.id, next);
    relations.push({ id: next--, members, tags: r.tags });
  }
  return { nodes, ways, relations };
}

/**
 * SEED-001: fetches the main database's data for `b` and uploads it to `server` as new elements, nodes first,
 * then ways, then relations, each chunk its own changeset, with the ids the server gives carried into the next.
 * Returns the changesets made.
 */
export async function seed(server: Server, token: string, b: LonLatBounds, onStage: (s: Stage) => void, fetchFn: Fetch = fetch): Promise<number[]> {
  onStage("fetching");
  const data = parseOsm(await fetchArea(b, SERVERS.main));
  const { nodes, ways, relations } = renumber(data);
  onStage("uploading");
  const api = `${server.api}/api/0.6`;
  const ids = new Map<string, number>();
  const real = (type: string, id: number) => (id < 0 ? ids.get(`${type}/${id}`) ?? id : id);
  const changesets: number[] = [];
  const comment = `Skyditor: copy of OpenStreetMap data for testing, around ${((b.minLat + b.maxLat) / 2).toFixed(4)}, ${((b.minLon + b.maxLon) / 2).toFixed(4)}`;
  const send = async (part: { nodes: OutNode[]; ways: OutWay[]; relations: OutRelation[] }) => {
    const res = await fetchFn(`${api}/changeset/create`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/xml" }, body: changesetXml({ comment, source: "OpenStreetMap" }) });
    if (!res.ok) throw new Error(`${server.name}: HTTP ${res.status}`);
    const id = Number(await res.text());
    changesets.push(id);
    try {
      const osc = toOsmChange({ create: part, modify: { nodes: [], ways: [], relations: [] }, delete: { nodes: [], ways: [], relations: [] }, context: [], areas: [], buildings: [], counts: { changed: 0, added: 0, removed: 0, buildings: 0 } }, id);
      const up = await fetchFn(`${api}/changeset/${id}/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/xml" }, body: osc });
      const text = await up.text();
      if (!up.ok) throw new Error(`${server.name}: HTTP ${up.status}: ${text.slice(0, 160)}`);
      for (const [k, v] of parseDiffResult(text).ids) ids.set(k, v);
    } finally {
      await fetchFn(`${api}/changeset/${id}/close`, { method: "PUT", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
  };
  const empty = () => ({ nodes: [] as OutNode[], ways: [] as OutWay[], relations: [] as OutRelation[] });
  for (let i = 0; i < nodes.length; i += CHUNK) await send({ ...empty(), nodes: nodes.slice(i, i + CHUNK) });
  for (let i = 0; i < ways.length; i += CHUNK)
    await send({ ...empty(), ways: ways.slice(i, i + CHUNK).map((w) => ({ ...w, nodes: w.nodes.map((n) => real("node", n)) })) });
  for (let i = 0; i < relations.length; i += CHUNK)
    await send({ ...empty(), relations: relations.slice(i, i + CHUNK).map((r) => ({ ...r, members: r.members.map((m) => ({ ...m, ref: real(m.type, m.ref) })) })) });
  return changesets;
}
