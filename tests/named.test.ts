import { describe, expect, it } from "vitest";
import { History } from "../src/model/history";
import { classifyArea, disagreesWithLand } from "../src/model/kinds";
import type { World } from "../src/model/world";
import { type Tool } from "../src/paint/snap";
import { answerWhole } from "../src/paint/stroke";
import { Sketch, at, paint } from "./helpers";

const R2: Tool = { type: "paint", kind: "R2" };
const COM: Tool = { type: "paint", kind: "COM" };
const UP: Tool = { type: "density", dir: 1 };
const ERASE: Tool = { type: "erase" };
const NAMED = { landuse: "residential", name: "Pärnaõue" };

/** Nine blocks, roads every 200 m; a named complex across the centre block and the one east of it. */
async function complex(tags: Record<string, string> = NAMED) {
  const s = new Sketch(300).grid(200);
  s.rect(-95, -95, 290, 95, tags);
  return s.world();
}

const namedArea = (w: World) =>
  w.atoms.flatMap((a) => a.pieces).filter((p) => p.named !== undefined).reduce((t, p) => t + p.area, 0);

describe("named residential areas", () => {
  it("NAME-001: a named landuse=residential is one named area; a place=neighbourhood alone is not", () => {
    expect(classifyArea(NAMED)).toEqual({ cls: "paintable", kind: "RU", named: "Pärnaõue" });
    expect(classifyArea({ ...NAMED, residential: "apartments" })).toEqual({ cls: "paintable", kind: "R5", named: "Pärnaõue" });
    expect(classifyArea({ ...NAMED, place: "neighbourhood" })).toEqual({ cls: "paintable", kind: "RU", named: "Pärnaõue" });
    expect(classifyArea({ place: "neighbourhood", name: "Pärnaõue" })).toBeNull();
    expect(classifyArea({ landuse: "residential", name: " " })).toEqual({ cls: "paintable", kind: "RU" });
  });

  it("NAME-001: every block of a named area knows its name, and it never merges with land beside it", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, { ...NAMED, residential: "single_family" });
    s.rect(0, -95, 95, 95, { landuse: "residential", residential: "single_family" });
    const w = await s.world();
    expect(at(w, -50, 0)?.named).toBe("Pärnaõue");
    expect(at(w, 50, 0)?.named).toBeUndefined();
    expect(at(w, -50, 0)).not.toBe(at(w, 50, 0));
    const c = await complex();
    expect(at(c, 0, 0)?.named).toBe("Pärnaõue");
    expect(at(c, 200, 0)?.named).toBe("Pärnaõue");
  });

  it("NAME-002: a tap with a tier claims the whole named area, in every block, as one step", async () => {
    const w = await complex();
    const { step } = paint(w, R2, 10, [[0, 0]], true);
    expect(at(w, 0, 0)?.kind).toBe("R2");
    expect(at(w, 200, 0)?.kind).toBe("R2");
    expect(at(w, 200, 0)?.named).toBe("Pärnaõue");
    expect(step?.atoms.length).toBe(2);
    const h = new History();
    h.push(step!);
    h.undo();
    expect(at(w, 200, 0)?.kind).toBe("RU");
  });

  it("NAME-002: brushing past a corner leaves the named area as it was", async () => {
    const w = await complex();
    const before = namedArea(w);
    const { events } = paint(w, R2, 10, [[-150, -150], [-85, -85], [-150, 0]]);
    expect(at(w, 0, 0)?.kind).toBe("RU");
    expect(at(w, 200, 0)?.kind).toBe("RU");
    expect(namedArea(w)).toBeCloseTo(before, 0);
    expect(events.some((e) => e.type === "reject")).toBe(false);
  });

  it("NAME-002: a stroke over most of the named area claims it whole", async () => {
    const w = await complex();
    const { events } = paint(w, R2, 60, [[-60, 0], [260, 0]]);
    expect(events.some((e) => e.type === "claim")).toBe(true);
    expect(at(w, 0, -90)?.kind).toBe("R2");
    expect(at(w, 280, 90)?.kind).toBe("R2");
  });

  it("NAME-002: freeform paint stops at the edge of a named area", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, NAMED);
    const w = await s.world();
    const before = namedArea(w);
    // The half block east of it is open land at r = 5; the stroke runs on into the named area and back.
    paint(w, R2, 5, [[60, -60], [-30, -60], [-30, 60], [60, 60]]);
    expect(at(w, 20, -60)?.kind).toBe("R2");
    expect(at(w, 20, 60)?.kind).toBe("R2");
    expect(at(w, -30, 0)?.kind).toBe("RU");
    expect(namedArea(w)).toBeCloseTo(before, 0);
  });

  it("NAME-003: commercial and the eraser leave a named area alone and reject once", async () => {
    for (const tool of [COM, ERASE]) {
      const w = await complex({ ...NAMED, residential: "terrace" });
      const before = namedArea(w);
      const { events, step } = paint(w, tool, 10, [[0, 0], [200, 0], [0, 50]]);
      expect(events.filter((e) => e.type === "reject").length).toBe(1);
      expect(step).toBeNull();
      expect(at(w, 0, 0)?.kind).toBe("R4");
      expect(namedArea(w)).toBeCloseTo(before, 0);
    }
    const w = await complex();
    expect(paint(w, ERASE, 10, [[0, 0]], true).events.filter((e) => e.type === "reject").length).toBe(1);
  });

  it("NAME-004: a density step moves the whole named area one tier, once per stroke", async () => {
    const w = await complex({ ...NAMED, residential: "single_family" });
    const { events } = paint(w, UP, 10, [[0, 0], [200, 0]]);
    expect(at(w, 0, 0)?.kind).toBe("R3");
    expect(at(w, 200, 0)?.kind).toBe("R3");
    expect(events.filter((e) => e.type === "tier").length).toBe(2);
  });

  it("NAME-005: an unspecified named area asks what it is until it has a tier or is mixed; undo asks again", async () => {
    const w = await complex();
    const [q] = w.quests();
    expect(w.quests().length).toBe(1);
    expect(q.name).toBe("Pärnaõue");
    expect(at(w, q.at[0], q.at[1])?.named).toBe("Pärnaõue");
    const h = new History();
    h.push(answerWhole(w, q.source, "RM").step!);
    expect(w.quests()).toEqual([]);
    h.undo();
    expect(w.quests().length).toBe(1);
    expect((await complex({ ...NAMED, residential: "apartments" })).quests()).toEqual([]);
  });

  it("NAME-006: answering gives the whole area the kind as one undo step, with a pop per block", async () => {
    const w = await complex();
    const [q] = w.quests();
    const { events, step } = answerWhole(w, q.source, "R4");
    expect(at(w, 0, 0)?.kind).toBe("R4");
    expect(at(w, 200, 0)?.kind).toBe("R4");
    expect(at(w, 0, 0)?.modified).toBe(true);
    expect(events.filter((e) => e.type === "claim").length).toBe(2);
    expect(step?.atoms.length).toBe(2);
    const h = new History();
    h.push(step!);
    h.undo();
    expect(at(w, 0, 0)?.kind).toBe("RU");
    expect(answerWhole(w, q.source, "RU").step).toBeNull();
  });

  it("NAME-007: no tag is read as mixed", () => {
    expect(classifyArea({ ...NAMED, residential: "mixed" })).toEqual({ cls: "paintable", kind: "RU", named: "Pärnaõue" });
  });

  it("DENS-004: density on mixed land rejects", async () => {
    const w = await complex();
    answerWhole(w, w.quests()[0].source, "RM");
    const { events, step } = paint(w, UP, 10, [[0, 0]]);
    expect(events.filter((e) => e.type === "reject").length).toBe(1);
    expect(step).toBeNull();
    expect(at(w, 0, 0)?.kind).toBe("RM");
  });

  it("BLD-007: mixed land is residential", () => {
    expect(disagreesWithLand("R2", "RM")).toBe(false);
    expect(disagreesWithLand("IND", "RM")).toBe(true);
  });

  it("NAME-002: a tier tap on a mixed area claims it whole", async () => {
    const w = await complex();
    answerWhole(w, w.quests()[0].source, "RM");
    paint(w, R2, 10, [[200, 0]], true);
    expect(at(w, 0, 0)?.kind).toBe("R2");
  });
});
