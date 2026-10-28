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
- Feel and tuning numbers are not requirements. Where a requirement needs to name a knob, it uses the knob's
  `TUNE-*` ID (§16); the value lives in `src/tuning.ts` only.

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
- A requirement that cannot be traced the usual way says so in a `Trace:` line after its statement:
  - `Trace: manual` — implemented and cited in code, but checked by hand in the running app rather
    than by a unit test (animation, sound, layout, input bindings, network).
  - `Trace: policy` — holds by construction or review; nothing in the code to cite (non-goals, what the
    user must never see).
- `npm run trace` lists every requirement with its implementing and testing locations. It fails if code
  or tests cite an ID that does not exist here, and if a requirement without a `Trace:` line is cited
  nowhere in the code. Requirements that could have a test but don't are counted, not failed.

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
| **Street space** | The land the barriers take up, at their width (LAT-003). It is never paintable. |
| **Atom** | One connected piece of land left over when street space and water are removed from the area. In a city, roughly a *block*. Atoms are the coarse snapping lattice. |
| **Piece** | A connected region inside one atom with one landuse value (or none). Every atom is fully divided into pieces. |
| **Void** | A piece with no landuse. |
| **Kind** | The landuse value of a piece: a paintable kind (§5), an exclusive context kind (§6), or void. |
| **Tier** | The step on the residential ladder (R1 rural … R6 high-rise). |
| **Brush** | The circular painting tool. Its size is set on screen and fixed in metres for each stroke. |
| **Stroke** | One press–drag–release gesture with the brush. One stroke is one undo step. |
| **Tap** | A stroke with almost no movement and a short duration (TUNE-TAP-*). |
| **Unit piece** | A piece small enough, relative to the brush, to be claimed whole (§8). |
| **Open piece** | A piece too large to be a unit piece. It gets painted freeform and then snapped (§9). |
| **Claim** | Turning a whole piece into the stroke's kind. |
| **Charge** | Visible progress towards claiming a unit piece during a stroke. |
| **Disputed** | A piece where two imported features say different things (IMP-012). Shown to the user as "the map disagrees here". |
| **Rival** | The kind a disputed piece's losing feature claimed. |

---

## 2. General

**GEN-001** The editor shall run in a desktop web browser without a server component, other than public
OSM data services.
  Trace: policy

**GEN-002** The editor shall never show the user its internal concepts (atoms, pieces, coverage,
thresholds, buffers). The user sees only: map, landuse colours, brush, tools, and results.
  Why: the snapping can get as clever as it needs to internally; the user just paints.
  Trace: policy

~~**GEN-003** The editor shall keep all geometry in a local planar coordinate system, in metres, centred on
the loaded area.~~ Retired: a code convention the user cannot notice. It lives in CLAUDE.md.

**GEN-004** The editor shall never let the lattice develop cracks, slivers or overlaps between pieces:
neighbouring pieces share their edges exactly, however often the land is repainted.
  Why: a crack between two pieces is a hole in the map nobody painted. How the geometry stays exact is a
  code rule (CLAUDE.md).

**GEN-005** The editor shall let the user do everything with a pointer alone (mouse, pen or touch), without
a keyboard. Keys are shortcuts, never the only way to do something.
  Why: people paint with a mouse or a finger and may have no hand, or no keyboard, for keys. Alt-click
  picking (PAINT-008) is a shortcut for choosing a palette tile, so the palette covers it.
  Trace: manual

---

## 3. Loading OSM data

**LOAD-001** The editor shall offer a bundled demo area that loads without network access.

**LOAD-002** When the user picks a place from the search results, the editor shall load a square area of
side TUNE-AREA-SIDE centred on that place.
  Trace: manual

**LOAD-003** When loading an area by bounding box, the editor shall first query the Overpass API and, if
that fails, query the OSM API 0.6 `map` call.
  Trace: manual

**LOAD-004** When the user drops an `.osm` (XML) or Overpass JSON file onto the editor, the editor shall
load that file. The area is the file's declared bounds, or the extent of its nodes if there are none.

**LOAD-005** The editor shall read areas drawn as closed ways and as multipolygon relations alike, holes
included.

**LOAD-006** If a multipolygon ring cannot be closed, then the editor shall skip that ring, keep loading,
and count the skipped ring in the load report.

**LOAD-007** While an area is loading, the editor shall show the current loading stage (fetching,
reading, building blocks, reading landuse).
  Trace: manual

**LOAD-008** If loading fails, then the editor shall show a short reason and return to the start screen,
without changing any area that was already loaded.
  Trace: manual

**LOAD-009** When the page URL contains `#map=<lat>/<lon>`, the editor shall load the area centred there,
and it shall keep that fragment updated with the loaded area's centre. The demo area uses `#demo`.
  Why: repeatable dev sessions and shareable places.
  Trace: manual

