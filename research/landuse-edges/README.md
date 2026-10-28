# Research: how good OSM landuse edges are drawn

Handoff for running this analysis on a planet file. The goal is to find out how careful mappers draw
landuse in cities, so Skyditor's snapping produces edges they would accept. These numbers will become
requirements and tuning values (REQUIREMENTS.md §0.5): street space (LAT-003, LAT-007, TUNE-HALFWIDTH)
and freeform snapping (SNAP-103, SNAP-108, SNAP-109, TUNE-SIMPLIFY).

## Why

Freeform painting commits the brush trail and only tidies the edges that land near something.
A test stroke across a 200 m block (r = 10 m) commits 59 nodes over 389 m of edge, and none of that edge
follows anything in the data. Mappers would call that noise. The aim: every committed edge follows
something real, or is a deliberate straight cut. This study says what "something real" is, and how far
from the road it sits.

## Decided so far

- **Landuse never shares nodes with roads.** Confirmed in every sample (≤ 0.8% of nodes).
- **Our style: the property line.** Landuse stops beyond the sidewalk and never includes it. The exception
  is roads inside a block, such as estate access roads, which the landuse surrounds together with their
  sidewalks. Q-003 is answered this way.
- **Later: follow the local style** (Q-008). Some cities consistently map to the kerb. The editor should
  detect the style from the existing landuse and follow it. Nothing is built for this yet.

## Running it

