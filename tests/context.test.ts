import { describe, expect, it } from "vitest";
import { CTX_COLORS, type CtxClass, KINDS, classifyArea } from "../src/model/kinds";
import { Sketch, at } from "./helpers";

/** CIE76 colour difference, enough to tell colours apart by eye. */
function deltaE(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
    });
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const OWN: [Record<string, string>, CtxClass][] = [
  [{ leisure: "park" }, "park"],
  [{ landuse: "education" }, "education"],
  [{ landuse: "cemetery" }, "cemetery"],
  [{ landuse: "construction" }, "construction"],
];

describe("context colours", () => {
  it("REN-015: parks, school grounds, cemeteries and construction each have their own class", () => {
    for (const [tags, ctx] of OWN) expect(classifyArea(tags)).toMatchObject({ cls: "exclusive", ctx });
    expect(classifyArea({ landuse: "meadow" })).toMatchObject({ ctx: "green" });
    expect(classifyArea({ landuse: "religious" })).toMatchObject({ ctx: "civic" });
    expect(classifyArea({ landuse: "brownfield" })).toMatchObject({ ctx: "grey" });
  });

  it("REN-015: their colours stand clear of every other context class and kind", () => {
    // Context land is drawn by class, never in the generic "Other land" colour.
    const kinds = Object.values(KINDS).filter((k) => k.id !== "CTX");
    const others = [...Object.entries(CTX_COLORS), ...kinds.map((k) => [k.id, k.color] as const)];
    for (const [, ctx] of OWN)
      for (const [name, color] of others) {
        if (name === ctx) continue;
        expect(deltaE(CTX_COLORS[ctx], color), `${ctx} vs ${name}`).toBeGreaterThan(18);
      }
  });

  it("REN-015: imported context pieces keep their class", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, { leisure: "park" });
    s.rect(105, -95, 295, 95, { landuse: "education" });
    const w = await s.world();
    expect(at(w, 0, 0)).toMatchObject({ kind: "CTX", ctx: "park" });
    expect(at(w, 200, 0)).toMatchObject({ kind: "CTX", ctx: "education" });
  });
});