---

## 4. Lattice (atoms)

**LAT-001** The editor shall treat as barriers the ways that cut a city into blocks: roads that carry
traffic, from motorways down to residential and pedestrian streets, railways, rivers and canals. Paths,
service roads and the like are not barriers (SNAP-108). The classes are listed in `src/osm/classes.ts`.
  Why: a block is what lies between the streets you would have to cross.

**LAT-002** The editor shall not treat a way tagged `tunnel` (any value except `no`), or `covered=yes`, as a
barrier.

**LAT-003** The editor shall give each barrier its real width on the map: its tagged `width` where present,
otherwise a typical width for its class (TUNE-HALFWIDTH), with rounded ends. This street space is never
paintable.

**LAT-004** The editor shall add to street space any `highway` area (closed way with `area=yes`, or an
`area:highway` feature) of a barrier class.

**LAT-005** The editor shall divide the land left after street space and water into atoms: every connected
piece of it is one atom, holes included.

**LAT-006** If a candidate atom is too small (TUNE-ATOM-MIN-AREA) or too thin (TUNE-ATOM-MIN-RADIUS) to be
land anyone paints, then the editor shall discard it.
  Why: traffic islands and slivers between parallel carriageways are not land anyone paints.

**LAT-007** The editor shall not split an atom along a dead-end barrier that ends inside it. The dead end
only becomes a notch in the atom.

**LAT-008** The editor shall treat as water the lakes, ponds, reservoirs, basins and river surfaces mapped
as areas (tags in `src/osm/classes.ts`). Coastline handling is out of scope for M0.

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
  Trace: manual

**KIND-003** The editor shall give each tier a colour on one continuous ramp, and a slab height
TUNE-LIFT that strictly increases from R1 to R6.

**KIND-004** The editor shall represent `landuse=residential` with no recognised `residential=*` value as
*unspecified residential*: a residential colour without a tier and without lift, shown with a hatch
pattern, translucent enough that overlay context beneath it stays visible.
  Why: most residential landuse in OSM has no subtag. It should look like it is waiting to be refined.

**KIND-005** The editor shall read each `residential=*` value that names a kind of housing as its tier
(KIND-001), synonyms included: `detached` and `single_family` are both R2, `apartments`, `urban` and
`block` all R5. The mapping is in `src/osm/classes.ts`.

**KIND-006** The editor shall give commercial, retail and industrial colours clearly distinct from the
residential ramp, and a single shared slab height TUNE-LIFT-NONRES.

**KIND-007** The editor shall offer an eraser (key `X`) that turns painted pieces back into void.

---

## 6. Interpreting existing landuse

Which tags mean what is a reading of OSM, not a design decision of this editor, and it shifts as mapping
practice does. The requirements here state the principle and a few examples; the full tag tables live in
`src/osm/classes.ts`, cite the requirement they implement, and are tested under its ID.

**IMP-001** The editor shall classify each loaded area feature as exactly one of: *paintable* (a landuse
kind of §5), *exclusive context*, *overlay context*, *water*, or *ignored*.

**IMP-002** The editor shall classify as exclusive context the land nobody paints landuse over: woods and
farmland, parks and golf courses, cemeteries, allotments, school grounds, military and railway land,
quarries, construction sites and the like.
  Why: this land is mapped by people with their own tags and practices. The editor shows it and paints
  around it (PAINT-004).

**IMP-003** The editor shall classify as overlay context the small features that sit inside landuse rather
than beside it: lawns, flowerbeds, gardens, playgrounds, pitches, parking.
  Why: in OSM these usually sit *inside* a residential or commercial area. They must not cut holes in
  the lattice. They are drawn on top, as hints.

**IMP-004** Where paintable and exclusive-context features overlap, the editor shall give the overlap to
the feature with the smaller area. → see CORR-001
  Why: a retail area drawn inside a big residential polygon is the more specific statement.

**IMP-005** The editor shall cut each paintable or exclusive-context feature into pieces at the block edges,
once its overlaps are resolved (IMP-004), so that every piece lies inside one atom.

**IMP-006** If an imported fragment inside an atom is too small (TUNE-IMPORT-MIN-FRAGMENT) or too thin
(TUNE-ATOM-MIN-RADIUS) to be land anyone meant, then the editor shall drop that fragment.
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
  Trace: manual

### Overlaps and disputes

Two overlapping features are *nested* when CORR-001 says so. The rest are sorted by the shape of their
overlap inside each block, and by whether their kinds *agree*: the same kind, unspecified residential and a
tier, or two exclusive-context kinds.

