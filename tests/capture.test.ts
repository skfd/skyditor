import { describe, expect, it } from "vitest";
import { applyCapture, planCapture } from "../src/model/capture";
import { rect, toI } from "../src/geo/clip";
import { History } from "../src/model/history";
import { type Tool, applyRegion } from "../src/paint/snap";
import { Sketch, at, atomAt, paint } from "./helpers";

const R2 = { landuse: "residential", residential: "detached" };
const R4 = { landuse: "residential", residential: "terrace" };
const COM = { landuse: "commercial" };
const ERASE: Tool = { type: "erase" };
const PAINT_COM: Tool = { type: "paint", kind: "COM" };
const UP: Tool = { type: "density", dir: 1 };

type World = Awaited<ReturnType<Sketch["world"]>>;
const plan = (w: World, from: [number, number], to: [number, number]) => planCapture(w, at(w, ...from)!, at(w, ...to)!);
function capture(w: World, from: [number, number], to: [number, number]) {
  const p = plan(w, from, to);
  expect(p).not.toBeNull();
  return applyCapture(w, p!);
}

/** Two areas side by side in one block, with `gap` metres of empty land between them. */
async function pair(gap: number, west: Record<string, string> = R2, east: Record<string, string> = R2) {
  const s = new Sketch(300).grid(200);
  s.rect(-95, -95, -gap / 2, 95, west);
  s.rect(gap / 2, -95, 95, 95, east);
  return s.world();
}

const box = (x0: number, y0: number, x1: number, y1: number) => rect({ minX: toI(x0), minY: toI(y0), maxX: toI(x1), maxY: toI(y1) });

/** Two touching areas with a strip 3 m wide erased between them (an import closes such gaps, IMP-007). */
async function narrowGap() {
  const w = await pair(0);
  const block = atomAt(w, 0, 0);
  block.pieces = applyRegion(block, { region: box(-1.5, -100, 1.5, 100), eligible: block.shape }, null).pieces;
  return w;
}

/** Areas in the centre block and the block west of it, across a residential street at x = -100. */
async function acrossStreet(tags: Record<string, string> = R2) {
  const s = new Sketch(300).grid(200);
  s.rect(-95, -95, 95, 95, tags);
  s.rect(-295, -95, -105, 95, tags);
  return s.world();
}

/** Areas either side of one street of class `highway` along x = 0, and nothing else. */
async function besideRoad(highway: string, tags: Record<string, string>) {
  const s = new Sketch(300);
  s.road([[0, -320], [0, 320]], highway, { name: "Spadina Avenue" });
  s.rect(-200, -60, 0, 60, tags);
  s.rect(0, -60, 200, 60, tags);
  return s.world();
}

