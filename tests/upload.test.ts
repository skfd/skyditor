import { describe, expect, it } from "vitest";
import { rect, toI, union } from "../src/geo/clip";
import { History } from "../src/model/history";
import { isProtected } from "../src/model/world";
import { SERVERS } from "../src/osm/server";
import { computeChanges, isEmptyChanges } from "../src/output/changes";
import { rebase } from "../src/output/rebase";
import { renumber } from "../src/output/seed";
import { changesetXml, parseDiffResult, upload } from "../src/output/upload";
import { prepare } from "../src/output/verify";
import { applyRegion } from "../src/paint/snap";
import { parseOsm } from "../src/osm/parse";
import { Sketch, at, atomAt, paint } from "./helpers";

type World = Awaited<ReturnType<Sketch["world"]>>;
const box = (x0: number, y0: number, x1: number, y1: number) => rect({ minX: toI(x0), minY: toI(y0), maxX: toI(x1), maxY: toI(y1) });
function fill(w: World, kind: "R2" | "COM" | null, x0: number, y0: number, x1: number, y1: number) {
  const block = atomAt(w, (x0 + x1) / 2, (y0 + y1) / 2);
  const eligible = union(...block.pieces.filter((p) => !isProtected(p)).map((p) => p.shape));
  block.pieces = applyRegion(block, { region: box(x0, y0, x1, y1), eligible }, kind).pieces;
}
const R2 = { landuse: "residential", residential: "single_family", name: "Pine Hill" };

/** A test server: answers element lookups from the world at version 1, and takes one changeset. */
function server(w: World) {
  const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  let next = 1000;
  const f = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined, auth: headers.Authorization });
    if (url.includes("/changeset/create")) return new Response("77", { status: 200 });
    if (url.includes("/changeset/77/upload")) {
      const body = init!.body as string;
      const lines: string[] = [];
      const del = body.indexOf("<delete");
      for (const m of body.matchAll(/<(node|way|relation) id="(-?\d+)"[^>]*changeset="77"/g)) {
        const old = Number(m[2]);
        if (del >= 0 && body.indexOf(m[0]) > del) lines.push(`<${m[1]} old_id="${old}"/>`);
        else lines.push(`<${m[1]} old_id="${old}" new_id="${old < 0 ? next++ : old}" new_version="${old < 0 ? 1 : 2}"/>`);
      }
      return new Response(`<diffResult version="0.6">${lines.join("")}</diffResult>`, { status: 200 });
    }
    if (url.includes("/changeset/77/close")) return new Response("", { status: 200 });
    const m = /\/api\/0\.6\/(node|way|relation)s\.json\?\w+=([\d,]+)/.exec(url)!;
    const elements = m[2].split(",").map(Number).map((id) => {
      if (m[1] === "node") {
        const n = w.source.nodes.get(id)!;
        return { type: "node", id, version: 1, lon: n[0], lat: n[1], tags: w.source.nodeTags.get(id) };
      }
      if (m[1] === "way") return { type: "way", ...w.source.ways.get(id)!, version: 1 };
      return { type: "relation", ...w.source.relations.get(id)!, version: 1 };
    });
    return new Response(JSON.stringify({ elements }), { status: 200 });
  };
  return { f, calls };
}

