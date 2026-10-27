import { describe, expect, it } from "vitest";
import { Sketch, at, atomAt, kindsIn } from "./helpers";

describe("import", () => {
  it("KIND-005 / KIND-004: residential=* maps to tiers; no subtag is unspecified", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "residential", residential: "terrace" });
    s.rect(105, -95, 300, 95, { landuse: "residential", residential: "urban" });
    s.rect(-300, -95, -105, 95, { landuse: "residential" });
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("R4");
    expect(at(w, 200, 0)?.kind).toBe("R5");
    expect(at(w, -200, 0)?.kind).toBe("RU");
  });

  it("IMP-002 / IMP-003: parks become protected pieces; grass and parking are overlays only", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, { leisure: "park" });
    s.rect(10, -95, 95, 95, { landuse: "grass" });
    s.rect(-200, -60, -150, 60, { amenity: "parking" });
    const w = await s.world();
    expect(at(w, -50, 0)?.kind).toBe("CTX");
    expect(at(w, 50, 0)?.kind).toBe(null);
    expect(w.overlay.length).toBe(2);
  });

  it("IMP-004 / CORR-001: a feature drawn inside a bigger one wins the overlap, undisputed", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-300, -300, 300, 300, { landuse: "residential" });
    s.rect(-90, -90, 0, 0, { landuse: "retail" });
    const w = await s.world();
    expect(at(w, -50, -50)?.kind).toBe("RET");
    expect(at(w, 50, 50)?.kind).toBe("RU");
    expect(at(w, -200, -200)?.kind).toBe("RU");
    expect(w.disputed()).toEqual([]);
  });

  it("IMP-005 / IMP-008: one feature over several blocks becomes linked, unmodified pieces", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-300, -300, 300, 0, { landuse: "industrial" });
    const w = await s.world();
    const ps = w.atoms.flatMap((a) => a.pieces).filter((p) => p.kind === "IND");
    expect(ps.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ps.map((p) => p.source)).size).toBe(1);
    expect(ps.every((p) => !p.modified)).toBe(true);
  });

  it("IMP-006: polygons poking a metre past the centreline leave no fragment in the next block", async () => {
    const s = new Sketch(300).grid(200);
    // Drawn to 106 m: past the street centreline at 100 m, 1 m into the next block (which starts at 105 m).
    s.rect(-95, -95, 106, 95, { landuse: "commercial" });
    const w = await s.world();
    expect(kindsIn(w, 200, 0)).not.toContain("COM");
    expect(at(w, 0, 0)?.kind).toBe("COM");
  });

  it("IMP-007: landuse traced a few metres inside the kerb closes up to the block edge", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-91, -92, 92, 91, { landuse: "residential", residential: "detached" });
    const w = await s.world();
    const a = atomAt(w, 0, 0);
    expect(a.pieces.filter((p) => p.kind === null).reduce((t, p) => t + p.area, 0)).toBeLessThan(5);
    expect(at(w, -94, -94)?.kind).toBe("R2");
  });

  it("IMP-007: a wide void next to imported landuse stays void, corners included", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, { landuse: "commercial" });
    const w = await s.world();
    expect(at(w, 50, 0)?.kind).toBe(null);
    expect(at(w, 93, -93)?.kind).toBe(null);
    expect(at(w, 3, -93)?.kind).toBe(null);
  });

  it("LOAD-005: multipolygon relations with holes are assembled from split member ways", async () => {
    const s = new Sketch(300).grid(200);
    const a = s.way([[-95, -95], [95, -95], [95, 95]], {});
    const b = s.way([[95, 95], [-95, 95], [-95, -95]], {});
    const hole = s.area([[-40, -40], [40, -40], [40, 40], [-40, 40]], {});
    s.relation([{ way: a, role: "outer" }, { way: b, role: "outer" }, { way: hole, role: "inner" }], { landuse: "retail" });
    const w = await s.world();
    expect(at(w, -70, -70)?.kind).toBe("RET");
    expect(at(w, 0, 0)?.kind).toBe(null);
  });
});
