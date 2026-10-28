// Strokes as a whole: what one gesture may change, and what it must leave intact.
import { describe, expect, it } from "vitest";
import { area, contains, difference, rect, ringFromMeters, toI, union } from "../src/geo/clip";
import { History } from "../src/model/history";
import { Stroke } from "../src/paint/stroke";
import { type Tool, applyRegion, strokeShape } from "../src/paint/snap";
import { Sketch, at, atomAt, paint } from "./helpers";

const R1: Tool = { type: "paint", kind: "R1" };
const R2: Tool = { type: "paint", kind: "R2" };
const R4: Tool = { type: "paint", kind: "R4" };
const COM: Tool = { type: "paint", kind: "COM" };
const UP: Tool = { type: "density", dir: 1 };
const ERASE: Tool = { type: "erase" };
const grid = () => new Sketch(300).grid(200);

describe("one stroke", () => {
  it("PAINT-005: a stroke across three blocks undoes as one step", async () => {
    const w = await grid().world();
    const h = new History();
    const { step } = paint(w, R2, 10, [[-250, 0], [250, 0]]);
    expect(step!.atoms).toHaveLength(3);
    for (const x of [-200, 0, 200]) expect(at(w, x, 0)?.kind).toBe("R2");
    h.push(step!);
    h.undo();
    for (const x of [-200, 0, 200]) expect(at(w, x, 0)?.kind).toBe(null);
  });

  it("SNAP-002: a unit piece's coverage only grows while the brush crosses it", async () => {
    const w = await grid().world();
    const block = at(w, 0, 0)!;
    const s = new Stroke(w, R2, 30, -80, -80);
    s.start();
    const counts = [s.coverage.get(block)!.count];
    for (let i = 1; i <= 16; i++) {
      // Until the block is claimed (SNAP-003), which ends its charge.
      if (s.move(-80 + 10 * i, -80 + 10 * i).some((e) => e.type === "claim")) break;
      counts.push(s.coverage.get(block)!.count);
    }
    expect(counts.length).toBeGreaterThan(3);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
  });

  it("SNAP-101: the stroke shape is the land the brush passed over, with thin notches smoothed away", () => {
    const run = (y: number) => ringFromMeters([[-50, y], [50, y]]);
    // Two passes 10 m wide: the slit between them is 5 m, much narrower than the brush, and closes.
    const closed = strokeShape([run(0), run(25)], 10);
    expect(contains(closed, toI(0), toI(0))).toBe(true);
    expect(contains(closed, toI(0), toI(12.5))).toBe(true);
    // A 12 m slit is a real gap and stays.
    const open = strokeShape([run(0), run(32)], 10);
    expect(contains(open, toI(0), toI(0))).toBe(true);
    expect(contains(open, toI(0), toI(16))).toBe(false);
  });

  it("SNAP-102: paint touches only the open pieces under it; context and other blocks stay as they were", async () => {
    const s = grid();
    s.rect(-90, -90, -30, -30, { leisure: "park" });
    const w = await s.world();
    const park = at(w, -60, -60)!;
    expect(park.kind).toBe("CTX");
    const centre = atomAt(w, 0, 0);
    const others = w.atoms.filter((a) => a !== centre).map((a) => a.pieces);
    paint(w, R2, 10, [[-80, -60], [80, -60]]);
    expect(at(w, -60, -60)).toBe(park);
    expect(at(w, -20, -60)?.kind).toBe("R2");
    expect(at(w, 50, -60)?.kind).toBe("R2");
    w.atoms.filter((a) => a !== centre).forEach((a, i) => expect(a.pieces).toBe(others[i]));
  });

  it("SNAP-107: a sliver the result leaves behind is merged into it; a real leftover is not", async () => {
    const w = await grid().world();
    const block = atomAt(w, 0, 0);
    const notch = (side: number) =>
      rect({ minX: toI(95 - side), minY: toI(95 - side), maxX: toI(95), maxY: toI(95) });
    const apply = (side: number) => {
      const region = difference(block.shape, notch(side));
      block.pieces = applyRegion(block, { region, eligible: block.shape }, "R2").pieces;
    };
    apply(6); // 36 m², below the sliver limit
    expect(at(w, 92, 92)?.kind).toBe("R2");
    expect(block.pieces).toHaveLength(1);
    const w2 = await grid().world();
    const block2 = atomAt(w2, 0, 0);
    block2.pieces = applyRegion(block2, { region: difference(block2.shape, notch(8)), eligible: block2.shape }, "R2").pieces;
    expect(at(w2, 92, 92)?.kind).toBe(null); // 64 m²: a corner the user left unpainted
  });
});

describe("the lattice under many strokes", () => {
  it("GEN-004: pieces keep tiling every block exactly, with no cracks and no overlaps", async () => {
    const w = await grid().world();
    const h = new History();
    const push = (r: ReturnType<typeof paint>) => r.step && h.push(r.step);
    push(paint(w, R2, 10, [[-80, -60], [80, -60]]));
    push(paint(w, COM, 10, [[20, -90], [20, 90]]));
    push(paint(w, R4, 30, [[200, 0]], true));
    push(paint(w, R1, 8, [[-35, -60], [-35, 60], [35, 60], [35, -60]]));
    push(paint(w, ERASE, 10, [[-60, 60], [60, -60]]));
    push(paint(w, R2, 12, [[-250, -200], [250, -200]])); // across three blocks
    push(paint(w, UP, 30, [[200, 0]], true));
    push(paint(w, COM, 10, [[0, -250], [0, 250]])); // down the middle column
    push(paint(w, R2, 30, [[0, 60], [0, 90]]));
    h.undo();
    h.redo();
    h.undo();
    push(paint(w, ERASE, 30, [[200, 0]], true));
    expect(Object.keys(w.mix()).length).toBeGreaterThan(3); // the strokes did leave a mixed map behind
    for (const a of w.atoms) {
      const sum = a.pieces.reduce((t, p) => t + p.area, 0);
      const covered = area(union(...a.pieces.map((p) => p.shape)));
      expect(Math.abs(sum - a.area) / a.area, `block ${a.id}: pieces sum to its area`).toBeLessThan(1e-4);
      expect(Math.abs(covered - a.area) / a.area, `block ${a.id}: pieces cover it`).toBeLessThan(1e-4);
    }
  });
});
