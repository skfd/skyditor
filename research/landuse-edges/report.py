"""Pools analyze.py results over many squares and answers the planet-run questions (README.md), as text.

    python report.py results.json > report.txt

Squares are screened first:
- block by block: paintable landuse covers at least MIN_COVER of the square and at most MAX_INSIDE % of the
  road length runs inside it (landuse drawn per block, not across neighbourhoods);
- careful: block by block, at least MIN_INNER inner-edge samples, and at most MAX_NOTHING % of them follow
  nothing.
Q3 uses the block-by-block squares, so the "nothing" screen does not decide its own answer. The rest use
the careful squares. A square's street style comes from its sidewalks: with at least MIN_SW rays that cross a
separately mapped sidewalk, it is "kerb" when the sidewalk is inside the landuse on most of them, else
"property line".
"""
import collections, gzip, json, math, sys
import numpy as np

BIN = 0.25
MIN_COVER, MAX_INSIDE, MIN_INNER, MAX_NOTHING, MIN_SW = 0.2, 10.0, 25, 10.0, 20
MAIN = ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "pedestrian", "service"]


def load(path):
    rows = json.load(gzip.open(path) if path.endswith(".gz") else open(path))
    errs = [r for r in rows if "error" in r]
    return [r for r in rows if "paint_cover" in r], rows, errs


def style(r):
    s = r["sidewalk"]
    if s["cases"] < MIN_SW:
        return "unknown"
    return "kerb" if s["inside_landuse_pct"] >= 50 else "property line"


def blockwise(r):
    return r["paint_cover"] >= MIN_COVER and r["roads_inside_landuse_pct"] <= MAX_INSIDE


def careful(r):
    n = r["inner_edge_n"]
    return blockwise(r) and n >= MIN_INNER and 100 * r["inner_first"].get("nothing", 0) / n <= MAX_NOTHING


def add_hist(acc, h):
    for k, v in h.items():
        acc[int(k)] += v


def hstats(h, ps=(10, 25, 50, 75, 90)):
    """Percentiles and count of a {bin: count} histogram, at bin centres."""
    if not h:
        return None
    ks = sorted(h)
    vals = np.array([(k + 0.5) * BIN for k in ks])
    cnt = np.array([h[k] for k in ks], dtype=float)
    cum = np.cumsum(cnt) / cnt.sum()
    return [round(float(vals[np.searchsorted(cum, p / 100)]), 1) for p in ps], int(cnt.sum())


def fmt(st):
    if not st:
        return "-"
    (p10, p25, p50, p75, p90), n = st
    return f"{p50:5.1f} ({p25:4.1f}-{p75:4.1f}; p10-90 {p10:4.1f}-{p90:4.1f}) n={n}"


def pool(rows, key, keyfn=lambda k: k):
    acc = collections.defaultdict(lambda: collections.Counter())
    for r in rows:
        for k, h in r.get(key, {}).items():
            add_hist(acc[keyfn(k)], h)
    return acc


def r2(groups):
    """Share of the variance of the distance explained by the grouping (groups: {label: Counter of bins})."""
    xs, ws, gm = [], [], []
    for h in groups.values():
        if sum(h.values()) < 30:
            continue
        v = np.array([(k + 0.5) * BIN for k in h]); w = np.array(list(h.values()), dtype=float)
        m = np.average(v, weights=w)
        xs.append(v); ws.append(w); gm.append(np.full(len(v), m))
    if not xs:
        return None, 0
    v, w, m = np.concatenate(xs), np.concatenate(ws), np.concatenate(gm)
    mu = np.average(v, weights=w)
    tot = np.sum(w * (v - mu) ** 2)
    return round(float(1 - np.sum(w * (v - m) ** 2) / tot), 3), int(w.sum())


def wmedian(a):
    a = np.sort(np.asarray(a, dtype=float))
    return float(a[np.searchsorted(np.cumsum(a) / a.sum(), 0.5)]) if len(a) else 0.0


def section(t):
    print(f"\n## {t}\n")


