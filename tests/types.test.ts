import { describe, expect, it } from "vitest";
import { toI } from "../src/geo/clip";
import { statusOf } from "../src/model/buildings";
import { History } from "../src/model/history";
import { addrCount } from "../src/model/kinds";
import type { World } from "../src/model/world";
import type { Target, Tool } from "../src/paint/snap";
import { Stroke } from "../src/paint/stroke";
import { Sketch } from "./helpers";

type Pt = [number, number];
const AGREE: Tool = { type: "agree" };
const R1: Tool = { type: "paint", kind: "R1" };
const R2: Tool = { type: "paint", kind: "R2" };
const R5: Tool = { type: "paint", kind: "R5" };
const ERASE: Tool = { type: "erase" };

/** A stroke along `pts` with the brush on buildings (or on land), like tests/helpers.ts' paint(). */
function stroke(w: World, tool: Tool, radius: number, pts: Pt[], tap = false, target: Target = "buildings") {
  const s = new Stroke(w, tool, radius, pts[0][0], pts[0][1], 0, target);
  const events = [...s.start()];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (radius * 0.1)));
    for (let k = 1; k <= n; k++) events.push(...s.move(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n));
  }
  const end = s.end(tap);
  return { events: [...events, ...end.events], step: end.step };
}

const bAt = (w: World, x: number, y: number) => w.buildingAt(toI(x), toI(y))!;
const guessAt = (w: World, x: number, y: number) => w.guessOf(bAt(w, x, y));

/** One block (-95..95 m), with whatever buildings a test needs in it. */
const block = () => new Sketch(300).grid(200);

