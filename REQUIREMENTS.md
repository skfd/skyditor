# Skyditor — Requirements

This file is the **primary source of truth** for Skyditor. Code follows from it, not the other way round.
If the code and this file disagree, the code is wrong — or this file gets changed first, on purpose.

Skyditor is a narrow OpenStreetMap editor for **landuse only**, mainly in cities. You paint landuse onto
the map and it snaps into place by itself. It should feel like a well-made video game: responsive, tactile,
legible. Animation is there to explain what happened, never just to decorate.

Current milestone: **M0 — "Toy"**. It reads OSM data, paints, snaps, and undoes. It does **not** write
anything back (see §15).

---

## 0. How this file works

### 0.1 Requirement syntax (EARS)

Every requirement is one sentence in one of the EARS patterns:

| Pattern        | Template                                                        |
|----------------|-----------------------------------------------------------------|
| Ubiquitous     | The editor shall `<response>`.                                  |
| Event-driven   | When `<trigger>`, the editor shall `<response>`.                |
| State-driven   | While `<state>`, the editor shall `<response>`.                 |
| Unwanted       | If `<condition>`, then the editor shall `<response>`.           |
| Optional       | Where `<feature is enabled>`, the editor shall `<response>`.    |
| Complex        | While `<state>`, when `<trigger>`, the editor shall `<response>`. |

Requirements are written as `**ID** statement`, optionally followed by an indented `Why:` line.
The `Why:` line is not normative. It records intent, so that an implementer can tell what is *right*
and not only what is *formally compliant*.

### 0.2 Identifiers

- IDs are `AREA-NNN` (for example `SNAP-004`). They are never reused or renumbered.
- A retired requirement stays in the file, struck through, with a note on what replaced it.
- Numeric feel and tuning values live in the **tuning table (§16)** as `TUNE-*` IDs. Requirements refer
  to them by ID instead of repeating numbers. The code mirrors the table in `src/tuning.ts`.

### 0.3 Corrections (CORR)

Sometimes code satisfies a requirement to the letter but is still *not right*. When that happens, we
don't silently re-interpret the original. We add a **correction** to §17:

```
**CORR-NNN** (corrects SNAP-004) <EARS statement that pins down the intended behaviour>
  Observed: <what the compliant-but-wrong implementation did>
  Why: <what was actually intended>
```

A correction has the same authority as a normal requirement, and wins over the requirement it corrects
where the two conflict. The corrected requirement gets a `→ see CORR-NNN` marker. Once a correction
has been absorbed into a rewritten requirement, it may be retired.

### 0.4 Traceability

- Code that implements a requirement cites its ID in a nearby comment, for example `// SNAP-004`.
- Tests name the IDs they verify in the test title, for example `it("SNAP-004: leftover strip …")`.
- `npm run trace` lists every requirement with its implementing and testing locations, and fails if the
  code cites an ID that does not exist here.

### 0.5 Change protocol

1. Change or add requirements (or a correction) here.
2. Change the code and tests to match. Cite the IDs.
3. Run `npm test` and `npm run trace`.

---

## 1. Glossary

| Term | Meaning |
|------|---------|
| **Area** | The rectangular extent of OSM data that is loaded into one session. |
| **Barrier** | A linear OSM feature that splits land into blocks: drivable roads, railways, rivers and canals (§4). |
| **Street space** | The union of all barriers, each buffered by its class half-width. It is never paintable. |
| **Atom** | One connected piece of land left over when street space and water are removed from the area. In a city, roughly a *block*. Atoms are the coarse snapping lattice. |
| **Piece** | A connected region inside one atom with one landuse value (or none). Every atom is fully divided into pieces. |
| **Void** | A piece with no landuse. |
| **Kind** | The landuse value of a piece: a paintable kind (§5), an exclusive context kind (§6), or void. |
| **Tier** | The step on the residential ladder (R1 rural … R6 high-rise). |
| **Brush** | The circular painting tool. Its radius is set in screen pixels and converted to metres when a stroke starts. |
| **Stroke** | One press–drag–release gesture with the brush. One stroke is one undo step. |
| **Tap** | A stroke with almost no movement and a short duration (TUNE-TAP-*). |
| **Unit piece** | A piece small enough, relative to the brush, to be claimed whole (§8). |
| **Open piece** | A piece too large to be a unit piece. It gets painted freeform and then snapped (§9). |
| **Claim** | Turning a whole piece into the stroke's kind. |
| **Charge** | Visible progress towards claiming a unit piece during a stroke. |

