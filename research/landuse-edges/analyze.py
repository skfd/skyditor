"""Measures how landuse edges are drawn in OSM sample areas (see README.md for what each metric means).

    python analyze.py [--areas areas.txt] extracts/*.osm > results.json

With --areas, each file named <name>.osm is centred on that area's lat/lon; otherwise on its bounds.
"""
import argparse, collections, json, math, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree
from osmload import Area, BARRIER_HW, FENCE, MINOR_HW, PAINT

STEP = 2.0          # m between boundary samples
FACING = 30.0       # m: an edge within this of a road centreline, and parallel to it, faces that road
PARALLEL = 15.0     # degrees
INNER = 20.0        # m: an edge farther than this from every road centreline is inside the block
FOLLOWS = 1.0       # m: an inner edge this close to a feature follows it
SHARED = 0.3        # m: closer than this counts as the same line


def samples(geom, step):
    """Points every `step` m along polygon boundaries, each with the local direction."""
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    out = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            L = ring.length
            for t in np.arange(step / 2, L, step):
                a, b = ring.interpolate(max(0, t - 0.5)), ring.interpolate(min(L, t + 0.5))
                out.append((ring.interpolate(t), math.atan2(b.y - a.y, b.x - a.x)))
    return out


def angdiff(a, b):
    d = abs(a - b) % math.pi
    return min(d, math.pi - d)


def pct(xs, ps=(10, 50, 90)):
    return [round(float(np.percentile(xs, p)), 1) for p in ps] if len(xs) else None


def share(n, total):
    return round(100 * n / max(1, total), 1)


def is_sidewalk(t):
    return t.get("footway") == "sidewalk" or t.get("path") == "sidewalk" or t.get("cycleway") == "sidewalk"


