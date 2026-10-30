// Network access to public OSM services (LOAD-003, LOAD-018).
import type { LonLatBounds } from "../geo/project";
import { OSM } from "./server";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const OSM_API = `${OSM.api}/api/0.6/map`;

export function overpassQuery(b: LonLatBounds): string {
  const bb = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  return `[out:json][timeout:60][bbox:${bb}];
(
  way["highway"]; way["railway"]; way["waterway"];
  way["landuse"]; relation["landuse"]["type"="multipolygon"];
  way["leisure"]; relation["leisure"]["type"="multipolygon"];
  way["natural"]; relation["natural"]["type"="multipolygon"];
  way["amenity"="parking"]; way["area:highway"]; way["building"];
  way["amenity"~"^(school|university|college|kindergarten)$"];
  relation["amenity"~"^(school|university|college|kindergarten)$"]["type"="multipolygon"];
);
out body;
>;
out skel qt;`;
}

async function withTimeout(url: string, init: RequestInit, ms: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** LOAD-003: Overpass first, then the OSM API `map` call. Returns the raw document text. */
export async function fetchArea(b: LonLatBounds): Promise<string> {
  const errors: string[] = [];
  try {
    const res = await withTimeout(OVERPASS, { method: "POST", body: new URLSearchParams({ data: overpassQuery(b) }) }, 70_000);
    if (res.ok) {
      const text = await res.text();
      // Overpass reports some failures inside a 200 response.
      if (!text.includes('"remark"') || text.includes('"elements"')) return withBounds(text, b);
      errors.push("Overpass: query failed");
    } else errors.push(`Overpass: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`Overpass: ${(e as Error).message}`);
  }
  try {
    const url = `${OSM_API}?bbox=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
    const res = await withTimeout(url, {}, 60_000);
    if (res.ok) return res.text();
    errors.push(`OSM API: HTTP ${res.status}${res.status === 400 ? " (area has too many nodes)" : ""}`);
  } catch (e) {
    errors.push(`OSM API: ${(e as Error).message}`);
  }
  throw new Error(errors.join("; "));
}

/** Overpass JSON carries no bounds; add the requested ones so the area is exactly what was asked for. */
function withBounds(text: string, b: LonLatBounds): string {
  const doc = JSON.parse(text);
  doc.bounds = { minlat: b.minLat, minlon: b.minLon, maxlat: b.maxLat, maxlon: b.maxLon };
  return JSON.stringify(doc);
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

/** LOAD-018: place search via Nominatim. */
export async function searchPlaces(q: string): Promise<Place[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
  const res = await withTimeout(url, { headers: { Accept: "application/json" } }, 15_000);
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return rows.map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) }));
}