---

## 2. General

**GEN-001** The editor shall run in a desktop web browser without a server component, other than public
OSM data services.

**GEN-002** The editor shall never show the user its internal concepts (atoms, pieces, coverage,
thresholds, buffers). The user sees only: map, landuse colours, brush, tools, and results.
  Why: the snapping can get as clever as it needs to internally; the user just paints.

**GEN-003** The editor shall keep all geometry in a local planar coordinate system, in metres, centred on
the loaded area.

**GEN-004** The editor shall run boolean and offset geometry on integer coordinates at the resolution
TUNE-GEOM-SCALE.
  Why: robust polygon operations. The landuse lattice is useless if it develops cracks.

---

## 3. Loading OSM data

**LOAD-001** The editor shall offer a bundled demo area that loads without network access.

**LOAD-002** When the user picks a place from the search results, the editor shall load a square area of
side TUNE-AREA-SIDE centred on that place.

**LOAD-003** When loading an area by bounding box, the editor shall first query the Overpass API and, if
that fails, query the OSM API 0.6 `map` call.

**LOAD-004** When the user drops an `.osm` (XML) or Overpass JSON file onto the editor, the editor shall
load that file. The area is the file's declared bounds, or the extent of its nodes if there are none.

**LOAD-005** The editor shall read nodes, ways and multipolygon relations, and assemble relation rings from
member ways joined end to end.

**LOAD-006** If a multipolygon ring cannot be closed, then the editor shall skip that ring, keep loading,
and count the skipped ring in the load report.

**LOAD-007** While an area is loading, the editor shall show the current loading stage (fetching,
reading, building blocks, reading landuse).

**LOAD-008** If loading fails, then the editor shall show a short reason and return to the start screen,
without changing any area that was already loaded.

**LOAD-009** When the page URL contains `#map=<lat>/<lon>`, the editor shall load the area centred there,
and it shall keep that fragment updated with the loaded area's centre. The demo area uses `#demo`.
  Why: repeatable dev sessions and shareable places.

---

## 4. Lattice (atoms)

**LAT-001** The editor shall treat these ways as barriers: `highway` = motorway, trunk, primary, secondary,
tertiary, unclassified, residential, living_street, pedestrian, road and their `_link` variants; `railway`
= rail, light_rail, narrow_gauge; `waterway` = river, canal.

**LAT-002** The editor shall not treat a way tagged `tunnel` (any value except `no`), or `covered=yes`, as a
barrier.

**LAT-003** The editor shall build street space by buffering each barrier by the half-width TUNE-HALFWIDTH
of its class, with round ends and joins, clipped to the area.

**LAT-004** The editor shall add to street space any `highway` area (closed way with `area=yes`, or an
`area:highway` feature) of a barrier class.

**LAT-005** The editor shall compute atoms as the connected parts of (area rectangle − street space −
water), keeping holes.

**LAT-006** If a candidate atom is smaller than TUNE-ATOM-MIN-AREA, or contains no disc of radius
TUNE-ATOM-MIN-RADIUS, then the editor shall discard it.
  Why: traffic islands and slivers between parallel carriageways are not land anyone paints.

**LAT-007** The editor shall not split an atom along a dead-end barrier that ends inside it. The dead end
only becomes a notch in the atom.

**LAT-008** The editor shall treat as water: `natural=water`, `waterway=riverbank`, `landuse=reservoir`,
`landuse=basin`. (Coastline handling is out of scope for M0.)

---

## 5. Paintable kinds and the residential ladder

**KIND-001** The editor shall offer exactly these paintable kinds, in this order:

