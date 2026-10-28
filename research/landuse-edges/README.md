# Research: how good OSM landuse edges are drawn

How careful mappers draw landuse in cities, so Skyditor's snapping produces edges they would accept.
These numbers feed requirements and tuning values (REQUIREMENTS.md §0.5): street space (LAT-003, LAT-007,
TUNE-HALFWIDTH) and freeform snapping (SNAP-103, SNAP-108, SNAP-109, SNAP-106).

Two runs so far: a first batch of 12 hand-picked areas, and a run over 44 cities (3,564 squares) that
answers the six questions the first batch raised. The answers and the changes they suggest are in
[44-city run](#44-city-run-geofabrik-october-2026) and [Proposed changes](#proposed-changes). The
[replay benchmark](#replay-benchmark-october-2026) scores the editor against the careful squares, so
each change gets a number before it lands.

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
  detect the style from the existing landuse and follow it. Nothing is built for this yet. The 44-city
  run says this is feasible where sidewalks are mapped separately.

## Running it

Needs Python ≥ 3.10 with `shapely>=2` and `numpy`, plus [osmium-tool](https://osmcode.org/osmium-tool/).
On this machine osmium runs in docker (image `name-ru-repair-osmium`, as `~/Code/osm-extracts` uses).

**Many cities (the 44-city run).** `cities.txt` lists each city with the regional extract that holds it,
named as in the shared OSM store (`python ~/Code/osm-extracts/osm_extracts.py fetch --url <geofabrik url>`).

```sh
python grid.py cities.txt work/                                  # 9 x 9 squares per city -> work/squares/
python analyze.py --areas work/areas.txt 'work/squares/*.osm.gz' > work/results.json
python report.py work/results.json > report.txt                  # pooled answers to Q1-Q6
```

- `grid.py` cuts each city's bbox out of its region, renumbers it, then cuts 81 squares 700 m wide whose
  centres are 1.2 km apart, so a city's grid runs from the centre about 5 km out. Each city takes 1–3 min.
- `analyze.py` takes about 15 min for all 3,564 squares on 22 processes. It expands quoted globs itself,
  since thousands of paths overflow the Windows command line.
- `results-2026-10.json.gz` and `report-2026-10.txt` are this run's output. `report.py` reads the gzip.

**Not from the planet history file.** The local planet is a full-history file. osmium cuts history only
with `complete_ways`, two passes, and each extract keeps id sets of about a gigabyte because planet ids are
spread so widely: 16 city extracts in one pass needed 42 GB. Regional Geofabrik extracts plus `renumber`
before cutting squares avoid both problems.

**A few hand-picked areas (the first batch).**

```sh
python extracts.py areas.txt > extracts.json                       # one bbox per area, 700 m square
osmium extract -c extracts.json -s smart -d extracts/ region.osm.pbf
python analyze.py --areas areas.txt 'extracts/*.osm' > results.json
python summarize.py results.json                                   # one table row per area
```

- `-s smart` keeps multipolygons that reach outside the square complete. The first batch came from the
  OSM API `map` call, which drops incomplete relations.
- The analysis uses the central 600 m (`core_half` in `osmload.py`). The extra 50 m on each side
  supplies the roads and neighbours that edge points near the border are measured against.
- No files are written outside the working directory, and nothing is uploaded.

| File | What it does |
|---|---|
| `cities.txt` | Cities for the grid: `name country region lat lon`. |
| `grid.py` | Cuts the sample squares for `cities.txt`; writes `work/areas.txt` with each square's city and country. |
| `areas.txt` | First-batch sample centres: `name lat lon`. |
| `extracts.py` | Writes the osmium config for `areas.txt`. |
| `osmload.py` | Loads OSM XML (or `.osm.gz`) into local metres; holds the tag sets, which mirror `src/osm/classes.ts`. |
| `analyze.py` | All metrics, writing one JSON object per square. |
| `report.py` | Screens and pools the squares, and prints the answers to Q1–Q6. |
| `summarize.py` | Prints one row per area; for a handful of areas. |
| `replay_squares.py` | Writes `replay-squares.txt`, the careful squares the [replay benchmark](#replay-benchmark-october-2026) uses. |

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
| `h_facing`, `h_beyond`, `h_width`, `h_lanes` | Histograms (0.25 m bins) of the facing distance by class and sidewalk state, of the distance past the sidewalk, and by `width`/`lanes`. They add up across squares. |
| `sidewalk_by_class` | Rays that cross a sidewalk: [sidewalk inside landuse, outside], by class. |
| `q2_*` | Car-road length [inside landuse, total] by class and how it ends (dead end, loop, ring, through), and by `access`, `service`, `motor_vehicle`, `lanes`. An end outside the square is not judged. |
| `inner_first`, `inner_any` | Inner-edge samples by first match and by every match. Targets: fence, wall, hedge, retaining wall, kerb line, building wall (parallel within 20°), crossing a building, inside a building, context edge, neighbouring paintable landuse, footway or path, service road. |
| `nothing_runs` | Runs of consecutive inner samples that follow nothing: length, largest distance from the chord, vertices turning ≥ 5° and their angles. |
| `q4_lot_areas`, `q4_block_areas`, `q4_fit` | Faces between roads, fences, walls, hedges and context edges, less street space (TUNE-HALFWIDTH); the blocks between roads alone; and how much landuse area whole faces cover when a face counts at ≥ 60% or ≥ 80% inside one polygon. |

**Known limitations.** The centreline is a stand-in for the road, since there are no kerb lines.
Sidewalks are only seen where they are mapped separately, so a square's street style is only known where
they are. Each area is a single 600 m square.

## First batch (12 areas, OSM API, October 2026)

These were picked by reputation, not by a measured quality score. Vienna Josefstadt had no paintable
landuse and is left out. The 44-city run supersedes this batch wherever the two overlap. In particular,
Munich and Tallinn come out mostly property line there, and Prague is undecided.

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

Each answer changes something specific in the editor. The 44-city run answers all six, below.

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

## 44-city run (Geofabrik, October 2026)

44 cities in 17 countries (`cities.txt`): the first batch's cities, more cities in those countries, eight
countries not sampled before, and six Canadian cities. Each city got a 9 × 9 grid of 600 m squares
1.2 km apart, 3,564 squares in all, cut from Geofabrik extracts of 2026-10-25 to 27. Kyiv and Lviv come from
the cached Ukraine history file, cut to its state on 2026-10-05. All the numbers below
are in [report-2026-10.txt](report-2026-10.txt).

The squares were screened as "Choosing more areas" in the first batch suggested:

- **Block by block:** paintable landuse covers ≥ 20% of the square, and ≤ 10% of its barrier-road length
  runs inside landuse. 582 of the 3,202 squares with any paintable landuse pass.
- **Careful:** block by block, plus ≥ 25 inner-edge samples of which ≤ 10% follow nothing. 265 squares pass.
- **Street style:** a square with ≥ 20 rays that cross a separately mapped sidewalk is *kerb* when the
  sidewalk is inside the landuse on most of them, otherwise *property line*. Only block-by-block squares
  are styled, since where streets run inside landuse their sidewalks are inside it too.

Q3 uses the block-by-block squares, so that the "nothing" screen does not decide its own answer. The other
questions use the careful squares.

### Most landuse is not drawn block by block

Of the 2,492 squares where paintable landuse covers at least 20%, 61% of residential street length (and
71% of residential dead ends) runs inside landuse. Only 582 squares are block by block. The Netherlands,
Austria, Switzerland, France, Hungary, Denmark and Sweden have almost none: landuse there is drawn across
whole neighbourhoods. Those squares say nothing about where an edge meets the street, so these countries
drop out of Q1 and Q5.

The block-by-block squares cluster in Warsaw, Turku, Helsinki, Toronto, Berlin, Riga, Kyiv, Wrocław and
Vilnius. A block-based editor writes the minority style. That is a choice, not a mistake; see Q-009 in
REQUIREMENTS.md.

### Q1. Distance at the street

Property-line squares (164), edge distance from the road centreline in metres: median (p25–p75), and
how many squares each row comes from.

| Class | No sidewalk mapped | Sidewalk mapped: edge from centreline | Edge past the sidewalk |
|---|---|---|---|
| primary | 9.9 (6.9–15.4), 20 sq | 10.9 (8.9–12.9), 38 sq | 1.9 (1.4–2.9) |
| secondary | 12.4 (8.6–16.9), 47 sq | 11.1 (9.4–14.1), 62 sq | 1.9 (1.1–2.9) |
| tertiary | 10.1 (7.9–13.6), 72 sq | 9.1 (7.6–12.1), 96 sq | 1.6 (1.1–2.6) |
| unclassified | 8.1 (5.6–11.1), 41 sq | 9.6 (7.4–12.1), 34 sq | 1.9 (1.1–2.9) |
| residential | 5.6 (4.4–7.4), 142 sq | 7.1 (5.9–9.1), 140 sq | **1.4** (0.9–1.9) |
| living_street | 4.4 (2.9–6.4), 43 sq | 6.4 (5.1–9.1), 14 sq | 1.9 (1.4–2.4) |
| pedestrian | 4.9 (3.6–9.1), 16 sq | 7.1, 4 sq (too few) | – |

- **Past the sidewalk:** the edge sits 1.4–1.9 m beyond a separately mapped sidewalk (medians by class),
  usually 1–3 m. That is the front-yard strip, and it is consistent across countries.
- **Kerb squares (60), for contrast:** with the sidewalk inside, the edge is 4.4–6.4 m from the
  centreline for every class. Today's TUNE-HALFWIDTH (residential 5 m, primary 9 m) is a kerb-style
  table: right for residential streets, too wide for kerb-style arterials, too narrow for property-line
  ones.
- **`width=*` and `lanes=*` do not beat the class.** On the samples that carry a `width`, class explains
  12.7% of the variance in distance and width 12.0%; both together explain 18.6%. On samples with `lanes`,
  class explains 16.7% and lanes 8.2%. The property line sits about width ÷ 2 + 3 m from the centreline
  (width 6 m → 6.1 m, 10 m → 9.4 m). Taking width ÷ 2 alone, as LAT-003 does, puts it at the kerb.
- **"No sidewalk mapped" understates the default.** Its streets come from squares that map sidewalks,
  so they are mostly streets that really have none. A city that never maps sidewalks separately is
  unstyled and contributes nothing here. Where a sidewalk exists but is not in the data, the honest
  figure is nearer the middle column: for residential streets 6–7 m, not 5.6.
- **Spread is wide.** Even within one class and style, p25–p75 spans 3–6 m. A fixed half-width will be
  off by a couple of metres on many streets, and only a mapped sidewalk pins the edge down.

### Q2. Which roads end up inside a block

Share of road length inside landuse. The first column uses the block-by-block squares. That screen caps
barrier roads at 10% inside, so for barrier classes it is a lower bound. The second column uses all 2,492
squares with cover, which neighbourhood-style squares dominate.

| Road | Block by block | All squares |
|---|---|---|
| service, any | 60–73% | 64–74% |
| … `service=driveway` / `parking_aisle` / `alley` | 71% / 66% / 63% | 75% / 71% / 81% |
| residential, through | 2.4% | 61% |
| residential, dead end | 8.3% | 71% |
| residential, `access=private` | 45% (2.2 km) | 86% |
| living_street, through | 8.1% | 67% |
| living_street, dead end / loop / ring | 30% / 38% / 66% | 80% / 87% / 92% |
| living_street, `access=private` | 66% (2.1 km) | 94% |
| pedestrian, dead end | 22% | 62% |
| primary to tertiary | ≤ 0.6% | 15–31% |
| trunk, motorway | 0% | 4–5% |

- Service roads are mostly inside, as LAT-001 already has it (not barriers).
- Residential dead ends mostly stay outside the landuse even in careful areas (8%). LAT-007, a notch
  rather than a split, fits them.
- The candidates to stop being barriers are private residential and living streets, and living streets
  that are dead ends, loops or rings. The lengths are small (a few km), so treat them as a direction, not
  a measurement.

### Q3. What inner edges follow

1,119 km of inner-block edge (more than 20 m from any road) in the block-by-block squares. *Any* counts
every target within reach (1 m; 0.3 m for landuse edges); *first* assigns each sample to one.

| Target | Any | First |
|---|---|---|
| Context edge (park, school grounds, parking, other landuse) | 48% | 31% |
| Neighbouring paintable landuse | 30% | 13% |
| Fence | 23% | 23% |
| Building wall (edge runs along it) | 11% | 10% |
| Wall | 4.1% | 3.9% |
| Hedge | 1.3% | 1.1% |
| Footway or path | 1.6% | 0.5% |
| Service road | 1.6% | 0.4% |
| Crosses a building, or runs inside one | 1.6% | 0.3% |
| Retaining wall; kerb line | 0.4%; 0.0% | |
| **Nothing** | | **16%** |

- The ranking is: context edges, fences, neighbouring landuse, building walls, walls, hedges. Paths and
  service roads, which SNAP-108 relies on, come last at under 1% each.
- Edges run *along* buildings seven times as often as they cross or enter them (11% against 1.6%). SNAP-109's "never through a
  building" is right; its 2.5 m yard is not. The edge sits on the wall, within 1 m.
- Fences matter most in Poland (40%), Latvia (50%) and Czechia (37%), and least in Canada (5%). In
  Canada, 29% of inner edges follow nothing.
- **Edges that follow nothing** (176 km in 4,559 runs) are mostly straight: within 1 m of the straight
  line for 97% of runs under 10 m, 84% at 10–30 m, 67% at 30–60 m, and 28–46% beyond 60 m, where they
  bend at a corner or two.

### Q4. Lots

Lots are faces between roads, fences, walls, hedges and context edges, less the editor's street space.

- They are big. The lot a typical square metre of landuse lies in has 10,000 m²; the block it lies in
  has 20,500 m². Fences divide a block into about two.
- Whole lots cover only **23–25%** of the landuse area in careful squares (≥ 80% or ≥ 60% of the lot
  inside one polygon). The rate is 29% in kerb squares and 16–29% by country.
- So **picking lots cannot replace freeform painting.** Most landuse polygons cut across lots along lines
  that no fence or context edge marks, likely between several landuse polygons in one block. Fences are
  still worth snapping to (Q3).

### Q5. How the style varies

| Country | Careful squares: kerb / property line | Block-by-block squares: kerb / property line |
|---|---|---|
| Finland | 0 / 39 | 1 / 98 |
| Poland | 4 / 47 | 6 / 78 |
| Latvia | 0 / 16 | 1 / 30 |
| Great Britain | 0 / 7 | 0 / 12 |
| Canada | 3 / 23 | 18 / 60 |
| Estonia | 0 / 2 | 1 / 9 |
| Germany | 36 / 22 | 61 / 43 (Berlin kerb; Hamburg, Munich property line) |
| Lithuania | 8 / 3 | 10 / 3 |
| Ukraine | 8 / 4 | 28 / 7 |
| Czechia | 1 / 1 | 4 / 4 |

- **Property line is the common style:** Finland, Poland, Latvia, Great Britain and Canada, plus Hamburg
  and Munich (Estonia too, on few squares). Kerb dominates in Berlin, Vilnius and Kyiv. Czechia is
  undecided.
- **A city keeps its style.** Two styled squares of the same city agree 93% of the time 1.2 km apart,
  91% at 2.4 km and 88% at 3.6 km or more. Within one square, the minority side has a median 1% of the
  sidewalk rays, and only 8% of squares are mixed (≥ 30%).
- **Every class follows the square's style:** in kerb squares 80–89% of rays have the sidewalk inside, for
  every class; in property-line squares 4–17%.
- **Detecting it needs mapped sidewalks.** One 600 m square with ≥ 20 sidewalk rays is enough, and a
  1.2 km loaded area (TUNE-AREA-SIDE) usually holds several. Without separately mapped sidewalks there is
  no reliable cue: residential edges sit 5.6 m (property line) against 4.6 m (kerb) from the centreline,
  and their spreads overlap.

### Q6. Shape

- **Edges that follow nothing** have 1.3 vertices per 100 m (turns ≥ 5°, runs ≥ 20 m, length-weighted).
  The median run has none: it is one straight segment. A third of their corners (34%) are right angles.
- **All paintable edges** in careful squares: median 4.2 nodes per 100 m, segments 11 m, 20% of vertices
  at right angles, and no buildings split (median 0%).
- For comparison, the test stroke in [Why](#why) commits 15 nodes per 100 m, none of them following anything.
- **Neighbours:** 74% of the edge facing a neighbouring polygon within 8 m is shared exactly (< 0.25 m),
  6% has a 0.25–2 m gap, and 20% sits 2–8 m away. Closing small gaps (SNAP-103) matches practice.
- **Tags:** `residential=*` is on 12% of residential polygons (3,007 of 25,417): `apartments` 1,345,
  `urban` 793, `rural` 237, `detached` 204, `single_family` 136, `terrace` 64. This bears on Q-001 and Q-002.

## Proposed changes

Each changes behaviour, so each goes through REQUIREMENTS.md first (§0.5). The values are starting points
from the medians above, for the replay benchmark to refine. All seven have since been made or tried, in this
order, each measured on the replay: see [Proposals made](#proposals-made-replay-2026-10-proposalstxt).

1. **Street space to the property line (LAT-003, Q-003).** Where a separately mapped sidewalk runs along a
   barrier, street space reaches the sidewalk's far side plus a new TUNE-SIDEWALK-MARGIN of 1.5 m.
   Elsewhere it uses property-line half-widths: residential 6–7, living_street 4.5–6, pedestrian 5,
   unclassified 8–9, tertiary 9–10, secondary 11, primary 10–11 m (between the two Q1 columns). Trunk and motorway are unmeasured and stay
   as they are. `width=*` should only widen, as width ÷ 2 + 3 m, never narrow: on its own it predicts no
   better than the class and lands at the kerb.
2. **Kerb style where the area is kerb style (Q-008).** When the loaded area has ≥ 20 sidewalk crossings
   and most have the sidewalk inside landuse, use today's kerb-style half-widths (TUNE-HALFWIDTH as it
   is) and ignore sidewalks. Otherwise use property line.
3. **Snap to fences, walls and hedges (SNAP-108).** Add them to the ways that divide an atom into cells,
   alongside paths and service roads. They follow 28% of inner edges, against about 1% for paths and
   service roads.
4. **Buildings: follow the wall (SNAP-109, TUNE-BUILDING-MARGIN).** Keep "never through a building". Cut
   the yard from 2.5 m to about 0.5 m, so an edge near a building runs along its wall as mappers draw it.
5. **Straight free edges (SNAP-106).** An edge that follows nothing should become one straight segment,
   or a few with square corners where the stroke turns. That is a new requirement, not a larger
   TUNE-SIMPLIFY: mappers draw 1.3 vertices per 100 m there, against 15 from the test stroke.
6. **Fewer barriers (LAT-001, LAT-007).** Consider treating `access=private` residential and living
   streets, and living streets that are dead ends, loops or rings, like service roads. The evidence is
   thin (a few km); confirm with the replay benchmark first.
7. **No lot picking (Q4).** Whole lots would paint about a quarter of the landuse. Keep freeform.

## Choosing more areas

The 44-city grid was cut blind and screened afterwards. To sharpen what is thin:

- Kerb-style cities beyond Berlin, Vilnius and Kyiv: other German, Czech and Ukrainian cities.
- Cities with separately mapped sidewalks in the neighbourhood-style countries (NL, AT, CH, FR, HU, DK,
  SE): their block-by-block pockets, if any.
- Trunk and motorway frontage, pedestrian streets and living streets, which have few squares each.
- Detached suburbs, which a 5 km grid barely reaches.

## Replay benchmark (October 2026)

The careful squares of the 44-city run serve as an answer key. For each square the editor loads the data
without its paintable landuse. Rough strokes are painted inside every true polygon. Then the snapped result
is scored against the mapper's polygon. The truth gets the same yardsticks, so every editor number sits
next to what the mappers drew.

```sh
python replay_squares.py results-2026-10.json.gz work/areas.txt > replay-squares.txt   # the careful squares
# from the repository root:
npm run replay                        # all of them, from work/squares/; about 70 s on 22 threads
npm run replay -- --only berlin_0_1,helsinki_3_4 --svg   # a few, with a picture each in work/replay/
npm run replay -- --report research/landuse-edges/replay-results-2026-10.json.gz   # re-print a saved run
npm run replay -- --tune SNAP_FACTOR=0 --out research/landuse-edges/work/replay-nosnap   # what if
```

The code lives in `bench/replay/` (TypeScript, driving the editor's own model) and `scripts/replay.mjs`
(the runner). `tests/replay.test.ts` replays one committed square (Turku), so the harness keeps working as
the editor changes. A run is deterministic: the same code gives the same scores whatever the thread count.

**How the strokes are made.** Each true polygon, clipped to the loaded 700 m square, gets an outline pass a
brush radius in from its edge, then rows 1.5 radii apart across the middle. The whole trail wobbles by a smooth
random field (0.3 radii RMS, wavelength about 60 m), so edges land a few metres either side of the truth.
The radius is 0.1 × √area, between 4 and 15 m, and smaller for strips the brush does not fit. This is an
idealised mapper who aims at the right edge; it does not model a careless one.

**What is scored.** All within the central 600 m, as in `analyze.py`.

- Overlap (IoU), truth missed, and result outside truth.
- Distance from each result edge to the nearest truth edge, and back, sampled every 2 m.
- What inner edges (> 20 m from every barrier) follow, first match: fence, wall or hedge; building outline;
  context edge; minor way; street space. Unlike `analyze.py`, a neighbouring landuse edge does not count:
  the result's edges between kinds are what is being judged.
- Vertices turning ≥ 5°, per 100 m of edge, and per 100 m of inner edge that follows nothing.
- Buildings split: buildings touching landuse with 5–95% of their footprint inside one polygon.

Strokes reach the edge of the loaded square, past the scored core: stopping them at the core would draw a
wobbly edge there that no mapper drew. Three things are adjusted for the editor's sake. Truth under protected context (a park on top of residential
land) is taken out, since nobody can paint there. Touching truth polygons are painted different kinds, so
the editor's merging of same-kind pieces does not erase their shared edge. Larger polygons are painted
first.

### Baseline (`replay-2026-10.txt`)

265 squares, 46 km² of truth.

| | All | Kerb (60) | Property line (164) | Mappers |
|---|---|---|---|---|
| Overlap (IoU) | 0.894 | 0.903 | 0.890 | |
| Truth missed | 4.7% | 6.3% | 3.7% | |
| Result outside truth | 6.4% | 3.9% | 7.8% | |
| Result edge → truth edge, median / p90 | 1.9 / 15.9 m | 1.1 / 10.6 m | 2.1 / 16.1 m | |
| Truth edge → result edge, median / p90 | 1.4 / 5.9 m | 1.1 / 5.6 m | 1.4 / 5.6 m | |
| Inner edges that follow nothing | 31.1% | 26.7% | 33.4% | 14.7% |
| … that follow a fence, wall or hedge | 20.6% | 17.0% | 21.7% | 34.7% |
| … that follow a building | 7.7% | 12.6% | 7.8% | 14.5% |
| Bends per 100 m of edge | 4.4 | 3.7 | 4.8 | 3.5 |
| Bends per 100 m of inner edge that follows nothing | 9.9 | 9.9 | 10.3 | 1.9 |
| Buildings split | 7.4% | 6.0% | 7.9% | 4.8% |

Only 0.6% of the painted area was claimed as whole pieces, so at these brush sizes almost everything goes
through freeform snapping.

**What it shows.**

- Area is already close: about 89% overlap whatever the style. In property-line squares, twice as much of
  the result lies outside the truth as in kerb squares (7.8% against 3.9%), as expected: street space stops
  at the kerb.
- Edges are where the editor falls short. Its inner edges follow nothing twice as often as the mappers'
  edges. Where they follow nothing, they bend 5 times as often. They follow fences three fifths as often,
  although fences are not snap targets yet (SNAP-108 uses paths and service roads).
- The long tail of result edges far from any truth edge (p90 about 16 m) has two sources seen in the
  pictures:
  - **Roads inside the truth.** In Hamburg 8_6 one polygon spans an estate road. The editor splits at every
    road and draws edges along both sides of it (Q2, proposal 6).
  - **Leftover swallowing reaches too far.** Kyiv 1_4 is a single 330,000 m² atom: it wraps around a
    motorway, so strips between the carriageways connect to the painted block. SNAP-103 swallows narrow
    leftovers that touch the paint, and here they touch it through each other. 21,000 m² outside the truth
    and more than a brush radius + 5 m from every trail got painted; with `--tune SNAP_FACTOR=0` that is
    500 m². SNAP-104 does not stop it. CORR-003 now limits it (below).
- Swallowing also does real work. With `SNAP_FACTOR=0` over all squares, the result outside truth drops from
  6.4% to 3.5% and the p90 from 15.9 to 8.4 m. But inner edges that follow nothing rise from 31% to 46%:
  swallowing is what carries many edges onto context, fences and paths. The fix is to limit how far it
  reaches from the stroke, not to remove it.

**Which number each proposal should move.**

| Proposal | Watch | Moved (all squares unless named) |
|---|---|---|
| 1. Street space to the property line | Result outside truth and edge distances, property-line squares | Outside 7.8% → 4.5%, truth edge median 1.4 → 0.9 m |
| 2. Kerb style where the area is kerb style | The same, kerb squares: they must not get worse | Unchanged |
| 3. Snap to fences, walls and hedges | Inner edges that follow a fence; that follow nothing | Fence 20.6% → 23.6%, nothing 31.1% → 28.3% |
| 4. Buildings: follow the wall | Inner edges that follow a building; buildings split | Building 7.7% → 14.8%, split 7.3% → 7.5% |
| 5. Straight free edges | Bends per 100 m of inner edge that follows nothing | 7.4 → 3.2 |
| 6. Fewer barriers | Result edge → truth edge, p90 | 14.1 → 13.9 m (private streets only) |
| Swallowing that stays near the stroke | Result outside truth and p90, without more edges that follow nothing | Outside 4.1% → 3.6%, p90 13.9 → 8.4 m, nothing 20.0% → 20.6% |

### Proposals made (`replay-2026-10-proposals.txt`)

Made in this order, one commit each, with the replay run after each. Saved run:
`replay-results-2026-10-proposals.json.gz`.

| Step | IoU | Outside truth | Truth missed | Result → truth edge, p90 | Inner edges: nothing / fence / building | Bends per 100 m, free edge | Buildings split |
|---|---|---|---|---|---|---|---|
| Baseline | 0.894 | 6.4% | 4.7% | 15.9 m | 31.1 / 20.6 / 7.7% | 9.9 | 7.4% |
| 1 + 2. Property line, or kerb (LAT-003, LAT-009) | 0.907 | 4.2% | 5.5% | 14.4 m | 31.1 / 20.6 / 7.8% | 9.9 | 7.4% |
| 3. Fences, walls, hedges (SNAP-108) | 0.908 | 4.2% | 5.4% | 14.6 m | 28.3 / 23.6 / 7.7% | 10.0 | 7.3% |
| 4. Building margin 0.5 m (TUNE-BUILDING-MARGIN) | 0.910 | 4.1% | 5.4% | 14.6 m | 21.6 / 24.3 / 14.8% | 7.4 | 7.5% |
| 5. Straight free edges (SNAP-111) | 0.909 | 4.1% | 5.5% | 14.1 m | 20.0 / 25.4 / 14.6% | 3.2 | 7.5% |
| 6. Private streets (LAT-001) | 0.909 | 4.1% | 5.5% | 13.9 m | 20.0 / 25.4 / 14.6% | 3.2 | 7.5% |
| 7. Swallow near the paint (CORR-003) | 0.912 | 3.6% | 5.6% | 8.4 m | 20.6 / 25.5 / 14.8% | 3.3 | 7.5% |
| Mappers | | | | | 14.8 / 34.7 / 14.5% | 1.9 | 4.8% |

Now, by street style:

| | All | Kerb (60) | Property line (164) | Mappers |
|---|---|---|---|---|
| Overlap (IoU) | 0.912 | 0.906 | 0.916 | |
| Truth missed | 5.6% | 6.6% | 4.8% | |
| Result outside truth | 3.6% | 3.2% | 4.0% | |
| Result edge → truth edge, median / p90 | 1.1 / 8.4 m | 1.1 / 6.9 m | 0.9 / 8.4 m | |
| Truth edge → result edge, median / p90 | 0.9 / 5.6 m | 1.1 / 8.6 m | 0.9 / 4.6 m | |
| Inner edges that follow nothing | 20.6% | 19.0% | 21.4% | 14.8% |
| … that follow a fence, wall or hedge | 25.5% | 19.1% | 27.1% | 34.7% |
| … that follow a building | 14.8% | 19.5% | 15.9% | 14.5% |
| Bends per 100 m of edge | 4.7 | 3.6 | 5.3 | 3.5 |
| Bends per 100 m of inner edge that follows nothing | 3.3 | 3.0 | 3.5 | 1.9 |
| Buildings split | 7.5% | 6.1% | 8.0% | 4.8% |

**How each went.**

1. **Street space to the property line.** Property-line half-widths per class, `width=*` only widening
   (width ÷ 2 + TUNE-WIDTH-VERGE), and the land from a street's centreline to TUNE-SIDEWALK-MARGIN past each
   sidewalk running along it within TUNE-SIDEWALK-REACH. The first run split more buildings (7.4% → 10.3%):
   the wider street space cut into buildings standing on the property line. Street space past the kerb now
   stops at building walls, which brought that back to 7.4%. Truth missed rises (property-line squares
   3.7% → 4.8%) as the price of result outside truth falling (7.8% → 4.0%).
2. **Kerb style.** The editor judges the style from the sidewalk running within 6 m of existing landuse
   edges, inside against outside, with at least TUNE-STYLE-EVIDENCE of it. Against the study's verdicts it
   agrees on 59 of 60 kerb squares and 159 of 164 property-line ones; of the 41 unknown, it calls 5 kerb. The
   replay judges from the full data, landuse included, as the editor would; only the painting hides it.
3. **Fences.** A smaller gain than the mappers' 35% suggests: a fence divides cells only where it cuts the
   block apart, and a fence that ends inside the block does not.
4. **Building walls.** Inner edges that follow a building now match the mappers.
5. **Straight free edges.** Douglas–Peucker at TUNE-STRAIGHTEN × brush radius on each stretch off the
   piece outline and the cells, then corners within 20° of square made square. 1.0 instead of 0.5 gives 2.4
   bends but IoU 0.905. A rounded outer corner of a stroke becomes a chamfer, not a square corner.
6. **Fewer barriers.** Only private residential and living streets. Living streets that are dead ends,
   loops or rings were tried as well: in the 23 squares they change, they add 38,600 m² of result, of which
   16,300 m² is truth (Warsaw 8_5 −0.030 IoU, Riga 7_3 −0.020). There, mappers stop at the living street.
7. **Swallowing near the paint (CORR-003).** A swallowed leftover reaches at most TUNE-SWALLOW-REACH ×
   brush radius from the paint. Kyiv 1_4 goes from 0.612 to 0.671 IoU; 143 of the 174 squares that change get
   better. Kerb squares miss a little more (truth edge → result edge p90 5.9 → 8.6 m): Berlin maps 1–3 m
   landuse strips around parks, which the idealised strokes barely reach and swallowing used to fill end to
   end. Reach 2.5 gives p90 9.1 m overall and 7.9 m there; 4 gives 10.4 and 7.4.

**What is left.**

- Edges that follow nothing: 20.6% against 14.8%. Fences that end inside a block are the obvious next target.
- Bends per 100 m of all edge: 4.7 against 3.5, and 5.3 in property-line squares. Street edges now step around
  building fronts and follow sidewalk geometry.
- Buildings split: 7.5% against 4.8%, untouched by any of this.

**Limits.** One idealised stroke pattern at one wobble. Only careful, block-by-block squares, so it says
nothing about neighbourhood-style areas (Q-009). Sidewalk style is unknown for 41 squares. The first
replay after each change should still be looked at in pictures (`--svg`), not only in numbers.
