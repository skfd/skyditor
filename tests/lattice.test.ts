import { describe, expect, it } from "vitest";
import { toI } from "../src/geo/clip";
import { TUNE } from "../src/tuning";
import { Sketch, atomAt } from "./helpers";

const BLOCK = 200 - 2 * TUNE.HALFWIDTH_PROPERTY.residential; // side of a grid(200) block

describe("lattice", () => {
  it("LAT-001 / LAT-003 / LAT-005: a street grid splits the area into blocks inset to the property line", async () => {
    const w = await new Sketch(300).grid(200).world();
    expect(w.atoms.length).toBe(9);
    // Centre block: 200 m between centrelines, minus the residential property-line half-width on each side.
    const hw = TUNE.HALFWIDTH_PROPERTY.residential;
    expect(atomAt(w, 0, 0).area).toBeCloseTo((200 - 2 * hw) ** 2, -2);
  });

  it("LAT-001: footways and service roads are not barriers", async () => {
    const s = new Sketch(300).grid(200);
    s.road([[-50, -100], [-50, 100]], "footway");
    s.road([[50, -100], [50, 100]], "service");
    expect((await s.world()).atoms.length).toBe(9);
  });

  it("LAT-001: a private street is not a barrier, but still divides cells", async () => {
    const s = new Sketch(300).grid(200);
    s.road([[0, -100], [0, 100]], "residential", { access: "private" });
    s.road([[-200, -100], [-200, 100]], "living_street", { access: "private" });
    s.road([[200, -100], [200, 100]], "living_street");
    const w = await s.world();
    expect(w.atoms.length).toBe(10);
    expect(atomAt(w, -10, 0)).toBe(atomAt(w, 10, 0));
    expect(atomAt(w, -210, 0)).toBe(atomAt(w, -190, 0));
    expect(w.cellsOf(atomAt(w, 0, 0)).length).toBe(2); // SNAP-108
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
    expect(atomAt(w, -80, -80).area).toBeCloseTo(BLOCK ** 2 - 80 * 80, -2);
    expect(w.atomAt(0, 0)).toBeNull();
  });

  it("LAT-004: a pedestrian square is street space, not land", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-20, -20, 20, 20, { highway: "pedestrian", area: "yes" });
    const w = await s.world();
    expect(w.atoms.length).toBe(9);
    expect(w.atomAt(0, 0)).toBeNull();
    expect(atomAt(w, -80, -80).area).toBeCloseTo(BLOCK ** 2 - 40 * 40, -2);
  });

  it("LAT-003: a tagged width widens street space to half of it plus a verge, and never narrows it", async () => {
    const s = new Sketch(300);
    s.road([[-320, -100], [320, -100]], "residential", { width: "30" });
    s.road([[-320, 100], [320, 100]], "residential", { width: "4" });
    const w = await s.world();
    const wide = 2 * (15 + TUNE.WIDTH_VERGE), narrow = 2 * TUNE.HALFWIDTH_PROPERTY.residential;
    expect(w.totalLand).toBeCloseTo(600 * 600 - 600 * (wide + narrow), -2);
  });

  // A street along y = 0 with a sidewalk 8 m south of it, and residential landuse whose edge sits `edge` m south.
  const sidewalked = (edge: number, sidewalk = 8) => {
    const s = new Sketch(300);
    s.road([[-320, 0], [320, 0]], "residential");
    s.road([[-320, sidewalk], [320, sidewalk]], "footway", { footway: "sidewalk" });
    s.rect(-320, edge, 320, 200, { landuse: "residential" });
    return s;
  };

  it("LAT-003: street space reaches past a sidewalk mapped along the street", async () => {
    const w = await sidewalked(10).world();
    expect(w.features.style).toBe("property_line");
    // The land south of the street starts TUNE-SIDEWALK-MARGIN past the sidewalk, not at the class width.
    expect(w.atomAt(0, toI(8 + TUNE.SIDEWALK_MARGIN - 0.3))).toBeNull();
    expect(w.atomAt(0, toI(8 + TUNE.SIDEWALK_MARGIN + 0.3))).not.toBeNull();
    // North of the street, with no sidewalk, the class width holds.
    expect(w.atomAt(0, toI(-TUNE.HALFWIDTH_PROPERTY.residential - 0.3))).not.toBeNull();
  });

  it("LAT-003: street space past the kerb stops at a building's wall", async () => {
    const s = new Sketch(300);
    s.road([[-320, 0], [320, 0]], "residential");
    const front = TUNE.HALFWIDTH.residential + 0.5; // between the kerb and the property line
    s.rect(-10, front, 10, front + 12, { building: "yes" });
    const w = await s.world();
    expect(w.atomAt(0, toI(front + 0.2))).not.toBeNull();
    expect(w.atomAt(toI(20), toI(front + 0.2))).toBeNull();
  });

  it("LAT-003: a sidewalk that runs along no street is not street space", async () => {
    const s = new Sketch(300).grid(200);
    s.road([[-60, -80], [60, -80]], "footway", { footway: "sidewalk" });
    const w = await s.world();
    expect(w.atoms.length).toBe(9);
    expect(atomAt(w, 0, 0).area).toBeCloseTo(BLOCK ** 2, -2);
  });

  it("LAT-009: where the existing landuse keeps its sidewalks inside, street space stops at the kerb", async () => {
    const w = await sidewalked(4).world();
    expect(w.features.style).toBe("kerb");
    expect(w.atomAt(0, toI(TUNE.HALFWIDTH.residential + 0.3))).not.toBeNull();
    expect(w.atomAt(0, toI(-TUNE.HALFWIDTH.residential - 0.3))).not.toBeNull();
  });

  it("LAT-009: too little sidewalk along landuse edges says nothing, so street space goes to the property line", async () => {
    const s = new Sketch(300);
    s.road([[-320, 0], [320, 0]], "residential");
    s.road([[0, 8], [TUNE.STYLE_EVIDENCE / 2, 8]], "footway", { footway: "sidewalk" });
    s.rect(-320, 4, 320, 200, { landuse: "residential" });
    const w = await s.world();
    expect(w.features.style).toBe("property_line");
  });
});