| Kind | Key | Label | OSM tags (provisional, see Q-001) |
|------|-----|-------|-----------------------------------|
| R1 | `1` | Rural | `landuse=residential` `residential=rural` |
| R2 | `2` | Detached houses | `landuse=residential` `residential=single_family` |
| R3 | `3` | Semi-detached | `landuse=residential` `residential=duplex` |
| R4 | `4` | Terraced / rowhouses | `landuse=residential` `residential=terrace` |
| R5 | `5` | Apartments | `landuse=residential` `residential=apartments` |
| R6 | `6` | High-rise | `landuse=residential` `residential=apartments` (+ see Q-002) |
| Commercial | `Q` | Commercial | `landuse=commercial` |
| Retail | `W` | Retail | `landuse=retail` |
| Industrial | `E` | Industrial | `landuse=industrial` |

**KIND-002** The editor shall present R1–R6 as one ordered ladder, from rural to high-rise, and never as
unrelated categories.
  Why: residential density is a progression. The UI, colour, height and sound should all say so.

**KIND-003** The editor shall give each tier a colour on one continuous ramp, and a slab height
TUNE-LIFT that strictly increases from R1 to R6.

**KIND-004** The editor shall represent `landuse=residential` with no recognised `residential=*` value as
*unspecified residential*: a residential colour without a tier and without lift, shown with a hatch
pattern, translucent enough that overlay context beneath it stays visible.
  Why: most residential landuse in OSM has no subtag. It should look like it is waiting to be refined.

**KIND-005** The editor shall map imported `residential=*` values to tiers as follows: rural → R1;
single_family, detached → R2; duplex → R3; terrace, terraced → R4; apartments, urban, block → R5.

**KIND-006** The editor shall give commercial, retail and industrial colours clearly distinct from the
residential ramp, and a single shared slab height TUNE-LIFT-NONRES.

**KIND-007** The editor shall offer an eraser (key `X`) that turns painted pieces back into void.

---

## 6. Interpreting existing landuse

**IMP-001** The editor shall classify each loaded area feature as exactly one of: *paintable*
(`landuse` = residential, commercial, retail, industrial), *exclusive context*, *overlay context*,
*water*, or *ignored*.

**IMP-002** The editor shall classify as exclusive context: `landuse` = forest, farmland, meadow, orchard,
vineyard, cemetery, allotments, recreation_ground, railway, construction, brownfield, greenfield,
military, religious, farmyard, quarry, landfill, plant_nursery, education, institutional; `leisure` =
park, golf_course, sports_centre, stadium, nature_reserve; `natural` = wood, scrub, heath, grassland,
wetland, sand, beach, bare_rock.

**IMP-003** The editor shall classify as overlay context: `landuse` = grass, flowerbed, village_green;
`leisure` = garden, playground, pitch, dog_park; `amenity` = parking.
  Why: in OSM these usually sit *inside* a residential or commercial area. They must not cut holes in
  the lattice. They are drawn on top, as hints.

**IMP-004** Where paintable and exclusive-context features overlap, the editor shall give the overlap to
the feature with the smaller area.
  Why: a retail area drawn inside a big residential polygon is the more specific statement.

**IMP-005** The editor shall convert each paintable or exclusive-context feature into pieces by
intersecting its resolved footprint (after IMP-004) with every atom it overlaps.

**IMP-006** If an imported fragment inside an atom is smaller than TUNE-IMPORT-MIN-FRAGMENT, or contains no
disc of radius TUNE-ATOM-MIN-RADIUS, then the editor shall drop that fragment.
  Why: polygons drawn to road centrelines poke a few centimetres into neighbouring blocks.

**IMP-007** The editor shall absorb into an adjacent imported paintable piece any part of the void inside
the same atom that is narrower than 2 × TUNE-IMPORT-SNAP and touches that piece. The corners of a wider
void are part of that void, not narrow parts.
  Why: landuse traced along kerbs or fences leaves thin gaps against our block edge. They should close.

**IMP-008** The editor shall remember, for each imported piece, the OSM element it came from and whether
the user has changed it.
  Why: when output exists (§15), untouched features must be written back untouched.

**IMP-009** Where the "original outlines" view is on (key `O`), the editor shall draw the unmodified OSM
outlines of paintable features on top of the map.

---

## 7. Painting — general

**PAINT-001** When the user presses the primary button over the map with a paint tool selected, the editor
shall start a stroke with the current kind and the brush radius converted to metres at that moment.

