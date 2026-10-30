import { describe, expect, it } from "vitest";
import { rect, toI, union } from "../src/geo/clip";
import { applyCapture, planCapture } from "../src/model/capture";
import { isProtected } from "../src/model/world";
import { type Changes, computeChanges, isEmptyChanges, retag } from "../src/output/changes";
import { toJosmXml } from "../src/output/osmxml";
import { type Tool, applyRegion } from "../src/paint/snap";
import { answerWhole } from "../src/paint/stroke";
import { Sketch, at, atomAt, paint } from "./helpers";

const R2 = { landuse: "residential", residential: "single_family", name: "Pine Hill" };
const COM: Tool = { type: "paint", kind: "COM" };
const UP: Tool = { type: "density", dir: 1 };
type World = Awaited<ReturnType<Sketch["world"]>>;

const box = (x0: number, y0: number, x1: number, y1: number) => rect({ minX: toI(x0), minY: toI(y0), maxX: toI(x1), maxY: toI(y1) });

/** Paints an exact rectangle of `kind` (or erases, null) in the block holding (x, y), as a snapped stroke would. */
function fill(w: World, kind: "R2" | "COM" | "R5" | null, x0: number, y0: number, x1: number, y1: number) {
  const block = atomAt(w, (x0 + x1) / 2, (y0 + y1) / 2);
  const eligible = union(...block.pieces.filter((p) => !isProtected(p)).map((p) => p.shape)); // PAINT-004
  block.pieces = applyRegion(block, { region: box(x0, y0, x1, y1), eligible }, kind).pieces;
}

/** Nine blocks, roads every 200 m; one R2 area filling the centre block, drawn 2 m into the street. */
function centre(tags: Record<string, string> = R2) {
  const s = new Sketch(300).grid(200);
  const way = s.rect(-95, -95, 95, 95, tags);
  return { s, way };
}

const wayNodes = (c: Changes, id: number) => [...c.modify.ways, ...c.create.ways].find((w) => w.id === id)!.nodes;
const nodeOf = (c: Changes, w: World, id: number) => {
  if (id > 0) return w.source.nodes.get(id)!;
  const n = c.create.nodes.find((n) => n.id === id)!;
  return [n.lon, n.lat] as [number, number];
};
/** A node's position in local metres, rounded to a decimetre. */
const metres = (c: Changes, w: World, id: number) => {
  const [lon, lat] = nodeOf(c, w, id);
  const p = w.features.proj;
  return [Math.round(p.x(lon) * 10) / 10, Math.round(p.y(lat) * 10) / 10];
};

