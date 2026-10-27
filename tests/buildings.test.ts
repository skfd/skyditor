import { describe, expect, it } from "vitest";
import { buildingLook, KINDS } from "../src/model/kinds";
import { worldFromText } from "../src/model/load";
import { buildingColor } from "../src/render/renderer";
import { Sketch } from "./helpers";

describe("building looks", () => {
  it("BLD-002: building types map to looks", () => {
    expect(buildingLook({ building: "farmhouse" })).toBe("R1");
    expect(buildingLook({ building: "house" })).toBe("R2");
    expect(buildingLook({ building: "semidetached_house" })).toBe("R3");
    expect(buildingLook({ building: "terrace" })).toBe("R4");
    expect(buildingLook({ building: "apartments" })).toBe("R5");
    expect(buildingLook({ building: "residential" })).toBe("RU");
    expect(buildingLook({ building: "office" })).toBe("COM");
    expect(buildingLook({ building: "supermarket" })).toBe("RET");
    expect(buildingLook({ building: "warehouse" })).toBe("IND");
    expect(buildingLook({ building: "school" })).toBe("CIVIC");
  });

  it("BLD-002: an explicit type wins over shops in the building", () => {
    expect(buildingLook({ building: "apartments", shop: "bakery" })).toBe("R5");
  });

  it("BLD-003: tall residential buildings look high-rise, by levels or by height", () => {
    expect(buildingLook({ building: "apartments", "building:levels": "8" })).toBe("R5");
    expect(buildingLook({ building: "apartments", "building:levels": "9" })).toBe("R6");
    expect(buildingLook({ building: "residential", "building:levels": "14;12" })).toBe("R6");
    expect(buildingLook({ building: "apartments", height: "30 m" })).toBe("R6");
    expect(buildingLook({ building: "apartments", height: "24" })).toBe("R5");
    expect(buildingLook({ building: "apartments", height: "100'" })).toBe("R5");
  });

  it("BLD-003: other looks keep their type whatever the height", () => {
    expect(buildingLook({ building: "house", "building:levels": "12" })).toBe("R2");
    expect(buildingLook({ building: "office", "building:levels": "30" })).toBe("COM");
    expect(buildingLook({ building: "yes", "building:levels": "30" })).toBeNull();
  });

  it("BLD-004: untyped buildings take a look from shop, office or civic amenity, in that order", () => {
    expect(buildingLook({ building: "yes", shop: "supermarket", office: "company" })).toBe("RET");
    expect(buildingLook({ building: "yes", office: "company" })).toBe("COM");
    expect(buildingLook({ building: "yes", amenity: "place_of_worship" })).toBe("CIVIC");
    expect(buildingLook({ building: "yes", amenity: "cafe" })).toBeNull();
  });

  it("BLD-005: untyped and accessory buildings stay unknown", () => {
    for (const b of ["yes", "roof", "garage", "garages", "shed", "carport", "greenhouse", "construction", "ruins"])
      expect(buildingLook({ building: b })).toBeNull();
  });

  it("BLD-001 / BLD-005: loaded buildings carry their look, never guessed from the land", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { landuse: "residential", residential: "single_family" });
    s.rect(-50, -50, -40, -40, { building: "house" });
    s.rect(10, 10, 20, 20, { building: "yes" });
    const { world } = await worldFromText(s.json());
    expect(world.features.buildings.map((b) => b.look).sort()).toEqual(["R2", null]);
  });

  it("BLD-006: building looks don't change the district mix", async () => {
    const mixWith = async (building: string) => {
      const s = new Sketch(300).grid(200);
      s.rect(-95, -95, 95, 95, { landuse: "residential" });
      s.rect(-50, -50, -40, -40, { building });
      return (await worldFromText(s.json())).world.mix();
    };
    expect(await mixWith("industrial")).toEqual(await mixWith("yes"));
  });

  it("REN-009: a building is its look's colour, a shade darker", () => {
    const shade = (c: string) => c.match(/\d+/g)!.map(Number);
    const base = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (const k of ["R2", "R5", "COM", "IND"] as const) {
      const b = base(KINDS[k].color);
      const s = shade(buildingColor(k));
      expect(s.reduce((x, y) => x + y)).toBeLessThan(b.reduce((x, y) => x + y));
    }
    expect(buildingColor("R2")).toBe("rgb(182,151,95)");
  });
});