**PAINT-002** While a stroke is active, the editor shall record the cursor path, adding a point once the
cursor has moved at least TUNE-TRAIL-STEP × brush radius from the previous point.

**PAINT-003** While a stroke is active, the editor shall draw the brush trail as a soft translucent band in
the kind's colour.

**PAINT-004** The editor shall never change exclusive-context pieces or water by painting, erasing or
density changes.

**PAINT-005** When a stroke ends, the editor shall commit all of the stroke's changes as one undo step.

**PAINT-006** If a stroke changes nothing, then the editor shall not create an undo step.

**PAINT-007** When a paint stroke would change a piece to the kind it already has, the editor shall leave
that piece alone. It is not a claim.

**PAINT-008** When the user Alt-clicks a piece, the editor shall select that piece's kind as the current
tool. For unspecified residential, or an empty spot, nothing changes.

**PAINT-009** If the cursor enters exclusive context or water during a paint or eraser stroke, then the
editor shall play the *reject* feedback (FEEL-004), at most once per stroke.
  Why: protected land must not change, but silence reads as "broken".

---

## 8. Snapping — unit pieces

**SNAP-001** The editor shall treat a piece as a unit piece when its area is at most
min(TUNE-UNIT-ABS-MAX, TUNE-UNIT-FACTOR × π × brush radius²).
  Why: zoom becomes precision. Zoomed out, the brush grabs whole blocks; zoomed in, it paints parts of
  blocks.

**SNAP-002** While a stroke is active, the editor shall track for each unit piece the fraction of its area
the stroke has covered, measured on a fixed set of sample points spread evenly over the piece.

**SNAP-003** When a unit piece's covered fraction reaches TUNE-CLAIM-COVERAGE during a stroke, the editor
shall claim that piece immediately, without waiting for the stroke to end.

**SNAP-004** When the user taps inside a unit piece with a paint tool, the editor shall claim that whole
piece.

**SNAP-005** While a stroke is active, the editor shall show each partly covered unit piece charging: a
dashed outline and a light fill in the stroke's colour, both growing with covered fraction ÷
TUNE-CLAIM-COVERAGE. A charging piece shall never look claimed.

**SNAP-006** When a stroke ends, the editor shall drop the charge of every unit piece that was not
claimed, with no change to the piece.
  Why: unit pieces are all-or-nothing. Half-claimed blocks don't exist.

---

## 9. Snapping — open pieces (freeform)

**SNAP-101** The editor shall build the stroke shape as the brush trail buffered by the brush radius
(round caps and joins), smoothed by a morphological closing of radius TUNE-SMOOTH-FACTOR × brush radius.

**SNAP-102** The editor shall limit the freeform result in each atom to the open pieces the stroke shape
touches, excluding exclusive-context pieces and pieces already of the stroke's kind.

**SNAP-103** The editor shall swallow leftovers: within the touched open pieces, any part outside the
stroke shape that is narrower than 2 × TUNE-SNAP-FACTOR × brush radius, and that touches the stroke shape,
shall join the result. The corners of a wider leftover belong to that leftover and are never swallowed.
  Why: this is what makes paint "snap". A gap narrower than the snap distance between the paint and a
  road, a neighbouring landuse, or a context area closes by itself. Wide leftovers stay.

**SNAP-104** The editor shall not swallow narrow leftovers that do not touch the stroke shape.
  Why: painting the west half of a field must not grab a rounded-off corner on its far east side.

**SNAP-108** The editor shall divide each atom into *cells* along minor ways (`highway` = service, footway,
path, cycleway, track, steps, bridleway) that cross it. When the stroke shape covers at least
TUNE-CELL-TAKE of a cell's area, the freeform result shall include that whole cell.
  Why: paths and service roads inside a block are where real lots end. Paint should prefer them.

**SNAP-109** The editor shall never let a freeform result cut through a building. A building with at least
half its area inside the result shall be included whole, with a margin of TUNE-BUILDING-MARGIN. Any other
building within that margin of the result shall be left out, with the same margin.
  Why: landuse is about what the buildings are. A boundary through a house is always wrong.

**SNAP-110** The editor shall build the freeform result in this order: stroke shape within the open pieces
(SNAP-102), whole cells (SNAP-108), buildings (SNAP-109), leftover swallowing (SNAP-103, SNAP-104).

