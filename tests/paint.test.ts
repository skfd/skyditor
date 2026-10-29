import { describe, expect, it } from "vitest";
import { contains, toI } from "../src/geo/clip";
import { History } from "../src/model/history";
import { Stroke } from "../src/paint/stroke";
import { type Tool, unitLimit } from "../src/paint/snap";
import { TUNE } from "../src/tuning";
import { Sketch, at, atomAt, paint } from "./helpers";

const R2: Tool = { type: "paint", kind: "R2" };
const COM: Tool = { type: "paint", kind: "COM" };
const UP: Tool = { type: "density", dir: 1 };
const DOWN: Tool = { type: "density", dir: -1 };
const ERASE: Tool = { type: "erase" };
const grid = () => new Sketch(300).grid(200);
const voidArea = (w: Awaited<ReturnType<Sketch["world"]>>, x: number, y: number) =>
  atomAt(w, x, y).pieces.filter((p) => p.kind === null).reduce((t, p) => t + p.area, 0);

describe("unit pieces", () => {
  it("SNAP-001: the unit limit scales with brush area and is capped", () => {
    expect(unitLimit(10)).toBeCloseTo(TUNE.UNIT_FACTOR * Math.PI * 100);
    expect(unitLimit(1000)).toBe(TUNE.UNIT_ABS_MAX);
  });

  it("SNAP-003: scrubbing over enough of a block claims it whole, during the stroke", async () => {
    const w = await grid().world();
    const s = new Stroke(w, R2, 30, -80, -60);
    s.start();
    const claims = [];
    for (const [x, y] of [[80, -60], [80, 0], [-80, 0], [-80, 60], [80, 60]] as [number, number][])
      for (let i = 1; i <= 20; i++) {
        const [lx, ly] = s.trail[s.trail.length - 1];
        claims.push(...s.move(lx + ((x - lx) * i) / 20, ly + ((y - ly) * i) / 20).filter((e) => e.type === "claim"));
      }
    expect(claims.length).toBe(1);
    expect(at(w, 93, 93)?.kind).toBe("R2"); // a corner the brush never touched
    expect(voidArea(w, 0, 0)).toBe(0);
  });

  it("SNAP-006: a stroke that covers too little of a unit piece leaves it unchanged", async () => {
    const w = await grid().world();
    const { step } = paint(w, R2, 30, [[-60, 0], [-20, 0]]);
    expect(step).toBeNull();
    expect(at(w, 0, 0)?.kind).toBe(null);
  });

  it("SNAP-004: tapping a unit piece claims it", async () => {
    const w = await grid().world();
    const { step, events } = paint(w, R2, 30, [[0, 0]], true);
    expect(step).not.toBeNull();
    expect(events.some((e) => e.type === "claim")).toBe(true);
    expect(at(w, -90, 90)?.kind).toBe("R2");
  });
});