describe("guessing building types", () => {
  it("TYPE-001: typed and accessory buildings have nothing to guess; `yes` and plain `residential` do", async () => {
    const s = block();
    s.rect(-90, -90, -80, -80, { building: "house" });
    s.rect(-70, -90, -60, -80, { building: "garage" });
    s.rect(-50, -90, -40, -80, { building: "yes" });
    s.rect(-30, -90, -20, -80, { building: "residential" });
    s.rect(-10, -90, 0, -80, { building: "yes", shop: "bakery" }); // typed by its use (BLD-004)
    const w = await s.world();
    expect(statusOf(bAt(w, -85, -85))).toBe("typed");
    expect(guessAt(w, -85, -85)).toBeNull();
    expect(statusOf(bAt(w, -65, -85))).toBe("protected");
    expect(guessAt(w, -65, -85)).toBeNull();
    expect(statusOf(bAt(w, -45, -85))).toBe("untyped");
    expect(guessAt(w, -45, -85)).not.toBeNull();
    expect(statusOf(bAt(w, -25, -85))).toBe("untyped");
    expect(guessAt(w, -25, -85)).not.toBeNull();
    expect(statusOf(bAt(w, -5, -85))).toBe("typed");
    expect(guessAt(w, -5, -85)).toBeNull();
  });

  it("TYPE-002: shared walls tell a house, a semi and a terrace apart", async () => {
    const s = block();
    s.rect(-90, -90, -80, -80, { building: "yes" }); // on its own
    s.rect(-60, -90, -50, -80, { building: "yes" }); // a pair sharing x = -50
    s.rect(-50, -90, -40, -80, { building: "yes" });
    for (let i = 0; i < 4; i++) s.rect(-20 + i * 8, -90, -12 + i * 8, -78, { building: "yes" }); // a row of four
    const w = await s.world();
    expect(guessAt(w, -85, -85)).toEqual({ look: "R2", candidates: ["R2"] });
    expect(guessAt(w, -55, -85)).toEqual({ look: "R3", candidates: ["R3"] });
    expect(guessAt(w, -45, -85)).toEqual({ look: "R3", candidates: ["R3"] });
    for (let i = 0; i < 4; i++) expect(guessAt(w, -16 + i * 8, -84)).toEqual({ look: "R4", candidates: ["R4"] });
  });

  it("TYPE-002: size and levels say apartments; a very large low footprint is business or industry", async () => {
    const s = block();
    s.rect(-90, -90, -70, -70, { building: "yes", "building:levels": "5" });
    s.rect(-50, -90, 0, -50, { building: "yes", "building:levels": "1" }); // 2000 m², one floor
    s.rect(20, -90, 70, -50, { building: "yes" }); // 2000 m², height unknown
    s.rect(-90, -40, -60, -10, { building: "yes" }); // 900 m² on its own: too big for one house
    const w = await s.world();
    expect(guessAt(w, -80, -80)).toEqual({ look: "R5", candidates: ["R5"] });
    expect(guessAt(w, -25, -70)).toEqual({ look: null, candidates: ["COM", "RET", "IND"] });
    expect(guessAt(w, 45, -70)).toEqual({ look: null, candidates: ["R5", "COM", "RET", "IND"] });
    expect(guessAt(w, -75, -25)).toEqual({ look: null, candidates: ["R2", "R5", "COM"] });
  });

  it("TYPE-002: addresses on the building count; a plain `residential` only ever becomes a tier", async () => {
    expect(addrCount({})).toBeUndefined();
    expect(addrCount({ "addr:housenumber": "12" })).toBe(1);
    expect(addrCount({ "addr:housenumber": "12;14" })).toBe(2);
    expect(addrCount({ "addr:housenumber": "12-16" })).toBe(5);
    expect(addrCount({ "addr:housenumber": "7", "addr:flats": "1-24" })).toBe(24);
    const s = block();
    s.rect(-90, -90, -80, -80, { building: "yes", "addr:housenumber": "3" });
    s.rect(-70, -90, -60, -80, { building: "yes", "addr:housenumber": "5;7" }); // two doors, one small footprint
    s.rect(-50, -90, -40, -80, { building: "yes", "addr:housenumber": "9", "addr:flats": "1-12" });
    s.rect(-30, -90, 20, -50, { building: "residential" }); // 2000 m² of unspecified residential: flats, never a shop
    s.rect(-30, -40, 0, -10, { building: "residential" }); // 900 m²: a big house or a small block
    const w = await s.world();
    expect(guessAt(w, -85, -85)).toEqual({ look: "R2", candidates: ["R2"] });
    expect(guessAt(w, -65, -85)).toEqual({ look: null, candidates: ["R3", "R5"] });
    expect(guessAt(w, -45, -85)).toEqual({ look: "R5", candidates: ["R5"] });
    expect(guessAt(w, -5, -70)).toEqual({ look: "R5", candidates: ["R5"] });
    expect(guessAt(w, -15, -25)).toEqual({ look: null, candidates: ["R2", "R5"] });
  });

  it("TYPE-002 / TYPE-003: typed neighbours of similar size confirm a guess, or make it unsure when they disagree", async () => {
    const s = block();
    for (let i = 0; i < 3; i++) s.rect(-90 + i * 20, -90, -80 + i * 20, -80, { building: "house" });
    s.rect(-30, -90, -20, -80, { building: "yes" }); // among houses: a house
    s.rect(-10, -90, 0, -80, { building: "yes", "addr:housenumber": "2;4" }); // two doors among houses: unsure
    const w = await s.world();
    expect(guessAt(w, -25, -85)).toEqual({ look: "R2", candidates: ["R2"] });
    expect(guessAt(w, -5, -85)).toEqual({ look: null, candidates: ["R2", "R3", "R5"] });

    const t = block();
    for (let i = 0; i < 3; i++) t.rect(-90 + i * 20, -90, -80 + i * 20, -80, { building: "apartments" });
    t.rect(-30, -90, -20, -80, { building: "yes" }); // on its own, but every neighbour its size is flats
    const w2 = await t.world();
    expect(guessAt(w2, -25, -85)).toEqual({ look: null, candidates: ["R2", "R5"] });
  });
});

