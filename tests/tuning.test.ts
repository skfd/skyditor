// REQUIREMENTS.md §16: every knob the spec names exists in src/tuning.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TUNE } from "../src/tuning";

/** TUNE-POP-STAGGER → POP_STAGGER. */
const key = (id: string) => id.slice("TUNE-".length).replace(/-/g, "_");

describe("§16 tuning knobs", () => {
  // Retired requirements (struck through) may name knobs that are gone.
  const text = readFileSync(new URL("../REQUIREMENTS.md", import.meta.url), "utf8").replace(/~~[\s\S]*?~~/g, "");
  // "TUNE-POP-*" names every knob with that prefix.
  const named = [...new Set(text.match(/TUNE-[A-Z0-9-]+\*?/g) ?? [])].sort();
  const keys = Object.keys(TUNE);

  it("names at least one knob", () => expect(named.length).toBeGreaterThan(0));

  for (const id of named) {
    it(`${id} exists in src/tuning.ts`, () => {
      if (id.endsWith("-*")) expect(keys.some((k) => k.startsWith(key(id.slice(0, -1))))).toBe(true);
      else expect(keys).toContain(key(id));
    });
  }
});
