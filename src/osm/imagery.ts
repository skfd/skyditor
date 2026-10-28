// Aerial imagery tiles for the imagery peek (PEEK-001). The source is one OSM may be edited from (PEEK-002):
// Esri World Imagery, as the iD editor uses it, with its attribution.
import type { LonLatBounds } from "../geo/project";

export const IMAGERY = {
  name: "Esri World Imagery",
  attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  maxZoom: 19,
  minZoom: 3,
  url: (z: number, x: number, y: number) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

const EQUATOR = 40075016.686; // m
const DEG = Math.PI / 180;

/** The tile zoom at which one tile pixel is no larger than one screen pixel, for a camera at `scale` px/m. */
export function tileZoom(scale: number, lat: number, dpr = 1): number {
  const metresPerScreenPx = 1 / (scale * dpr);
  const z = Math.ceil(Math.log2((EQUATOR * Math.cos(lat * DEG)) / 256 / metresPerScreenPx));
  return Math.max(IMAGERY.minZoom, Math.min(IMAGERY.maxZoom, z));
}

/** Fractional tile coordinates of a point at zoom `z`. */
export function tileAt(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin(lat * DEG);
  const y = ((1 - Math.log((1 + s) / (1 - s)) / (2 * Math.PI)) / 2) * n;
  return [x, y];
}

/** The lon/lat box a tile covers. */
export function tileBounds(x: number, y: number, z: number): LonLatBounds {
  const n = 2 ** z;
  const lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) / DEG;
  return { minLon: lon(x), maxLon: lon(x + 1), minLat: lat(y + 1), maxLat: lat(y) };
}

/** Loaded tiles, fetched on first use. PEEK-005: a tile arriving calls back so the frame redraws. */
export class TileCache {
  private readonly tiles = new Map<string, { img: HTMLImageElement; ok: boolean }>();
  private static readonly MAX = 400;

  constructor(private readonly onLoad: () => void) {}

  /** The tile if it has arrived, else null (and it is on its way). */
  get(z: number, x: number, y: number): HTMLImageElement | null {
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    const key = `${z}/${((x % n) + n) % n}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      const img = new Image();
      t = { img, ok: false };
      img.onload = () => {
        t!.ok = true;
        this.onLoad();
      };
      img.src = IMAGERY.url(z, ((x % n) + n) % n, y);
      this.tiles.set(key, t);
      if (this.tiles.size > TileCache.MAX) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return t.ok ? t.img : null;
  }
}
