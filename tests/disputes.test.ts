import { describe, expect, it } from "vitest";
import { contains, ringFromMeters, toI, union } from "../src/geo/clip";
import { History } from "../src/model/history";
import { disagreesWithLand } from "../src/model/kinds";
import { rippleT, spikesAlong } from "../src/render/marks";
import { TUNE } from "../src/tuning";
import { Sketch, at, paint } from "./helpers";

// One block, -95..95 m each way, with an industrial area and an apartment area overlapping in a band 50 m
// wide (x -30..20). Neither lies inside the other, and they disagree.
const clash = () => {
  const s = new Sketch(300).grid(200);
  s.rect(-95, -95, 20, 95, { landuse: "industrial" });
  s.rect(-30, -95, 95, 95, { landuse: "residential", residential: "apartments" });
  return s;
};

describe("overlaps", () => {
  it("IMP-010: a drift strip between two lots is split down the middle", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 2, 95, { landuse: "residential", residential: "detached" });
    s.rect(-2, -95, 95, 95, { landuse: "commercial" });
    const w = await s.world();
    expect(at(w, -1.2, 0)?.kind).toBe("R2");
    expect(at(w, 1.2, 0)?.kind).toBe("COM");
    expect(w.disputed()).toEqual([]);
  });

  it("IMP-011: agreeing features overlap quietly, and the tier wins over unspecified residential", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 20, 95, { landuse: "residential" });
    s.rect(-40, -95, 95, 95, { landuse: "residential", residential: "terrace" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("R4");
    expect(at(w, -70, 0)?.kind).toBe("RU");
    expect(w.disputed()).toEqual([]);
  });

  it("IMP-011: two kinds of context never dispute", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 20, 95, { leisure: "park" });
    s.rect(-30, -95, 95, 95, { landuse: "forest" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("CTX");
    expect(w.disputed()).toEqual([]);
  });

  it("IMP-012: disagreeing features mark their wide overlap disputed; the smaller one shows", async () => {
    const w = await clash().world();
    const p = at(w, 0, 0)!;
    expect(p.kind).toBe("IND");
    expect(p.rival?.kind).toBe("R5");
    expect(at(w, -70, 0)?.rival).toBeUndefined();
    expect(at(w, 60, 0)?.rival).toBeUndefined();
    expect(at(w, 60, 0)?.kind).toBe("R5");
    expect(w.disputed().length).toBe(1);
  });

  it("IMP-012 / CORR-001: near-duplicates of different kinds are disputed, not decided by a few m²", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "commercial" });
    s.rect(-95, -95, 95, 94, { landuse: "retail" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("RET");
    expect(at(w, 0, 0)?.rival?.kind).toBe("COM");
  });

  it("IMP-012: context and landuse can disagree; the rival keeps its colour class", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 20, 95, { leisure: "park" });
    s.rect(-30, -95, 95, 95, { landuse: "residential", residential: "detached" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("CTX");
    expect(at(w, 0, 0)?.rival).toMatchObject({ kind: "R2", ctx: undefined });
  });

  it("IMP-012: context holds the overlap even when it is the larger feature", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 40, 95, { leisure: "park" });
    s.rect(-20, -95, 95, 95, { landuse: "residential", residential: "detached" });
    const w = await s.world();
    expect(at(w, 10, 0)?.kind).toBe("CTX");
    expect(at(w, 10, 0)?.rival?.kind).toBe("R2");
    expect(at(w, 70, 0)?.kind).toBe("R2");
  });

  it("CORR-001: landuse nested inside context still keeps its land, undisputed", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "farmland" });
    s.rect(-40, -40, 40, 40, { landuse: "residential", residential: "rural" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("R1");
    expect(w.disputed()).toEqual([]);
  });
});