describe("open pieces", () => {
  it("SNAP-103: a gap narrower than the snap distance between paint and road closes", async () => {
    const w = await grid().world();
    // r = 10: the 190 m block is far above the unit limit. Paint edge at y = -70, block edge at y = -95.
    paint(w, R2, 10, [[-60, -80], [60, -80]]);
    expect(at(w, 0, -93)?.kind).toBe("R2");
    expect(at(w, 0, -50)?.kind).toBe(null);
  });

  it("SNAP-103: a leftover wider than the snap distance stays", async () => {
    const w = await grid().world();
    paint(w, R2, 10, [[-60, -50], [60, -50]]); // paint edge at y = -60, 35 m from the road
    expect(at(w, 0, -90)?.kind).toBe(null);
  });

  it("CORR-003: a long narrow leftover is swallowed only near the paint", async () => {
    // A dead end off the east street runs 14 m inside the north edge of the centre block, leaving an 8 m strip
    // that reaches 150 m east from where the paint is.
    const s = grid();
    s.road([[100, -80], [-60, -80]]);
    const w = await s.world();
    paint(w, R2, 10, [[-80, -110], [-80, 110]]);
    const reach = TUNE.SWALLOW_REACH * 10;
    expect(at(w, -70 + reach / 2, -90)?.kind).toBe("R2");
    expect(at(w, -70 + reach + 10, -90)?.kind).toBe(null);
    expect(at(w, 50, -90)?.kind).toBe(null);
  });

  it("SNAP-104: corners of a wide leftover are never swallowed", async () => {
    const w = await grid().world();
    paint(w, R2, 10, [[-60, -80], [60, -80]]);
    expect(at(w, 93, 93)?.kind).toBe(null);
    expect(at(w, -93, 93)?.kind).toBe(null);
  });

  it("SNAP-108: a mostly covered cell between a path and the road is taken whole", async () => {
    const s = grid();
    s.road([[0, -110], [0, 110]], "footway");
    const w = await s.world();
    paint(w, R2, 14, [[-78, -75], [-78, 75], [-30, 75], [-30, -75]]);
    expect(at(w, -54, 0)?.kind).toBe("R2"); // 20 m wide unpainted strip, taken with its cell
    expect(at(w, 50, 0)?.kind).toBe(null);
  });

  it("SNAP-108: a fence, wall or hedge divides cells like a path", async () => {
    for (const barrier of ["fence", "wall", "hedge"]) {
      const s = grid();
      s.way([[0, -110], [0, 110]], { barrier });
      const w = await s.world();
      paint(w, R2, 14, [[-78, -75], [-78, 75], [-30, 75], [-30, -75]]);
      expect(at(w, -54, 0)?.kind).toBe("R2");
      expect(at(w, 50, 0)?.kind).toBe(null);
    }
  });

  it("SNAP-112: a gap up to a fence that ends inside the block closes", async () => {
    // The fence runs in from the east street and stops in the middle; it divides no cells. Paint edge at y = -30,
    // the fence half the widest gap that closes beyond it.
    const gap = TUNE.FENCE_SNAP * 10;
    const s = grid();
    s.way([[100, -30 - gap], [0, -30 - gap]], { barrier: "fence" });
    const w = await s.world();
    expect(w.cellsOf(atomAt(w, 0, 0)).length).toBe(0);
    paint(w, R2, 10, [[-60, -20], [60, -20]]);
    expect(at(w, 30, -30 - gap / 2)?.kind).toBe("R2");
    expect(at(w, 30, -34 - gap)?.kind).toBe(null);
    expect(at(w, -30, -30 - gap / 2)?.kind).toBe(null); // no fence here: a wide leftover
  });

  it("SNAP-112: a fence in a gap too wide to close does not make it close", async () => {
    // Paint edge at y = -80, block edge near -94: too wide to close. The fence leaves a near part just wider
    // than a gap up to a fence may be.
    const near = 2 * TUNE.FENCE_SNAP * 10 + 1;
    const s = grid();
    s.way([[-100, -80 - near], [100, -80 - near]], { barrier: "fence" });
    const w = await s.world();
    paint(w, R2, 10, [[-60, -70], [60, -70]]);
    expect(at(w, 0, -80 - near / 2)?.kind).toBe(null);
  });

  it("SNAP-112: no leftover is swallowed across a fence", async () => {
    // Paint edge at y = -82, fence at -87, block edge near -94: the whole gap would close without the fence.
    expect(2 * TUNE.FENCE_SNAP * 12).toBeGreaterThan(5);
    const s = grid();
    s.way([[-100, -87], [100, -87]], { barrier: "wall" });
    const w = await s.world();
    paint(w, R2, 12, [[-60, -70], [60, -70]]);
    expect(at(w, 0, -85)?.kind).toBe("R2");
    expect(at(w, 0, -91)?.kind).toBe(null);
  });

  it("SNAP-112: a fence across a gap that closes leaves no crack", async () => {
    const s = grid();
    s.way([[0, -100], [0, -60]], { barrier: "hedge" });
    const w = await s.world();
    // The live preview (SNAP-105) shows the region before SNAP-107 tidies slivers, so check it there too.
    const s2 = new Stroke(w, R2, 12, -60, -75);
    s2.start();
    for (let x = -59; x <= 60; x++) s2.move(x, -75);
    s2.updatePreview();
    const region = s2.preview.get(atomAt(w, 0, 0))!.region;
    expect(contains(region, toI(-5), toI(-91))).toBe(true);
    expect(contains(region, toI(0), toI(-91))).toBe(true);
    s2.end(false);
    expect(at(w, 0, -91)?.kind).toBe("R2");
  });

  it("SNAP-112: two lots painted one after the other leave no crack along the fence between them", async () => {
    for (const [first, second] of [[R2, R2], [COM, R2]] as Tool[][]) {
      const s = grid();
      s.way([[0, -110], [0, 110]], { barrier: "fence" });
      const w = await s.world();
      paint(w, first, 14, [[-78, -75], [-78, 75], [-30, 75], [-30, -75]]);
      const pts: [number, number][] = [[78, -75], [78, 75], [30, 75], [30, -75]];
      const st = new Stroke(w, second, 14, ...pts[0]);
      st.start();
      for (let i = 1; i < pts.length; i++)
        for (let k = 1; k <= 40; k++) {
          const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
          st.move(ax + ((bx - ax) * k) / 40, ay + ((by - ay) * k) / 40);
        }
      st.updatePreview();
      const region = st.preview.get(atomAt(w, 0, 0))!.region;
      expect(contains(region, toI(0.1), toI(0))).toBe(true);
      st.end(false);
      expect(voidArea(w, 0, 0)).toBeLessThan(1);
    }
  });

  // A wobbly stroke across the centre block, from its west edge to its east edge: its north and south
  // outlines follow nothing, so each becomes one straight line.
  const wobbly = (amp: number) =>
    Array.from({ length: 49 }, (_, i): [number, number] => [-120 + 5 * i, -20 + amp * Math.sin(i * 0.9)]);
  const innerVertices = (w: Awaited<ReturnType<Sketch["world"]>>) =>
    at(w, 0, -20)!.shape.flat().filter((p) => Math.abs(p.X) < toI(80)).length;

  it("SNAP-111: an edge that follows nothing becomes a straight line", async () => {
    const w = await grid().world();
    paint(w, R2, 10, wobbly(2));
    expect(at(w, 0, -20)?.kind).toBe("R2");
    expect(innerVertices(w)).toBe(0);
  });

  it("SNAP-111: where the stroke turns, the edge turns with a square corner", async () => {
    const w = await grid().world();
    // Along the west edge, then turning east along y = 40 to the east edge: an L of 20 m wide paint.
    paint(w, R2, 10, [[-84, -110], [-84, 40], [110, 40]]);
    // The inner corner of the L, about (-74, 30), and nothing else on the free edges south and east of it.
    const corner = at(w, -80, 40)!.shape.flat().filter((p) => p.X > toI(-80) && p.X < toI(85) && p.Y > toI(-85) && p.Y < toI(45));
    expect(corner.length).toBe(1);
    const ring = at(w, -80, 40)!.shape.find((r) => r.includes(corner[0]))!;
    const k = ring.indexOf(corner[0]);
    const [p, v, q] = [ring[(k + ring.length - 1) % ring.length], ring[k], ring[(k + 1) % ring.length]];
    const cos = ((p.X - v.X) * (q.X - v.X) + (p.Y - v.Y) * (q.Y - v.Y)) /
      (Math.hypot(p.X - v.X, p.Y - v.Y) * Math.hypot(q.X - v.X, q.Y - v.Y));
    expect(Math.abs(cos)).toBeLessThan(0.02);
  });

  it("SNAP-109: a building mostly outside the paint is left out with its yard", async () => {
    const s = grid();
    s.rect(-10, -20, 10, 0, { building: "house" });
    const w = await s.world();
    paint(w, R2, 10, [[-60, -25], [60, -25]]); // covers y ∈ [-35, -15]: a quarter of the house
    expect(at(w, 0, -17)?.kind).toBe(null);
    expect(at(w, 0, -20 - TUNE.BUILDING_MARGIN / 2)?.kind).toBe(null); // in its yard
    expect(at(w, 0, -20 - TUNE.BUILDING_MARGIN - 0.3)?.kind).toBe("R2"); // the edge follows the wall
    expect(at(w, 30, -17)?.kind).toBe("R2");
  });

  it("SNAP-109: a building mostly inside the paint is included whole, with its yard", async () => {
    const s = grid();
    s.rect(-10, -20, 10, 0, { building: "house" });
    const w = await s.world();
    paint(w, R2, 10, [[-60, -12], [60, -12]]); // covers y ∈ [-22, -2]
    expect(at(w, 0, -1)?.kind).toBe("R2");
    expect(at(w, 0, TUNE.BUILDING_MARGIN / 2)?.kind).toBe("R2");
    expect(at(w, 30, TUNE.BUILDING_MARGIN / 2)?.kind).toBe(null);
  });
});