def main():
    rows, allrows, errs = load(sys.argv[1])
    bb = [r for r in rows if blockwise(r)]
    ca = [r for r in rows if careful(r)]
    for r in rows:
        r["style"] = style(r)

    section("Sample")
    print(f"{len(allrows)} squares, {len(errs)} failed, {len(rows)} with paintable landuse and roads; "
          f"{len(bb)} block by block; {len(ca)} careful.")
    print(f"Screens: cover >= {MIN_COVER}, roads inside <= {MAX_INSIDE}%, inner samples >= {MIN_INNER}, "
          f"nothing <= {MAX_NOTHING}%, style needs >= {MIN_SW} sidewalk rays.\n")
    cities = collections.defaultdict(list)
    for r in allrows:
        cities[(r.get("country", "?"), r.get("city", "?"))].append(r)
    print(f"{'country city':24} squares  paint  block  careful   kerb  prop  unknown (careful)")
    for (c, city), rs in sorted(cities.items()):
        p = [r for r in rs if "paint_cover" in r]
        cc = [r for r in p if careful(r)]
        st = collections.Counter(r["style"] for r in cc)
        print(f"{c + ' ' + city:24} {len(rs):7} {len(p):6} {sum(blockwise(r) for r in p):6} {len(cc):8} "
              f"{st['kerb']:6} {st['property line']:5} {st['unknown']:8}")

    section("Q5. Street style by country (careful squares; all squares with paint in brackets)")
    by = collections.defaultdict(collections.Counter)
    byall = collections.defaultdict(collections.Counter)
    for r in ca:
        by[r.get("country", "?")][r["style"]] += 1
    for r in rows:
        byall[r.get("country", "?")][r["style"]] += 1
    print(f"{'country':8} {'kerb':>10} {'prop':>10} {'unknown':>10}   kerb share of decided")
    for c in sorted(byall):
        a, b = by[c], byall[c]
        dec = a["kerb"] + a["property line"]
        decb = b["kerb"] + b["property line"]
        print(f"{c:8} {a['kerb']:4} ({b['kerb']:3}) {a['property line']:4} ({b['property line']:3}) {a['unknown']:4} ({b['unknown']:3})"
              f"   {round(100 * a['kerb'] / dec) if dec else '-':>3}% ({round(100 * b['kerb'] / decb) if decb else '-'}%)")
    # Does style hold across a city? Agreement between decided squares of the same city, by grid distance.
    agree = collections.defaultdict(lambda: [0, 0])
    dec = [r for r in rows if r["style"] != "unknown"]
    for city in {r.get("city") for r in dec}:
        cs = [r for r in dec if r.get("city") == city]
        for i, a in enumerate(cs):
            ra, ca_ = map(int, a["name"].rsplit("_", 2)[1:])
            for b in cs[i + 1:]:
                rb, cb = map(int, b["name"].rsplit("_", 2)[1:])
                d = max(abs(ra - rb), abs(ca_ - cb))
                d = "1 (1.2 km)" if d == 1 else "2 (2.4 km)" if d == 2 else "3+ (3.6+ km)"
                agree[d][0] += a["style"] == b["style"]
                agree[d][1] += 1
    print("\nTwo squares of the same city with a decided style agree (all squares with paint):")
    for d in sorted(agree):
        print(f"  grid distance {d}: {round(100 * agree[d][0] / agree[d][1])}% of {agree[d][1]} pairs")
    # How decided is one square? The minority's share of sidewalk rays.
    mix = []
    for r in dec:
        s = r["sidewalk"]["inside_landuse_pct"]
        mix.append(min(s, 100 - s))
    mix = np.array(mix)
    print(f"\nMinority share of sidewalk rays within one square: median {np.median(mix):.0f}%, "
          f"{np.mean(mix >= 30) * 100:.0f}% of decided squares have >= 30% (mixed).")
    print("\nSidewalk inside landuse by road class, pooled rays (kerb squares | property-line squares):")
    for cls in MAIN:
        k = [r["sidewalk_by_class"].get(cls, [0, 0]) for r in dec if r["style"] == "kerb"]
        p = [r["sidewalk_by_class"].get(cls, [0, 0]) for r in dec if r["style"] == "property line"]
        ki, ko = sum(x[0] for x in k), sum(x[1] for x in k)
        pi, po = sum(x[0] for x in p), sum(x[1] for x in p)
        if ki + ko + pi + po:
            print(f"  {cls:14} {round(100 * ki / max(1, ki + ko)):3}% of {ki + ko:6} | {round(100 * pi / max(1, pi + po)):3}% of {pi + po:6}")

    section("Q1. Edge distance from the road centreline, by class (m: median (p25-p75; p10-p90))")
    for st in ("property line", "kerb"):
        rs = [r for r in ca if r["style"] == st]
        print(f"### {st} squares ({len(rs)})\n")
        fac = pool(rs, "h_facing")
        bey = pool(rs, "h_beyond")
        for cls in MAIN:
            print(f"  {cls}")
            for state in ("sidewalk outside", "sidewalk inside", "no sidewalk"):
                h = fac.get(f"{cls}|{state}")
                if h and sum(h.values()) >= 30:
                    print(f"    {state:18} {fmt(hstats(h))}")
            h = bey.get(cls)
            if h and sum(h.values()) >= 30:
                print(f"    {'past the sidewalk':18} {fmt(hstats(h))}")
        print()
    rs = [r for r in ca if r["style"] == "property line"]
    allfac = pool(rs, "h_facing", lambda k: k.split("|")[0])
    print("Edge distance in property-line squares by country (all classes; residential):")
    for c in sorted({r.get("country") for r in rs}):
        cr = [r for r in rs if r.get("country") == c]
        a = pool(cr, "h_facing", lambda k: k.split("|")[0])
        tot = collections.Counter()
        for h in a.values():
            tot.update(h)
        print(f"  {c:4} {len(cr):4} squares  all {fmt(hstats(tot))}\n{'':16}residential {fmt(hstats(a.get('residential')))}")
    # Does width or lanes predict the distance better than class? Compare on the same samples.
    wid = pool(rs, "h_width")
    lan = pool(rs, "h_lanes")
    print("\nVariance of the distance explained (R², property-line squares), compared on the same samples:")
    byc = collections.defaultdict(collections.Counter)
    byw = collections.defaultdict(collections.Counter)
    for k, h in wid.items():
        cls, w = k.split("|")
        byc[cls].update(h); byw[w].update(h)
    print(f"  samples with width=*: class {r2(byc)}, width {r2(byw)}, class+width {r2(wid)}  (R², n)")
    byc = collections.defaultdict(collections.Counter)
    byl = collections.defaultdict(collections.Counter)
    tagged = {k: h for k, h in lan.items() if not k.endswith("|-")}
    for k, h in tagged.items():
        cls, l = k.split("|")
        byc[cls].update(h); byl[l].update(h)
    print(f"  samples with lanes=*: class {r2(byc)}, lanes {r2(byl)}, class+lanes {r2(tagged)}")
    print(f"  all samples: class {r2(allfac)}")
    print("\n  distance by width=* (all classes, property-line squares):")
    for w in sorted(byw, key=lambda x: int(x)):
        if sum(byw[w].values()) >= 50:
            print(f"    width {w:>3} m: {fmt(hstats(byw[w]))}")

    section("Q2. Roads inside landuse (block-by-block squares): % of length inside, of total m")

    def q2(key, top=25, minlen=300):
        acc = collections.defaultdict(lambda: [0.0, 0.0])
        for r in bb:
            for k, (i, t) in r.get(key, {}).items():
                acc[k][0] += i; acc[k][1] += t
        items = sorted(((k, v) for k, v in acc.items() if v[1] >= minlen), key=lambda kv: -kv[1][1])[:top]
        for k, (i, t) in items:
            print(f"  {k:36} {100 * i / t:5.1f}% of {round(t):8} m")

    print("By class and how the road ends (dead end: an end that joins nothing inside the square; loop: both ends"
          " on the same road; closed: a ring):")
    q2("q2_class_end", 40)
    print("\nBy access=*:")
    q2("q2_access", 30)
    print("\nService roads by service=*:")
    q2("q2_service", 12)
    print("\nBy motor_vehicle=* (or motorcar=*):")
    q2("q2_motor_vehicle", 20)

    section("Q3. What inner-block edges follow (block-by-block squares)")
    first, anyc = collections.Counter(), collections.Counter()
    for r in bb:
        first.update(r["inner_first"]); anyc.update(r["inner_any"])
    n = sum(first.values())
    print(f"{n} samples ({n * 2 / 1000:.0f} km of edge). Any = share of samples within reach of the target; "
          "first = assigned in priority order.\n")
    print(f"  {'target':20} {'any':>6} {'first':>6}")
    for k, v in sorted(anyc.items(), key=lambda kv: -kv[1]):
        print(f"  {k:20} {100 * v / n:5.1f}% {100 * first.get(k, 0) / n:5.1f}%")
    print(f"  {'nothing':20} {'':6} {100 * first.get('nothing', 0) / n:5.1f}%")
    print("\nBy country, first match (%):")
    keys = ["fence", "wall", "hedge", "retaining_wall", "kerb", "building wall", "crosses building", "inside building",
            "other landuse edge", "footway/path", "service road", "nothing"]
    print(f"  {'':5} {'n':>6} " + " ".join(f"{k[:9]:>9}" for k in keys))
    for c in sorted({r.get("country") for r in bb}):
        f = collections.Counter()
        for r in bb:
            if r.get("country") == c:
                f.update(r["inner_first"])
        t = sum(f.values())
        if t >= 200:
            print(f"  {c:5} {t:6} " + " ".join(f"{100 * f.get(k, 0) / t:9.1f}" for k in keys))
    runs = [x for r in bb for x in r["nothing_runs"]]
    if runs:
        L = np.array([x[0] for x in runs]); dev = np.array([x[1] for x in runs]); nv = np.array([x[2] for x in runs])
        tot = L.sum()
        print(f"\nEdges that follow nothing: {len(runs)} runs, {tot / 1000:.1f} km.")
        for lo, hi in [(0, 10), (10, 30), (30, 60), (60, 120), (120, 1e9)]:
            m = (L >= lo) & (L < hi)
            print(f"  length {lo:>3}-{'' if hi > 1e8 else int(hi):<4} m: {100 * L[m].sum() / tot:5.1f}% of the length, "
                  f"straight (within 1 m of the chord) {100 * L[m & (dev < 1)].sum() / max(1, L[m].sum()):5.1f}%")
        print(f"  straight overall: {100 * L[dev < 1].sum() / tot:.0f}% of the length; "
              f"within 2 m: {100 * L[dev < 2].sum() / tot:.0f}%")

    section("Q4. Lots between roads, fences, walls, hedges and context edges (careful squares)")
    lots = np.array([a for r in ca for a in r["q4_lot_areas"]])
    blocks = np.array([a for r in ca for a in r["q4_block_areas"]])
    if len(lots):
        print(f"Faces touching paintable landuse: {len(lots)} lots, median {np.median(lots):.0f} m² "
              f"(p25 {np.percentile(lots, 25):.0f}, p75 {np.percentile(lots, 75):.0f}); "
              f"blocks between roads: {len(blocks)}, median {np.median(blocks):.0f} m².")
        print(f"Area-weighted (the lot a typical square metre is in): lots {wmedian(lots):.0f} m², "
              f"blocks {wmedian(blocks):.0f} m².")
    print("\nShare of landuse area that whole lots would cover (a lot counts when >= 60% of it is in the polygon):")
    for c in sorted({r.get("country") for r in ca}):
        f = [r["q4_fit"] for r in ca if r.get("country") == c]
        a, t = sum(x[0] for x in f), sum(x[1] for x in f)
        lc = [a_ for r in ca if r.get("country") == c for a_ in r["q4_lot_areas"]]
        if t:
            print(f"  {c:4} {100 * a / t:5.1f}% of {t / 1e6:6.2f} km²; lots area-weighted median {wmedian(lc):7.0f} m²")
    for st in ("property line", "kerb"):
        f = [r["q4_fit"] for r in ca if r["style"] == st]
        a, t = sum(x[0] for x in f), sum(x[1] for x in f)
        if t:
            print(f"  {st:14} squares: {100 * a / t:.1f}%")

    section("Q6. Shape of edges that follow nothing (block-by-block squares)")
    if runs:
        long_ = [x for x in runs if x[0] >= 20]
        L = np.array([x[0] for x in long_]); nv = np.array([x[2] for x in long_])
        print(f"Runs of 20 m or more: {len(long_)}; vertices (turn >= 5°) per 100 m, length-weighted: "
              f"{100 * nv.sum() / L.sum():.1f}; median per run {np.median(100 * nv / L):.1f}.")
        ang = np.array([a for x in long_ for a in x[3]])
        if len(ang):
            print("Turn angles at those vertices: " + ", ".join(
                f"{lo}-{hi}°: {100 * np.mean((ang >= lo) & (ang < hi)):.0f}%" for lo, hi in
                [(5, 15), (15, 30), (30, 60), (60, 80), (80, 100), (100, 181)]))
    print("\nAll paintable edges in careful squares (per square medians, pooled): nodes per 100 m "
          f"{np.median([r['nodes_per_100m'][1] for r in ca if r['nodes_per_100m']]):.1f}; "
          f"segment {np.median([r['segment_m'][1] for r in ca if r['segment_m']]):.1f} m; right-angle vertices "
          f"{np.median([r['turn_pct']['80-100'] for r in ca]):.0f}%; buildings split "
          f"{np.median([r['buildings_split_pct'] for r in ca]):.1f}%.")
    print("\nNeighbour gaps pooled (careful squares): ", end="")
    g = collections.Counter()
    for r in ca:
        add_hist(g, r["h_gap"])
    t = sum(g.values())
    print(f"shared (< 0.25 m bin) {100 * g[0] / t:.0f}%, 0.25-2 m {100 * sum(v for k, v in g.items() if 1 <= k < 8) / t:.0f}%, "
          f"2-8 m {100 * sum(v for k, v in g.items() if k >= 8) / t:.0f}%.")
    tags = collections.Counter()
    for r in rows:
        tags.update(r["residential_subtags"])
    print(f"\nresidential=* on landuse=residential (all squares): {dict(tags.most_common(8))}")


if __name__ == "__main__":
    main()
