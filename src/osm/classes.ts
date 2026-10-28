// The OSM tag tables (REQUIREMENTS.md §6): which tags the editor reads as what. The requirements state
// the principle and a few examples; these lists are the reading, and change as mapping practice does.
import type { BuildingLook, CtxClass, PaintKind, TierKind } from "../model/kinds";
import type { Tags } from "./parse";

/** LAT-001: ways that cut a city into blocks. A `_link` of a barrier highway is a barrier too. */
export const BARRIER_HIGHWAY = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
  "pedestrian", "road",
]);
export const BARRIER_RAILWAY = new Set(["rail", "light_rail", "narrow_gauge"]);
export const BARRIER_WATERWAY = new Set(["river", "canal"]);

/** LAT-001: street classes that stop being barriers when private. */
export const PRIVATE_LOCAL = new Set(["residential", "living_street"]);

/** SNAP-108: minor ways that divide a block into lots without being barriers. */
export const MINOR_HIGHWAY = new Set(["service", "footway", "path", "cycleway", "track", "steps", "bridleway"]);

/** SNAP-108: `barrier=*` lines that mark where a lot ends. */
export const LOT_BARRIER = new Set(["fence", "wall", "hedge", "retaining_wall", "city_wall"]);

/** LAT-003 / LAT-009: a footway, path or cycleway mapped separately as a street's sidewalk. */
export const isSidewalk = (t: Tags) =>
  t.footway === "sidewalk" || t.path === "sidewalk" || t.cycleway === "sidewalk";

/** LAT-008: water mapped as an area. */
export const isWaterArea = (t: Tags) =>
  t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir" || t.landuse === "basin";

/** KIND-005: `residential=*` values that name a kind of housing, by tier. */
export const RESIDENTIAL_TIER: Record<string, TierKind> = {
  rural: "R1",
  single_family: "R2",
  detached: "R2",
  duplex: "R3",
  terrace: "R4",
  terraced: "R4",
  apartments: "R5",
  urban: "R5",
  block: "R5",
};

/** IMP-002: exclusive context, each with its colour class (REN-015). */
export const EXCLUSIVE: Record<string, Record<string, CtxClass>> = {
  landuse: {
    forest: "wood", farmland: "farm", meadow: "green", orchard: "farm", vineyard: "farm", cemetery: "cemetery",
    allotments: "farm", recreation_ground: "green", railway: "grey", construction: "construction", brownfield: "grey",
    greenfield: "farm", military: "grey", religious: "civic", farmyard: "farm", quarry: "grey", landfill: "grey",
    plant_nursery: "farm", education: "education", institutional: "civic",
  },
  leisure: { park: "park", golf_course: "green", sports_centre: "civic", stadium: "civic", nature_reserve: "green" },
  natural: {
    wood: "wood", scrub: "wood", heath: "green", grassland: "green", wetland: "green", sand: "farm", beach: "farm",
    bare_rock: "grey",
  },
};

/** IMP-003: overlay context, each with its colour class. */
export const OVERLAY: Record<string, Record<string, CtxClass>> = {
  landuse: { grass: "green", flowerbed: "green", village_green: "green" },
  leisure: { garden: "green", playground: "green", pitch: "green", dog_park: "green" },
  amenity: { parking: "grey" },
};

/** IMP-013, BLD-004: amenities whose grounds and buildings are education land. */
export const EDUCATION_AMENITY = new Set(["school", "university", "college", "kindergarten"]);

/** BLD-002: `building=*` values that name a kind of building, by look. */
export const BUILDING_LOOK: Record<string, BuildingLook> = {
  farm: "R1", farmhouse: "R1", cabin: "R1", static_caravan: "R1",
  house: "R2", detached: "R2", bungalow: "R2",
  semidetached_house: "R3",
  terrace: "R4",
  apartments: "R5", dormitory: "R5",
  residential: "RU",
  commercial: "COM", office: "COM", hotel: "COM",
  retail: "RET", supermarket: "RET", kiosk: "RET",
  industrial: "IND", warehouse: "IND", manufacture: "IND", factory: "IND", hangar: "IND",
  school: "EDU", university: "EDU", college: "EDU", kindergarten: "EDU",
  hospital: "CIVIC",
  church: "CIVIC", cathedral: "CIVIC", chapel: "CIVIC", mosque: "CIVIC", synagogue: "CIVIC", temple: "CIVIC",
  public: "CIVIC", government: "CIVIC", civic: "CIVIC", fire_station: "CIVIC", train_station: "CIVIC",
};

/** TYPE-008: the one `building=*` value the editor writes for each paintable kind. R1 names no building (TYPE-009). */
export const BUILDING_WRITE: Partial<Record<PaintKind, string>> = {
  R2: "house",
  R3: "semidetached_house",
  R4: "terrace",
  R5: "apartments",
  R6: "apartments", // Q-002
  COM: "commercial",
  RET: "retail",
  IND: "industrial",
};

/** TYPE-001: `building=*` values that say nothing about what the building is, so it may be guessed. */
export const UNTYPED_BUILDING = new Set(["yes", "residential"]);

/** BLD-004: amenities that make an untyped building civic. */
export const CIVIC_AMENITY = new Set(["hospital", "place_of_worship", "townhall", "library", "fire_station", "police"]);