**SNAP-105** While a stroke is active, the editor shall show the snapped freeform result as a live preview
in the stroke's colour, updated at least every TUNE-PREVIEW-INTERVAL.

**SNAP-106** When a stroke ends, the editor shall apply the snapped freeform result. Its shape shall be
simplified with tolerance TUNE-SIMPLIFY, and it shall settle into place with the claim animation
(FEEL-001).

**SNAP-107** If applying a freeform result leaves a non-context piece in the same atom smaller than
TUNE-SLIVER-AREA, touching the result, then the editor shall merge that piece into the result.

---

## 10. Overlap

**OVL-001** The editor shall keep the pieces of each atom non-overlapping and covering the whole atom, with
void filling whatever no landuse covers.

**OVL-002** When painted landuse covers part of a piece of a different paintable kind, the editor shall give
the covered part to the new kind and shrink the old piece.
  Why: new paint wins. Overlaps get resolved at the moment they are made, never kept around.

**OVL-003** When a change leaves two pieces of the same kind touching inside one atom, the editor shall
merge them into one piece.

**OVL-004** The editor shall treat an imported piece whose geometry or kind the user changes as modified
(IMP-008); every fragment that came from the same OSM element stays linked to it.

---

## 11. Density steps

**DENS-001** The editor shall offer a *density up* tool (key `A`) and a *density down* tool (key `Z`).

**DENS-002** While a density stroke is active, when the cursor enters a residential piece that has a tier,
the editor shall move that piece one tier up (or down), once per piece per stroke.

**DENS-003** If a density step would go above R6 or below R1, then the editor shall leave the tier as it
is and play the *bump* feedback (FEEL-005).

**DENS-004** If a density tool touches unspecified residential or a non-residential landuse piece, then
the editor shall leave it alone and play the *reject* feedback (FEEL-004), at most once per stroke. Void is
ignored silently.

**DENS-005** The editor shall never split a piece with a density tool.

---

## 12. Undo

**UNDO-001** When the user presses Ctrl/Cmd+Z, the editor shall revert the most recent undo step.

**UNDO-002** When the user presses Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y, the editor shall reapply the most
recently reverted step.

**UNDO-003** When a new undo step is created, the editor shall discard all reverted steps.

**UNDO-004** When an undo or redo changes pieces, the editor shall animate them with the short settle
animation (FEEL-006), so the user can see what changed.

---

## 13. Camera and input

**CAM-001** When the user turns the mouse wheel or pinches, the editor shall zoom towards the cursor, with
smooth motion (TUNE-ZOOM-*).

**CAM-002** When the user drags with the secondary or middle button, or with the primary button while
holding Space, the editor shall pan the map. After release, it shall coast to a stop (TUNE-PAN-*).

**CAM-003** When the user presses an arrow key, the editor shall pan the map smoothly in that direction.

**CAM-004** When an area finishes loading, or the user presses `F`, the editor shall move the camera to fit
the whole area.

**CAM-005** The editor shall keep the zoom within TUNE-ZOOM-MIN..TUNE-ZOOM-MAX pixels per metre, and keep the
view centre within the area.

**INP-001** When the user presses `[` or `]`, or turns the wheel while holding Shift, the editor shall
shrink or grow the brush within TUNE-BRUSH-MIN..TUNE-BRUSH-MAX pixels.

**INP-002** When the user presses a tool key (KIND-001, KIND-007, DENS-001), the editor shall select that
tool.

**INP-003** When the user presses `B`, the editor shall toggle the building layer. When the user presses
`M`, it shall toggle sound. When the user presses `H` or `?`, it shall toggle the help panel.

**INP-004** The editor shall not open the browser context menu over the map.

---

## 14. Rendering, feel and HUD

### 14.1 Rendering

**REN-001** The editor shall draw, from bottom to top: street space, void land, water, exclusive context,
overlay context, landuse slabs, buildings, the stroke trail and preview, and the brush cursor.
  Why: overlay context (grass, parking) lives inside landuse; painted land must look fully painted.

