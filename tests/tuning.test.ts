// REQUIREMENTS.md §16: the tuning table and its mirror src/tuning.ts must agree, row by row.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TUNE } from "../src/tuning";

/** The §16 rows, as TUNE-ID → value cell. */
const tableRows = (): Map<string, string> => {
  const text = readFileSync(new URL("../REQUIREMENTS.md", import.meta.url), "utf8");
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^\| (TUNE-[A-Z0-9-]+) \| (.*?) \|/gm)) out.set(m[1], m[2]);
  return out;
};

/** TUNE-POP-STAGGER → POP_STAGGER. */
const key = (id: string) => id.slice("TUNE-".length).replace(/-/g, "_");

// Keys compare without the decoration the table uses for OSM values (`_link` ↔ link).
const normKey = (k: string) => k.replace(/[`_]/g, "");

type Shape = number[] | [string, number][];

/** A table value cell as a comparable shape: the numbers in it, or the (key, number) pairs of a list. */
const parseCell = (cell: string): Shape => {
  const bare = cell
    .replace(/\s*\([^)]*\)\s*$/, "") // trailing unit, "(px)"
    .replace(/(\d) (\d{3})\b/g, "$1$2"); // "150 000"
  const parts = bare.split(/,\s*/);
  const pairs = parts.map((p) => /^(\S+)\s+(-?\d+(?:\.\d+)?)$/.exec(p));
  if (parts.length > 1 && pairs.every(Boolean)) {
    return pairs.map((m): [string, number] => [normKey(m![1]), Number(m![2])]);
  }
  return (bare.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
};

/** A TUNE entry in the same shape. */
const shapeOf = (v: unknown): Shape => {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v as number[];
  return Object.entries(v as Record<string, number>).map(([k, n]): [string, number] => [normKey(k), n]);
};

describe("§16 tuning table", () => {
  const table = tableRows();

  it("has one row per TUNE entry and one TUNE entry per row", () => {
    expect(table.size).toBeGreaterThan(0);
    expect([...table.keys()].map(key).sort()).toEqual(Object.keys(TUNE).sort());
  });

  for (const [id, cell] of table) {
    it(`${id} is ${cell}`, () => {
      expect(shapeOf((TUNE as Record<string, unknown>)[key(id)])).toEqual(parseCell(cell));
    });
  }
});
