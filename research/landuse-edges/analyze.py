"""Measures how landuse edges are drawn in OSM sample areas (see README.md for what each metric means).

    python analyze.py [--areas areas.txt] 'squares/*.osm.gz' > results.json

With --areas, each file named <name>.osm[.gz] is centred on that area's lat/lon (and tagged with its city and
country when the areas file has them); otherwise on its bounds. Per-area percentiles are for reading one
area; the `h_*` histograms and `q2_*`, `q4_*` sums are what report.py pools across areas.
"""
import argparse, collections, glob, json, math, os, sys, traceback
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, polygonize, unary_union
from shapely.strtree import STRtree
from osmload import Area, BARRIER_HW, FENCE, MINOR_HW, PAINT

STEP = 2.0          # m between boundary samples
FACING = 30.0       # m: an edge within this of a road centreline, and parallel to it, faces that road
PARALLEL = 15.0     # degrees
INNER = 20.0        # m: an edge farther than this from every road centreline is inside the block
FOLLOWS = 1.0       # m: an inner edge this close to a feature follows it
SHARED = 0.3        # m: closer than this counts as the same line
ALONG = 20.0        # degrees: an edge near a building outline and this parallel to it runs along the wall
BIN = 0.25          # m: histogram bin for distances
CAR = BARRIER_HW | {"service"}
# What an inner edge can follow, in the order used when one sample matches several (first match).
TARGETS = ["fence", "wall", "hedge", "retaining_wall", "kerb", "building wall", "other landuse edge",
           "footway/path", "service road", "inside building", "crosses building"]


def samples(geom, step):
    """(ring, position along it, point, local direction) every `step` m along polygon boundaries."""
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    out = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            L = ring.length
            for t in np.arange(step / 2, L, step):
                a, b = ring.interpolate(max(0, t - 0.5)), ring.interpolate(min(L, t + 0.5))
                out.append((ring, float(t), ring.interpolate(t), math.atan2(b.y - a.y, b.x - a.x)))
    return out


def angdiff(a, b):
    d = abs(a - b) % math.pi
    return min(d, math.pi - d)


def direction(line, pt):
    s = line.project(pt)
    a, b = line.interpolate(max(0, s - 0.5)), line.interpolate(min(line.length, s + 0.5))
    return math.atan2(b.y - a.y, b.x - a.x)


def pct(xs, ps=(10, 50, 90)):
    return [round(float(np.percentile(xs, p)), 1) for p in ps] if len(xs) else None


def share(n, total):
    return round(100 * n / max(1, total), 1)


def hist(xs, bin=BIN):
    """Sparse histogram {bin index: count}; report.py adds these up across areas."""
    return dict(collections.Counter(int(x / bin) for x in xs))


def is_sidewalk(t):
    return t.get("footway") == "sidewalk" or t.get("path") == "sidewalk" or t.get("cycleway") == "sidewalk"


def num(v):
    try:
        return float(str(v).split(";")[0].replace(",", ".").replace("m", "").strip())
    except ValueError:
        return None


def turn(a, b, c):
    t1, t2 = math.atan2(b[1] - a[1], b[0] - a[0]), math.atan2(c[1] - b[1], c[0] - b[0])
    return abs(math.degrees((t2 - t1 + math.pi) % (2 * math.pi) - math.pi))


def vertices(ring):
    """(position along the ring, turn angle) for each vertex of a closed ring."""
    c = list(ring.coords)[:-1]
    out, t = [], 0.0
    for k in range(len(c)):
        out.append((t, turn(c[k - 1], c[k], c[(k + 1) % len(c)])))
        t += math.dist(c[k], c[(k + 1) % len(c)])
    return out


def square_name(path):
    return os.path.basename(path).split(".")[0]


def analyze(path, centre=None, meta=None):
    try:
        return _analyze(path, centre, meta)
    except Exception:
        return {"name": square_name(path), **(meta or {}), "error": traceback.format_exc(limit=3)}