**IMP-010** If two features that are not nested overlap in a part of a block narrower than
2 × TUNE-IMPORT-SNAP, then the editor shall split that part along its middle between them.
  Why: an edge traced twice drifts by a few metres. Nobody meant the overlap, and the true boundary is
  most likely between the two lines, not on the outer one.

**IMP-011** Where two agreeing features that are not nested overlap in a wider part, the editor shall give
that part to the tier over unspecified residential, and otherwise to the smaller feature.
  Why: they say the same thing and differ only in detail, so the detail wins and nothing is wrong.

**IMP-012** If two disagreeing features that are not nested overlap in a wider part, then the editor shall
give that part to the exclusive-context feature if one of them is exclusive context, and otherwise to the
smaller feature, and mark it *disputed*, remembering the other feature and its kind as its rival. A
disputed part too small to keep as a fragment on its own (IMP-006) shall not be marked.
  Why: two mappers disagree, and nothing in the data says who is right. The lattice still needs one kind
  at every spot, but the editor must not pretend it knows. Context always holds the part because the
  editor never overwrites context (PAINT-004); it only asks the user to confirm the shrink (DISP-004).

**IMP-013** The editor shall read an area tagged as a school, university, college or kindergarten by its
`amenity` alone, with no landuse IMP-001 recognises, as education context (REN-015).
  Why: most school grounds in OSM carry only the amenity. Without this, their land shows as empty.

**IMP-014** The editor shall mark an area read by IMP-013 as *missing its landuse* unless at least
TUNE-NEST-INSIDE of its land lies inside `landuse=education` features.
  Why: the school is mapped but the landuse layer has a hole there. A separate `landuse=education` outline
  that already covers the grounds says all there is to say.

**DISP-001** When a paint stroke or a density step changes all or part of a disputed piece, the editor
shall make the changed part undisputed and leave the rest of the piece disputed.
  Why: painting over a disagreement is the user's answer to it. Undo brings the dispute back with the
  pieces (UNDO-001).

**DISP-002** The editor shall let paint tools claim a disputed piece that is not exclusive context even
when it already has the stroke's kind.
  Why: agreeing with what is shown is an answer too.

~~**DISP-003** The editor shall not let the eraser or density tools change disputed exclusive context.~~
Retired: replaced by DISP-004 and DISP-005.

**DISP-004** When the user taps a disputed exclusive-context piece with a paint tool or the eraser, the
editor shall settle the dispute in favour of the context: the piece keeps its kind and is no longer
disputed, and the rival feature counts as changed by the user (IMP-008).
  Why: parks, school grounds, cemeteries and the like are not this editor's to change, so the context
  always wins. But the neighbouring feature only shrinks once the user has seen the overlap and said so.

**DISP-005** If a stroke that is not a tap, or a density stroke, reaches disputed exclusive context, then
the editor shall leave it unchanged and play the reject feedback (PAINT-009, DENS-004).
  Why: painting past the overlap must not shrink a neighbouring feature as a side effect. Settling takes a
  deliberate click.

### Buildings

**BLD-001** The editor shall give each loaded building one *look*: a paintable kind (§5), unspecified
residential, education, civic, or unknown, from the first of BLD-002, BLD-004 and BLD-005 that applies, then adjusted
by BLD-003.
  Why: a building says what the land around it should be. When buildings and land share colours, the map
  reads without a legend, and a building that disagrees with its land shows where landuse is wrong or
  missing.

**BLD-002** When a building's `building=*` value names a kind of building, the editor shall give it the
matching look: farmhouses and cabins R1, houses R2, semi-detached houses R3, terraces R4, blocks of flats
R5, a plain `residential` building unspecified residential; offices and hotels commercial; shops and
supermarkets retail; warehouses and factories industrial; schools education; hospitals, places of worship
and public buildings civic. The table is in `src/osm/classes.ts`.
  Why: an explicit building type wins over everything else. A block of flats with shops downstairs is
  still residential land.

**BLD-003** When a building has the look R5 or unspecified residential and at least TUNE-HIGHRISE-LEVELS
levels, the editor shall give it the look R6. Its levels are `building:levels`, or else `height` in metres
÷ TUNE-LEVEL-HEIGHT.
  Why: R6 has no tag of its own (Q-002); the number of floors is the only honest signal. Other looks keep
  their type whatever the height: a 12-storey "house" is a tagging mistake, not a high-rise.

**BLD-004** When a building's type says nothing (BLD-002), the editor shall take its look from what the
building is used for, in this order: a shop → retail; an office → commercial; a school → education; a
hospital, place of worship, town hall, library, fire or police station → civic. The tags are in
`src/osm/classes.ts`.

**BLD-005** The editor shall give every other building the look unknown, including the untyped
`building=yes` and roofs, garages, sheds, greenhouses and ruins, and shall not guess a look from the
landuse around the building.
  Why: most buildings in OSM have no type. A guess from the land would only echo the land's colour back
  and pass a guess off as data. Garages next to houses are not industrial.