**REN-002** The editor shall draw each landuse piece as a *slab*: the top face at its true position, and a
darker side face directly below it, offset downwards by the kind's lift in screen pixels, scaled with
zoom within TUNE-LIFT-ZOOM-CLAMP.
  Why: height reads as density at a glance, but the top face stays exactly where the data is.

**REN-003** The editor shall draw slabs in north-to-south order, so that southern slabs hide the sides of
northern slabs.

**REN-004** The editor shall draw a thin gap (TUNE-PIECE-GAP) between neighbouring pieces of different
kinds within an atom.

**REN-005** Where the building layer is on, the editor shall draw OSM building footprints as faint shapes
over the landuse.

**REN-006** While a paint tool is selected and the cursor is over the map, the editor shall faintly outline
the atoms within TUNE-HINT-RADIUS × brush radius of the cursor.
  Why: it shows where things will snap, without explaining why.

**REN-007** When the cursor is over a piece, the editor shall highlight that piece slightly.

**REN-008** The editor shall keep 60 frames per second on the demo area on a typical laptop, and shall
redraw only when something changed or is animating.

### 14.2 Feel

**FEEL-001** When a piece is claimed, the editor shall play the *pop*: the slab rises from the ground to its
lift with an overshoot (TUNE-POP-*), a brief light flash fades out, and the pop sound plays.

**FEEL-002** When several pieces are claimed at the same moment, the editor shall stagger their pops by
distance from the cursor (TUNE-POP-STAGGER).

**FEEL-003** Where sound is on, the editor shall play claim sounds whose pitch rises with tier; commercial,
retail and industrial each have their own pitch outside the residential range.

**FEEL-004** When an action is rejected, the editor shall play the *reject*: a short horizontal shake of the
brush cursor with a red tint, and a low sound.

**FEEL-005** When a density step hits the top or bottom of the ladder, the editor shall play the *bump*: a
small hop of the slab, with no change.

**FEEL-006** When pieces change because of undo or redo, the editor shall play a shortened pop without
overshoot.

**FEEL-007** When an area finishes loading, the editor shall reveal the existing landuse with a quick pop
wave from the centre outwards, lasting no longer than TUNE-REVEAL-MAX.

**FEEL-008** Where the user prefers reduced motion, the editor shall scale every animation duration by
TUNE-REDUCED-MOTION and leave out overshoot, shake and stagger.

**FEEL-009** The editor shall never make the user wait for an animation: input stays live during every
animation, and the model is updated before the animation starts.

### 14.3 HUD

**HUD-001** The editor shall show a palette with the residential ladder as one connected strip of six tiles
(R1→R6) whose icons grow in height, followed by commercial, retail, industrial, density up/down and the
eraser.

**HUD-002** When the user points at a palette tile, the editor shall show the tile's name, its key, and the
OSM tags it stands for.

**HUD-003** The editor shall show a *district mix* bar: the share of the area's land held by each kind
(R1–R6, unspecified residential, commercial, retail, industrial, exclusive context, void). Each segment
moves smoothly to its new value after every change.
  Why: like a city-builder's zoning meter — it tells you what the district is made of.

**HUD-004** The editor shall show the brush cursor as a ring in the current tool's colour, with its radius
following the brush size.

**HUD-005** The editor shall show the OSM attribution "© OpenStreetMap contributors" whenever OSM data is
on screen.

---

## 15. Non-goals for M0

**NG-001** The editor shall not upload, export, or otherwise write OSM data in M0.

**NG-002** The editor shall not edit any feature other than the landuse kinds in §5.

**NG-003** The editor shall not show a raster basemap.
  Why: the lattice *is* the map. Roads and blocks come from the same data the user is painting on.

---

## 16. Tuning table

All numbers here are starting values to be tuned by feel. The code mirrors them in `src/tuning.ts`.