def _analyze(path, centre=None, meta=None):
    A = Area(path, centre)
    core = A.core
    roads, cars, sidewalks, minors, service = [], [], [], [], []
    barriers = collections.defaultdict(list)
    for wid, (nds, t) in A.ways.items():
        hw = t.get("highway")
        open_road = t.get("area") != "yes" and t.get("tunnel", "no") == "no" and t.get("covered") != "yes"
        if hw in BARRIER_HW and open_road:
            roads.append((wid, A.line(wid), hw, nds, t))
        if hw in CAR and open_road:
            cars.append((wid, A.line(wid), hw, nds, t))
        if hw in MINOR_HW and is_sidewalk(t):
            sidewalks.append(A.line(wid))
        elif hw == "service":
            service.append(A.line(wid))
        elif hw in MINOR_HW:
            minors.append(A.line(wid))
        b = t.get("barrier")
        if b in FENCE or b == "kerb":
            barriers[{"city_wall": "wall"}.get(b, b)].append(A.line(wid))
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

    R = {"name": square_name(path), **(meta or {})}
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

    # 2. Roads inside landuse: by class, and (Q2) by dead end, loop and access tags, as [inside m, total m].
    ways_on = collections.defaultdict(set)  # node -> car roads through it
    for wid, _, _, nds, _ in cars:
        for n in nds:
            ways_on[n].add(wid)
    inner_paint = paint_union.buffer(-1)
    eng = collections.defaultdict(lambda: [0.0, 0.0])
    q2 = {k: collections.defaultdict(lambda: [0.0, 0.0]) for k in
          ("class_end", "access", "service", "motor_vehicle", "lanes")}
    dead = [0.0, 0.0]
    for wid, l, hw, nds, t in cars:
        lc = l.intersection(core)
        if lc.length == 0:
            continue
        inside = lc.intersection(inner_paint).length
        if hw in BARRIER_HW:
            eng[hw][0] += inside
            eng[hw][1] += lc.length
        if nds[0] == nds[-1]:
            end = "closed"
        elif any(len(ways_on[n]) == 1 and core.buffer(20).contains(Point(A.nodes[n])) for n in (nds[0], nds[-1])):
            # An end outside the square may join roads the extract left out, so it is not judged.
            end = "dead end"
        elif (ways_on[nds[0]] - {wid}) & (ways_on[nds[-1]] - {wid}):
            end = "loop"  # leaves and rejoins the same road
        else:
            end = "through"
        if hw in BARRIER_HW and inside > 0.5 * lc.length:
            dead[1] += lc.length
            if end == "dead end":
                dead[0] += lc.length
        for key, val in (("class_end", f"{hw}|{end}"), ("access", f"{hw}|{t.get('access', '-')}"),
                         ("service", t.get("service", "-") if hw == "service" else None),
                         ("motor_vehicle", f"{hw}|{t.get('motor_vehicle', t.get('motorcar', '-'))}"),
                         ("lanes", f"{hw}|{t.get('lanes', '-')}")):
            if val is not None:
                q2[key][val][0] += inside
                q2[key][val][1] += lc.length
    R["roads_inside_landuse_pct"] = share(sum(v[0] for v in eng.values()), road_core)
    R["roads_inside_by_class"] = {k: f"{share(v[0], v[1])}% of {round(v[1])} m" for k, v in eng.items() if v[1] > 100}
    R["roads_inside_dead_end_pct"] = share(dead[0], dead[1])
    for k, d in q2.items():
        R["q2_" + k] = {v: [round(x[0], 1), round(x[1], 1)] for v, x in d.items()}

    # Indexes for the sample loop.
    rtree = STRtree(road_lines)
    swtree = STRtree(sidewalks) if sidewalks else None
    btargets = [(k, v) for k, v in barriers.items()]
    btrees = {k: STRtree(v) for k, v in btargets}
    mtree = STRtree(minors) if minors else None
    stree = STRtree(service) if service else None
    bpolys = [b for b in buildings if b.geom_type == "Polygon"]
    bext = [b.exterior for b in bpolys]
    btree = STRtree(bext) if bext else None
    bptree = STRtree(bpolys) if bpolys else None
    zones = [(p[0], p[1]) for p in paint] + [(o[0], o[1]) for o in other]
    zbound = [z[1].boundary for z in zones]
    ztree = STRtree([z[1] for z in zones])
    near = lambda tree, pt, d: tree is not None and any(tree.geometries[j].distance(pt) < d for j in tree.query(pt.buffer(d)))

    dist = collections.defaultdict(list)
    h_facing = collections.defaultdict(list)    # "class|sidewalk state" -> distances from the centreline
    h_beyond = collections.defaultdict(list)    # class -> distance past a separately mapped sidewalk
    h_width = collections.defaultdict(list)     # "class|width m" -> distances (property-line pairs only)
    h_lanes = collections.defaultdict(list)     # "class|lanes" -> distances
    sw_class = collections.defaultdict(lambda: [0, 0])  # class -> [sidewalk inside landuse, sidewalk outside]
    beyond_sw, sw_inside, sw_cases = [], 0, 0
    inner = collections.Counter()
    inner_any = collections.Counter()
    gaps = []
    runs = []  # (length m, max deviation from the chord m, vertices, turn angles) for "nothing" runs
    for aid, g, lu, t, nds in paint:
        rows = []
        for ring, pos, pt, ang in samples(g, STEP):
            if not core.contains(pt):
                rows.append((ring, pos, pt, "out"))
                continue
            i = rtree.nearest(pt)
            rl = road_lines[i]
            d = rl.distance(pt)
            hw, rt = roads[i][2], roads[i][4]
            kind = "other"
            if d <= FACING and angdiff(ang, direction(rl, pt)) < math.radians(PARALLEL):
                kind = "facing"
                dist[hw].append(d)
                state = "no sidewalk"
                if swtree is not None and d > 0.5:
                    foot = nearest_points(rl, pt)[0]
                    ux, uy = (pt.x - foot.x) / d, (pt.y - foot.y) / d
                    ray = LineString([foot, (foot.x + ux * (d + 12), foot.y + uy * (d + 12))])
                    hits = [sidewalks[j] for j in swtree.query(ray) if sidewalks[j].intersects(ray)]
                    if hits:
                        ds = min(foot.distance(h.intersection(ray)) for h in hits)
                        sw_cases += 1
                        if ds <= d + SHARED:
                            beyond_sw.append(d - ds)
                            h_beyond[hw].append(d - ds)
                            sw_class[hw][1] += 1
                            state = "sidewalk outside"
                        else:
                            sw_inside += 1
                            sw_class[hw][0] += 1
                            state = "sidewalk inside"
                h_facing[f"{hw}|{state}"].append(d)
                w = num(rt.get("width"))
                if w is not None and 2 <= w <= 40:
                    h_width[f"{hw}|{round(w)}"].append(d)
                h_lanes[f"{hw}|{rt.get('lanes', '-')}"].append(d)
            elif d > INNER:
                # 3. What an edge inside the block follows: every match (inner_any) and the first (inner).
                kind = "inner"
                hit = []
                for k in ("fence", "wall", "hedge", "retaining_wall", "kerb"):
                    if near(btrees.get(k), pt, FOLLOWS):
                        hit.append(k)
                if btree is not None:
                    j = btree.nearest(pt)
                    if bext[j].distance(pt) < FOLLOWS:
                        hit.append("building wall" if angdiff(ang, direction(bext[j], pt)) < math.radians(ALONG)
                                   else "crosses building")
                cands = [j for j in ztree.query(pt.buffer(SHARED)) if zones[j][0] != aid]
                if any(zbound[j].distance(pt) < SHARED for j in cands):
                    hit.append("other landuse edge")
                if near(mtree, pt, FOLLOWS): hit.append("footway/path")
                if near(stree, pt, FOLLOWS): hit.append("service road")
                if bptree is not None and "building wall" not in hit and "crosses building" not in hit and \
                        len(bptree.query(pt, predicate="within")):
                    hit.append("inside building")
                hit.sort(key=TARGETS.index)
                inner[hit[0] if hit else "nothing"] += 1
                for h in hit:
                    inner_any[h] += 1
                if not hit:
                    kind = "nothing"
            rows.append((ring, pos, pt, kind))
            # 5. Gaps to neighbouring landuse in the same block (the gap line must not cross a road).
            cands = [j for j in ztree.query(pt.buffer(8)) if zones[j][0] != aid]
            if cands and not any(zones[j][1].contains(pt) and zbound[j].distance(pt) > SHARED for j in cands):
                q = min((nearest_points(pt, zbound[j])[1] for j in cands), key=pt.distance)
                gd = pt.distance(q)
                if gd < 8 and (gd < SHARED or not any(road_lines[j].intersects(LineString([pt, q])) for j in rtree.query(LineString([pt, q])))):
                    gaps.append(gd)
        # 6. Runs of inner edge that follow nothing: length, straightness, vertices and their angles.
        run = []
        for k, row in enumerate(rows + [(None, 0, None, "end")]):
            if row[3] == "nothing" and (not run or (row[0] is run[-1][0] and row[1] - run[-1][1] <= STEP + 0.01)):
                run.append(row)
                continue
            if len(run) >= 3:
                ring, t0, t1 = run[0][0], run[0][1], run[-1][1]
                chord = LineString([run[0][2], run[-1][2]])
                dev = max(chord.distance(r[2]) for r in run)
                vs = [a for t, a in vertices(ring) if t0 <= t <= t1 and a >= 5]
                runs.append((t1 - t0 + STEP, round(dev, 2), len(vs), [round(a) for a in vs]))
            run = [row] if row[3] == "nothing" else []

    alld = sum(dist.values(), [])
    R["facing_dist_by_class"] = {k: {"n": len(v), "p10/50/90": pct(v)} for k, v in dist.items() if len(v) >= 20}
    R["facing_dist_hist_pct"] = {lab: share(sum(lo <= x < hi for x in alld), len(alld)) for lab, lo, hi in
                                 [("<0.5", 0, 0.5), ("0.5-3", 0.5, 3), ("3-6", 3, 6), ("6-10", 6, 10), ("10-15", 10, 15), ("15-30", 15, 31)]}
    R["sidewalk"] = {"cases": sw_cases, "inside_landuse_pct": share(sw_inside, sw_cases), "edge_beyond_sidewalk_m": pct(beyond_sw)}
    R["sidewalk_by_class"] = {k: v for k, v in sw_class.items()}
    R["h_facing"] = {k: hist(v) for k, v in h_facing.items()}
    R["h_beyond"] = {k: hist(v) for k, v in h_beyond.items()}
    R["h_width"] = {k: hist(v) for k, v in h_width.items()}
    R["h_lanes"] = {k: hist(v) for k, v in h_lanes.items()}
    R["inner_edge_n"] = sum(inner.values())
    R["inner_edge_follows_pct"] = {k: share(v, R["inner_edge_n"]) for k, v in inner.most_common()}
    R["inner_first"] = dict(inner)
    R["inner_any"] = dict(inner_any)
    R["nothing_runs"] = runs
    R["neighbour_gap_pct"] = {"n": len(gaps), "<0.3 shared": share(sum(x < SHARED for x in gaps), len(gaps)),
                              "0.3-2": share(sum(SHARED <= x < 2 for x in gaps), len(gaps)), "2-8": share(sum(x >= 2 for x in gaps), len(gaps))}
    R["h_gap"] = hist(gaps)
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
                segs.append(math.dist(c[k - 1], c[k]))
                turns.append(turn(c[k - 1], c[k], c[(k + 1) % len(c)]))
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

    # 4. Lots: faces cut by roads, fences, walls, hedges and context edges. Faces touching the square's edge
    # are cut short and left out. A lot "fits" a landuse polygon when at least 60% of it lies in that polygon
    # (lots run to the road centreline, landuse stops short of it); q4_fit sums, per polygon, the polygon area
    # those fitting lots cover, against the polygon area: how much of the landuse whole lots could paint.
    dividers = road_lines + [l for k in ("fence", "wall", "hedge", "retaining_wall") for l in barriers.get(k, [])] \
        + [o[1].boundary for o in other] + [core.exterior]
    faces = [f for f in polygonize(unary_union([d.intersection(core.buffer(1)) for d in dividers]))
             if f.area > 20 and not f.intersects(core.exterior)]
    blocks = [f for f in polygonize(unary_union([l.intersection(core.buffer(1)) for l in road_lines] + [core.exterior]))
              if f.area > 20 and not f.intersects(core.exterior)]
    R["q4_lot_areas"] = [round(f.area) for f in faces if f.intersects(paint_union)]
    R["q4_block_areas"] = [round(f.area) for f in blocks if f.intersects(paint_union)]
    fit = [0.0, 0.0]
    ftree = STRtree(faces) if faces else None
    for aid, g, *_ in paint:
        gc = g.intersection(core)
        if gc.area < 100:
            continue
        fit[1] += gc.area
        if ftree is None:
            continue
        for j in ftree.query(gc):
            f = faces[j]
            ov = f.intersection(gc).area
            if ov >= 0.6 * f.area:
                fit[0] += ov
    R["q4_fit"] = [round(fit[0]), round(fit[1])]
    return R


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--areas")
    ap.add_argument("-j", type=int, default=os.cpu_count())
    a = ap.parse_args()
    centres, metas = {}, {}
    if a.areas:
        for line in open(a.areas):
            f = line.split("#")[0].split()
            if len(f) >= 3:
                centres[f[0]] = (float(f[1]), float(f[2]))
            if len(f) >= 5:
                metas[f[0]] = {"city": f[3], "country": f[4]}
    # Patterns are expanded here too: a few thousand squares overflow the Windows command line.
    files = [f for pat in a.files for f in (sorted(glob.glob(pat)) or [pat])]
    jobs = [(f, centres.get(square_name(f)), metas.get(square_name(f))) for f in files]
    with ProcessPoolExecutor(a.j) as ex:
        out = list(ex.map(analyze, *zip(*jobs), chunksize=1))
    json.dump(out, sys.stdout, indent=None, separators=(",", ":"))


if __name__ == "__main__":
    main()