Needs Python ≥ 3.10 with `shapely>=2` and `numpy`, plus [osmium-tool](https://osmcode.org/osmium-tool/).

```sh
pip install shapely numpy
python extracts.py areas.txt > extracts.json                       # one bbox per area, 700 m square
osmium extract -c extracts.json -s smart -d extracts/ planet.osm.pbf   # one pass over the planet
python analyze.py --areas areas.txt extracts/*.osm > results.json
python summarize.py results.json
```

- `-s smart` keeps multipolygons that reach outside the square complete. The first batch came from the
  OSM API `map` call, which drops incomplete relations, so planet runs should cover slightly more.
- The analysis uses the central 600 m (`core_half` in `osmload.py`). The extra 50 m on each side
  supplies the roads and neighbours that edge points near the border are measured against.
- `analyze.py` runs one process per file. Each area takes a few seconds.
- No files are written outside the working directory, and nothing is uploaded.

| File | What it does |
|---|---|
| `areas.txt` | Sample centres: `name lat lon`. |
| `extracts.py` | Writes the osmium config for `areas.txt`. |
| `osmload.py` | Loads OSM XML into local metres; holds the tag sets, which mirror LAT-001, SNAP-108 and KIND-001. |
| `analyze.py` | All metrics, writing one JSON object per area. |
| `summarize.py` | Prints the results as tables. |

## What it measures

The landuse counted is the paintable kinds only (`landuse` = residential, commercial, retail, industrial).
Its boundaries are sampled every 2 m inside the central square.

| Metric | Meaning |
|---|---|
| `nodes_on_road_pct` | Share of landuse nodes that are also nodes of a barrier road. |
| `roads_inside_landuse_pct`, `_by_class`, `_dead_end_pct` | Road length more than 1 m inside landuse, by class, and the share of that length on ways with a loose end. |
| `facing_dist_*` | For edges within 30 m of a road centreline and parallel to it (< 15°): distance from the centreline. |
| `sidewalk` | Along the same perpendiculars: whether a separately mapped sidewalk (`footway=sidewalk` etc.) is inside the landuse, and how far past the sidewalk the edge sits. |
| `inner_edge_follows_pct` | For edges more than 20 m from every road: the first match within 1 m of a fence, wall or hedge; a building outline; another landuse or context edge (within 0.3 m); or a path or service road. Otherwise "nothing". |
| `neighbour_gap_pct` | Gap to the nearest other landuse or context polygon within 8 m, not counting gaps that cross a road. Below 0.3 m counts as shared. |
| `nodes_shared_with_landuse_pct` | Landuse nodes also used by another landuse or context polygon. |
| `nodes_per_100m`, `segment_m`, `turn_pct` | Node density, segment lengths, and turning angle at each vertex. |
| `buildings_split_pct` | Buildings touching landuse with between 5% and 95% of their area inside it. |

**Known limitations.** The centreline is a stand-in for the road, since there are no kerb lines.
Sidewalks are only seen where they are mapped separately. "Follows a building" includes edges that run
along a wall and edges that cross one. Each area is a single 600 m square.

## First batch (12 areas, OSM API, October 2026)

These were picked by reputation, not by a measured quality score. Vienna Josefstadt had no paintable
landuse and is left out.

**Glue.** Landuse never sits on roads: at most 0.8% of nodes are shared with them, and almost no edge
comes within 0.5 m of a centreline.

**Two styles at the street.**

| Style | Areas | Sidewalk inside landuse | Residential street: edge from centreline (median) |
|---|---|---|---|
| Kerb | Munich, Berlin, Prague, Tallinn | 64–96% | 3.6–5.5 m |
| Property line | Helsinki, Karlsruhe, Warsaw, Utrecht, Amersfoort | 0–13% | 5–9 m; edge **1.1–2.3 m beyond the sidewalk** (median) |

Our current street space buffers residential roads by 5 m (TUNE-HALFWIDTH), which matches the kerb style.

**Roads inside landuse.** Where landuse is drawn block by block (Berlin, Munich, Helsinki, Karlsruhe),
almost no through road is inside it. The ones that are inside are mostly dead ends (51–63% in Helsinki,
Karlsruhe and Tallinn), living streets (Warsaw: 80%) and pedestrian streets. Amsterdam, Prague and
Hamburg have landuse drawn across whole neighbourhoods (36–93% of roads inside): that is a different
style and a poor model for us.

**Edges inside blocks** almost always follow something in the best areas: 0–0.4% "nothing" in Munich,
Helsinki and Warsaw, against 32–48% in the neighbourhood-style areas. Share of inner-block edge in the
block-by-block areas:

| Area | Fence, wall, hedge | Building | Other landuse or context edge | Path, service road | Nothing |
|---|---|---|---|---|---|
| Munich | 100% | 0% | 0% | 0% | 0% |
| Warsaw | 51% | 22% | 26% | 1% | 0.4% |
| Tallinn | 36% | 31% | 9% | 3% | 21% |
| Helsinki | 31% | 60% | 8% | 1% | 0% |
| Karlsruhe | 22% | 36% | 30% | 0% | 12% |
| Berlin (only 34 samples) | 0% | 85% | 15% | 0% | 0% |

Paths and service roads reach at most 8% anywhere (Amersfoort).

SNAP-108 currently relies on paths, which the data barely supports. Fences and walls are not used at
all, and SNAP-109 draws a 2.5 m yard around buildings that matches nothing.

**Neighbours share edges.** In the block-by-block areas, 52–75% of the edge facing a neighbour in the same
block is exactly shared, and gaps of 0.3–2 m are rare (5–11%). Prague and Utrecht are sloppier (48–54%
small gaps).

**Shape.** Median 4–12 nodes per 100 m in the block-by-block areas, and many right-angle corners. Buildings are almost never split
(0–3%; Utrecht is an outlier at 41%, from two large polygons).

**Tags.** `residential=*` is almost unused: 2 of about 180 residential polygons. This matters for Q-001.

## Questions for the planet run

Each answer changes something specific in the editor.

1. **Distance at the street, by road class, in property-line areas.** Report the median and spread of the
   edge distance from the centreline, with and without a separately mapped sidewalk, and of the distance
   beyond the sidewalk. → New per-class values for TUNE-HALFWIDTH and a sidewalk margin. Does `width=*`
   or `lanes=*` predict the distance better than the class does?
2. **Which roads end up inside a block.** By class, dead end or not, loop or not, `access`/`service`/
   `motor_vehicle` tags. → Which roads stop being barriers (generalising LAT-007).
3. **What inner edges follow, ranked.** Split "building" into running along a wall and crossing a
   building; check `barrier=retaining_wall` and `kerb` lines. → The snap targets and their priority.
   Where an edge follows nothing: is it straight, and how long?
4. **How large is a typical lot** between features inside a block (fence to fence, wall to wall)?
   → Whether picking lots can replace freeform painting in most blocks.
5. **How the style varies.** Kerb or property line by country, city, and road class. Does a single
   loaded area mix both? → Whether Q-008 can be detected reliably from about 1 km² of data.
6. **Shape targets.** Nodes per 100 m and corner angles for edges that follow nothing. → TUNE-SIMPLIFY and
   how strictly free edges are straightened.

## Choosing more areas

The first batch was picked by hand. With a planet file, it's better to screen candidates and then sample.
Cut a grid of 600 m squares over a few dozen cities, run `analyze.py`, and keep squares with high
`paint_cover`, a low `roads_inside_landuse_pct` (block by block) and little "nothing" in
`inner_edge_follows_pct`. Report results for those, and keep the rest as a contrast. Mix densities:
city centres, perimeter blocks, housing estates, detached suburbs, and industrial land.

## What comes next: a replay benchmark

Use the well-mapped squares as an answer key. Remove their paintable landuse, paint rough strokes inside
each true polygon (shrunk and jittered), and score Skyditor's snapped result against the mapper's
polygon: overlap, distance between edges, nodes per 100 m, share of edge that follows a feature, and
buildings split. Each snapping change then gets a number before it lands. Ideally `analyze.py`'s metrics
get ported to TypeScript so the same scores run under `npm test`.