**BLD-006** The editor shall use building looks only for drawing (REN-009, REN-010, REN-011), not for
snapping, piece kinds or the district mix.
  Why: looks are hints for the eye. Using them to decide anything is Q-004 and Q-005.

**BLD-007** The editor shall treat a building as *disagreeing with its land* when its look is residential
(a tier or unspecified), commercial, retail or industrial, the piece under its centre has a paintable kind
or unspecified residential, and the two are in different families: residential (R1–R6 and unspecified),
business (commercial and retail), or industrial.
  Why: a house among flats is ordinary mixed housing, and offices above shops are ordinary business land.
  A factory among houses, or houses on industrial land, says the landuse is wrong. Civic and unknown
  buildings, void and context land say nothing either way.

---

## 7. Painting — general

**PAINT-001** When the user presses the primary button over the map with a paint tool selected, the editor
shall start a stroke with the current kind and a brush size that stays fixed, in metres, for the whole
stroke.

**PAINT-002** While a stroke is active, the editor shall follow the cursor closely enough that the trail
shows no corners at any brush size (TUNE-TRAIL-STEP).

**PAINT-003** While a stroke is active, the editor shall draw the brush trail as a soft translucent band in
the kind's colour.
  Trace: manual

**PAINT-004** The editor shall never change the kind or shape of exclusive-context pieces or water by
painting, erasing or density changes. Settling a dispute in favour of the context (DISP-004) is the only
change a tool makes to exclusive context.
  Why: the editor reads parks, school grounds, cemeteries, construction sites and other context, but it
  neither adds nor overwrites them.

**PAINT-005** When a stroke ends, the editor shall commit all of the stroke's changes as one undo step.

**PAINT-006** If a stroke changes nothing, then the editor shall not create an undo step.

**PAINT-007** When a paint stroke would change a piece to the kind it already has, the editor shall leave
that piece alone, unless it is disputed (DISP-002). It is not a claim.

**PAINT-008** When the user Alt-clicks a piece, the editor shall select that piece's kind as the current
tool. For unspecified residential, or an empty spot, nothing changes.
  Trace: manual

**PAINT-009** If the cursor enters exclusive context or water during a paint or eraser stroke, then the
editor shall play the *reject* feedback (FEEL-004), at most once per stroke. A tap that settles a dispute
(DISP-004) is not rejected.
  Why: protected land must not change, but silence reads as "broken".

**PAINT-010** If a second finger touches the map while a stroke is active, then the editor shall cancel
the stroke, restoring everything it changed without creating an undo step, and start the two-finger
gesture (CAM-006).
  Why: every two-finger pan starts with one finger. Without this, each pan would leave a dab of paint.

**PAINT-011** While any finger of a two-finger gesture is still on the map, the editor shall not start a
stroke.
  Why: lifting the fingers one at a time must not paint with the last one.
  Trace: manual

---

## 8. Snapping — unit pieces

**SNAP-001** The editor shall treat a piece as a unit piece when it is small relative to the brush: no more
than TUNE-UNIT-FACTOR brush discs in area, and never above TUNE-UNIT-ABS-MAX. → see CORR-002
  Why: zoom becomes precision. Zoomed out, the brush grabs whole blocks; zoomed in, it paints parts of
  blocks.

**SNAP-002** While a stroke is active, the editor shall track how much of each unit piece the stroke has
covered.

**SNAP-003** When a unit piece's covered fraction reaches TUNE-CLAIM-COVERAGE during a stroke, the editor
shall claim that piece immediately, without waiting for the stroke to end.

**SNAP-004** When the user taps inside a unit piece with a paint tool, the editor shall claim that whole
piece.

**SNAP-005** While a stroke is active, the editor shall show each partly covered unit piece charging: a
dashed outline and a light fill in the stroke's colour, both growing as the piece nears its claim
(SNAP-003). A charging piece shall never look claimed.
  Trace: manual

**SNAP-006** When a stroke ends, the editor shall drop the charge of every unit piece that was not
claimed, with no change to the piece.
  Why: unit pieces are all-or-nothing. Half-claimed blocks don't exist.

---

## 9. Snapping — open pieces (freeform)

**SNAP-101** The editor shall take as the stroke shape the land the brush passed over, with notches and
gaps much narrower than the brush smoothed away (TUNE-SMOOTH-FACTOR).

**SNAP-102** The editor shall limit the freeform result in each atom to the open pieces the stroke shape
touches, excluding exclusive-context pieces, and pieces already of the stroke's kind unless they are
disputed (DISP-002).

