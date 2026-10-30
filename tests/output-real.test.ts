// §18 Output on real data: the bundled demo district and one replay square are loaded as the app loads them,
// edited as a mapper would (bench/output/edit.ts), written, checked as JOSM's validator would check them
// (bench/output/check.ts) and read back (bench/output/roundtrip.ts). `npm run outcheck` runs the same on more.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkChanges, formatProblems } from "../bench/output/check";
import { editWorld } from "../bench/output/edit";
import { roundTrip } from "../bench/output/roundtrip";
import { worldFromText } from "../src/model/load";
import { parseOsm } from "../src/osm/parse";
import { computeChanges, isEmptyChanges } from "../src/output/changes";
import { toJosmXml } from "../src/output/osmxml";

const fixtures = [
  { name: "demo-tallinn", text: () => readFileSync(new URL("../public/fixtures/demo-tallinn.json", import.meta.url), "utf8") },
  { name: "turku_4_0", text: () => gunzipSync(readFileSync(new URL("./fixtures/replay-turku_4_0.osm.gz", import.meta.url))).toString("utf8") },
];

describe.each(fixtures)("output on real data: $name", ({ text }) => {
  const load = async () => {
    const osm = text();
    const { world } = await worldFromText(osm);
    return { world, osm };
  };

  it("OUT-002 / IMP-008: the map as loaded writes nothing, although the lattice reshaped every outline", async () => {
    const { world } = await load();
    expect(world.source.importedKind.size).toBeGreaterThan(0);
    const c = computeChanges(world);
    expect(isEmptyChanges(c)).toBe(true);
    expect(c.modify.ways).toEqual([]);
    expect(c.create.nodes).toEqual([]);
    expect(c.delete.nodes).toEqual([]);
  });

  it("OUT-001 / OUT-003 / OUT-004 / OUT-010: a mapper's edits write sound elements: kept nodes as loaded, no street node taken, simple rings, nothing for untouched areas", async () => {
    const { world } = await load();
    const { edits, painted } = editWorld(world);
    expect(edits.filter((e) => e.what !== "untouched" && e.changed > 0).length).toBeGreaterThan(2);
    expect(edits.filter((e) => e.what === "untouched").length).toBeGreaterThan(0);
    const c = computeChanges(world);
    expect(isEmptyChanges(c)).toBe(false);
    const problems = checkChanges(world, c, painted);
    expect(formatProblems(problems)).toBe("");
    // OUT-001: every node a rewritten outline keeps is one that was loaded, at the position it had.
    for (const n of c.context) expect(world.source.nodes.get(n.id)).toEqual([n.lon, n.lat]);
    expect(c.context.length).toBeGreaterThan(0);
  });

  it("OUT-009: the counts are areas and buildings, never elements", async () => {
    const { world } = await load();
    editWorld(world);
    const c = computeChanges(world);
    const by = { changed: 0, added: 0, removed: 0 };
    for (const a of c.areas) by[a.what]++;
    expect(c.counts).toEqual({ ...by, buildings: 0 });
    const elements = c.create.nodes.length + c.create.ways.length + c.modify.ways.length;
    expect(elements).toBeGreaterThan(c.counts.changed + c.counts.added);
  });

  it("OUT-002 / OUT-004 / JOSM-003: the file read back and loaded again gives the land that was painted", async () => {
    const { world, osm } = await load();
    editWorld(world);
    const c = computeChanges(world);
    const xml = toJosmXml(c);
    expect(xml).toContain(`generator="Skyditor"`);
    expect(() => parseOsm(xml)).not.toThrow();
    const rt = roundTrip(world, parseOsm(osm), c);
    // What differs is the lattice's reading of gaps against the block edge (IMP-007), which is not written
    // (OUT-002) and can close towards another neighbour once the outlines around it changed.
    expect(rt.iou).toBeGreaterThan(0.98);
    for (const k of rt.byKind) if (k.painted_m2 > 1000) expect(k.overlap_m2 / k.painted_m2).toBeGreaterThan(0.9);
  });
}, 60_000);
