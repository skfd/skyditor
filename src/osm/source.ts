// OUT-001: the OSM elements a map was loaded from, kept whole for as long as the map is shown, and what the
// lattice made of each landuse feature at import, so output (OUT-002) can tell the user's changes from the
// lattice's reading.
import { type Shape, union } from "../geo/clip";
import type { Kind } from "../model/kinds";
import type { Atom, Piece } from "../model/world";
import type { OsmData, OsmRelation, OsmWay, Tags } from "./parse";

export class Source {
  readonly nodes = new Map<number, [number, number]>(); // id -> [lon, lat]
  readonly nodeTags = new Map<number, Tags>();
  readonly ways = new Map<number, OsmWay>();
  readonly relations = new Map<number, OsmRelation>();
  /** OUT-002: the land each paintable feature got at import, by feature id (`way/1`), integer units. */
  readonly importedLand = new Map<string, Shape>();
  readonly importedKind = new Map<string, Kind>();
  /** OUT-007: the parts each rival feature lost at import, still disputed then, by the rival's id. */
  readonly disputed = new Map<string, Shape>();

  /** Elements fetched for one tile or file. An element fetched twice counts once (LOAD-013). */
  add(data: OsmData) {
    for (const [id, pt] of data.nodes) if (!this.nodes.has(id)) this.nodes.set(id, pt);
    for (const [id, tags] of data.nodeTags) if (!this.nodeTags.has(id)) this.nodeTags.set(id, tags);
    for (const [id, w] of data.ways) if (!this.ways.has(id)) this.ways.set(id, w);
    for (const r of data.relations) if (!this.relations.has(r.id)) this.relations.set(r.id, r);
  }

  /**
   * Records what import gave each feature in the atoms that just loaded. Atoms loaded earlier never change at
   * import (LOAD-013), so the land of one feature accumulates tile by tile.
   */
  snapshot(atoms: Iterable<Atom>) {
    for (const atom of atoms)
      for (const p of atom.pieces) {
        if (p.kind === null || !p.source) continue;
        if (p.kind !== "CTX") {
          this.importedLand.set(p.source, join(this.importedLand.get(p.source), p.shape));
          if (!this.importedKind.has(p.source)) this.importedKind.set(p.source, p.kind);
        }
        if (p.rival?.source) this.disputed.set(p.rival.source, join(this.disputed.get(p.rival.source), p.shape));
      }
  }

  /** UPL-003: after an upload the written land is the map's land. */
  rebase(feature: string, land: Shape, kind: Kind) {
    this.importedLand.set(feature, land);
    this.importedKind.set(feature, kind);
    this.disputed.delete(feature);
  }

  /** The id and type of an element string such as `way/12`. */
  static ref(id: string): { type: "way" | "relation" | "node"; id: number } | null {
    const m = /^(node|way|relation)\/(\d+)$/.exec(id);
    return m ? { type: m[1] as "way" | "relation" | "node", id: Number(m[2]) } : null;
  }

  /** Whether `p` is a piece of imported land, for the snapshot. */
  static imported(p: Piece) {
    return p.source !== undefined;
  }
}

const join = (a: Shape | undefined, b: Shape) => (a ? union(a, b) : b);
