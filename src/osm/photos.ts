// Street-level photos for the photo peek (PEEK-003, PEEK-004), from Panoramax: an open API, no key, and a
// source OSM may be edited from (PEEK-002). Mapillary and KartaView are offered as links to the same spot.
import type { LonLatBounds, Projection } from "../geo/project";
import { TUNE } from "../tuning";

const PANORAMAX_API = "https://api.panoramax.xyz/api";
const PANORAMAX_WEB = "https://api.panoramax.xyz/en/index";

export interface Photo {
  id: string;
  provider: "Panoramax";
  lon: number;
  lat: number;
  azimuth: number | null; // degrees from north, clockwise; null when unknown
  thumb: string; // small image URL
  sd: string; // panel-sized image URL
  date: string; // ISO
  url: string; // the photo in its viewer
}

interface StacItem {
  id: string;
  geometry?: { type: string; coordinates: [number, number] };
  properties?: Record<string, unknown>;
  assets?: Record<string, { href?: string }>;
}

/** PEEK-003: the photos taken inside a lon/lat box, newest first as the API returns them. */
export async function searchPanoramax(b: LonLatBounds, signal?: AbortSignal): Promise<Photo[]> {
  const bbox = [b.minLon, b.minLat, b.maxLon, b.maxLat].map((v) => v.toFixed(6)).join(",");
  const res = await fetch(`${PANORAMAX_API}/search?bbox=${bbox}&limit=50`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Panoramax: HTTP ${res.status}`);
  const data = (await res.json()) as { features?: StacItem[] };
  return (data.features ?? []).flatMap((f) => {
    if (f.geometry?.type !== "Point") return [];
    const [lon, lat] = f.geometry.coordinates;
    const az = f.properties?.["view:azimuth"];
    const thumb = f.assets?.thumb?.href ?? f.assets?.sd?.href;
    const sd = f.assets?.sd?.href ?? f.assets?.hd?.href ?? thumb;
    if (!thumb || !sd) return [];
    return [{
      id: f.id,
      provider: "Panoramax" as const,
      lon,
      lat,
      azimuth: typeof az === "number" ? az : null,
      thumb,
      sd,
      date: typeof f.properties?.datetime === "string" ? f.properties.datetime : "",
      url: `${PANORAMAX_WEB}#focus=pic&pic=${encodeURIComponent(f.id)}`,
    }];
  });
}

/**
 * PEEK-003 / PEEK-004: the photo that best shows the spot at (x, y) metres: the nearest one, with looking
 * away from the spot costing TUNE-PHOTO-TURN metres per degree. Null when none is within TUNE-PHOTO-RADIUS.
 */
export function bestPhoto(photos: Photo[], proj: Projection, x: number, y: number): { photo: Photo; distance: number } | null {
  let best: { photo: Photo; distance: number; score: number } | null = null;
  for (const p of photos) {
    const px = proj.x(p.lon), py = proj.y(p.lat);
    const dx = x - px, dy = y - py;
    const distance = Math.hypot(dx, dy);
    if (distance > TUNE.PHOTO_RADIUS) continue;
    // Bearing from the camera to the spot: y points south, so north is -y.
    const bearing = ((Math.atan2(dx, -dy) / Math.PI) * 180 + 360) % 360;
    const turn = p.azimuth === null ? 90 : Math.abs((((bearing - p.azimuth) % 360) + 540) % 360 - 180);
    const score = distance + TUNE.PHOTO_TURN * turn;
    if (!best || score < best.score) best = { photo: p, distance, score };
  }
  return best && { photo: best.photo, distance: best.distance };
}

/** PEEK-003 / PEEK-004: where to look for more, at a lat/lon, with the chosen photo's own page first. */
export function photoLinks(lat: number, lon: number, photo: Photo | null = null): { name: string; url: string }[] {
  const la = lat.toFixed(6), lo = lon.toFixed(6);
  return [
    { name: "Panoramax", url: photo?.url ?? `${PANORAMAX_WEB}#focus=map&map=18/${la}/${lo}` },
    { name: "Mapillary", url: `https://www.mapillary.com/app/?lat=${la}&lng=${lo}&z=18` },
    { name: "KartaView", url: `https://kartaview.org/map/@${la},${lo},18z` },
  ];
}
