import { describe, expect, it } from "vitest";
import { KINDS, TIERS, classifyArea } from "../src/model/kinds";
import { TUNE } from "../src/tuning";
import { deltaE } from "./helpers";

describe("the residential ladder", () => {
  it("KIND-003: each tier is a step up in height and a distinct colour on the ramp", () => {
    for (let i = 1; i < TIERS.length; i++) {
      const lo = KINDS[TIERS[i - 1]], hi = KINDS[TIERS[i]];
      expect(hi.lift, `${hi.id} above ${lo.id}`).toBeGreaterThan(lo.lift);
      expect(hi.tier).toBe(lo.tier! + 1);
      expect(deltaE(lo.color, hi.color), `${lo.id} vs ${hi.id}`).toBeGreaterThan(5);
    }
  });

  it("KIND-006: commercial, retail and industrial share one height and stand clear of the ramp", () => {
    for (const id of ["COM", "RET", "IND"] as const) {
      expect(KINDS[id].lift).toBe(TUNE.LIFT_NONRES);
      for (const t of TIERS) expect(deltaE(KINDS[id].color, KINDS[t].color), `${id} vs ${t}`).toBeGreaterThan(12);
    }
  });
});

describe("reading area features", () => {
  it("IMP-001: every area feature gets exactly one class, or is ignored", () => {
    expect(classifyArea({ landuse: "residential" })).toEqual({ cls: "paintable", kind: "RU" });
    expect(classifyArea({ landuse: "residential", residential: "terrace" })).toEqual({ cls: "paintable", kind: "R4" });
    expect(classifyArea({ landuse: "retail" })).toEqual({ cls: "paintable", kind: "RET" });
    expect(classifyArea({ leisure: "park" })).toMatchObject({ cls: "exclusive" });
    expect(classifyArea({ landuse: "grass" })).toMatchObject({ cls: "overlay" });
    expect(classifyArea({ natural: "water" })).toEqual({ cls: "water" });
    // Not landuse: buildings, shops, and tags the editor has never heard of.
    expect(classifyArea({ building: "yes" })).toBeNull();
    expect(classifyArea({ shop: "bakery" })).toBeNull();
    expect(classifyArea({ landuse: "made_up" })).toBeNull();
    // One class even when the tags argue (Q-007): the paintable landuse wins, quietly.
    expect(classifyArea({ landuse: "residential", leisure: "park" })).toEqual({ cls: "paintable", kind: "RU" });
  });
});