describe("leftovers of freeform paint", () => {
  // A U painted zoomed in (r = 8): the void inside it stays joined to the void around it, about 31 000 m².
  const u = async () => {
    const w = await grid().world();
    paint(w, R2, 8, [[-35, -60], [-35, 60], [35, 60], [35, -60]]);
    return w;
  };

  it("CORR-002: the inside of a painted U takes paint brushed over it, even zoomed out", async () => {
    const w = await u();
    expect(at(w, 0, 0)!.area).toBeLessThan(unitLimit(30)); // small enough to have been all-or-nothing
    const { step } = paint(w, R2, 30, [[0, -60], [0, 45]]);
    expect(step).not.toBeNull();
    expect(at(w, 0, 0)?.kind).toBe("R2");
    expect(at(w, -20, -50)?.kind).toBe("R2");
    expect(at(w, -80, 0)?.kind).toBe(null); // outside the U, beyond the brush
  });

  it("CORR-002: a tap on the leftover paints where it lands, not the whole leftover", async () => {
    const w = await u();
    paint(w, R2, 30, [[-75, 0]], true);
    expect(at(w, -75, 0)?.kind).toBe("R2");
    expect(at(w, 75, 0)?.kind).toBe(null);
  });

  it("CORR-002: a block cleared whole is a unit piece again", async () => {
    const w = await grid().world();
    paint(w, R2, 30, [[0, 0]], true);
    paint(w, ERASE, 30, [[0, 0]], true);
    expect(at(w, 0, 0)?.kind).toBe(null);
    paint(w, COM, 30, [[0, 0]], true);
    expect(at(w, -90, 90)?.kind).toBe("COM");
  });

  it("CORR-002: a density step keeps painted land out of all-or-nothing claims", async () => {
    const w = await u();
    paint(w, UP, 8, [[-35, 0], [-35, 10]]);
    expect(at(w, -35, 0)?.kind).toBe("R3");
    paint(w, COM, 30, [[35, -60], [35, 0]]); // brushes the right arm only
    expect(at(w, 35, -40)?.kind).toBe("COM");
    expect(at(w, -35, 0)?.kind).toBe("R3");
  });
});