describe("what is written", () => {
  it("OUT-002 / IMP-008: an untouched map writes nothing, although the lattice reshaped every area", async () => {
    const { s } = centre();
    s.rect(105, -95, 295, 95, { landuse: "commercial" });
    const w = await s.world();
    const c = computeChanges(w);
    expect(isEmptyChanges(c)).toBe(true);
    expect(c.modify.ways).toEqual([]);
    expect(c.create.nodes).toEqual([]);
  });

  it("OUT-004: painted land with no element becomes one new closed way with the kind's tags", async () => {
    const w = await new Sketch(300).grid(200).world();
    fill(w, "R2", -100, -100, 100, 100);
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 0, added: 1, removed: 0, buildings: 0 });
    const way = c.create.ways[0];
    expect(way.tags).toEqual({ landuse: "residential", residential: "single_family" });
    expect(way.nodes[0]).toBe(way.nodes[way.nodes.length - 1]);
    expect(way.nodes.every((n) => n < 0)).toBe(true);
    expect(c.create.nodes.length).toBe(way.nodes.length - 1);
    // The way stops at the block's edge: inside the street space.
    for (const n of way.nodes) {
      const [x, y] = metres(c, w, n);
      expect(Math.abs(x)).toBeLessThan(100);
      expect(Math.abs(y)).toBeLessThan(100);
    }
  });

  it("OUT-002 / OUT-003: paint over part of an area shrinks its way, keeping the nodes it still runs through, and the new area shares the cut's nodes", async () => {
    const { s, way } = centre();
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100);
    expect(at(w, 50, 0)?.kind).toBe("COM");
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 1, added: 1, removed: 0, buildings: 0 });
    const r2 = c.modify.ways.find((x) => x.id === way)!;
    expect(r2.tags).toEqual(R2);
    const nodes = wayNodes(c, way);
    // Its west corners are the original nodes, drawn 2 m into the street; the cut is new, at x = 20.
    const west = w.source.ways.get(way)!.nodes.filter((n) => w.features.proj.x(w.source.nodes.get(n)![0]) < 0);
    for (const n of new Set(west)) expect(nodes).toContain(n);
    const cut = nodes.filter((n) => n < 0);
    expect(cut.length).toBe(2);
    for (const n of cut) {
      const [x, y] = metres(c, w, n);
      expect(x).toBeCloseTo(20, 0);
      expect(Math.abs(y)).toBeCloseTo(95, 0); // the cut reaches out through the overhang, to the outline (OUT-002)
    }
    // The commercial way shares them (OUT-003) and takes the street space the old area gave up, so it reaches the
    // old area's east corners too, which are its nodes now rather than deleted ones.
    const com = c.create.ways[0];
    expect(com.tags).toEqual({ landuse: "commercial" });
    for (const n of cut) expect(com.nodes).toContain(n);
    const east = w.source.ways.get(way)!.nodes.filter((n) => w.features.proj.x(w.source.nodes.get(n)![0]) > 0);
    for (const n of new Set(east)) expect(com.nodes).toContain(n);
    expect(c.delete.nodes).toEqual([]);
    expect(r2.nodes.length).toBe(5);
    expect(com.nodes.length).toBe(5);
    expect(c.create.nodes.length).toBe(2);
  });

  it("OUT-004 / OUT-006: erasing all of an area deletes its way and its nodes", async () => {
    const { s, way } = centre();
    const w = await s.world();
    fill(w, null, -100, -100, 100, 100);
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 0, added: 0, removed: 1, buildings: 0 });
    expect(c.delete.ways.map((x) => x.id)).toEqual([way]);
    expect(c.delete.nodes.length).toBe(4);
    expect(c.modify.ways).toEqual([]);
  });

  it("OUT-004: a node another way still uses is kept when its area is deleted", async () => {
    const s = new Sketch(300).grid(200);
    const way = s.rect(-95, -95, 95, 95, R2);
    s.way([[-95, -95], [-95, 95]], { barrier: "fence" }); // shares the west nodes
    const w = await s.world();
    fill(w, null, -100, -100, 100, 100);
    const c = computeChanges(w);
    expect(c.delete.ways.map((x) => x.id)).toEqual([way]);
    expect(c.delete.nodes.length).toBe(2);
  });

  it("OUT-005: a density step on a whole area writes tags only, every other tag kept", async () => {
    const { s, way } = centre();
    const w = await s.world();
    paint(w, UP, 5, [[0, -2], [0, 2]]); // NAME-004: the named area moves whole
    expect(at(w, 0, 0)?.kind).toBe("R3");
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 1, added: 0, removed: 0, buildings: 0 });
    const m = c.modify.ways[0];
    expect(m.id).toBe(way);
    expect(m.tags).toEqual({ landuse: "residential", residential: "duplex", name: "Pine Hill" });
    expect(m.nodes).toEqual(w.source.ways.get(way)!.nodes);
    expect(c.create.nodes).toEqual([]);
    expect(c.delete.nodes).toEqual([]);
  });

  it("OUT-005 / Q-011: mixed writes landuse=residential alone; business kinds drop residential=*", () => {
    expect(retag({ landuse: "residential", residential: "terrace", name: "X" }, "RM")).toEqual({ landuse: "residential", name: "X" });
    expect(retag({ landuse: "residential", residential: "terrace" }, "COM")).toEqual({ landuse: "commercial" });
    expect(retag({ landuse: "retail", note: "n" }, "R6")).toEqual({ landuse: "residential", residential: "apartments", note: "n" });
  });

  it("OUT-005 / Q-011: a mixed answer on unspecified land writes nothing, since it says the same; a tier on it writes the tier", async () => {
    const { s, way } = centre({ landuse: "residential", name: "Pine Hill" });
    const w = await s.world();
    answerWhole(w, `way/${way}`, "RM");
    expect(at(w, 0, 0)?.kind).toBe("RM");
    expect(isEmptyChanges(computeChanges(w))).toBe(true);
    answerWhole(w, `way/${way}`, "R4");
    const c = computeChanges(w);
    expect(c.counts.changed).toBe(1);
    expect(c.modify.ways[0].tags).toEqual({ landuse: "residential", residential: "terrace", name: "Pine Hill" });
  });

  it("OUT-005 / TYPE-011: a typed building writes its building tag, nodes untouched", async () => {
    const s = new Sketch(300).grid(200);
    const house = s.rect(-20, -20, 20, 20, { building: "yes", "addr:housenumber": "7" });
    const w = await s.world();
    paint(w, { type: "paint", kind: "R2" }, 5, [[0, 0]], true); // not on buildings: nothing typed
    expect(computeChanges(w).counts.buildings).toBe(0);
    const set = w.setOf(w.buildingsIn({ minX: toI(-1), minY: toI(-1), maxX: toI(1), maxY: toI(1) })[0]);
    const b = set.items[0];
    set.items = [{ ...b, tags: { ...b.tags, building: "house" }, look: "R2", modified: true }];
    const c = computeChanges(w);
    expect(c.counts.buildings).toBe(1);
    const m = c.modify.ways.find((x) => x.id === house)!;
    expect(m.tags).toEqual({ building: "house", "addr:housenumber": "7" });
    expect(m.nodes).toEqual(w.source.ways.get(house)!.nodes);
  });

  it("OUT-006 / CAP-005: a captured area is deleted and the source's outline takes its land", async () => {
    const s = new Sketch(300).grid(200);
    const west = s.rect(-95, -95, -5, 95, R2);
    const east = s.rect(5, -95, 95, 95, { landuse: "residential", residential: "single_family" });
    const w = await s.world();
    const plan = planCapture(w, at(w, -50, 0)!, at(w, 50, 0)!);
    expect(plan).not.toBeNull();
    applyCapture(w, plan!);
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 1, added: 0, removed: 1, buildings: 0 });
    expect(c.delete.ways.map((x) => x.id)).toEqual([east]);
    const m = c.modify.ways.find((x) => x.id === west)!;
    expect(m.tags.name).toBe("Pine Hill");
    const xs = m.nodes.map((n) => metres(c, w, n)[0]);
    expect(Math.max(...xs)).toBeGreaterThan(90); // reaches the east side now
  });

  it("OUT-007 / DISP-004: a settled dispute takes the disputed part out of the rival's outline", async () => {
    const s = new Sketch(300).grid(200);
    const park = s.rect(-95, -95, 20, 95, { leisure: "park" });
    const res = s.rect(-30, -95, 95, 95, R2);
    const w = await s.world();
    expect(at(w, 0, 0)?.kind).toBe("CTX");
    expect(at(w, 0, 0)?.rival?.source).toBe(`way/${res}`);
    expect(isEmptyChanges(computeChanges(w))).toBe(true);
    paint(w, COM, 5, [[0, 0]], true); // DISP-004: a tap settles for the park
    expect(at(w, 0, 0)?.rival).toBeUndefined();
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 1, added: 0, removed: 0, buildings: 0 });
    const m = c.modify.ways.find((x) => x.id === res)!;
    const xs = m.nodes.map((n) => metres(c, w, n)[0]);
    expect(Math.min(...xs)).toBeCloseTo(20, 0);
    expect(c.modify.ways.find((x) => x.id === park)).toBeUndefined();
  });

  it("OUT-004: a hole makes a multipolygon; a multipolygon's single-way ring is rewritten in place", async () => {
    const s = new Sketch(300).grid(200);
    const outer = s.rect(-95, -95, 95, 95, {});
    const inner = s.rect(-30, -30, 30, 30, {});
    s.relation([{ way: outer, role: "outer" }, { way: inner, role: "inner" }], { landuse: "residential", residential: "rural" });
    s.rect(-30, -30, 30, 30, { leisure: "park" }); // the hole holds a park, so the lattice has a piece there
    const w = await s.world();
    expect(at(w, 60, 60)?.kind).toBe("R1");
    expect(isEmptyChanges(computeChanges(w))).toBe(true);
    fill(w, "COM", 40, -100, 100, 100);
    const c = computeChanges(w);
    expect(c.counts.changed).toBe(1);
    expect(c.modify.ways.map((x) => x.id)).toEqual([outer]);
    expect(c.modify.relations.length).toBe(0); // same members, same tags
    expect(c.create.ways.length).toBe(1);
    expect(c.create.ways[0].tags.landuse).toBe("commercial");
  });

  it("OUT-004: new land around a park is a new multipolygon with the park's outline as its inner way", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-30, -30, 30, 30, { leisure: "park" });
    const w = await s.world();
    fill(w, "R5", -100, -100, 100, 100);
    const c = computeChanges(w);
    expect(c.counts.added).toBe(1);
    expect(c.create.relations.length).toBe(1);
    const rel = c.create.relations[0];
    expect(rel.tags).toEqual({ type: "multipolygon", landuse: "residential", residential: "apartments" });
    expect(rel.members.map((m) => m.role).sort()).toEqual(["inner", "outer"]);
    const innerWay = c.create.ways.find((x) => x.id === rel.members.find((m) => m.role === "inner")!.ref)!;
    expect(innerWay.nodes.every((n) => n > 0)).toBe(true); // OUT-003: the park's own nodes
  });

  it("OUT-003: a street's node is never taken, even where the paint reaches it", async () => {
    const s = new Sketch(300);
    s.road([[-320, 0], [320, 0]], "residential");
    const w = await s.world();
    const [x, y] = [-100, -40];
    fill(w, "R2", x - 50, y - 30, x + 50, y + 30);
    const c = computeChanges(w);
    expect(c.create.ways[0].nodes.every((n) => n < 0)).toBe(true);
  });
});