describe("agreeing and typing", () => {
  // A house-sized `yes` on its own (guessed R2), an unsure one with two doors, a typed house and a garage.
  const scene = () => {
    const s = block();
    s.rect(-90, -90, -80, -80, { building: "yes" });
    s.rect(-60, -90, -50, -80, { building: "yes", "addr:housenumber": "1;3" });
    s.rect(-30, -90, -20, -80, { building: "bungalow" });
    s.rect(0, -90, 10, -80, { building: "garage" });
    return s.world();
  };

  it("TYPE-007: an agree stroke types the guessed buildings it passes over, skips the unsure, leaves the typed", async () => {
    const w = await scene();
    const bungalow = bAt(w, -25, -85);
    const { events, step } = stroke(w, AGREE, 8, [[-95, -85], [15, -85]]);
    expect(events.filter((e) => e.type === "typed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "skip")).toHaveLength(1);
    expect(events.some((e) => e.type === "reject")).toBe(false);
    const house = bAt(w, -85, -85);
    expect(house.tags.building).toBe("house");
    expect(house.look).toBe("R2");
    expect(house.modified).toBe(true);
    expect(w.guessOf(house)).toBeNull();
    expect(bAt(w, -55, -85).tags.building).toBe("yes");
    expect(bAt(w, -25, -85)).toBe(bungalow);
    expect(step?.buildings).toHaveLength(1);
  });

  it("TYPE-007: a tap agrees to the one building under it, whatever the brush size", async () => {
    const w = await scene();
    const { events } = stroke(w, AGREE, 1, [[-83, -83]], true);
    expect(events.filter((e) => e.type === "typed")).toHaveLength(1);
    expect(bAt(w, -85, -85).tags.building).toBe("house");
  });

  it("TYPE-008: a paint stroke on buildings writes the tile's type; the same look leaves the specific type alone", async () => {
    const w = await scene();
    stroke(w, R5, 8, [[-55, -95], [-55, -75]]);
    expect(bAt(w, -55, -85).tags.building).toBe("apartments");
    expect(bAt(w, -55, -85).look).toBe("R5");
    expect(w.guessOf(bAt(w, -55, -85))).toBeNull();
    const { step } = stroke(w, R2, 8, [[-25, -95], [-25, -75]]);
    expect(step).toBeNull(); // PAINT-006
    expect(bAt(w, -25, -85).tags.building).toBe("bungalow");
  });

  it("TYPE-008: a paint stroke only reaches buildings whose centre the brush passes over", async () => {
    const w = await scene();
    stroke(w, R5, 3, [[-89, -95], [-89, -75]]); // along the west wall, 4 m from the centre
    expect(bAt(w, -85, -85).tags.building).toBe("yes");
  });

  it("TYPE-009: accessories and the Rural tile are rejected once per stroke, and nothing changes", async () => {
    const w = await scene();
    const garage = bAt(w, 5, -85);
    const a = stroke(w, R5, 8, [[-5, -85], [15, -85]]);
    expect(a.events.filter((e) => e.type === "reject")).toHaveLength(1);
    expect(a.step).toBeNull();
    expect(bAt(w, 5, -85)).toBe(garage);
    const b = stroke(w, R1, 8, [[-95, -85], [15, -85]]);
    expect(b.events.filter((e) => e.type === "reject")).toHaveLength(1);
    expect(b.step).toBeNull();
    expect(bAt(w, -85, -85).tags.building).toBe("yes");
  });

  it("TYPE-010: the eraser makes a typed building untyped, so it is guessed afresh; it respects accessories", async () => {
    const w = await scene();
    stroke(w, ERASE, 8, [[-25, -95], [-25, -75]]);
    const b = bAt(w, -25, -85);
    expect(b.tags.building).toBe("yes");
    expect(b.modified).toBe(true);
    expect(w.guessOf(b)).toEqual({ look: "R2", candidates: ["R2"] });
    const { events, step } = stroke(w, ERASE, 8, [[5, -95], [5, -75]]);
    expect(events.filter((e) => e.type === "reject")).toHaveLength(1);
    expect(step).toBeNull();
  });

  it("TYPE-006: with land as the target, paint and the eraser leave buildings alone", async () => {
    const w = await scene();
    const { step } = stroke(w, R5, 8, [[-85, -95], [-85, -75]], false, "land");
    expect(bAt(w, -85, -85).tags.building).toBe("yes");
    expect(step?.buildings ?? []).toHaveLength(0);
  });

  it("TYPE-011: a stroke on buildings is one undo step; undo brings the guess back, redo the type", async () => {
    const w = await scene();
    const before = bAt(w, -85, -85);
    const h = new History();
    const { step } = stroke(w, AGREE, 8, [[-95, -85], [15, -85]]);
    h.push(step!);
    expect(bAt(w, -85, -85).geom.source).toBe(before.geom.source);
    h.undo();
    expect(bAt(w, -85, -85)).toBe(before);
    expect(w.guessOf(before)?.look).toBe("R2");
    h.redo();
    expect(bAt(w, -85, -85).tags.building).toBe("house");
    expect(bAt(w, -85, -85).geom.source).toMatch(/^way\/\d+$/);
  });

  it("TYPE-012: buildings to decide are listed north to south and leave the list once typed", async () => {
    const w = await scene();
    const list = w.toDecide();
    expect(list.map((b) => b.tags.building)).toEqual(["yes", "yes"]);
    expect(list[0].geom.minX).toBeLessThan(list[1].geom.minX); // same row: west first
    stroke(w, AGREE, 8, [[-95, -85], [15, -85]]);
    expect(w.toDecide()).toHaveLength(1);
    stroke(w, R5, 8, [[-55, -95], [-55, -75]]);
    expect(w.toDecide()).toHaveLength(0);
  });

  it("TYPE-014: typing buildings changes no land: the district mix is the same before and after", async () => {
    const w = await scene();
    const before = w.mix();
    stroke(w, AGREE, 8, [[-95, -85], [15, -85]]);
    stroke(w, R5, 8, [[-55, -95], [-55, -75]]);
    expect(w.mix()).toEqual(before);
  });
});
