import { describe, expect, it } from "vitest";
import { Sketch, atomAt } from "./helpers";

describe("lattice", () => {
  it("LAT-001 / LAT-003 / LAT-005: a street grid splits the area into blocks inset by street half-widths", async () => {
    const w = await new Sketch(300).grid(200).world();
    expect(w.atoms.length).toBe(9);
    // Centre block: 200 m between centrelines, minus 5 m half-width on each side.
    expect(atomAt(w, 0, 0).area).toBeCloseTo(190 * 190, -2);
  });

  it("LAT-001: footways and service roads are not barriers", async () => {
    const s = new Sketch(300).grid(200);
    s.road([[-50, -100], [-50, 100]], "footway");
    s.road([[50, -100], [50, 100]], "service");
    expect((await s.world()).atoms.length).toBe(9);
  });

  it("LAT-002: tunnels and covered ways do not split land", async () => {
    const s = new Sketch(300).grid(200);
    s.road([[0, -100], [0, 100]], "primary", { tunnel: "yes" });
    s.road([[-100, 0], [100, 0]], "secondary", { covered: "yes" });
    expect((await s.world()).atoms.length).toBe(9);
  });

  it("LAT-007: a dead end makes a notch, not a split", async () => {
    const s = new Sketch(300).grid(200);
    s.road([[0, -100], [0, 40]]);
    const w = await s.world();
    expect(w.atoms.length).toBe(9);
    expect(atomAt(w, -50, 0).area).toBeLessThan(190 * 190 - 100 * 10 + 1);
  });

  it("LAT-006: slivers between parallel carriageways are discarded", async () => {
    const s = new Sketch(300);
    s.road([[-320, 0], [320, 0]], "primary"); // half-width 9
    s.road([[-320, 20], [320, 20]], "primary"); // leaves a 2 m strip
    const w = await s.world();
    expect(w.atoms.length).toBe(2);
  });

  it("LAT-008: water is not land", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-40, -40, 40, 40, { natural: "water" });
    const w = await s.world();
    expect(atomAt(w, -80, -80).area).toBeCloseTo(190 * 190 - 80 * 80, -2);
    expect(w.atomAt(0, 0)).toBeNull();
  });

  it("LAT-004: a pedestrian square is street space, not land", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-20, -20, 20, 20, { highway: "pedestrian", area: "yes" });
    const w = await s.world();
    expect(w.atoms.length).toBe(9);
    expect(w.atomAt(0, 0)).toBeNull();
    expect(atomAt(w, -80, -80).area).toBeCloseTo(190 * 190 - 40 * 40, -2);
  });

  it("LAT-003: width=* overrides the class half-width", async () => {
    const s = new Sketch(300);
    s.road([[-320, 0], [320, 0]], "residential", { width: "30" });
    const w = await s.world();
    expect(w.totalLand).toBeCloseTo(600 * 600 - 600 * 30, -2);
  });
});
