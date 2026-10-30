// Local planar projection: metres, x east, y south (screen-like), centred on the area. All model geometry
// lives in these coordinates; lon/lat exists only at the import and URL edges (CLAUDE.md).
export interface LonLatBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const R = 6378137;
const DEG = Math.PI / 180;

export class Projection {
  readonly kx: number;
  readonly ky: number;
  constructor(readonly lon0: number, readonly lat0: number) {
    this.ky = R * DEG;
    this.kx = R * DEG * Math.cos(lat0 * DEG);
  }
  static centredOn(b: LonLatBounds) {
    return new Projection((b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2);
  }
  x(lon: number) {
    return (lon - this.lon0) * this.kx;
  }
  y(lat: number) {
    return -(lat - this.lat0) * this.ky;
  }
  lon(x: number) {
    return x / this.kx + this.lon0;
  }
  lat(y: number) {
    return -y / this.ky + this.lat0;
  }
}

/** Square bounds of side `sideM` metres centred on a point. */
export function squareAround(lat: number, lon: number, sideM: number): LonLatBounds {
  const dLat = sideM / 2 / (R * DEG);
  const dLon = sideM / 2 / (R * DEG * Math.cos(lat * DEG));
  return { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
}

// Metres per pixel at OSM zoom 0 on the equator, as openstreetmap.org links count zoom (LOAD-019).
const Z0 = (2 * Math.PI * R) / 256;

/** LOAD-019: the OSM zoom level of a view showing `scale` pixels per metre at latitude `lat`. */
export const osmZoom = (scale: number, lat: number) => Math.log2(scale * Z0 * Math.cos(lat * DEG));

/** LOAD-019: pixels per metre at OSM zoom level `z` and latitude `lat`. */
export const zoomScale = (z: number, lat: number) => 2 ** z / (Z0 * Math.cos(lat * DEG));

/** LOAD-019: `#map=<zoom>/<lat>/<lon>`, or the older `#map=<lat>/<lon>` (no zoom). */
export function parseMapHash(h: string): { zoom: number | null; lat: number; lon: number } | null {
  const m = /^#map=(-?[\d.]+)\/(-?[\d.]+)(?:\/(-?[\d.]+))?$/.exec(h);
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]].map((v) => (v === undefined ? NaN : Number(v)));
  const out = m[3] === undefined ? { zoom: null, lat: a, lon: b } : { zoom: a, lat: b, lon: c };
  const ok = Number.isFinite(out.lat) && Number.isFinite(out.lon) && Math.abs(out.lat) <= 90 && Math.abs(out.lon) <= 180;
  return ok && (out.zoom === null || Number.isFinite(out.zoom)) ? out : null;
}

/** LOAD-019: the fragment for a view, at the precision openstreetmap.org uses for its zoom. */
export function mapHash(zoom: number, lat: number, lon: number): string {
  const z = Math.round(zoom * 100) / 100;
  const digits = Math.max(0, Math.ceil(Math.log10(2 ** Math.round(zoom)) - 0.5));
  return `#map=${z}/${lat.toFixed(digits)}/${lon.toFixed(digits)}`;
}
