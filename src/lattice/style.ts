// LAT-009: does the existing landuse of an area stop at the kerb or at the property line?
import { difference, lengthInside, offset, union } from "../geo/clip";
import type { Features } from "../osm/features";
import { TUNE } from "../tuning";

export type StreetStyle = "kerb" | "property_line";

// How close to a landuse edge a sidewalk must run to say which side of it the edge is on, m. The study
// (research/landuse-edges/analyze.py) looked from the street out to 12 m past the edge; property-line
// edges sit 1–3 m past the sidewalk, kerb-style ones a sidewalk's width or two short of it.
const NEAR_EDGE = 6;

/**
 * Kerb style when most sidewalk running along existing landuse edges lies inside the landuse, over at least
 * TUNE-STYLE-EVIDENCE of it; property line otherwise, including where nothing says.
 */
export function streetStyle(f: Features): StreetStyle {
  if (f.sidewalks.length === 0) return "property_line";
  const land = union(...f.areas.filter((a) => a.klass.cls === "paintable").map((a) => a.shape));
  if (land.length === 0) return "property_line";
  const inside = lengthInside(f.sidewalks, difference(land, offset(land, -NEAR_EDGE)));
  const outside = lengthInside(f.sidewalks, difference(offset(land, NEAR_EDGE), land));
  if (inside + outside < TUNE.STYLE_EVIDENCE) return "property_line";
  return inside > outside ? "kerb" : "property_line";
}