| ID | Value | Meaning |
|----|-------|---------|
| TUNE-GEOM-SCALE | 100 per m | Integer geometry resolution (1 cm). |
| TUNE-AREA-SIDE | 1200 m | Side of a searched area. |
| TUNE-HALFWIDTH | motorway 12, trunk 10, primary 9, secondary 8, tertiary 7, unclassified 5, residential 5, living_street 4, pedestrian 4, road 5, `_link` 5, rail 4, light_rail 3, narrow_gauge 3, river 10, canal 8 (m) | Street space half-widths. `width=*`, when present, overrides with width ÷ 2. |
| TUNE-ATOM-MIN-AREA | 150 m² | Smallest kept atom. |
| TUNE-ATOM-MIN-RADIUS | 2.5 m | Smallest disc an atom or imported fragment must contain. |
| TUNE-IMPORT-MIN-FRAGMENT | 60 m² | Smallest kept imported fragment. |
| TUNE-IMPORT-SNAP | 6 m | Leftover radius closed around imported pieces. |
| TUNE-BRUSH-DEFAULT | 30 px | Initial brush radius. |
| TUNE-BRUSH-MIN / MAX | 8 / 120 px | Brush radius limits. |
| TUNE-TRAIL-STEP | 0.2 | Trail point spacing, as a fraction of brush radius. |
| TUNE-UNIT-FACTOR | 14 | Unit piece limit, as a multiple of brush disc area. |
| TUNE-UNIT-ABS-MAX | 150 000 m² | Unit piece limit, absolute. |
| TUNE-UNIT-SAMPLES | 120 | Target sample points per unit piece. |
| TUNE-CLAIM-COVERAGE | 0.3 | Covered fraction at which a unit piece is claimed. |
| TUNE-SMOOTH-FACTOR | 0.35 | Stroke smoothing radius ÷ brush radius. |
| TUNE-SNAP-FACTOR | 0.6 | Leftover swallow radius ÷ brush radius. |
| TUNE-CELL-TAKE | 0.5 | Covered fraction at which a cell is taken whole. |
| TUNE-BUILDING-MARGIN | 2.5 m | Yard kept around buildings by freeform results. |
| TUNE-SIMPLIFY | 0.4 m | Simplification tolerance of committed freeform shapes. |
| TUNE-SLIVER-AREA | 40 m² | Pieces smaller than this get merged after a change. |
| TUNE-PREVIEW-INTERVAL | 50 ms | Maximum freeform preview staleness. |
| TUNE-TAP-MOVE / TAP-TIME | 6 px / 350 ms | Tap detection. |
| TUNE-LIFT | R1 1, R2 2, R3 3, R4 4, R5 6, R6 9 (px) | Slab height per tier at 1 px/m. |
| TUNE-LIFT-NONRES | 3 px | Slab height of commercial, retail, industrial. |
| TUNE-LIFT-ZOOM-CLAMP | 0.5 .. 1.6 | Zoom scale factor applied to lift. |
| TUNE-PIECE-GAP | 0.6 m | Gap between neighbouring pieces of different kinds. |
| TUNE-HINT-RADIUS | 3 | Lattice hint radius ÷ brush radius. |
| TUNE-POP-DURATION | 340 ms | Claim pop length. |
| TUNE-POP-OVERSHOOT | 1.7 | Back-ease overshoot constant. |
| TUNE-POP-FLASH | 200 ms | Flash fade length. |
| TUNE-POP-STAGGER | 14 ms per 10 m | Pop stagger for simultaneous claims. |
| TUNE-REVEAL-MAX | 900 ms | Longest load reveal. |
| TUNE-ZOOM-MIN / MAX | 0.08 / 12 px/m | Zoom limits. |
| TUNE-ZOOM-HALFLIFE | 70 ms | Zoom smoothing half-life. |
| TUNE-PAN-HALFLIFE | 160 ms | Pan coasting half-life. |
| TUNE-REDUCED-MOTION | 0.3 | Duration factor with reduced motion. |

---

## 17. Corrections

*(none yet)*

---

## 18. Open questions

**Q-001** Which `residential=*` values should R2 (detached vs. single_family) and R5 (apartments vs. urban)
write when output arrives? Decide before output exists.

**Q-002** OSM has no established tag for high-rise residential areas. Options: `residential=apartments`
plus a `building:levels` hint, `residential=urban`, or a proposal. Until this is decided, R6 is
"R5 with more height" and does not round-trip through import.

**Q-003** Should output landuse stop at the kerb (our atom edge) or extend to road centrelines? The current
lattice stops at the kerb, which matches the common "don't glue landuse to roads" practice.

**Q-004** Should painting suggest a tier from the buildings underneath (count, footprint, levels)? Good
candidate for M1.
