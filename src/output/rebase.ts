// UPL-003: after an upload the written elements are the map's elements: pieces carry the new ids and count as
// unchanged, the source holds what was written, and the next diff starts from here.
import { classifyArea } from "../model/kinds";
import { type Piece, type World, makePiece } from "../model/world";
import type { AreaFeature } from "../osm/features";
import type { Changes, OutNode, OutWay } from "./changes";
import type { Uploaded } from "./upload";

const same = (p: Piece, atom: number, feature: string, modified: boolean) =>
  makePiece(atom, p.kind, p.shape, { ctx: p.ctx, source: feature, feature, modified, rival: p.rival, drawn: p.drawn, name: p.name, whole: p.whole });

export function rebase(world: World, c: Changes, up: Uploaded) {
  const src = world.source;
  const newId = (type: string, id: number) => (id < 0 ? up.ids.get(`${type}/${id}`) ?? id : id);

  // The source: created elements with their real ids, changed ones as written, deleted ones gone.
  const putNode = (n: OutNode) => {
    const id = newId("node", n.id);
    src.nodes.set(id, [n.lon, n.lat]);
    if (Object.keys(n.tags).length) src.nodeTags.set(id, n.tags);
    else src.nodeTags.delete(id);
  };
  const putWay = (w: OutWay) => src.ways.set(newId("way", w.id), { id: newId("way", w.id), nodes: w.nodes.map((n) => newId("node", n)), tags: w.tags });
  for (const n of [...c.create.nodes, ...c.modify.nodes]) putNode(n);
  for (const w of [...c.create.ways, ...c.modify.ways]) putWay(w);
  for (const r of [...c.create.relations, ...c.modify.relations])
    src.relations.set(newId("relation", r.id), { id: newId("relation", r.id), tags: r.tags, members: r.members.map((m) => ({ ...m, ref: newId(m.type, m.ref) })) });
  for (const n of c.delete.nodes) {
    src.nodes.delete(n.id);
    src.nodeTags.delete(n.id);
  }
  for (const w of c.delete.ways) src.ways.delete(w.id);
  for (const r of c.delete.relations) src.relations.delete(r.id);

  // Areas: the element each one is now, its outline and land as written.
  const rename = new Map<string, string>(); // old feature -> the element it is now
  for (const a of c.areas) {
    const el = a.elements.find((e) => e.type === "relation") ?? a.elements.find((e) => e.type === "way");
    const feature = a.what === "removed" || !el ? null : `${el.type}/${newId(el.type, el.id)}`;
    const base = a.feature.split("+")[0];
    const old = world.features.areas.findIndex((f) => f.id === base);
    if (!feature) {
      if (a.what === "removed") {
        if (old >= 0) world.features.areas.splice(old, 1);
        const o = world.originals.findIndex((f) => f.id === base);
        if (o >= 0) world.originals.splice(o, 1);
        src.importedLand.delete(base);
        src.importedKind.delete(base);
        src.disputed.delete(base);
      }
      continue;
    }
    rename.set(a.feature, feature);
    const tags = a.elements.some((e) => e.type === "relation")
      ? [...c.create.relations, ...c.modify.relations].find((r) => `relation/${newId("relation", r.id)}` === feature)?.tags
      : [...c.create.ways, ...c.modify.ways].find((w) => `way/${newId("way", w.id)}` === feature)?.tags;
    const klass = classifyArea(tags ?? {});
    if (!klass) continue;
    const area: AreaFeature = { id: feature, tags: tags ?? {}, shape: a.outline, area: 0, klass };
    if (old >= 0 && a.feature === base) world.features.areas[old] = area;
    else world.features.areas.push(area);
    const o = world.originals.findIndex((f) => f.id === base);
    if (o >= 0 && a.feature === base) world.originals[o] = area;
    else if (klass.cls === "paintable") world.originals.push(area);
    src.rebase(feature, a.land, a.kind);
  }

  // Pieces: the new ids, and nothing modified any more. Replaced, never mutated.
  const extras = new Map<string, Map<string, string>>(); // base feature -> kind -> the element of that kind's part
  for (const [from, to] of rename) {
    const [base, kind] = from.split("+");
    if (kind) (extras.get(base) ?? extras.set(base, new Map()).get(base)!).set(kind, to);
  }
  for (const atom of world.atoms) {
    let changed = false;
    const pieces = atom.pieces.map((p) => {
      if (!p.feature || p.kind === null) return p;
      const to = extras.get(p.feature)?.get(p.kind) ?? rename.get(p.feature);
      if (to === undefined && !p.modified) return p;
      changed = true;
      return same(p, atom.id, to ?? p.feature, false);
    });
    if (changed) atom.pieces = pieces;
  }
  for (const set of world.buildingSets())
    if (set.items.some((b) => b.modified)) set.items = set.items.map((b) => (b.modified ? { ...b, modified: false } : b));
}
