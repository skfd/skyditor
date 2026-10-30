// The changes as OSM XML: the file JOSM reads as a layer with unsaved changes, with its `action` marks
// (JOSM-001, JOSM-003).
import type { Changes, OutNode, OutRelation, OutWay } from "./changes";

const VERSION = "0.6";
export const GENERATOR = "Skyditor";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

const tags = (t: Record<string, string>) =>
  Object.entries(t).map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join("");

const attrs = (e: { id: number; version?: number }, extra = "") =>
  `id="${e.id}"${e.version !== undefined ? ` version="${e.version}"` : ""}${extra}`;

const node = (n: OutNode, extra = "") => `<node ${attrs(n, extra)} lat="${n.lat}" lon="${n.lon}">${tags(n.tags)}</node>`;
const way = (w: OutWay, extra = "") =>
  `<way ${attrs(w, extra)}>${w.nodes.map((n) => `<nd ref="${n}"/>`).join("")}${tags(w.tags)}</way>`;
const relation = (r: OutRelation, extra = "") =>
  `<relation ${attrs(r, extra)}>${r.members.map((m) => `<member type="${m.type}" ref="${m.ref}" role="${esc(m.role)}"/>`).join("")}${tags(r.tags)}</relation>`;

/**
 * JOSM-001: the file JOSM reads as a layer with unsaved changes. New elements have negative ids, changed and
 * deleted ones say so with `action`, and the nodes a changed way keeps come along unchanged so the way is whole.
 */
export function toJosmXml(c: Changes): string {
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<osm version="${VERSION}" generator="${GENERATOR}" upload="true">`];
  for (const n of c.context) out.push(node(n));
  const mod = ` action="modify"`, del = ` action="delete" visible="false"`;
  for (const n of c.create.nodes) out.push(node(n, mod));
  for (const n of c.modify.nodes) out.push(node(n, mod));
  for (const n of c.delete.nodes) out.push(node(n, del));
  for (const w of c.create.ways) out.push(way(w, mod));
  for (const w of c.modify.ways) out.push(way(w, mod));
  for (const w of c.delete.ways) out.push(way(w, del));
  for (const r of c.create.relations) out.push(relation(r, mod));
  for (const r of c.modify.relations) out.push(relation(r, mod));
  for (const r of c.delete.relations) out.push(relation(r, del));
  out.push(`</osm>`);
  return out.join("\n");
}
