import { describe, expect, it } from "vitest";
import { CTX_COLORS, type CtxClass, KINDS, classifyArea } from "../src/model/kinds";
import { Sketch, at, deltaE } from "./helpers";

const OWN: [Record<string, string>, CtxClass][] = [
  [{ leisure: "park" }, "park"],
  [{ landuse: "education" }, "education"],
  [{ landuse: "cemetery" }, "cemetery"],
  [{ landuse: "construction" }, "construction"],
];

describe("context colours", () => {
  it("REN-015: parks, school grounds, cemeteries and construction each have their own class", () => {
    for (const [tags, ctx] of OWN) expect(classifyArea(tags)).toMatchObject({ cls: "exclusive", ctx });
    expect(classifyArea({ landuse: "meadow" })).toMatchObject({ ctx: "green" });
    expect(classifyArea({ landuse: "religious" })).toMatchObject({ ctx: "civic" });
    expect(classifyArea({ landuse: "brownfield" })).toMatchObject({ ctx: "grey" });
  });

  it("REN-015: their colours stand clear of every other context class and kind", () => {
    // Context land is drawn by class, never in the generic "Other land" colour.
    const kinds = Object.values(KINDS).filter((k) => k.id !== "CTX");
    const others = [...Object.entries(CTX_COLORS), ...kinds.map((k) => [k.id, k.color] as const)];
    for (const [, ctx] of OWN)
      for (const [name, color] of others) {
        if (name === ctx) continue;
        expect(deltaE(CTX_COLORS[ctx], color), `${ctx} vs ${name}`).toBeGreaterThan(18);
      }
  });

  it("REN-015: imported context pieces keep their class", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { leisure: "park" });
    s.rect(105, -95, 295, 95, { landuse: "education" });
    const w = await s.world();
    expect(at(w, 0, 0)).toMatchObject({ kind: "CTX", ctx: "park" });
    expect(at(w, 200, 0)).toMatchObject({ kind: "CTX", ctx: "education" });
  });
});

describe("school grounds", () => {
  it("IMP-013: school amenities without a landuse are read as education context", () => {
    for (const amenity of ["school", "university", "college", "kindergarten"])
      expect(classifyArea({ amenity })).toMatchObject({ cls: "exclusive", ctx: "education", implied: true });
    expect(classifyArea({ amenity: "school", landuse: "education" })).toEqual({
      cls: "exclusive", ctx: "education", label: "landuse=education",
    });
    expect(classifyArea({ amenity: "school", landuse: "residential" })).toMatchObject({ cls: "paintable", kind: "RU" });
    expect(classifyArea({ amenity: "hospital" })).toBeNull();
  });

  it("IMP-013: a school building is a building, not grounds", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-50, -50, 50, 50, { building: "school", amenity: "school" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBeNull();
    expect(w.features.buildings[0].look).toBe("EDU");
  });

  it("IMP-014 / REN-016: grounds tagged only as a school are marked, at a point inside them", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "residential" });
    // An L-shaped school, so its centroid is not on it.
    const id = s.area([[-90, -90], [90, -90], [90, -40], [-40, -40], [-40, 90], [-90, 90]], { amenity: "school" });
    const w = await s.world();
    expect(at(w, -60, 60)).toMatchObject({ kind: "CTX", ctx: "education" });
    expect(w.issues).toEqual([
      { source: `way/${id}`, tagged: "amenity=school", missing: "landuse=education", at: expect.any(Array) },
    ]);
    const [x, y] = w.issues[0].at;
    expect(at(w, x, y)?.source).toBe(`way/${id}`);
  });

  it("IMP-014: a landuse=education outline over the grounds clears the mark", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "education" });
    s.rect(-90, -90, 90, 90, { amenity: "school" });
    s.rect(105, -95, 295, 95, { amenity: "school", landuse: "education" });
    const w = await s.world();
    expect(w.issues).toEqual([]);
  });

  it("IMP-014: a landuse=education outline covering only part of the grounds leaves the mark", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, { landuse: "education" });
    s.rect(-90, -90, 90, 90, { amenity: "school" });
    const w = await s.world();
    expect(w.issues.length).toBe(1);
  });
});
