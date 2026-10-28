"""Prints results.json from analyze.py as tables.  python summarize.py results.json"""
import json, sys

rows = [r for r in json.load(open(sys.argv[1])) if "paint_cover" in r]
skipped = [r["name"] for r in json.load(open(sys.argv[1])) if "paint_cover" not in r]
w = max(len(r["name"]) for r in rows)

print("Road-facing edges. cover = paintable landuse share of the square; glue = landuse nodes on roads;")
print("inside = road length inside landuse; dist = edge distance from centreline (% of samples);")
print("swIn = separately mapped sidewalk inside landuse; beyond = edge distance past the sidewalk p10/50/90.")
print(f"{'area':{w}} cover polys glue% inside%  <0.5 0.5-3   3-6  6-10 10-15 15-30  swIn%  beyond")
for r in rows:
    h, s = r["facing_dist_hist_pct"], r["sidewalk"]
    sw = (f"{s['inside_landuse_pct']:6} {s['edge_beyond_sidewalk_m']}" if s["cases"] >= 20 else "     -  -")
    print(f"{r['name']:{w}} {r['paint_cover']:5} {sum(r['counts'].values()):5} {r['nodes_on_road_pct']:5} {r['roads_inside_landuse_pct']:7} "
          + " ".join(f"{v:5}" for v in h.values()) + f" {sw}")

print("\nEdge distance from centreline by road class, p10/50/90 m:")
for r in rows:
    print(f"  {r['name']:{w}} " + "  ".join(f"{k} {v['p10/50/90']}" for k, v in sorted(r["facing_dist_by_class"].items())))

print("\nRoads inside landuse, by class (and share of those that are dead ends):")
for r in rows:
    print(f"  {r['name']:{w}} dead-end {r['roads_inside_dead_end_pct']}%  {r['roads_inside_by_class']}")

print("\nInner-block edges (> 20 m from any road) follow:")
for r in rows:
    print(f"  {r['name']:{w}} n={r['inner_edge_n']:<5} {r['inner_edge_follows_pct']}")

print("\nNeighbouring landuse in the same block: gap widths, and nodes shared with other landuse:")
for r in rows:
    print(f"  {r['name']:{w}} {r['neighbour_gap_pct']}  shared nodes {r['nodes_shared_with_landuse_pct']}%")

print("\nShape: nodes per 100 m, segment length (m), turn angles (% of vertices), buildings split:")
for r in rows:
    print(f"  {r['name']:{w}} {r['nodes_per_100m']} {r['segment_m']} {r['turn_pct']} split {r['buildings_split_pct']}% of {r['buildings_touching']}")

print("\nTags:")
for r in rows:
    print(f"  {r['name']:{w}} {r['counts']} residential=* {r['residential_subtags']}")
if skipped:
    print("\nNo paintable landuse (skipped):", ", ".join(skipped))
