// Landuse kinds, the residential ladder and import classification (KIND-*, IMP-001..003, LAT-008).
import type { Tags } from "../osm/parse";
import { BUILDING_LOOK, CIVIC_AMENITY, EDUCATION_AMENITY, EXCLUSIVE, OVERLAY, RESIDENTIAL_TIER, isWaterArea } from "../osm/classes";
import { TUNE } from "../tuning";

export type TierKind = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type PaintKind = TierKind | "COM" | "RET" | "IND";
/** RU = unspecified residential (KIND-004); CTX = exclusive context (IMP-002). */
export type Kind = PaintKind | "RU" | "CTX";

export const TIERS: TierKind[] = ["R1", "R2", "R3", "R4", "R5", "R6"];
export const PAINT_KINDS: PaintKind[] = [...TIERS, "COM", "RET", "IND"];

export interface KindDef {
  id: Kind;
  label: string;
  key?: string;
  tags: Tags;
  color: string;
  lift: number; // px at 1 px/m (TUNE-LIFT)
  tier?: number; // 1..6 for the ladder
  pitch: number; // semitones above the base note (FEEL-003)
}

// KIND-001, KIND-003, KIND-006: one warm ramp for the ladder, cool distinct hues for the rest.
export const KINDS: Record<Kind, KindDef> = {
  R1: { id: "R1", label: "Rural", key: "1", tags: { landuse: "residential", residential: "rural" }, color: "#e6e2b0", lift: TUNE.LIFT.R1, tier: 1, pitch: 0 },
  R2: { id: "R2", label: "Detached houses", key: "2", tags: { landuse: "residential", residential: "single_family" }, color: "#f0cc7c", lift: TUNE.LIFT.R2, tier: 2, pitch: 2 },
  R3: { id: "R3", label: "Semi-detached", key: "3", tags: { landuse: "residential", residential: "duplex" }, color: "#eaa85b", lift: TUNE.LIFT.R3, tier: 3, pitch: 4 },
  R4: { id: "R4", label: "Terraced / rowhouses", key: "4", tags: { landuse: "residential", residential: "terrace" }, color: "#dc874e", lift: TUNE.LIFT.R4, tier: 4, pitch: 5 },
  R5: { id: "R5", label: "Apartments", key: "5", tags: { landuse: "residential", residential: "apartments" }, color: "#c66342", lift: TUNE.LIFT.R5, tier: 5, pitch: 7 },
  R6: { id: "R6", label: "High-rise", key: "6", tags: { landuse: "residential", residential: "apartments" }, color: "#a2423b", lift: TUNE.LIFT.R6, tier: 6, pitch: 9 },
  COM: { id: "COM", label: "Commercial", key: "Q", tags: { landuse: "commercial" }, color: "#7d92e0", lift: TUNE.LIFT_NONRES, pitch: 12 },
  RET: { id: "RET", label: "Retail", key: "W", tags: { landuse: "retail" }, color: "#c46fd0", lift: TUNE.LIFT_NONRES, pitch: 14 },
  IND: { id: "IND", label: "Industrial", key: "E", tags: { landuse: "industrial" }, color: "#8b92a3", lift: TUNE.LIFT_NONRES, pitch: -5 },
  RU: { id: "RU", label: "Residential (unspecified)", tags: { landuse: "residential" }, color: "#d6ccbb", lift: 0, pitch: 0 },
  CTX: { id: "CTX", label: "Other land", tags: {}, color: "#cfd8c0", lift: 0, pitch: 0 },
};

export const tierOf = (k: Kind | null) => (k ? KINDS[k].tier : undefined);
export const tierKind = (t: number) => TIERS[Math.max(1, Math.min(6, t)) - 1];
export const isResidential = (k: Kind | null) => k === "RU" || (!!k && KINDS[k].tier !== undefined);

// REN-015: context colour classes. The first four are the context a city is full of, each its own colour.
export type CtxClass = "park" | "education" | "cemetery" | "construction" | "green" | "wood" | "farm" | "grey" | "civic";
export const CTX_COLORS: Record<CtxClass, string> = {
  park: "#9ad97a",
  education: "#a9ddd3",
  cemetery: "#8fa592",
  construction: "#c4a27c",
  green: "#bcdba3",
  wood: "#94c184",
  farm: "#e5e5be",
  grey: "#d4d0c8",
  civic: "#e3d7c7",
};

export type AreaClass =
  | { cls: "paintable"; kind: PaintKind | "RU" }
  | { cls: "exclusive"; ctx: CtxClass; label: string; implied?: true } // implied: by an amenity (IMP-013)
  | { cls: "overlay"; ctx: CtxClass }
  | { cls: "water" };

