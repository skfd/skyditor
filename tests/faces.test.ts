import { describe, expect, it } from "vitest";
import { contains, difference, rect, toI } from "../src/geo/clip";
import { makePiece } from "../src/model/world";
import { faces } from "../src/render/faces";
import { TUNE } from "../src/tuning";
import { Sketch, atomAt } from "./helpers";

const GAP = TUNE.PIECE_GAP;
const has = (s: import("../src/geo/clip").Shape, x: number, y: number) => contains(s, toI(x), toI(y));

describe("top faces", () => {
  it("REN-004: neighbouring areas of one kind show as one surface, with no line between them", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, { landuse: "residential" });
    s.rect(0, -95, 95, 95, { landuse: "residential" });
    const w = await s.world();
    const land = atomAt(w, 0, 0).pieces.filter((p) => p.kind !== null);
    expect(land.length).toBe(2); // the import keeps the two features apart
    const f = faces(land, GAP);
    const [a, b] = land.map((p) => f.get(p)!);
    expect(a.group).toBe(b.group);
    for (const y of [-60, 0, 60]) expect(has(a.group!, 0, y)).toBe(true);
    expect(has(a.top, -GAP / 4, 0) || has(b.top, -GAP / 4, 0)).toBe(true);
  });

  it("REN-004: a thin gap separates neighbours of different kinds", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, { landuse: "residential" });
    s.rect(0, -95, 95, 95, { landuse: "retail" });
    const w = await s.world();
    const land = atomAt(w, 0, 0).pieces.filter((p) => p.kind !== null);
    expect(new Set(land.map((p) => p.kind)).size).toBe(2);
    const f = faces(land, GAP);
    for (const p of land) {
      expect(f.get(p)!.group).toBe(null);
      expect(has(f.get(p)!.top, 0, 0)).toBe(false);
    }
    expect(land.some((p) => has(f.get(p)!.top, -GAP, 0))).toBe(true);
    expect(land.some((p) => has(f.get(p)!.top, GAP, 0))).toBe(true);
  });

  it("REN-004: a crack too small to be land shows no dot", () => {
    const crack = rect({ minX: toI(-0.2), minY: toI(-0.2), maxX: toI(0.2), maxY: toI(0.2) });
    const p = makePiece(0, "R2", difference(rect({ minX: toI(-50), minY: toI(-50), maxX: toI(50), maxY: toI(50) }), crack));
    expect(has(p.shape, 0, 0)).toBe(false);
    expect(has(faces([p], GAP).get(p)!.top, 0, 0)).toBe(true);
  });
});
