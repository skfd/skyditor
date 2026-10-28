"""Loads an OSM XML file into local metres (x east, y north) around its centre, with shapely geometry."""
import gzip, math
import xml.etree.ElementTree as ET
from shapely.geometry import LineString, Polygon, box
from shapely.ops import polygonize, unary_union

# Mirrors LAT-001 in REQUIREMENTS.md.
BARRIER_HW = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
              "pedestrian", "road", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
# Mirrors SNAP-108.
MINOR_HW = {"service", "footway", "path", "cycleway", "track", "steps", "bridleway"}
# Mirrors KIND-001.
PAINT = {"residential", "commercial", "retail", "industrial"}
FENCE = {"fence", "wall", "hedge", "retaining_wall", "city_wall"}


class Area:
    def __init__(self, path, centre=None, core_half=300):
        root = ET.parse(gzip.open(path) if str(path).endswith(".gz") else path).getroot()
        raw = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.iter("node")}
        if centre:
            self.lat0, self.lon0 = centre
        else:
            b = root.find("bounds")
            if b is not None:
                self.lat0 = (float(b.get("minlat")) + float(b.get("maxlat"))) / 2
                self.lon0 = (float(b.get("minlon")) + float(b.get("maxlon"))) / 2
            else:
                lats = [p[0] for p in raw.values()]; lons = [p[1] for p in raw.values()]
                self.lat0, self.lon0 = (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2
        k = math.cos(math.radians(self.lat0))
        self.nodes = {i: ((lon - self.lon0) * 111320 * k, (lat - self.lat0) * 110574) for i, (lat, lon) in raw.items()}
        self.ways = {}
        for w in root.iter("way"):
            nds = [nd.get("ref") for nd in w.iter("nd")]
            if len(nds) >= 2 and all(n in self.nodes for n in nds):
                self.ways[w.get("id")] = (nds, {t.get("k"): t.get("v") for t in w.iter("tag")})
        self.rels = []
        for r in root.iter("relation"):
            tags = {t.get("k"): t.get("v") for t in r.iter("tag")}
            if tags.get("type") != "multipolygon":
                continue
            mem = [(m.get("ref"), m.get("role")) for m in r.iter("member") if m.get("type") == "way"]
            # Incomplete relations are skipped; extract with a complete strategy to keep them (see README).
            if mem and all(ref in self.ways for ref, _ in mem):
                self.rels.append((r.get("id"), mem, tags))
        self.core = box(-core_half, -core_half, core_half, core_half)

    def line(self, wid):
        return LineString([self.nodes[n] for n in self.ways[wid][0]])

    def areas(self):
        """(id, polygon, tags, node ids) for closed ways and complete multipolygons."""
        out = []
        for wid, (nds, tags) in self.ways.items():
            if nds[0] == nds[-1] and len(nds) >= 4 and tags.get("area") != "no":
                p = Polygon([self.nodes[n] for n in nds])
                out.append(("w" + wid, p if p.is_valid else p.buffer(0), tags, set(nds)))
        for rid, mem, tags in self.rels:
            outer = unary_union(list(polygonize(unary_union([self.line(r) for r, role in mem if role in ("outer", "")]))))
            inner = [self.line(r) for r, role in mem if role == "inner"]
            g = outer.difference(unary_union(list(polygonize(unary_union(inner))))) if inner else outer
            if not g.is_empty:
                out.append(("r" + rid, g, tags, {n for r, _ in mem for n in self.ways[r][0]}))
        return out
