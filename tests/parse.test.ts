import { describe, expect, it } from "vitest";
import { assembleRings, barrierClass, halfWidth, tagWidth } from "../src/osm/features";
import { parseOsm } from "../src/osm/parse";
import { worldFromText } from "../src/model/load";
import { Sketch } from "./helpers";

describe("reading OSM", () => {
  it("LOAD-004: OSM XML and Overpass JSON of the same data give the same world", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "residential", residential: "terrace", name: "A & B" });
    const a = (await worldFromText(s.json())).world;
    const b = (await worldFromText(s.xml())).world;
    expect(b.atoms.length).toBe(a.atoms.length);
    expect(b.mix()).toEqual(a.mix());
    expect(parseOsm(s.xml()).ways.size).toBe(parseOsm(s.json()).ways.size);
  });

  it("LOAD-005: rings assemble from ways in any direction and order", () => {
    const { rings, open } = assembleRings([[1, 2, 3], [5, 4, 3], [5, 6, 1]]);
    expect(open).toBe(0);
    expect(rings.length).toBe(1);
    expect(rings[0].length).toBe(7);
  });

  it("LOAD-006: unclosable rings are skipped and counted", async () => {
    const { rings, open } = assembleRings([[1, 2, 3], [7, 8, 9]]);
    expect(rings.length).toBe(0);
    expect(open).toBe(2);
    const s = new Sketch(300).grid(200);
    const w1 = s.way([[-95, -95], [95, -95], [95, 95]], {});
    s.relation([{ way: w1, role: "outer" }], { landuse: "retail" });
    const { report } = await worldFromText(s.json());
    expect(report.skippedRings).toBe(1);
  });

  it("LAT-001 / LAT-002: barrier classes", () => {
    expect(barrierClass({ highway: "residential" })).toBe("residential");
    expect(barrierClass({ highway: "primary_link" })).toBe("link");
    expect(barrierClass({ highway: "footway" })).toBeNull();
    expect(barrierClass({ highway: "service" })).toBeNull();
    expect(barrierClass({ railway: "rail" })).toBe("rail");
    expect(barrierClass({ railway: "tram" })).toBeNull();
    expect(barrierClass({ waterway: "river" })).toBe("river");
    expect(barrierClass({ highway: "primary", tunnel: "yes" })).toBeNull();
    expect(barrierClass({ highway: "primary", tunnel: "no" })).toBe("primary");
    expect(barrierClass({ highway: "pedestrian", area: "yes" })).toBeNull();
    expect(tagWidth({ width: "12 m" })).toBe(12);
    expect(tagWidth({ width: "wide" })).toBeNull();
    expect(halfWidth("residential", 12, "kerb")).toBe(6);
    expect(halfWidth("residential", null, "kerb")).toBe(5);
  });
});