/** IMP-001: every area feature gets exactly one class (or null = ignored). */
export function classifyArea(tags: Tags): AreaClass | null {
  const lu = tags.landuse;
  if (isWaterArea(tags)) return { cls: "water" }; // LAT-008
  if (lu === "residential") {
    const t = RESIDENTIAL_TIER[tags.residential ?? ""]; // KIND-005
    return { cls: "paintable", kind: t ?? "RU" }; // KIND-004
  }
  if (lu === "commercial") return { cls: "paintable", kind: "COM" };
  if (lu === "retail") return { cls: "paintable", kind: "RET" };
  if (lu === "industrial") return { cls: "paintable", kind: "IND" };
  for (const key of ["landuse", "leisure", "natural"]) {
    // IMP-002
    const v = tags[key];
    if (v && EXCLUSIVE[key]?.[v]) return { cls: "exclusive", ctx: EXCLUSIVE[key][v], label: `${key}=${v}` };
  }
  // IMP-013: school grounds mapped by their amenity alone.
  if (EDUCATION_AMENITY.has(tags.amenity ?? ""))
    return { cls: "exclusive", ctx: "education", label: `amenity=${tags.amenity}`, implied: true };
  for (const key of ["landuse", "leisure", "amenity"]) {
    // IMP-003
    const v = tags[key];
    if (v && OVERLAY[key]?.[v]) return { cls: "overlay", ctx: OVERLAY[key][v] };
  }
  return null;
}

/** BLD-001: what a building says about its land. null = unknown. */
export type BuildingLook = PaintKind | "RU" | "EDU" | "CIVIC";


/** BLD-003: levels from `building:levels`, else `height` in metres. */
export function levelsOf(tags: Tags): number | undefined {
  const lv = /^\s*(\d+(?:\.\d+)?)/.exec(tags["building:levels"] ?? "");
  if (lv) return Number(lv[1]);
  const h = /^\s*(\d+(?:\.\d+)?)\s*(?:m)?\s*$/.exec(tags.height ?? "");
  if (h) return Number(h[1]) / TUNE.LEVEL_HEIGHT;
  return undefined;
}

/**
 * TYPE-002: how many addresses the building's own tags carry: house numbers ("12", "12;14", "12-18"), or the
 * flats or units behind them ("1-24"). Undefined when it has none.
 */
export function addrCount(tags: Tags): number | undefined {
  const count = (v: string | undefined): number => {
    if (!v) return 0;
    let n = 0;
    for (const part of v.split(/[;,]/)) {
      const r = /^\s*(\d+)\s*[-–]\s*(\d+)\s*[a-z]?\s*$/i.exec(part);
      if (r) {
        const [a, b] = [Number(r[1]), Number(r[2])];
        // "12-18" on one house is three numbers at most; a flats range "1-24" is 24.
        n += a <= b && b - a <= 200 ? b - a + 1 : 1;
      } else if (part.trim()) n++;
    }
    return n;
  };
  const flats = Math.max(count(tags["addr:flats"]), count(tags["addr:unit"]));
  const houses = count(tags["addr:housenumber"]);
  if (!flats && !houses) return undefined;
  return Math.max(flats, houses);
}

/** BLD-001..BLD-005 */
export function buildingLook(tags: Tags): BuildingLook | null {
  let look: BuildingLook | null = BUILDING_LOOK[tags.building ?? ""] ?? null; // BLD-002
  if (!look) {
    // BLD-004
    if (tags.shop) look = "RET";
    else if (tags.office) look = "COM";
    else if (EDUCATION_AMENITY.has(tags.amenity ?? "")) look = "EDU";
    else if (CIVIC_AMENITY.has(tags.amenity ?? "")) look = "CIVIC";
  }
  // BLD-003
  if ((look === "R5" || look === "RU") && (levelsOf(tags) ?? 0) >= TUNE.HIGHRISE_LEVELS) look = "R6";
  return look; // BLD-005: anything else stays unknown
}

/** REN-009: base colour of a look, before shading. */
export const lookColor = (look: BuildingLook) =>
  look === "EDU" ? CTX_COLORS.education : look === "CIVIC" ? CTX_COLORS.civic : KINDS[look].color;

/** Human-readable OSM tags for a kind (HUD-002). */
export const tagString = (k: Kind) =>
  Object.entries(KINDS[k].tags)
    .map(([a, b]) => `${a}=${b}`)
    .join(" + ");

/** Overlaps and disputes: kinds that say the same thing, differing at most in detail. */
export function agree(a: Kind, b: Kind): boolean {
  if (a === b) return true; // two exclusive-context kinds are both "CTX"
  return (a === "RU" && tierOf(b) !== undefined) || (b === "RU" && tierOf(a) !== undefined);
}

/** BLD-007: residential, business or industrial; null when the kind says nothing about buildings. */
function family(k: Kind | BuildingLook | null): "res" | "biz" | "ind" | null {
  if (k === "RU" || (k && k in KINDS && KINDS[k as Kind].tier !== undefined)) return "res";
  if (k === "COM" || k === "RET") return "biz";
  if (k === "IND") return "ind";
  return null;
}

/** BLD-007: whether a building with `look` disagrees with land of `kind`. */
export function disagreesWithLand(look: BuildingLook | null, kind: Kind | null): boolean {
  const a = family(look), b = family(kind);
  return a !== null && b !== null && a !== b;
}