describe("settling disputes", () => {
  const IND = { type: "paint", kind: "IND" } as const;

  it("DISP-002: tapping a disputed block with the kind it already shows settles it", async () => {
    const w = await clash().world();
    const { step } = paint(w, IND, 20, [[0, 0]], true);
    expect(step).not.toBeNull();
    expect(at(w, 0, 0)?.kind).toBe("IND");
    expect(at(w, 0, 0)?.rival).toBeUndefined();
    expect(w.disputed()).toEqual([]);
  });

  // A park and detached houses overlapping in x -30..20; the park holds the overlap (IMP-012).
  const parkClash = () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 20, 95, { leisure: "park" });
    s.rect(-30, -95, 95, 95, { landuse: "residential", residential: "detached" });
    return s.world();
  };

  it("PAINT-004 / DISP-005: dragging paint over disputed context rejects and changes nothing", async () => {
    const w = await parkClash();
    const { events } = paint(w, { type: "paint", kind: "R2" }, 4, [[0, -90], [0, 90]]);
    expect(events.some((e) => e.type === "reject")).toBe(true); // PAINT-009
    expect(at(w, 0, 0)?.kind).toBe("CTX");
    expect(at(w, 0, 0)?.rival?.kind).toBe("R2");
  });

  it("DISP-005: a press held on disputed context without moving rejects and changes nothing", async () => {
    const w = await parkClash();
    const { events, step } = paint(w, { type: "paint", kind: "R2" }, 4, [[0, 0]]);
    expect(step).toBeNull();
    expect(events.filter((e) => e.type === "reject").length).toBe(1);
    expect(at(w, 0, 0)?.rival?.kind).toBe("R2");
  });

  it("DISP-004: tapping disputed context settles it for the context and marks the rival changed", async () => {
    const w = await parkClash();
    const h = new History();
    expect(at(w, 60, 0)?.modified).toBe(false);
    const { events, step } = paint(w, { type: "paint", kind: "R2" }, 20, [[0, 0]], true);
    expect(events.some((e) => e.type === "reject")).toBe(false); // PAINT-009
    h.push(step!);
    expect(at(w, 0, 0)?.kind).toBe("CTX");
    expect(at(w, 0, 0)?.rival).toBeUndefined();
    expect(w.disputed()).toEqual([]);
    expect(at(w, 60, 0)?.kind).toBe("R2"); // the tap paints nothing else
    expect(at(w, 60, 0)?.modified).toBe(true); // IMP-008: the houses' outline shrinks
    h.undo();
    expect(at(w, 0, 0)?.rival?.kind).toBe("R2");
    expect(at(w, 60, 0)?.modified).toBe(false);
  });

  it("DISP-004: the eraser settles disputed context too", async () => {
    const w = await parkClash();
    const { events, step } = paint(w, { type: "erase" }, 20, [[0, 0]], true);
    expect(step).not.toBeNull();
    expect(events.some((e) => e.type === "reject")).toBe(false);
    expect(at(w, 0, 0)?.kind).toBe("CTX");
    expect(at(w, 0, 0)?.rival).toBeUndefined();
  });

  it("DISP-005: density tools leave disputed context alone", async () => {
    const w = await parkClash();
    const { events, step } = paint(w, { type: "density", dir: 1 }, 5, [[0, -20], [0, 20]]);
    expect(step).toBeNull();
    expect(events.some((e) => e.type === "reject")).toBe(true);
    expect(at(w, 0, 0)?.rival?.kind).toBe("R2");
  });

  it("PAINT-004: undisputed context stays protected from taps", async () => {
    const w = await parkClash();
    const { events, step } = paint(w, { type: "paint", kind: "R2" }, 20, [[-70, 0]], true);
    expect(step).toBeNull();
    expect(at(w, -70, 0)?.kind).toBe("CTX");
    expect(events.some((e) => e.type === "reject")).toBe(true);
  });

  it("DISP-001: painting part of a disputed piece settles that part; undo brings the dispute back", async () => {
    const w = await clash().world();
    const h = new History();
    const { step } = paint(w, { type: "paint", kind: "R5" }, 4, [[-5, -90], [-5, -20]]);
    h.push(step!);
    expect(at(w, -5, -50)?.kind).toBe("R5");
    expect(at(w, -5, -50)?.rival).toBeUndefined();
    expect(at(w, -5, 60)?.kind).toBe("IND");
    expect(at(w, -5, 60)?.rival?.kind).toBe("R5");
    h.undo();
    expect(at(w, -5, -50)?.rival?.kind).toBe("R5");
  });

  it("DISP-001: a density step settles the disputed piece it changes", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 20, 95, { landuse: "residential", residential: "detached" });
    s.rect(-30, -95, 95, 95, { landuse: "commercial" });
    const w = await s.world();
    expect(at(w, 0, 0)?.rival?.kind).toBe("COM");
    paint(w, { type: "density", dir: 1 }, 5, [[0, -2], [0, 2]]);
    expect(at(w, 0, 0)?.kind).toBe("R3");
    expect(at(w, 0, 0)?.rival).toBeUndefined();
  });

  it("HUD-009 / HUD-010: disputed pieces are listed one per piece, north to south", async () => {
    const s = clash();
    s.rect(-95, 205, 20, 295, { landuse: "industrial" });
    s.rect(-30, 205, 95, 295, { landuse: "retail" });
    const w = await s.world();
    const list = w.disputed();
    expect(list.map((p) => p.rival?.kind)).toEqual(["R5", "RET"]);
  });
});