describe("overlap", () => {
  it("OVL-002 / OVL-001: new paint takes its part of another kind; pieces still tile the block", async () => {
    const s = grid();
    s.rect(-95, -95, 95, 95, { landuse: "residential" });
    const w = await s.world();
    paint(w, COM, 10, [[-90, 0], [90, 0]]);
    const a = atomAt(w, 0, 0);
    expect(at(w, 0, 0)?.kind).toBe("COM");
    expect(at(w, 0, -60)?.kind).toBe("RU");
    expect(at(w, 0, 60)?.kind).toBe("RU");
    const sum = a.pieces.reduce((t, p) => t + p.area, 0);
    expect(Math.abs(sum - a.area)).toBeLessThan(2);
    // OVL-004
    expect(a.pieces.filter((p) => p.kind === "RU").every((p) => p.modified && p.source)).toBe(true);
  });

  it("OVL-003: touching pieces of the same kind merge", async () => {
    const s = grid();
    s.rect(-95, -95, 0, 95, { landuse: "commercial" });
    const w = await s.world();
    paint(w, R2, 30, [[-50, 0]], true);
    paint(w, R2, 30, [[50, 0]], true);
    const a = atomAt(w, 0, 0);
    expect(a.pieces.length).toBe(1);
    expect(a.pieces[0].kind).toBe("R2");
  });

  it("PAINT-004: exclusive context is never painted over", async () => {
    const s = grid();
    s.rect(-95, -95, 95, 95, { leisure: "park" });
    const w = await s.world();
    expect(paint(w, R2, 30, [[0, 0]], true).step).toBeNull();
    expect(paint(w, R2, 10, [[-90, 0], [90, 0]]).step).toBeNull();
    expect(at(w, 0, 0)?.kind).toBe("CTX");
  });

  it("PAINT-006 / PAINT-007: painting a kind onto itself changes nothing and makes no undo step", async () => {
    const s = grid();
    s.rect(-95, -95, 95, 95, { landuse: "residential", residential: "detached" });
    const w = await s.world();
    expect(paint(w, R2, 30, [[0, 0]], true).step).toBeNull();
    expect(paint(w, R2, 10, [[-90, 0], [90, 0]]).step).toBeNull();
  });

  it("KIND-007: the eraser turns landuse back into void", async () => {
    const s = grid();
    s.rect(-95, -95, 95, 95, { landuse: "industrial" });
    const w = await s.world();
    paint(w, ERASE, 30, [[0, 0]], true);
    expect(at(w, 0, 0)?.kind).toBe(null);
    expect(voidArea(w, 0, 0)).toBeCloseTo(atomAt(w, 0, 0).area, 0);
  });
});