describe("the files", () => {
  it("JOSM-001 / JOSM-003: the JOSM file marks new, changed and deleted elements and carries the kept nodes", async () => {
    const { s, way } = centre();
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100);
    const c = computeChanges(w);
    for (const n of c.context) n.version = 3;
    for (const x of [...c.modify.ways, ...c.delete.nodes]) x.version = 2;
    const xml = toJosmXml(c);
    expect(xml).toContain(`<osm version="0.6" generator="Skyditor" upload="true">`);
    expect(xml).toMatch(new RegExp(`<way id="${way}" version="2" action="modify">`));
    expect(xml).toMatch(/<way id="-\d+" action="modify">(<nd ref="-?\d+"\/>)+<tag k="landuse" v="commercial"\/><\/way>/);
    expect(xml).toMatch(/<node id="\d+" version="3" lat="/); // a kept node, no action
    expect(xml).toMatch(/<tag k="name" v="Pine Hill"\/>/);
    // Deleted elements are marked so, and invisible.
    const w2 = await centre().s.world();
    fill(w2, null, -100, -100, 100, 100);
    const d = computeChanges(w2);
    for (const x of [...d.delete.ways, ...d.delete.nodes]) x.version = 2;
    expect(toJosmXml(d)).toMatch(/<node id="\d+" version="2" action="delete" visible="false"/);
    expect(toJosmXml(d)).toMatch(/<way id="\d+" version="2" action="delete" visible="false"/);
  });
});
