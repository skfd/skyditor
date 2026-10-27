// Builds the bundled offline demo area (LOAD-001) from the OSM API 0.6 `map` call.
// Usage: node scripts/make-fixture.mjs <minLon> <minLat> <maxLon> <maxLat> <out.json> [--from file.osm]
// Output is a filtered Overpass-style JSON document that the editor loads like any dropped file.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const fromFile = fromIdx >= 0 ? args.splice(fromIdx, 2)[1] : null;
const [minLon, minLat, maxLon, maxLat] = args.slice(0, 4).map(Number);
const out = args[4];
if (!out || [minLon, minLat, maxLon, maxLat].some(Number.isNaN)) {
  console.error("usage: make-fixture.mjs minLon minLat maxLon maxLat out.json [--from file.osm]");
  process.exit(2);
}

let xml;
if (fromFile) xml = readFileSync(fromFile, "utf8");
else {
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${minLon},${minLat},${maxLon},${maxLat}`;
  const res = await fetch(url, { headers: { "User-Agent": "skyditor-fixture-builder" } });
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  xml = await res.text();
}

const KEEP_KEYS = new Set([
  "highway", "railway", "waterway", "landuse", "leisure", "natural", "building", "amenity",
  "area", "area:highway", "tunnel", "covered", "width", "residential", "water", "name",
  "building:levels", "type",
]);
const WANTED = (t) =>
  t.highway || t.railway || t.waterway || t.landuse || t.leisure || t.natural || t.building ||
  t.amenity === "parking" || t["area:highway"];

const unesc = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" :
    String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], unesc(m[2])]));

const nodes = new Map();
const ways = [];
const rels = [];
const re = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
for (const m of xml.matchAll(re)) {
  const a = attrs(m[2]);
  const body = m[4] ?? "";
  const tags = {};
  for (const t of body.matchAll(/<tag\b([^>]*)\/>/g)) {
    const ta = attrs(t[1]);
    tags[ta.k] = ta.v;
  }
  if (m[1] === "node") nodes.set(a.id, [Number(a.lon), Number(a.lat)]);
  else if (m[1] === "way") ways.push({ id: a.id, tags, nodes: [...body.matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]) });
  else rels.push({ id: a.id, tags, members: [...body.matchAll(/<member\b([^>]*)\/>/g)].map((x) => attrs(x[1])) });
}

const pick = (tags) => Object.fromEntries(Object.entries(tags).filter(([k]) => KEEP_KEYS.has(k)));
const keptRels = rels.filter((r) => r.tags.type === "multipolygon" && WANTED(r.tags));
const memberWays = new Set(keptRels.flatMap((r) => r.members.filter((m) => m.type === "way").map((m) => m.ref)));
const keptWays = ways.filter((w) => WANTED(w.tags) || memberWays.has(w.id));
const usedNodes = new Set(keptWays.flatMap((w) => w.nodes));

const r7 = (x) => Math.round(x * 1e7) / 1e7;
const elements = [];
for (const id of usedNodes) {
  const n = nodes.get(id);
  if (n) elements.push({ type: "node", id: Number(id), lat: r7(n[1]), lon: r7(n[0]) });
}
for (const w of keptWays) {
  const t = pick(w.tags);
  elements.push({ type: "way", id: Number(w.id), nodes: w.nodes.map(Number), ...(Object.keys(t).length ? { tags: t } : {}) });
}
for (const r of keptRels) {
  elements.push({
    type: "relation", id: Number(r.id), tags: pick(r.tags),
    members: r.members.map((m) => ({ type: m.type, ref: Number(m.ref), role: m.role ?? "" })),
  });
}
const doc = {
  version: 0.6,
  generator: "skyditor make-fixture",
  copyright: "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
  bounds: { minlat: minLat, minlon: minLon, maxlat: maxLat, maxlon: maxLon },
  elements,
};
writeFileSync(out, JSON.stringify(doc));
console.log(`wrote ${out}: ${usedNodes.size} nodes, ${keptWays.length} ways, ${keptRels.length} relations`);