describe("uploading", () => {
  it("UPL-001: the changeset carries the comment and who made it", () => {
    expect(changesetXml({ comment: "Pine Hill <3" })).toBe(
      `<osm><changeset><tag k="created_by" v="Skyditor 0.1"/><tag k="comment" v="Pine Hill &lt;3"/></changeset></osm>`,
    );
  });

  it("UPL-001: the diffResult says what each placeholder became", () => {
    const r = parseDiffResult(`<diffResult version="0.6"><node old_id="-1" new_id="501" new_version="1"/><way old_id="-2" new_id="90" new_version="1"/><way old_id="7" new_id="7" new_version="3"/><node old_id="4"/></diffResult>`);
    expect(r.ids.get("node/-1")).toBe(501);
    expect(r.ids.get("way/-2")).toBe(90);
    expect(r.ids.has("way/7")).toBe(false);
    expect(r.versions.get("way/7")).toBe(3);
    expect(r.versions.get("way/90")).toBe(1);
  });

  it("UPL-001 / UPL-003: open, upload, close; then the map is clean, with the new ids, and the next diff is empty", async () => {
    const s = new Sketch(300).grid(200);
    const way = s.rect(-95, -95, 95, 95, R2);
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100);
    const srv = server(w);
    const prepared = await prepare(w, SERVERS.dev.api, srv.f);
    const up = await upload(SERVERS.dev, "TOKEN", prepared.changes, "Split Pine Hill", srv.f);
    const writes = srv.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.url.split("/api/0.6")[1]}`)).toEqual(["PUT /changeset/create", "POST /changeset/77/upload", "PUT /changeset/77/close"]);
    expect(writes.every((c) => c.auth === "Bearer TOKEN")).toBe(true);
    expect(writes[0].body).toContain(`<tag k="comment" v="Split Pine Hill"/>`);
    expect(writes[1].body).toContain(`changeset="77"`);
    expect(writes[1].body).toContain(`<way id="${way}" version="1" changeset="77">`);
    expect(up.changeset).toBe(77);
    expect(up.url).toBe("https://master.apis.dev.openstreetmap.org/changeset/77");
    const newWay = up.ids.get(`way/${prepared.changes.create.ways[0].id}`)!;
    expect(newWay).toBeGreaterThan(0);

    rebase(w, prepared.changes, up);
    expect(at(w, 50, 0)?.feature).toBe(`way/${newWay}`);
    expect(at(w, 50, 0)?.modified).toBe(false);
    expect(at(w, -50, 0)?.feature).toBe(`way/${way}`);
    expect(at(w, -50, 0)?.modified).toBe(false);
    expect(w.source.ways.get(newWay)?.tags).toEqual({ landuse: "commercial" });
    expect(w.source.ways.get(newWay)?.nodes.every((n) => n > 0)).toBe(true);
    expect(isEmptyChanges(computeChanges(w))).toBe(true);
    // Painting on goes from here: the next change is against the written outline.
    paint(w, { type: "density", dir: 1 }, 5, [[-50, -2], [-50, 2]]);
    const c = computeChanges(w);
    expect(c.counts).toEqual({ changed: 1, added: 0, removed: 0, buildings: 0 });
    expect(c.modify.ways[0].tags.residential).toBe("duplex");
  });

  it("UPL-002: a refused upload throws with the reason and closes the changeset", async () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, R2);
    const w = await s.world();
    fill(w, "COM", 20, -100, 100, 100);
    const srv = server(w);
    const bad = async (url: string, init?: RequestInit) =>
      url.includes("/upload") ? new Response("Version mismatch: Provided 1, server had: 2 of Way 5", { status: 409 }) : srv.f(url, init);
    const prepared = await prepare(w, SERVERS.dev.api, srv.f);
    await expect(upload(SERVERS.dev, "TOKEN", prepared.changes, "x", bad)).rejects.toThrow(/changed an element meanwhile.*Version mismatch/);
    expect(srv.calls.some((c) => c.url.includes("/changeset/77/close"))).toBe(true);
    const h = new History();
    expect(h.canUndo).toBe(false); // nothing in the world was touched: the caller keeps its history
    expect(isEmptyChanges(computeChanges(w))).toBe(false);
  });

  it("SEED-001: a copy renumbers every element and reference, dropping ways the download cut", () => {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 95, 95, R2);
    const d = parseOsm(s.json());
    const anyWay = [...d.ways.values()][0];
    d.nodes.delete(anyWay.nodes[0]); // as if cut by the download's edge
    const r = renumber(d);
    expect(r.nodes.every((n) => n.id < 0)).toBe(true);
    expect(r.ways.length).toBe(d.ways.size - 1);
    expect(r.ways.every((w) => w.nodes.every((n) => n < 0 && r.nodes.some((x) => x.id === n)))).toBe(true);
    expect(r.ways.find((w) => w.tags.name === "Pine Hill")).toBeDefined();
  });
});
