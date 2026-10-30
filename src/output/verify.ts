// OUT-008: before anything is sent, every element the changes touch is compared with the server's copy, and
// its version taken from there. Areas whose elements changed since they loaded are left out, by name.
import type { Source } from "../osm/source";
import type { Tags } from "../osm/parse";
import { type Changes, type Ref, computeChanges } from "./changes";
import type { World } from "../model/world";

const CHUNK = 300; // ids per request: well inside the URL length the API takes
const ROUNDS = 4; // leaving an area out can change what the rest references, so the check is repeated

interface ServerElement {
  type: "node" | "way" | "relation";
  id: number;
  version: number;
  visible?: boolean;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: "node" | "way" | "relation"; ref: number; role: string }[];
  tags?: Tags;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What is ready to send: the changes with versions, and the areas left out (OUT-008), as the user knows them. */
export interface Prepared {
  changes: Changes;
  leftOut: string[];
}

/**
 * Fetches the server's copy of every existing element the changes touch (`api` is the API 0.6 base), fills in
 * versions, and recomputes without the areas whose elements changed meanwhile.
 */
export async function prepare(world: World, api: string, fetchFn: Fetch = fetch): Promise<Prepared> {
  const cache = new Map<string, ServerElement | null>(); // "way/1" -> the server's copy, null when gone
  const skip = new Set<string>();
  let changes = computeChanges(world);
  for (let round = 0; round < ROUNDS; round++) {
    await fetchMissing(existing(changes), cache, api, fetchFn);
    const conflicts = conflicting(changes, world.source, cache);
    if (conflicts.size === 0) break;
    for (const f of conflicts) skip.add(f);
    changes = computeChanges(world, skip);
  }
  for (const e of existing(changes)) {
    const s = cache.get(refKey(e.ref));
    if (s) e.element.version = s.version;
  }
  return { changes, leftOut: [...skip].map((f) => nameOf(world, f)) };
}

/** Every existing element the changes carry, with the object the version goes on. */
function existing(c: Changes): { ref: Ref; element: { version?: number } }[] {
  const out: { ref: Ref; element: { version?: number } }[] = [];
  for (const n of c.context) out.push({ ref: { type: "node", id: n.id }, element: n });
  for (const list of [c.modify, c.delete]) {
    for (const n of list.nodes) out.push({ ref: { type: "node", id: n.id }, element: n });
    for (const w of list.ways) out.push({ ref: { type: "way", id: w.id }, element: w });
    for (const r of list.relations) out.push({ ref: { type: "relation", id: r.id }, element: r });
  }
  return out.filter((e) => e.ref.id > 0);
}

const refKey = (r: Ref) => `${r.type}/${r.id}`;

async function fetchMissing(refs: { ref: Ref }[], cache: Map<string, ServerElement | null>, api: string, fetchFn: Fetch) {
  for (const type of ["node", "way", "relation"] as const) {
    const ids = [...new Set(refs.filter((e) => e.ref.type === type && !cache.has(refKey(e.ref))).map((e) => e.ref.id))];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const url = `${api}/api/0.6/${type}s.json?${type}s=${chunk.join(",")}`;
      const res = await fetchFn(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status === 404 ? "An element is gone from" : "No answer from"} the server (HTTP ${res.status})`);
      const doc = (await res.json()) as { elements?: ServerElement[] };
      for (const id of chunk) cache.set(`${type}/${id}`, null);
      for (const e of doc.elements ?? []) cache.set(`${e.type}/${e.id}`, e);
    }
  }
}

/** OUT-008: the areas (and buildings) whose elements are not as they were loaded. */
function conflicting(c: Changes, src: Source, cache: Map<string, ServerElement | null>): Set<string> {
  const changed = new Set<string>();
  for (const { ref } of existing(c)) if (!same(ref, src, cache.get(refKey(ref)))) changed.add(refKey(ref));
  const out = new Set<string>();
  if (changed.size === 0) return out;
  for (const a of c.areas) if (a.elements.some((e) => changed.has(refKey(e)))) out.add(a.feature);
  for (const b of c.buildings) if (changed.has(b)) out.add(b);
  // A changed node shared with an area that itself wrote nothing but a kept node: still that area's.
  for (const a of c.areas) if (a.elements.some((e) => e.type === "way" && (src.ways.get(e.id)?.nodes ?? []).some((n) => changed.has(`node/${n}`)))) out.add(a.feature);
  return out;
}

function same(ref: Ref, src: Source, s: ServerElement | null | undefined): boolean {
  if (!s || s.visible === false) return false;
  if (ref.type === "node") {
    const n = src.nodes.get(ref.id);
    if (!n || s.lat === undefined || s.lon === undefined) return false;
    return Math.abs(n[0] - s.lon) < 1e-7 && Math.abs(n[1] - s.lat) < 1e-7 && sameTags(src.nodeTags.get(ref.id) ?? {}, s.tags ?? {});
  }
  if (ref.type === "way") {
    const w = src.ways.get(ref.id);
    return !!w && sameList(w.nodes, s.nodes ?? []) && sameTags(w.tags, s.tags ?? {});
  }
  const r = src.relations.get(ref.id);
  if (!r) return false;
  const ms = s.members ?? [];
  return r.members.length === ms.length && r.members.every((m, i) => m.type === ms[i].type && m.ref === ms[i].ref && m.role === ms[i].role) && sameTags(r.tags, s.tags ?? {});
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameTags = (a: Tags, b: Tags) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** How the user knows an area: its name, else its kind and OSM element (not an internal concept, GEN-002). */
function nameOf(world: World, feature: string): string {
  const base = feature.split("+")[0];
  for (const atom of world.atoms) for (const p of atom.pieces) if (p.source === base && p.name) return p.name;
  const b = [...world.buildingSets()].flatMap((s) => s.items).find((x) => x.geom.source === base);
  if (b) return `building ${base.replace("/", " ")}`;
  return base.startsWith("new/") ? "a new area" : `area ${base.replace("/", " ")}`;
}