describe("density", () => {
  const tiers = async (residential: string) => {
    const s = grid();
    s.rect(-95, -95, 95, 95, { landuse: "residential", residential });
    s.rect(105, -95, 300, 95, { landuse: "residential" });
    s.rect(-300, -95, -105, 95, { landuse: "retail" });
    return s.world();
  };

  it("DENS-002: dragging over a tiered piece steps it once per stroke", async () => {
    const w = await tiers("detached");
    paint(w, UP, 10, [[-50, 0], [50, 0], [-50, 10]]);
    expect(at(w, 0, 0)?.kind).toBe("R3");
    paint(w, DOWN, 10, [[0, 0]]);
    paint(w, DOWN, 10, [[0, 0]]);
    expect(at(w, 0, 0)?.kind).toBe("R1");
  });

  it("DENS-003: the ladder ends bump instead of wrapping", async () => {
    const w = await tiers("rural");
    const { events, step } = paint(w, DOWN, 10, [[0, 0]]);
    expect(events.map((e) => e.type)).toEqual(["bump"]);
    expect(step).toBeNull();
  });

  it("DENS-004: unspecified residential and non-residential landuse reject, once per stroke", async () => {
    const w = await tiers("detached");
    const { events } = paint(w, UP, 10, [[200, 0], [-200, 0]]);
    expect(events.filter((e) => e.type === "reject").length).toBe(1);
    expect(at(w, 200, 0)?.kind).toBe("RU");
    expect(at(w, -200, 0)?.kind).toBe("RET");
    expect(at(w, 0, 0)?.kind).toBe("R3");
  });

  it("DENS-005: density never splits a piece", async () => {
    const w = await tiers("terrace");
    const before = atomAt(w, 0, 0).pieces.length;
    paint(w, UP, 10, [[0, 0]]);
    expect(atomAt(w, 0, 0).pieces.length).toBe(before);
  });
});

describe("undo", () => {
  it("UNDO-001 / UNDO-002 / UNDO-003: strokes undo and redo as whole steps", async () => {
    const w = await grid().world();
    const h = new History();
    h.push(paint(w, R2, 30, [[0, 0]], true).step!);
    h.push(paint(w, COM, 30, [[200, 0]], true).step!);
    expect(at(w, 200, 0)?.kind).toBe("COM");
    h.undo();
    expect(at(w, 200, 0)?.kind).toBe(null);
    expect(at(w, 0, 0)?.kind).toBe("R2");
    h.redo();
    expect(at(w, 200, 0)?.kind).toBe("COM");
    h.undo();
    h.push(paint(w, R2, 30, [[-200, 0]], true).step!);
    expect(h.canRedo).toBe(false);
    h.undo();
    h.undo();
    expect(at(w, 0, 0)?.kind).toBe(null);
    expect(w.pieceAt(toI(-200), 0)?.kind).toBe(null);
  });
});

describe("feedback", () => {
  it("PAINT-009: entering protected land during a stroke rejects once", async () => {
    const s = grid();
    s.rect(-95, -95, 95, 95, { leisure: "park" });
    const w = await s.world();
    const { events } = paint(w, R2, 10, [[-200, 0], [0, 0], [0, 50], [0, -50]]);
    expect(events.filter((e) => e.type === "reject").length).toBe(1);
  });
});
