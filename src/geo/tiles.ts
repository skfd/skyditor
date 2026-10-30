// The live map's tile grid (LOAD-010). One grid per session, in the session's fixed projection: every tile
// shares it, so blocks built from different tiles line up exactly (LOAD-013). Tiles are squares of
// TUNE-TILE-SIDE in local metres, and tile (0, 0) is centred on the place the map began at.
import { Projection, type LonLatBounds } from "./project";
import { TUNE } from "../tuning";

export interface Tile {
  readonly i: number; // column, east is positive
  readonly j: number; // row, south is positive (y runs south, as in project.ts)
}

/** A rectangle in local metres. */
export interface MetreRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const tileKey = (t: Tile) => `${t.i},${t.j}`;

export class TileGrid {
  constructor(readonly proj: Projection, readonly side = TUNE.TILE_SIDE) {}

  /** A grid whose first tile is centred on a place. */
  static at(lat: number, lon: number, side = TUNE.TILE_SIDE) {
    return new TileGrid(new Projection(lon, lat), side);
  }

  /** The tile a point in local metres falls in. */
  tileAt(x: number, y: number): Tile {
    return { i: Math.round(x / this.side), j: Math.round(y / this.side) };
  }

  /** A tile's square, grown by `margin` metres on every side. */
  rect(t: Tile, margin = 0): MetreRect {
    const h = this.side / 2 + margin;
    const cx = t.i * this.side, cy = t.j * this.side;
    return { minX: cx - h, minY: cy - h, maxX: cx + h, maxY: cy + h };
  }

  /** LOAD-011: what to fetch for a tile: its square plus TUNE-LOAD-MARGIN, so the blocks crossing its edge close. */
  fetchBounds(t: Tile, margin = TUNE.LOAD_MARGIN): LonLatBounds {
    const r = this.rect(t, margin);
    const p = this.proj;
    return { minLon: p.lon(r.minX), maxLon: p.lon(r.maxX), minLat: p.lat(r.maxY), maxLat: p.lat(r.minY) };
  }

  /** LOAD-010: the tiles touching the view grown by `ahead` metres, nearest the view centre first. */
  around(view: MetreRect, ahead = TUNE.LOAD_AHEAD): Tile[] {
    const a = this.tileAt(view.minX - ahead, view.minY - ahead);
    const b = this.tileAt(view.maxX + ahead, view.maxY + ahead);
    const cx = (view.minX + view.maxX) / 2, cy = (view.minY + view.maxY) / 2;
    const out: { t: Tile; d: number }[] = [];
    for (let j = a.j; j <= b.j; j++)
      for (let i = a.i; i <= b.i; i++) out.push({ t: { i, j }, d: Math.hypot(i * this.side - cx, j * this.side - cy) });
    return out.sort((p, q) => p.d - q.d).map((o) => o.t);
  }

  /** LOAD-018: whether a place lies within TUNE-LOAD-REACH of where this map began. */
  reaches(lat: number, lon: number, reach = TUNE.LOAD_REACH): boolean {
    return Math.hypot(this.proj.x(lon), this.proj.y(lat)) <= reach;
  }
}
