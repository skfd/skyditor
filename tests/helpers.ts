// Builds small synthetic OSM documents in local metres, so tests read like map sketches.
import { toI } from "../src/geo/clip";
import { worldFromText } from "../src/model/load";
import type { Piece, World } from "../src/model/world";
import { Stroke } from "../src/paint/stroke";
import type { Tool } from "../src/paint/snap";

const R = 6378137;
const DEG = Math.PI / 180;
// Projection centred on (0, 0): x east, y south, metres.
const lon = (x: number) => x / (R * DEG);
const lat = (y: number) => -y / (R * DEG);

type Tags = Record<string, string>;
type Pt = [number, number];

export class Sketch {
  private nodes: { type: "node"; id: number; lat: number; lon: number }[] = [];
  private ways: { type: "way"; id: number; nodes: number[]; tags: Tags }[] = [];
  private rels: any[] = [];
  private nid = 1;
  private wid = 1;

  constructor(readonly half = 300) {}

  private byPos = new Map<string, number>();

  /** Nodes at the same position are shared, like in real OSM data. */
  private node(p: Pt) {
    const key = `${p[0]},${p[1]}`;
    const known = this.byPos.get(key);
    if (known) return known;
    const id = this.nid++;
    this.byPos.set(key, id);
    this.nodes.push({ type: "node", id, lat: lat(p[1]), lon: lon(p[0]) });
    return id;
  }

  way(pts: Pt[], tags: Tags, closed = false): number {
    const ids = pts.map((p) => this.node(p));
    if (closed) ids.push(ids[0]);
    const id = this.wid++;
    this.ways.push({ type: "way", id, nodes: ids, tags });
    return id;
  }

  road(pts: Pt[], highway = "residential", extra: Tags = {}) {
    return this.way(pts, { highway, ...extra });
  }

  area(pts: Pt[], tags: Tags) {
    return this.way(pts, tags, true);
  }

  rect(x0: number, y0: number, x1: number, y1: number, tags: Tags) {
    return this.area([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], tags);
  }

  relation(members: { way: number; role: string }[], tags: Tags) {
    this.rels.push({
      type: "relation",
      id: this.rels.length + 1,
      tags: { type: "multipolygon", ...tags },
      members: members.map((m) => ({ type: "way", ref: m.way, role: m.role })),
    });
  }

  /** A street grid every `step` metres across the whole sketch. */
  grid(step: number, highway = "residential") {
    const h = this.half;
    for (let v = -h + step; v < h; v += step) {
      this.road([[v, -h - 20], [v, h + 20]], highway);
      this.road([[-h - 20, v], [h + 20, v]], highway);
    }
    return this;
  }

  json(): string {
    const h = this.half;
    return JSON.stringify({
      bounds: { minlat: lat(h), minlon: lon(-h), maxlat: lat(-h), maxlon: lon(h) },
      elements: [...this.nodes, ...this.ways, ...this.rels],
    });
  }

  xml(): string {
    const h = this.half;
    const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<osm version="0.6">`];
    out.push(`<bounds minlat="${lat(h)}" minlon="${lon(-h)}" maxlat="${lat(-h)}" maxlon="${lon(h)}"/>`);
    for (const n of this.nodes) out.push(`<node id="${n.id}" lat="${n.lat}" lon="${n.lon}"/>`);
    const tags = (t: Tags) => Object.entries(t).map(([k, v]) => `<tag k="${k}" v="${v.replace(/&/g, "&amp;")}"/>`).join("");
    for (const w of this.ways) out.push(`<way id="${w.id}">${w.nodes.map((r) => `<nd ref="${r}"/>`).join("")}${tags(w.tags)}</way>`);
    for (const r of this.rels)
      out.push(`<relation id="${r.id}">${r.members.map((m: any) => `<member type="way" ref="${m.ref}" role="${m.role}"/>`).join("")}${tags(r.tags)}</relation>`);
    out.push(`</osm>`);
    return out.join("\n");
  }

  async world(): Promise<World> {
    return (await worldFromText(this.json())).world;
  }
}

export const at = (w: World, x: number, y: number): Piece | null => w.pieceAt(toI(x), toI(y));
export const atomAt = (w: World, x: number, y: number) => w.atomAt(toI(x), toI(y))!;

/** Runs a whole stroke along `pts` (metres) and returns its result. */
export function paint(w: World, tool: Tool, radius: number, pts: Pt[], tap = false) {
  const s = new Stroke(w, tool, radius, pts[0][0], pts[0][1]);
  const events = [...s.start()];
  for (const p of densify(pts, radius * 0.1).slice(1)) events.push(...s.move(p[0], p[1]));
  const end = s.end(tap);
  return { events: [...events, ...end.events], step: end.step };
}

function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

export const kindsIn = (w: World, x: number, y: number) => w.atomAt(toI(x), toI(y))!.pieces.map((p) => p.kind);

/** CIE76 colour difference, enough to tell colours apart by eye. */
export function deltaE(a: string, b: string): number {
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
