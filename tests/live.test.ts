import { describe, expect, it } from "vitest";
import { type Shape, area, bbox, toI, toM, union } from "../src/geo/clip";
import { Projection } from "../src/geo/project";
import { TileGrid } from "../src/geo/tiles";
import { History } from "../src/model/history";
import { LiveMap } from "../src/model/live";
import type { World } from "../src/model/world";
import type { Tool } from "../src/paint/snap";
import { Sketch, at, paint } from "./helpers";

const R2: Tool = { type: "paint", kind: "R2" };

// Tiles of 400 m with 150 m of margin: tile (0, 0) is built within ±310 m (TRUST in live.ts is 40 m), and
// tile (1, 0) from x = 90 to 710 m. Roads every 200 m run at x and y = ..., -200, 0, 200, 400, ...
const live = (blockWait = 5000) => new LiveMap(new TileGrid(new Projection(0, 0), 400), { margin: 150, blockWait });

const boxM = (s: Shape) => {
  const b = bbox(s);
  return [toM(b.minX), toM(b.minY), toM(b.maxX), toM(b.maxY)].map(Math.round);
};

/** Every atom of `w` is one of the true blocks of the whole sketch, exactly. */
function expectTrueBlocks(w: World, truth: World) {
  for (const a of w.atoms) {
    const match = truth.atoms.find((t) => t.area === a.area && JSON.stringify(t.bbox) === JSON.stringify(a.bbox));
    expect(match, `block ${boxM(a.shape)} is not a whole block`).toBeDefined();
  }
}

describe("live map", () => {
  it("LOAD-011: a tile shows only the blocks it has whole", async () => {
    const s = new Sketch(1000).grid(200);
    const m = live();
    const { world, atoms } = m.add({ i: 0, j: 0 }, s.json());
    expect(atoms.map((a) => boxM(a.shape)).sort()).toEqual(
      [[-194, -194, -6, -6], [-194, 6, -6, 194], [6, -194, 194, -6], [6, 6, 194, 194]].sort(),
    );
    expectTrueBlocks(world, await s.world());
  });

  it("LOAD-011: a block across two tiles loads whole once both are in", async () => {
    const s = new Sketch(1000).grid(200);
    const m = live();
    m.add({ i: 0, j: 0 }, s.json());
    const { world, atoms } = m.add({ i: 1, j: 0 }, s.json());
    // The blocks east of x = 200 waited for tile (1, 0); the four of tile (0, 0) did not load again.
    expect(atoms.map((a) => boxM(a.shape)[0]).sort()).toEqual([206, 206, 406, 406]);
    expect(world.atoms.length).toBe(8);
    expectTrueBlocks(world, await s.world());
  });

  it("LOAD-013: blocks loaded before stay as they were, with the user's paint and undo", () => {
    const s = new Sketch(1000).grid(200);
    s.rect(10, 10, 390, 190, { landuse: "residential" }); // one area across both tiles
    const m = live();
    const w = m.add({ i: 0, j: 0 }, s.json()).world;
    const { step } = paint(w, R2, 10, [[100, -100]], true);
    const h = new History();
    h.push(step!);
    const before = w.atoms.map((a) => [a, a.pieces] as const);
    m.add({ i: 1, j: 0 }, s.json());
    for (const [a, pieces] of before) {
      expect(w.atoms[a.id]).toBe(a);
      expect(a.pieces).toBe(pieces);
    }
    expect(at(w, 100, -100)?.kind).toBe("R2");
    h.undo();
    expect(at(w, 100, -100)?.kind).toBe(null);
    // The area's new part came in as OSM has it, as the same area.
    expect(at(w, 300, 100)?.kind).toBe("RU");
    expect(at(w, 300, 100)?.feature).toBe(at(w, 100, 100)?.feature);
  });

  it("LOAD-014: a block wider than TUNE-BLOCK-WAIT shows cut, and the rest becomes a block of its own", () => {
    // One long field between two roads, with no street across it.
    const s = new Sketch(1500);
    s.road([[-1520, -100], [1520, -100]]);
    s.road([[-1520, 100], [1520, 100]]);
    const m = live(500);
    // The land beyond either road is a field too; only the one between them counts here.
    const middle = (g: { atoms: { shape: Shape }[] }) => g.atoms.map((x) => boxM(x.shape)).filter((b) => b[1] === -94);
    expect(middle(m.add({ i: 0, j: 0 }, s.json()))).toEqual([[-310, -94, 310, 94]]);
    expect(middle(m.add({ i: 1, j: 0 }, s.json()))).toEqual([]); // 310..710 is 400 m across: it waits
    const c = m.add({ i: 2, j: 0 }, s.json());
    expect(middle(c)).toEqual([[310, -94, 1110, 94]]);
    const w = c.world;
    const sum = w.atoms.reduce((t, x) => t + x.area, 0);
    expect(area(union(...w.atoms.map((x) => x.shape)))).toBeCloseTo(sum, -2); // no overlap
  });

  it("LOAD-011: a field narrower than TUNE-BLOCK-WAIT waits for its end", () => {
    const s = new Sketch(1500);
    s.road([[-1520, -100], [1520, -100]]);
    s.road([[-1520, 100], [1520, 100]]);
    const m = live(5000);
    expect(m.add({ i: 0, j: 0 }, s.json()).atoms).toEqual([]);
  });

  it("LOAD-011: a building shows with its block", () => {
    const s = new Sketch(1000).grid(200);
    s.rect(280, 80, 320, 120, { building: "house" });
    const m = live();
    const w = m.add({ i: 0, j: 0 }, s.json()).world;
    expect(w.buildingAt(toI(300), toI(100))).toBe(null);
    m.add({ i: 1, j: 0 }, s.json());
    expect(w.buildingAt(toI(300), toI(100))?.geom.source).toBeDefined();
  });

  it("LOAD-013: a building loading into a set undo holds stays through undo and redo", () => {
    const s = new Sketch(1000).grid(200);
    s.rect(-30, -205, 30, -195, { building: "house" }); // on the road: in no block
    s.rect(370, -205, 430, -195, { building: "house" }); // the same, in tile (1, 0) only
    const m = live();
    const w = m.add({ i: 0, j: 0 }, s.json()).world;
    const set = [...w.buildingSets()].find((x) => x.atom === -1)!;
    const h = new History();
    h.push({ atoms: [], buildings: [{ set, before: set.items, after: [...set.items] }] });
    const { joined } = m.add({ i: 1, j: 0 }, s.json());
    for (const j of joined) h.include(j.set, j.items);
    expect(set.items.length).toBe(2);
    h.undo();
    expect(set.items.length).toBe(2);
    h.redo();
    expect(set.items.length).toBe(2);
  });
});