def analyze(path, centre=None):
    A = Area(path, centre)
    core = A.core
    roads, sidewalks, minors, fences = [], [], [], []
    for wid, (nds, t) in A.ways.items():
        hw = t.get("highway")
        if hw in BARRIER_HW and t.get("area") != "yes" and t.get("tunnel", "no") == "no" and t.get("covered") != "yes":
            roads.append((wid, A.line(wid), hw, nds))
        elif hw in MINOR_HW and is_sidewalk(t):
            sidewalks.append(A.line(wid))
        elif hw in MINOR_HW:
            minors.append(A.line(wid))
        if t.get("barrier") in FENCE:
            fences.append(A.line(wid))
    paint, other, buildings = [], [], []
    for aid, g, t, nds in A.areas():
        if g.is_empty or g.area < 1:
            continue
        if "building" in t:
            buildings.append(g)
        elif t.get("landuse") in PAINT:
            paint.append((aid, g, t["landuse"], t, nds))
        elif t.get("landuse") or t.get("leisure") or t.get("natural") or t.get("amenity") in (
                "school", "university", "college", "kindergarten", "parking", "hospital"):
            other.append((aid, g, t, nds))

    R = {"name": os.path.splitext(os.path.basename(path))[0]}
    road_lines = [r[1] for r in roads]
    road_core = sum(l.intersection(core).length for l in road_lines)
    R["road_m"] = round(road_core)
    R["sidewalk_m"] = round(sum(l.intersection(core).length for l in sidewalks))
    R["counts"] = dict(collections.Counter(p[2] for p in paint))
    R["residential_subtags"] = dict(collections.Counter(p[3].get("residential", "-") for p in paint if p[2] == "residential"))
    if not paint or not roads:
        return R
    paint_union = unary_union([p[1] for p in paint])
    R["paint_cover"] = round(paint_union.intersection(core).area / core.area, 2)
    R["any_cover"] = round(unary_union([paint_union] + [o[1] for o in other]).intersection(core).area / core.area, 2)

    # 1. Glue to roads: landuse nodes that are also road nodes.
    road_nodes = {n for r in roads for n in r[3]}
    pn = [n for p in paint for n in p[4] if core.contains(Point(A.nodes[n]))]
    R["nodes_on_road_pct"] = share(sum(n in road_nodes for n in pn), len(pn))
    R["polys_sharing_road_node_pct"] = share(sum(bool(p[4] & road_nodes) for p in paint), len(paint))

    # 2. Roads inside landuse, by class, and how many of those are dead ends.
    hw_ends = collections.Counter(n for nds, t in A.ways.values() if t.get("highway") in BARRIER_HW for n in nds)
    inner_paint = paint_union.buffer(-1)
    eng = collections.defaultdict(lambda: [0.0, 0.0])
    dead = [0.0, 0.0]
    for wid, l, hw, nds in roads:
        lc = l.intersection(core)
        if lc.length == 0:
            continue
        inside = lc.intersection(inner_paint).length
        eng[hw][0] += inside
        eng[hw][1] += lc.length
        if inside > 0.5 * lc.length:
            dead[1] += lc.length
            if any(hw_ends[n] == 1 for n in (nds[0], nds[-1])):
                dead[0] += lc.length
    R["roads_inside_landuse_pct"] = share(sum(v[0] for v in eng.values()), road_core)
    R["roads_inside_by_class"] = {k: f"{share(v[0], v[1])}% of {round(v[1])} m" for k, v in eng.items() if v[1] > 100}
    R["roads_inside_dead_end_pct"] = share(dead[0], dead[1])

    # 3. Road-facing edges: distance from the centreline, and where the sidewalk is.
    rtree = STRtree(road_lines)
    swtree = STRtree(sidewalks) if sidewalks else None
    ftree = STRtree(fences) if fences else None
    mtree = STRtree(minors) if minors else None
    btree = STRtree([b.exterior for b in buildings if b.geom_type == "Polygon"]) if buildings else None
    near = lambda tree, pt, d: tree is not None and any(tree.geometries[j].distance(pt) < d for j in tree.query(pt.buffer(d)))
    dist = collections.defaultdict(list)
    beyond_sw, sw_inside, sw_cases = [], 0, 0
    inner = collections.Counter()
    gaps = []
    for aid, g, lu, t, nds in paint:
        rest = [p[1] for p in paint if p[0] != aid] + [o[1] for o in other]
        neighbours = unary_union([r for r in rest if r.distance(g) < 8])
        edges = unary_union([r.boundary for r in rest]) if rest else None
        for pt, ang in samples(g, STEP):
            if not core.contains(pt):
                continue
            i = rtree.nearest(pt)
            rl = road_lines[i]
            d = rl.distance(pt)
            s = rl.project(pt)
            foot = rl.interpolate(s)
            fa, fb = rl.interpolate(max(0, s - 1)), rl.interpolate(min(rl.length, s + 1))
            rang = math.atan2(fb.y - fa.y, fb.x - fa.x)
            if d <= FACING and angdiff(ang, rang) < math.radians(PARALLEL):
                dist[roads[i][2]].append(d)
                if swtree is not None and d > 0.5:
                    ux, uy = (pt.x - foot.x) / d, (pt.y - foot.y) / d
                    ray = LineString([foot, (foot.x + ux * (d + 12), foot.y + uy * (d + 12))])
                    hits = [sidewalks[j] for j in swtree.query(ray) if sidewalks[j].intersects(ray)]
                    if hits:
                        ds = min(foot.distance(h.intersection(ray)) for h in hits)
                        sw_cases += 1
                        if ds <= d + SHARED:
                            beyond_sw.append(d - ds)
                        else:
                            sw_inside += 1
            elif d > INNER:
                # 4. What an edge inside the block follows.
                hit = []
                if near(ftree, pt, FOLLOWS): hit.append("fence/wall/hedge")
                if near(btree, pt, FOLLOWS): hit.append("building")
                if edges is not None and edges.distance(pt) < SHARED: hit.append("other landuse edge")
                if near(mtree, pt, FOLLOWS): hit.append("path/service")
                inner[hit[0] if hit else "nothing"] += 1
            # 5. Gaps to neighbouring landuse in the same block (the gap line must not cross a road).
            if not neighbours.is_empty and not neighbours.buffer(-SHARED).contains(pt):
                q = nearest_points(pt, neighbours.boundary)[1]
                gd = pt.distance(q)
                if gd < 8 and (gd < SHARED or not any(road_lines[j].intersects(LineString([pt, q])) for j in rtree.query(LineString([pt, q])))):
                    gaps.append(gd)
    alld = sum(dist.values(), [])
    R["facing_dist_by_class"] = {k: {"n": len(v), "p10/50/90": pct(v)} for k, v in dist.items() if len(v) >= 20}
    R["facing_dist_hist_pct"] = {lab: share(sum(lo <= x < hi for x in alld), len(alld)) for lab, lo, hi in
                                 [("<0.5", 0, 0.5), ("0.5-3", 0.5, 3), ("3-6", 3, 6), ("6-10", 6, 10), ("10-15", 10, 15), ("15-30", 15, 31)]}
    R["sidewalk"] = {"cases": sw_cases, "inside_landuse_pct": share(sw_inside, sw_cases), "edge_beyond_sidewalk_m": pct(beyond_sw)}
    R["inner_edge_n"] = sum(inner.values())
    R["inner_edge_follows_pct"] = {k: share(v, R["inner_edge_n"]) for k, v in inner.most_common()}
    R["neighbour_gap_pct"] = {"n": len(gaps), "<0.3 shared": share(sum(x < SHARED for x in gaps), len(gaps)),
                              "0.3-2": share(sum(SHARED <= x < 2 for x in gaps), len(gaps)), "2-8": share(sum(x >= 2 for x in gaps), len(gaps))}
    # Nodes a paintable polygon shares with another paintable polygon or with context.
    other_nodes = {n for o in other for n in o[3]}
    uses = collections.Counter(n for p in paint for n in p[4])
    core_nodes = {n for n in uses if core.contains(Point(A.nodes[n]))}
    R["nodes_shared_with_landuse_pct"] = share(sum(uses[n] > 1 or n in other_nodes for n in core_nodes), len(core_nodes))

    # 6. Shape.
    segs, turns, dens = [], [], []
    for aid, g, *_ in paint:
        for p in ([g] if g.geom_type == "Polygon" else list(g.geoms)):
            c = list(p.exterior.coords)[:-1]
            if len(c) < 3:
                continue
            dens.append(100 * len(c) / p.exterior.length)
            for k in range(len(c)):
                a, b, cc = c[k - 1], c[k], c[(k + 1) % len(c)]
                segs.append(math.dist(a, b))
                t1, t2 = math.atan2(b[1] - a[1], b[0] - a[0]), math.atan2(cc[1] - b[1], cc[0] - b[0])
                turns.append(abs(math.degrees((t2 - t1 + math.pi) % (2 * math.pi) - math.pi)))
    turns = np.array(turns)
    R["nodes_per_100m"] = pct(dens)
    R["segment_m"] = pct(segs)
    R["turn_pct"] = {"<5": share(np.sum(turns < 5), len(turns)), "5-30": share(np.sum((turns >= 5) & (turns < 30)), len(turns)),
                     "30-80": share(np.sum((turns >= 30) & (turns < 80)), len(turns)),
                     "80-100": share(np.sum((turns >= 80) & (turns <= 100)), len(turns)), ">100": share(np.sum(turns > 100), len(turns))}

    # 7. Buildings split by a landuse edge.
    touching = [b for b in buildings if b.intersects(core) and b.intersects(paint_union)]
    R["buildings_touching"] = len(touching)
    R["buildings_split_pct"] = share(sum(0.05 < b.intersection(paint_union).area / b.area < 0.95 for b in touching), len(touching))
    return R


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--areas")
    ap.add_argument("-j", type=int, default=os.cpu_count())
    a = ap.parse_args()
    centres = {}
    if a.areas:
        for line in open(a.areas):
            f = line.split("#")[0].split()
            if len(f) == 3:
                centres[f[0]] = (float(f[1]), float(f[2]))
    jobs = [(f, centres.get(os.path.splitext(os.path.basename(f))[0])) for f in a.files]
    with ProcessPoolExecutor(a.j) as ex:
        out = list(ex.map(analyze, *zip(*jobs)))
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