describe("marks", () => {
  it("BLD-007: buildings disagree with land only across families", () => {
    expect(disagreesWithLand("R2", "IND")).toBe(true);
    expect(disagreesWithLand("IND", "RU")).toBe(true);
    expect(disagreesWithLand("R5", "COM")).toBe(true);
    expect(disagreesWithLand("R2", "R5")).toBe(false);
    expect(disagreesWithLand("COM", "RET")).toBe(false);
    expect(disagreesWithLand("CIVIC", "R2")).toBe(false);
    expect(disagreesWithLand(null, "IND")).toBe(false);
    expect(disagreesWithLand("IND", "CTX")).toBe(false);
    expect(disagreesWithLand("IND", null)).toBe(false);
  });

  it("REN-013: spikes sit on the edge, every spacing, pointing out of the shape, holes included", () => {
    const outer = ringFromMeters([[0, 0], [40, 0], [40, 40], [0, 40]]);
    const hole = ringFromMeters([[10, 10], [10, 30], [30, 30], [30, 10]]);
    const shape = union([outer]).concat(union([hole]).map((r) => r.slice().reverse()));
    const spikes = spikesAlong(shape, 4, 1, 0.5);
    expect(spikes.length).toBe(40 + 20);
    const inside = (x: number, y: number) => contains(shape, toI(x), toI(y));
    for (const [ax, ay, bx, by, tx, ty] of spikes) {
      const [mx, my] = [(ax + bx) / 2, (ay + by) / 2];
      expect(inside(tx, ty)).toBe(false);
      // Just inside from the base is land.
      expect(inside(mx + (mx - tx) * 0.2, my + (my - ty) * 0.2)).toBe(true);
    }
  });

  it("REN-013: spikes creep along the edge as the phase grows", () => {
    const sq = union([ringFromMeters([[0, 0], [40, 0], [40, 40], [0, 40]])]);
    const a = spikesAlong(sq, 4, 1, 0)[0], b = spikesAlong(sq, 4, 1, 1)[0];
    expect(Math.hypot(a[4] - b[4], a[5] - b[5])).toBeCloseTo(1, 5);
  });

  it("REN-011: ripples cycle once per period, neighbours out of step", () => {
    const t0 = rippleT(1000, 0, 0);
    expect(t0).toBeGreaterThanOrEqual(0);
    expect(t0).toBeLessThan(1);
    expect(rippleT(1000 + TUNE.RIPPLE_PERIOD, 0, 0)).toBeCloseTo(t0, 6);
    expect(rippleT(1000, 1200, 800)).not.toBeCloseTo(t0, 2);
  });
});
