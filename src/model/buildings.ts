// Buildings as editable things (TYPE-*): what OSM says they are, what the user made them, and what may be
// guessed. Buildings are immutable; replace them, never mutate (renderer caches and undo depend on identity).
import type { BBox, Shape } from "../geo/clip";
import { BUILDING_LOOK, BUILDING_WRITE, UNTYPED_BUILDING } from "../osm/classes";
import type { Tags } from "../osm/parse";
import { type BuildingLook, KINDS, type PaintKind, buildingLook } from "./kinds";

/** The part of a building that never changes: its footprint and where it stands. */
export interface BuildingGeom extends BBox {
  readonly id: number;
  readonly source: string; // "way/123" (TYPE-011)
  readonly ring: Float32Array; // closed ring, x,y metres
  readonly shape: Shape;
  readonly area: number; // m²
  readonly cx: number; // centre, integer units
  readonly cy: number;
  readonly atom: number; // the atom its centre stands in, or -1
  cluster: number; // TYPE-002: buildings sharing walls share a cluster id
  clusterSize: number;
  yard?: Shape; // SNAP-109, computed on first use
}

export interface Building {
  readonly geom: BuildingGeom;
  readonly tags: Tags; // current tags: the original ones, with the user's `building=*` on top
  readonly look: BuildingLook | null; // BLD-001, or the kind the user painted (TYPE-008)
  readonly modified: boolean; // TYPE-011
}

/** TYPE-001 / TYPE-009: what a stroke may do to a building. */
export type BuildingStatus =
  | "untyped" // `building=yes` or plain `residential`: open to guessing
  | "typed" // a paintable kind, from its type or its use
  | "protected"; // civic, education or an accessory: the palette has no kind for it

export function statusOf(b: Pick<Building, "tags" | "look">): BuildingStatus {
  if (b.look === "EDU" || b.look === "CIVIC") return "protected";
  if (b.look !== null && b.look !== "RU") return "typed";
  const v = b.tags.building ?? "";
  if (UNTYPED_BUILDING.has(v) || BUILDING_LOOK[v] === "RU") return "untyped";
  return "protected"; // garages, sheds, roofs, huts, ruins and everything else that is not a kind (TYPE-009)
}

export const makeBuilding = (geom: BuildingGeom, tags: Tags, extra: { look?: BuildingLook | null; modified?: boolean } = {}): Building => ({
  geom,
  tags,
  look: extra.look === undefined ? buildingLook(tags) : extra.look,
  modified: extra.modified ?? false,
});

/** TYPE-008: a copy typed as `kind`, or null when the building is already that kind. Never call on R1. */
export function typeAs(b: Building, kind: PaintKind): Building | null {
  const value = BUILDING_WRITE[kind];
  if (!value || b.look === kind) return null;
  // The look is the painted kind itself, so high-rise stays high-rise although it writes `apartments` (Q-002).
  return makeBuilding(b.geom, { ...b.tags, building: value }, { look: kind, modified: true });
}

/** TYPE-010: a copy made untyped again, or null when there is no type to remove. */
export function untype(b: Building): Building | null {
  if (statusOf(b) !== "typed" || UNTYPED_BUILDING.has(b.tags.building ?? "")) return null;
  return makeBuilding(b.geom, { ...b.tags, building: "yes" }, { modified: true });
}

export const paintable = (look: BuildingLook | null): look is PaintKind => look !== null && look in KINDS && look !== "RU";
