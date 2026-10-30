// Reads OSM XML (API 0.6 / .osm files) and Overpass JSON into one in-memory form (LOAD-004, LOAD-005).
import type { LonLatBounds } from "../geo/project";

export type Tags = Record<string, string>;
export interface OsmWay {
  id: number;
  nodes: number[];
  tags: Tags;
}
export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}
export interface OsmRelation {
  id: number;
  tags: Tags;
  members: OsmMember[];
}
export interface OsmData {
  bounds: LonLatBounds | null;
  nodes: Map<number, [number, number]>; // id -> [lon, lat]
  nodeTags: Map<number, Tags>; // OUT-004: only tagged nodes; a tagged node is never deleted with its way
  ways: Map<number, OsmWay>;
  relations: OsmRelation[];
}

export const emptyOsm = (): OsmData => ({ bounds: null, nodes: new Map(), nodeTags: new Map(), ways: new Map(), relations: [] });

export function parseOsm(text: string): OsmData {
  const t = text.trimStart();
  if (t.startsWith("{")) return parseOsmJson(JSON.parse(t));
  if (t.startsWith("<")) return parseOsmXml(t);
  throw new Error("Not an OSM XML or JSON document");
}

export function parseOsmJson(doc: any): OsmData {
  const data = emptyOsm();
  if (doc.bounds) {
    const b = doc.bounds;
    data.bounds = { minLat: +b.minlat, minLon: +b.minlon, maxLat: +b.maxlat, maxLon: +b.maxlon };
  }
  for (const e of doc.elements ?? []) {
    if (e.type === "node") {
      data.nodes.set(e.id, [e.lon, e.lat]);
      if (e.tags && Object.keys(e.tags).length) data.nodeTags.set(e.id, e.tags);
    } else if (e.type === "way") data.ways.set(e.id, { id: e.id, nodes: e.nodes ?? [], tags: e.tags ?? {} });
    else if (e.type === "relation")
      data.relations.push({
        id: e.id,
        tags: e.tags ?? {},
        members: (e.members ?? []).map((m: any) => ({ type: m.type, ref: m.ref, role: m.role ?? "" })),
      });
  }
  return data;
}

const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const unescape = (s: string) =>
  s.indexOf("&") < 0
    ? s
    : s.replace(ENTITY, (_, e: string) =>
        e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'"
          : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unescape(m[2] ?? m[3]);
  return out;
}

/** A small streaming-free scanner. OSM XML is flat and regular enough that a full XML parser is not needed. */
export function parseOsmXml(xml: string): OsmData {
  const data = emptyOsm();
  const b = /<bounds\b([^>]*)\/?>/.exec(xml);
  if (b) {
    const a = attrs(b[1]);
    data.bounds = { minLat: +a.minlat, minLon: +a.minlon, maxLat: +a.maxlat, maxLon: +a.maxlon };
  }
  const re = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;
  for (const m of xml.matchAll(re)) {
    const a = attrs(m[2]);
    if (a.action === "delete") continue;
    const id = Number(a.id);
    const body = m[4] ?? "";
    const tags: Tags = {};
    if (body)
      for (const t of body.matchAll(/<tag\b([^>]*)\/>/g)) {
        const ta = attrs(t[1]);
        tags[ta.k] = ta.v;
      }
    if (m[1] === "node") {
      data.nodes.set(id, [Number(a.lon), Number(a.lat)]);
      if (Object.keys(tags).length) data.nodeTags.set(id, tags);
    } else if (m[1] === "way")
      data.ways.set(id, { id, tags, nodes: [...body.matchAll(/<nd\b[^>]*\bref\s*=\s*["'](-?\d+)["']/g)].map((x) => Number(x[1])) });
    else
      data.relations.push({
        id,
        tags,
        members: [...body.matchAll(/<member\b([^>]*)\/>/g)].map((x) => {
          const ma = attrs(x[1]);
          return { type: ma.type as OsmMember["type"], ref: Number(ma.ref), role: ma.role ?? "" };
        }),
      });
  }
  return data;
}

/** Bounds of the data: declared bounds, else the extent of all nodes (LOAD-004). */
export function dataBounds(d: OsmData): LonLatBounds | null {
  if (d.bounds && [d.bounds.minLat, d.bounds.minLon, d.bounds.maxLat, d.bounds.maxLon].every(Number.isFinite))
    return d.bounds;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of d.nodes.values()) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return Number.isFinite(minLon) ? { minLon, minLat, maxLon, maxLat } : null;
}