describe("capture", () => {
  it("CAP-005: the source takes the target over; the source keeps its OSM element; undo splits them again", async () => {
    const w = await pair(0);
    const west = at(w, -50, 0)!;
    const east = at(w, 50, 0)!;
    expect(west.feature).not.toBe(east.feature);
    const { step } = capture(w, [-50, 0], [50, 0]);
    expect(at(w, 50, 0)).toBe(at(w, -50, 0));
    expect(at(w, 50, 0)?.source).toBe(west.source);
    expect(at(w, 50, 0)?.modified).toBe(true);
    const h = new History();
    h.push(step);
    h.undo();
    expect(at(w, -50, 0)).toBe(west);
    expect(at(w, 50, 0)).toBe(east);
  });

  it("CAP-007 / CAP-008: a narrow gap of empty land between them is filled; a wide one stops the capture", async () => {
    const w = await narrowGap();
    expect(at(w, 0, 0)?.kind).toBeNull();
    capture(w, [-50, 0], [50, 0]);
    expect(at(w, 0, 0)?.feature).toBe(at(w, -50, 0)?.feature);
    expect(atomAt(w, 0, 0).pieces.filter((p) => p.kind === null)).toHaveLength(0);
    expect(plan(await pair(20), [-50, 0], [50, 0])).toBeNull();
  });

  it("CAP-007: only the same kind: two tiers are two kinds", async () => {
    expect(plan(await pair(0, R2, R4), [-50, 0], [50, 0])).toBeNull();
    expect(plan(await pair(0, COM, R2), [-50, 0], [50, 0])).toBeNull();
  });

  it("CAP-007: a target with a name the source lacks is taken only the other way round, keeping the name", async () => {
    const w = await pair(0, COM, { ...COM, name: "Galleria" });
    expect(plan(w, [-50, 0], [50, 0])).toBeNull();
    capture(w, [50, 0], [-50, 0]);
    expect(at(w, -50, 0)?.name).toBe("Galleria");
  });

  it("CAP-007: land of another area between them stops the capture", async () => {
    const w = await narrowGap();
    const block = atomAt(w, 0, 0);
    block.pieces = applyRegion(block, { region: box(-1.5, -10, 1.5, 10), eligible: block.shape }, "COM").pieces;
    expect(at(w, 0, 0)?.kind).toBe("COM");
    expect(plan(w, [-50, 0], [50, 0])).toBeNull();
  });

  it("CAP-008: across a local street, the area takes the street between the two blocks, and no more of it", async () => {
    const w = await acrossStreet();
    const source = at(w, 0, 0)!;
    expect(at(w, -100, 0)).toBeNull();
    const { step } = capture(w, [0, 0], [-200, 0]);
    expect(at(w, -100, 0)?.feature).toBe(source.feature);
    expect(at(w, -200, 0)?.source).toBe(source.source);
    expect(at(w, -100, -150)).toBeNull(); // the street beside other blocks stays street
    const h = new History();
    h.push(step);
    h.undo();
    expect(at(w, -100, 0)).toBeNull();
    h.redo();
    expect(at(w, -100, 0)?.feature).toBe(source.feature);
  });

  it("CAP-008: the street goes back to being street when the land beside it is erased, and comes back with undo", async () => {
    const w = await acrossStreet();
    capture(w, [0, 0], [-200, 0]);
    const h = new History();
    h.push(paint(w, ERASE, 30, [[-200, 0]], true).step!);
    expect(at(w, -200, 0)?.kind).toBeNull();
    expect(at(w, -100, 0)).toBeNull();
    h.undo();
    expect(at(w, -100, 0)?.kind).toBe("R2");
  });

  it("CAP-008: paint reaching the street land gives it back to the street", async () => {
    const w = await acrossStreet();
    capture(w, [0, 0], [-200, 0]);
    paint(w, PAINT_COM, 4, [[-100, -60], [-100, 60]]);
    expect(at(w, -100, 0)).toBeNull();
    expect(at(w, 0, 0)?.kind).toBe("R2");
  });

  it("CAP-008: a density step over both blocks moves the street land with them", async () => {
    const w = await acrossStreet();
    capture(w, [0, 0], [-200, 0]);
    paint(w, UP, 10, [[-200, 0], [0, 0]]);
    expect(at(w, 0, 0)?.kind).toBe("R3");
    expect(at(w, -200, 0)?.kind).toBe("R3");
    expect(at(w, -100, 0)?.kind).toBe("R3");
  });

  it("CAP-009: residential captures across local streets; business land across arterials too; nothing across a motorway", async () => {
    expect(plan(await besideRoad("unclassified", R2), [-100, 0], [100, 0])).not.toBeNull();
    expect(plan(await besideRoad("primary", R2), [-100, 0], [100, 0])).toBeNull();
    expect(plan(await besideRoad("primary", COM), [-100, 0], [100, 0])).not.toBeNull();
    expect(plan(await besideRoad("motorway", COM), [-100, 0], [100, 0])).toBeNull();
  });

  it("CAP-009: never across two streets at once", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, COM);
    s.rect(105, 105, 295, 295, COM); // diagonally across the crossing
    expect(plan(await s.world(), [0, 0], [200, 200])).toBeNull();
  });

  it("CAP-002: an area's pieces are found in every block it covers", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 295, 95, COM);
    const w = await s.world();
    const area = w.areaOf(at(w, 0, 0)!);
    expect(area).toContain(at(w, 200, 0));
    expect(area).toHaveLength(2);
  });

  it("CAP-004: the verdict is ready while the arrow is drawn, without changing the map", async () => {
    const w = await pair(0);
    const before = atomAt(w, 0, 0).pieces;
    expect(plan(w, [-50, 0], [50, 0])).not.toBeNull();
    expect(atomAt(w, 0, 0).pieces).toBe(before);
    expect(w.bridges).toHaveLength(0);
  });
});
