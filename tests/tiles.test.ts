import { describe, expect, it } from "vitest";
import { area, bbox, toM } from "../src/geo/clip";
import { Projection } from "../src/geo/project";
import { TileGrid, tileKey } from "../src/geo/tiles";
import { worldFromText } from "../src/model/load";
import { Sketch } from "./helpers";

const R = 6378137;
const DEG = Math.PI / 180;
// As in helpers.ts: a projection centred on (0, 0).
const lon = (x: number) => x / (R * DEG);
const lat = (y: number) => -y / (R * DEG);

describe("live map tile grid", () => {
  const grid = TileGrid.at(0, 0, 600);

  it("LOAD-010: loads the tile under the view centre first, then outwards", () => {
    const tiles = grid.around({ minX: -100, minY: -100, maxX: 500, maxY: 300 }, 300);
    expect(tileKey(tiles[0])).toBe("0,0"); // the view centre (200, 100) is in tile (0, 0)
    const d = tiles.map((t) => Math.hypot(t.i * 600 - 200, t.j * 600 - 100));
    expect(d).toEqual([...d].sort((a, b) => a - b));
  });

  it("LOAD-010: covers the view and TUNE-LOAD-AHEAD around it, and no more", () => {
    // x: -400..800 → tiles -1..1; y: -400..600 → tiles -1..1 (600 lies on the edge of tile 1).
    const keys = new Set(grid.around({ minX: -100, minY: -100, maxX: 500, maxY: 300 }, 300).map(tileKey));
    expect(keys).toEqual(new Set(["-1,-1", "0,-1", "1,-1", "-1,0", "0,0", "1,0", "-1,1", "0,1", "1,1"]));
  });

  it("LOAD-011: fetches each tile with TUNE-LOAD-MARGIN on every side", () => {
    const b = grid.fetchBounds({ i: 1, j: -2 }, 200);
    const p = grid.proj;
    expect(p.x(b.minLon)).toBeCloseTo(100, 6); // tile 1 spans 300..900
    expect(p.x(b.maxLon)).toBeCloseTo(1100, 6);
    expect(p.y(b.maxLat)).toBeCloseTo(-1700, 6);
    expect(p.y(b.minLat)).toBeCloseTo(-700, 6); // tile -2 spans -1500..-900
  });

  it("LOAD-018: a searched place keeps the map only within TUNE-LOAD-REACH of where it began", () => {
    expect(grid.reaches(lat(-9000), lon(12000), 20_000)).toBe(true);
    expect(grid.reaches(lat(-16000), lon(16000), 20_000)).toBe(false);
  });
});

describe("one projection per session", () => {
  it("LOAD-013: a block loaded in two different downloads comes out identical", async () => {
    const s = new Sketch(600).grid(200);
    const proj = new Projection(0, 0);
    // Two downloads of the same streets, framed differently, as two neighbouring tiles fetched with a margin are.
    const frame = (x0: number, x1: number) => ({ minLon: lon(x0), maxLon: lon(x1), minLat: lat(500), maxLat: lat(-500) });
    const a = (await worldFromText(s.json(), undefined, frame(-500, 250), proj)).world;
    const b = (await worldFromText(s.json(), undefined, frame(-50, 500), proj)).world;
    // Roads run at -400, -200, 0, 200 and 400: the block between x = 0 and 200, y = 0 and 200 is whole in both.
    const inner = (w: typeof a) =>
      w.atoms.find((t) => {
        const bb = bbox(t.shape);
        return toM(bb.minX) > 0 && toM(bb.maxX) < 200 && toM(bb.minY) > 0 && toM(bb.maxY) < 200;
      })!;
    const ia = inner(a), ib = inner(b);
    expect(ia).toBeDefined();
    expect(ib).toBeDefined();
    expect(area(ib.shape)).toBe(area(ia.shape));
    expect(bbox(ib.shape)).toEqual(bbox(ia.shape));
  });
});
