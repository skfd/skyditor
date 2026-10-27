import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { worldFromText } from "../src/model/load";

const text = readFileSync(new URL("../public/fixtures/demo-tallinn.json", import.meta.url), "utf8");

describe("demo fixture", () => {
  it("LOAD-001 / LAT-005: the bundled demo area loads into a lattice with existing landuse", async () => {
    const { world, report } = await worldFromText(text);
    console.log(report, world.mix());
    expect(report.atoms).toBeGreaterThan(30);
    expect(report.pieces).toBeGreaterThan(0);
    const mix = world.mix();
    expect(mix.RU ?? 0).toBeGreaterThan(0);
    // OVL-001: pieces cover each atom exactly.
    for (const a of world.atoms) {
      const sum = a.pieces.reduce((s, p) => s + p.area, 0);
      expect(Math.abs(sum - a.area) / a.area).toBeLessThan(0.01);
    }
  }, 60_000);
});
