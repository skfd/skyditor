import { describe, expect, it } from "vitest";
import { rect, toI, union } from "../src/geo/clip";
import { isProtected } from "../src/model/world";
import { applyRegion } from "../src/paint/snap";
import { prepare } from "../src/output/verify";
import { Sketch, atomAt } from "./helpers";

type World = Awaited<ReturnType<Sketch["world"]>>;
const box = (x0: number, y0: number, x1: number, y1: number) => rect({ minX: toI(x0), minY: toI(y0), maxX: toI(x1), maxY: toI(y1) });
function fill(w: World, kind: "R2" | "COM" | null, x0: number, y0: number, x1: number, y1: number) {
  const block = atomAt(w, (x0 + x1) / 2, (y0 + y1) / 2);
  const eligible = union(...block.pieces.filter((p) => !isProtected(p)).map((p) => p.shape));
  block.pieces = applyRegion(block, { region: box(x0, y0, x1, y1), eligible }, kind).pieces;
}

/** A server that answers from the world's own source data, at the given versions, with `edits` applied on top. */
function server(w: World, version: number, edits: Record<string, Partial<{ lat: number; nodes: number[]; tags: Record<string, string>; gone: boolean }>> = {}) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const m = /\/api\/0\.6\/(node|way|relation)s\.json\?\w+=([\d,]+)/.exec(url)!;
    const type = m[1] as "node" | "way" | "relation";
    const elements: unknown[] = [];
    for (const id of m[2].split(",").map(Number)) {
      const e = edits[`${type}/${id}`] ?? {};
      if (e.gone) continue;
      if (type === "node") {
        const n = w.source.nodes.get(id)!;
        elements.push({ type, id, version, lon: n[0], lat: e.lat ?? n[1], tags: e.tags ?? w.source.nodeTags.get(id) });
      } else if (type === "way") {
        const way = w.source.ways.get(id)!;
        elements.push({ type, id, version, nodes: e.nodes ?? way.nodes, tags: e.tags ?? way.tags });
      } else {
        const r = w.source.relations.get(id)!;
        elements.push({ type, id, version, members: r.members, tags: e.tags ?? r.tags });
      }
    }
    return new Response(JSON.stringify({ elements }), { status: 200 });
  };
  return { f, calls };
}

const R2 = { landuse: "residential", residential: "single_family", name: "Pine Hill" };

describe("checking against the server", () => {
  it("OUT-008: versions come from the server, for kept nodes and changed elements alike", async () => {
    const s = new Sketch(300).grid(200);
    const way = s.rect(-95, -95, 95, 95, R2);
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100);
    const srv = server(w, 7);
    const { changes, leftOut } = await prepare(w, "https://x", srv.f);
    expect(leftOut).toEqual([]);
    expect(changes.modify.ways.find((x) => x.id === way)?.version).toBe(7);
    for (const n of changes.context) expect(n.version).toBe(7);
    expect(srv.calls.every((u) => u.startsWith("https://x/api/0.6/"))).toBe(true);
    expect(srv.calls.some((u) => u.includes("/nodes.json?nodes="))).toBe(true);
  });

  it("OUT-008: an area whose way changed on the server is left out, by name, and the rest still goes", async () => {
    const s = new Sketch(300).grid(200);
    const way = s.rect(-95, -95, 95, 95, R2);
    s.rect(105, -95, 295, 95, { landuse: "retail" });
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100); // changes Pine Hill and makes a new area
    fill(w, null, 100, -100, 300, 100); // removes the retail area
    const srv = server(w, 2, { [`way/${way}`]: { tags: { ...R2, note: "edited meanwhile" } } });
    const { changes, leftOut } = await prepare(w, "https://x", srv.f);
    expect(leftOut).toEqual(["Pine Hill"]);
    expect(changes.modify.ways.find((x) => x.id === way)).toBeUndefined();
    expect(changes.counts.removed).toBe(1); // the retail area still goes
    expect(changes.counts.added).toBe(1); // and the new commercial area
  });

  it("OUT-008: a moved node, or one that is gone, leaves its area out", async () => {
    const s = new Sketch(300).grid(200);
    const way = s.rect(-95, -95, 95, 95, R2);
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100);
    const node = w.source.ways.get(way)!.nodes[0];
    let r = await prepare(w, "https://x", server(w, 1, { [`node/${node}`]: { lat: 0.001 } }).f);
    expect(r.leftOut).toEqual(["Pine Hill"]);
    r = await prepare(w, "https://x", server(w, 1, { [`node/${node}`]: { gone: true } }).f);
    expect(r.leftOut).toEqual(["Pine Hill"]);
  });

  it("OUT-008: a typed building whose way changed is left out as a building", async () => {
    const s = new Sketch(300).grid(200);
    const house = s.rect(-20, -20, 20, 20, { building: "yes" });
    const w = await s.world();
    const set = w.setOf(w.buildingsIn({ minX: toI(-1), minY: toI(-1), maxX: toI(1), maxY: toI(1) })[0]);
    const b = set.items[0];
    set.items = [{ ...b, tags: { building: "house" }, look: "R2", modified: true }];
    const r = await prepare(w, "https://x", server(w, 3, { [`way/${house}`]: { tags: { building: "garage" } } }).f);
    expect(r.leftOut).toEqual([`building way ${house}`]);
    expect(r.changes.counts.buildings).toBe(0);
  });
});