**SNAP-103** The editor shall swallow leftovers: within the touched open pieces, any part outside the
stroke shape that is narrower than the snap distance (TUNE-SNAP-FACTOR of the brush's width), and that
touches the stroke shape, shall join the result. The corners of a wider leftover belong to that leftover and
are never swallowed.
  Why: this is what makes paint "snap". A gap narrower than the snap distance between the paint and a
  road, a neighbouring landuse, or a context area closes by itself. Wide leftovers stay.

**SNAP-104** The editor shall not swallow narrow leftovers that do not touch the stroke shape.
  Why: painting the west half of a field must not grab a rounded-off corner on its far east side.

**SNAP-108** The editor shall divide each atom into *cells* along the minor ways that cross it: paths,
cycleways, service roads, tracks and steps (classes in `src/osm/classes.ts`). When the stroke shape covers
at least TUNE-CELL-TAKE of a cell's area, the freeform result shall include that whole cell.
  Why: paths and service roads inside a block are where real lots end. Paint should prefer them.

**SNAP-109** The editor shall never let a freeform result cut through a building. A building with at least
half its area inside the result shall be included whole, with a margin of TUNE-BUILDING-MARGIN. Any other
building within that margin of the result shall be left out, with the same margin.
  Why: landuse is about what the buildings are. A boundary through a house is always wrong.

~~**SNAP-110** The editor shall build the freeform result in this order: stroke shape within the open pieces
(SNAP-102), whole cells (SNAP-108), buildings (SNAP-109), leftover swallowing (SNAP-103, SNAP-104).~~
Retired: an order of operations is how, not what. It is a comment in `src/paint/snap.ts`.

**SNAP-105** While a stroke is active, the editor shall show the snapped freeform result as a live preview
in the stroke's colour, updated at least every TUNE-PREVIEW-INTERVAL.
  Trace: manual

**SNAP-106** When a stroke ends, the editor shall apply the snapped freeform result. Its outline shall be
cleaned of the brush's jitter (TUNE-SIMPLIFY), and it shall settle into place with the claim animation
(FEEL-001).

**SNAP-107** If applying a freeform result leaves a piece in the same atom smaller than TUNE-SLIVER-AREA,
touching the result, that the stroke could change (PAINT-004, DISP-002), then the editor shall
merge that piece into the result.

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
  Trace: manual

---

## 13. Camera and input

**CAM-001** When the user turns the mouse wheel or pinches, the editor shall zoom towards the cursor, with
smooth motion (TUNE-ZOOM-*).
  Trace: manual

**CAM-002** When the user drags with the secondary or middle button, or with the primary button while
holding Space, the editor shall pan the map. After release, it shall coast to a stop (TUNE-PAN-*).
  Trace: manual

**CAM-003** When the user presses an arrow key, the editor shall pan the map smoothly in that direction.
  Trace: manual

**CAM-004** When an area finishes loading, or the user presses `F` or the fit button (HUD-006), the editor shall move the camera to fit
the whole area.
  Trace: manual

**CAM-005** The editor shall keep the zoom within its limits (TUNE-ZOOM-MIN, TUNE-ZOOM-MAX), and keep the
view centre within the area.

**INP-001** When the user presses `[` or `]`, presses a brush size button (HUD-006), or turns the wheel
while holding Shift, the editor shall shrink or grow the brush within its limits (TUNE-BRUSH-MIN,
TUNE-BRUSH-MAX), one step (TUNE-BRUSH-STEP) per press.
  Trace: manual

**INP-002** When the user presses a tool key (KIND-001, KIND-007, DENS-001), the editor shall select that
tool.
  Trace: manual

**INP-003** When the user presses `B`, the editor shall toggle the building layer. When the user presses
`M`, it shall toggle sound. When the user presses `H` or `?`, it shall toggle the help panel.
  Trace: manual

**INP-004** The editor shall not open the browser context menu over the map.
  Trace: manual

**CAM-006** When the user drags two fingers on the map, the editor shall pan and zoom at once: the map point
under the fingers' midpoint stays under it, and the zoom follows the change in the fingers' spread. After
release, it shall coast to a stop (TUNE-PAN-*).
  Why: the map should feel stuck to the fingers, like every other map on a touch screen.

**CAM-007** When the user presses the zoom-in or zoom-out button (HUD-006), the editor shall zoom by
TUNE-ZOOM-STEP towards the centre of the view, with smooth motion.

---

## 14. Rendering, feel and HUD

### 14.1 Rendering

**REN-001** The editor shall draw, from bottom to top: street space, void land, water, exclusive context,
overlay context, landuse slabs, buildings, the edges of disputed pieces (REN-013), the stroke trail and
preview, and the brush cursor.
  Why: overlay context (grass, parking) lives inside landuse; painted land must look fully painted.
  Trace: manual

**REN-002** The editor shall draw each landuse piece as a *slab*: the top face at its true position, and a
darker side face below it, as tall as the kind's lift, growing a little with zoom (TUNE-LIFT-ZOOM-CLAMP).
  Why: height reads as density at a glance, but the top face stays exactly where the data is.
  Trace: manual

**REN-003** The editor shall let southern slabs hide the sides of northern slabs, as a city seen from the
south.
  Trace: manual

**REN-004** The editor shall draw a thin gap (TUNE-PIECE-GAP) between neighbouring pieces of different
kinds within an atom.
  Trace: manual

~~**REN-005** Where the building layer is on, the editor shall draw OSM building footprints as faint shapes
over the landuse.~~ Retired: replaced by REN-009 and REN-010.

**REN-006** While a paint tool is selected and the cursor is over the map, the editor shall faintly outline
the atoms within TUNE-HINT-RADIUS × brush radius of the cursor.
  Why: it shows where things will snap, without explaining why.
  Trace: manual

**REN-007** When the cursor is over a piece, the editor shall highlight that piece slightly.
  Trace: manual

**REN-008** The editor shall stay smooth (60 frames per second on the demo area on a typical laptop) and
shall not spend work redrawing while nothing on screen changes or moves.
  Trace: manual

**REN-009** Where the building layer is on, the editor shall draw each building whose look (BLD-001) is
not unknown in its look's colour mixed TUNE-BUILDING-SHADE of the way towards the neutral building colour,
at opacity TUNE-BUILDING-ALPHA. A look's colour is its kind's colour (§5), or the education or civic
context colour (REN-015).
  Why: on land of its own kind a building reads as the same family, a shade darker; on the wrong land it
  stands out.

**REN-010** Where the building layer is on, the editor shall draw buildings with the look unknown as faint
shapes in the neutral building colour.
  Trace: manual

**REN-011** Where the building layer is on, the editor shall draw each building that disagrees with its
land (BLD-007) with a dark edge in its look's colour and a ripple: a copy of that edge that grows out of the
footprint by TUNE-RIPPLE-REACH and fades, once every TUNE-RIPPLE-PERIOD, with neighbouring buildings out of
step.
  Why: the building calls out "I am not what this land says" without covering what the land is.

**REN-012** The editor shall draw a disputed piece in its own kind, striped with its rival's colour
(TUNE-DISPUTE-STRIPE).
  Why: both claims stay visible. Stripes already read as "not settled" (KIND-004).
  Trace: manual

**REN-013** The editor shall edge each disputed piece with small red spikes pointing outwards,
TUNE-SPIKE-SPACING apart, that creep along the edge at TUNE-SPIKE-SPEED.
  Why: a dispute is an error in the map. It should look sharp and alive, unlike anything the user paints.

**REN-014** While the only motion on screen is the ripples (REN-011) and spikes (REN-013), the editor shall
redraw at most once every TUNE-AMBIENT-INTERVAL.
  Why: slow motion needs few frames. Constant full-rate redraws would cost battery for nothing (REN-008).
  Trace: manual

**REN-015** The editor shall draw each exclusive-context piece flat, in the colour of its class, each class
clearly distinct from the others and from the paintable kinds:

| Class | Features (IMP-002) |
|-------|--------------------|
| Park | `leisure=park` |
| Education | `landuse=education`, and areas read by IMP-013 |
| Cemetery | `landuse=cemetery` |
| Construction | `landuse=construction` |
| Green | `landuse` = meadow, recreation_ground; `leisure` = golf_course, nature_reserve; `natural` = heath, grassland, wetland |
| Wood | `landuse=forest`; `natural` = wood, scrub |
| Farm | `landuse` = farmland, orchard, vineyard, allotments, greenfield, farmyard, plant_nursery; `natural` = sand, beach |
| Civic | `landuse` = religious, institutional; `leisure` = sports_centre, stadium |
| Grey | `landuse` = railway, brownfield, military, quarry, landfill; `natural=bare_rock` |

  Why: parks, school grounds, cemeteries and building sites are the context a city is full of, and each
  should read at a glance. The rest is grouped by how it looks from above.

**REN-016** The editor shall mark each area missing its landuse (IMP-014) with a small round badge at a
point well inside its land, kept at a constant screen size above the map, and with no other mark: no
spikes, stripes or motion.
  Why: a missing tag is a gap, not a contradiction. It should be easy to spot, and much quieter than a
  dispute (REN-013).

### 14.2 Feel

**FEEL-001** When a piece is claimed, the editor shall play the *pop*: the slab rises from the ground to its
lift with an overshoot (TUNE-POP-*), a brief light flash fades out, and the pop sound plays.
  Trace: manual

**FEEL-002** When several pieces are claimed at the same moment, the editor shall stagger their pops by
distance from the cursor (TUNE-POP-STAGGER).
  Trace: manual

**FEEL-003** Where sound is on, the editor shall play claim sounds whose pitch rises with tier; commercial,
retail and industrial each have their own pitch outside the residential range.
  Trace: manual

**FEEL-004** When an action is rejected, the editor shall play the *reject*: a short horizontal shake of the
brush cursor with a red tint, and a low sound.
  Trace: manual

**FEEL-005** When a density step hits the top or bottom of the ladder, the editor shall play the *bump*: a
small hop of the slab, with no change.
  Trace: manual

**FEEL-006** When pieces change because of undo or redo, the editor shall play a shortened pop without
overshoot.
  Trace: manual

**FEEL-007** When an area finishes loading, the editor shall reveal the existing landuse with a quick pop
wave from the centre outwards, lasting no longer than TUNE-REVEAL-MAX.
  Trace: manual

**FEEL-008** Where the user prefers reduced motion, the editor shall scale every animation duration by
TUNE-REDUCED-MOTION and leave out overshoot, shake and stagger. Ripples (REN-011) become a steady outline,
and spikes (REN-013) stand still.
  Trace: manual

**FEEL-009** The editor shall never make the user wait for an animation: input stays live during every
animation, and the model is updated before the animation starts.
  Trace: manual

### 14.3 HUD

**HUD-001** The editor shall show a palette with the residential ladder as one connected strip of six tiles
(R1→R6) whose icons grow in height, followed by commercial, retail, industrial, density up/down and the
eraser.
  Trace: manual

**HUD-002** When the user points at a palette tile, the editor shall show the tile's name, its key, and the
OSM tags it stands for.
  Trace: manual

**HUD-003** The editor shall show a *district mix* bar: the share of the area's land held by each kind
(R1–R6, unspecified residential, commercial, retail, industrial, exclusive context, void). Each segment
moves smoothly to its new value after every change.
  Why: like a city-builder's zoning meter — it tells you what the district is made of.
  Trace: manual

**HUD-004** The editor shall show the brush cursor as a ring in the current tool's colour, with its radius
following the brush size.
  Trace: manual

**HUD-005** The editor shall show the OSM attribution "© OpenStreetMap contributors" whenever OSM data is
on screen.
  Trace: manual

**HUD-006** The editor shall show map controls at the side of the map: undo and redo (UNDO-001, UNDO-002),
zoom in and out (CAM-007), fit area (CAM-004), and brush grow and shrink (INP-001) around a dot that shows
the brush size. Undo and redo shall look disabled while there is nothing to undo or redo.
  Why: GEN-005. Each control does exactly what its key does.
  Trace: manual

**HUD-007** The editor shall show toggle buttons for the building layer (INP-003) and the original
outlines (IMP-009), each showing whether its layer is on.
  Trace: manual

**HUD-008** The editor shall list, in the help panel, the pointer or touch way of doing each action next to
its key.
  Trace: manual

**HUD-009** While any piece is disputed, the editor shall show a button in the top bar with the number of
places where the map disagrees (one per disputed piece). It is hidden while there are none.
  Why: errors you can't find don't get fixed. The count turns them into a short list to work through.

**HUD-010** When the user presses that button, or presses `N`, the editor shall move the camera to the next
disputed piece, north to south, so that at least TUNE-DISPUTE-VIEW of land around it is in view, and
flash it.

**HUD-011** When a change settles the last disputed piece, the editor shall say briefly that the map no
longer disagrees anywhere.
  Why: finishing the list is a small win. It should feel like one.
  Trace: manual

**HUD-012** When the user presses a badge (REN-016), the editor shall show next to it what the area is
tagged as, the landuse tag it lacks, and a link that opens the area on openstreetmap.org in a new tab.
Pressing anywhere else closes it.
  Why: the editor writes no tags (NG-001), so the fix happens in OSM. The link takes the user straight
  there.
  Trace: manual

---

## 15. Non-goals for M0

**NG-001** The editor shall not upload, export, or otherwise write OSM data in M0.
  Trace: policy

**NG-002** The editor shall not edit any feature other than the landuse kinds in §5.
  Trace: policy

**NG-003** The editor shall not show a raster basemap.
  Why: the lattice *is* the map. Roads and blocks come from the same data the user is painting on.
  Trace: policy

---

## 16. Tuning

Feel numbers are code-level work, not requirements. Each knob is named `TUNE-*` and lives in
`src/tuning.ts` with its unit and a one-line meaning. A requirement names a knob where it needs a word for
"the snap distance" or "the brush limits"; it never states the value, and tuning a value is not a change to
this file. `npm test` fails if this file names a knob that `src/tuning.ts` does not have.

---

## 17. Corrections

**CORR-001** (corrects IMP-004) The editor shall give an overlap to the smaller feature by size alone only
where the two are *nested*: at least TUNE-NEST-INSIDE of the smaller feature's land lies inside the larger
one, and its land area is at most TUNE-NEST-SIZE of the larger one's. Every other overlap is settled by
IMP-010 to IMP-012. Land areas and overlaps are measured inside atoms only.
  Observed: smaller-wins also decided near-duplicates (a few square metres decided between commercial and
  retail), gave whole drift strips to one side, and settled real disagreements silently.
  Why: "the smaller one is more specific" is only true when one feature is clearly drawn inside the other.

**CORR-002** (corrects SNAP-001) The editor shall never treat a piece as a unit piece, whatever its area,
once a freeform result (SNAP-106) has drawn part of its outline: the pieces of the result, what it leaves
of the pieces it shrinks, the void it leaves behind, and any piece these later merge into.
  Observed: after painting a U into a block, the void inside the U stayed joined to the void around it.
  Zoomed out, that leftover fell under the unit limit, so brushing the whole gap charged it to about 20%
  and let go with no change, every time.
  Why: unit pieces are the blocks and mapped areas the user finds on the map. A leftover shaped by the
  user's own paint is not one of them, and land the user has brushed over must take the paint.

---

## 18. Open questions

**Q-001** Which `residential=*` values should R2 (detached vs. single_family) and R5 (apartments vs. urban)
write when output arrives? Decide before output exists.

**Q-002** OSM has no established tag for high-rise residential areas. Options: `residential=apartments`
plus a `building:levels` hint, `residential=urban`, or a proposal. Until this is decided, R6 is
"R5 with more height" and does not round-trip through import.
  In use (44-city run, `research/landuse-edges/`): `residential=*` is on 12% of residential polygons, most
  often `apartments` (1,345), `urban` (793), `rural` (237), `detached` (204) and `single_family` (136).

~~**Q-003** Should output landuse stop at the kerb (our atom edge) or extend to road centrelines? The current
lattice stops at the kerb, which matches the common "don't glue landuse to roads" practice.~~ Answered:
neither. Landuse never shares nodes with roads, and it stops at the property line, beyond the sidewalk
(see Q-008 and `research/landuse-edges/`). Street space (LAT-003) does not do this yet; requirements to follow.
The study's README proposes them, with values.

**Q-004** Should painting suggest a tier from the buildings underneath (count, footprint, levels)? Good
candidate for M1.

**Q-005** Should buildings with the look unknown get an inferred look, drawn fainter than a tagged one?
Candidate signals, strongest first: footprint shape (two buildings sharing a wall → semi-detached, a row
of narrow buildings sharing walls → terraced, small detached footprint → house, very large plain footprint
→ industrial or retail); then address and entrance nodes (several house numbers on one footprint, many
`addr:unit`/`addr:flats`/`entrance=*` → apartments). Address mapping differs a lot between cities
(on the outline, inside it, or imported points at the plot centre), and fetching tagged nodes makes area
downloads bigger. The same inference should feed Q-004, so colours and suggestions never disagree.

~~**Q-006** How does the user settle a dispute in favour of exclusive context ("it really is a park")? Paint
tools can only answer with a paintable kind (DISP-003). Design together with Q-007.~~ Answered: context
always wins, and the user confirms it with a tap (IMP-012, DISP-004).

**Q-007** One feature with two landuse statements (for example `landuse=residential` + `leisure=park` on the
same way) is an error of the same family as a dispute. IMP-001 currently picks one class quietly. How
should the editor show it, and how does the user settle it?

**Q-008** Should the editor match the local mapping style for where landuse meets the street? Well-mapped
areas use two styles: to the kerb, with sidewalks inside the landuse (Berlin, Vilnius, Kyiv), and to the
property line, a median 1.4–1.9 m beyond a separately mapped sidewalk (Finland, Poland, Latvia, Great
Britain, Canada, Hamburg, Munich). For now the editor uses the property-line style everywhere (Q-003).
Later it should detect the style from the existing landuse in the loaded area and follow it. The 44-city
run in `research/landuse-edges/` says this works where sidewalks are mapped separately: a city keeps one
style (88–93% of square pairs agree), and one 600 m square with about 20 sidewalk crossings decides it.
  Why: an editor that pulls every edit towards one style fights the local mappers.

**Q-009** Most OSM landuse is not drawn block by block. In the 44-city run, 61% of residential street
length in squares with landuse runs inside it. In the Netherlands, Austria, Switzerland, France, Hungary,
Denmark and Sweden, almost no square is block by block. The editor writes landuse per block. Should it
also offer the neighbourhood style where that is the local habit, or leave such areas as they are?
  Why: the same reasoning as Q-008, one level up.
