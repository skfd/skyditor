// Tuning knobs (REQUIREMENTS.md §16). This is the only place their values live.
// Requirements name a knob by its TUNE-* ID; changing a value here is tuning, not a requirement change.
// All values are starting points to be tuned by feel.

export const TUNE = {
  // Geometry and loading
  GEOM_SCALE: 100, // TUNE-GEOM-SCALE: integer units per metre (1 cm resolution)
  AREA_SIDE: 1200, // TUNE-AREA-SIDE: side of a searched area, m
  HALFWIDTH: {
    // TUNE-HALFWIDTH: street space half-width per barrier class, m; `width=*` overrides with width ÷ 2
    motorway: 12, trunk: 10, primary: 9, secondary: 8, tertiary: 7, unclassified: 5,
    residential: 5, living_street: 4, pedestrian: 4, road: 5, link: 5,
    rail: 4, light_rail: 3, narrow_gauge: 3, river: 10, canal: 8,
  } as Record<string, number>,
  ATOM_MIN_AREA: 150, // TUNE-ATOM-MIN-AREA: smallest kept atom, m²
  ATOM_MIN_RADIUS: 2.5, // TUNE-ATOM-MIN-RADIUS: smallest disc an atom or imported fragment must contain, m

  // Importing landuse
  IMPORT_MIN_FRAGMENT: 60, // TUNE-IMPORT-MIN-FRAGMENT: smallest kept imported fragment, m²
  IMPORT_SNAP: 6, // TUNE-IMPORT-SNAP: leftover radius closed around imported pieces, m; half the widest overlap split as drift (IMP-010)
  NEST_INSIDE: 0.9, // TUNE-NEST-INSIDE: share of the smaller feature's land inside the larger one for nesting (CORR-001)
  NEST_SIZE: 0.8, // TUNE-NEST-SIZE: largest land area of the smaller feature, as a share of the larger one's, for nesting (CORR-001)

  // Brush
  BRUSH_DEFAULT: 30, // TUNE-BRUSH-DEFAULT: initial brush radius, px
  BRUSH_MIN: 8, // TUNE-BRUSH-MIN: smallest brush radius, px
  BRUSH_MAX: 120, // TUNE-BRUSH-MAX: largest brush radius, px
  BRUSH_STEP: 1.15, // TUNE-BRUSH-STEP: brush radius factor per key or button press
  TRAIL_STEP: 0.2, // TUNE-TRAIL-STEP: trail point spacing, × brush radius
  TAP_MOVE: 6, // TUNE-TAP-MOVE: farthest a tap may move, px
  TAP_TIME: 350, // TUNE-TAP-TIME: longest a tap may last, ms

  // Snapping: unit pieces
  UNIT_FACTOR: 14, // TUNE-UNIT-FACTOR: unit piece limit, × brush disc area
  UNIT_ABS_MAX: 150_000, // TUNE-UNIT-ABS-MAX: unit piece limit, absolute, m²
  UNIT_SAMPLES: 120, // TUNE-UNIT-SAMPLES: target sample points per unit piece for coverage
  CLAIM_COVERAGE: 0.3, // TUNE-CLAIM-COVERAGE: covered fraction at which a unit piece is claimed

  // Snapping: freeform
  SMOOTH_FACTOR: 0.35, // TUNE-SMOOTH-FACTOR: stroke smoothing radius ÷ brush radius
  SNAP_FACTOR: 0.6, // TUNE-SNAP-FACTOR: leftover swallow radius ÷ brush radius
  CELL_TAKE: 0.5, // TUNE-CELL-TAKE: covered fraction at which a cell is taken whole
  BUILDING_MARGIN: 2.5, // TUNE-BUILDING-MARGIN: yard kept around buildings by freeform results, m
  SIMPLIFY: 0.4, // TUNE-SIMPLIFY: simplification tolerance of committed freeform shapes, m
  SLIVER_AREA: 40, // TUNE-SLIVER-AREA: pieces smaller than this get merged after a change, m²
  PREVIEW_INTERVAL: 50, // TUNE-PREVIEW-INTERVAL: maximum freeform preview staleness, ms

  // Buildings
  HIGHRISE_LEVELS: 9, // TUNE-HIGHRISE-LEVELS: levels from which a residential building looks high-rise
  LEVEL_HEIGHT: 3, // TUNE-LEVEL-HEIGHT: height of one level, for buildings with only `height`, m
  BUILDING_SHADE: 0.35, // TUNE-BUILDING-SHADE: how far a building's colour is mixed towards the neutral building colour
  BUILDING_ALPHA: 0.85, // TUNE-BUILDING-ALPHA: opacity of buildings with a known look

  // Guessing building types (TYPE-002)
  GUESS_TOUCH: 0.3, // TUNE-GUESS-TOUCH: gap up to which two footprints count as sharing a wall, m
  GUESS_HOUSE_AREA: 350, // TUNE-GUESS-HOUSE-AREA: largest footprint of a house or one terraced unit, m²
  GUESS_BIG_AREA: 1500, // TUNE-GUESS-BIG-AREA: footprint from which a building is apartments or business, m²
  GUESS_APT_LEVELS: 4, // TUNE-GUESS-APT-LEVELS: levels from which a building is apartments
  GUESS_MANY_ADDR: 5, // TUNE-GUESS-MANY-ADDR: addresses from which a building is apartments
  GUESS_SIMILAR: 2, // TUNE-GUESS-SIMILAR: area ratio within which two buildings in a block are of similar size
  GUESS_NEIGHBOUR_MIN: 3, // TUNE-GUESS-NEIGHBOUR-MIN: typed similar neighbours needed before they count
  GUESS_NEIGHBOUR_SHARE: 0.75, // TUNE-GUESS-NEIGHBOUR-SHARE: share of them with one look for that look to count
  GUESS_ALPHA: 0.55, // TUNE-GUESS-ALPHA: opacity of a guessed building, before its hatch

  // Disputes
  RIPPLE_PERIOD: 2400, // TUNE-RIPPLE-PERIOD: time between ripples of a disagreeing building, ms
  RIPPLE_REACH: 12, // TUNE-RIPPLE-REACH: how far a ripple grows out of the footprint, px
  DISPUTE_STRIPE: 12, // TUNE-DISPUTE-STRIPE: stripe period on disputed pieces (rival colour on half of it), px
  SPIKE_SPACING: 11, // TUNE-SPIKE-SPACING: distance between spikes on a disputed piece's edge, px
  SPIKE_SIZE: 5, // TUNE-SPIKE-SIZE: spike length, px
  SPIKE_SPEED: 6, // TUNE-SPIKE-SPEED: how fast spikes creep along the edge, px/s
  AMBIENT_INTERVAL: 50, // TUNE-AMBIENT-INTERVAL: shortest time between redraws for ripples and spikes alone, ms
  DISPUTE_VIEW: 160, // TUNE-DISPUTE-VIEW: smallest stretch of land shown around a disputed piece the camera moves to, m

  // Slabs
  LIFT: { R1: 1, R2: 2, R3: 3, R4: 4, R5: 6, R6: 9 } as Record<string, number>, // TUNE-LIFT: slab height per tier at 1 px/m, px
  LIFT_NONRES: 3, // TUNE-LIFT-NONRES: slab height of commercial, retail, industrial, px
  LIFT_ZOOM_CLAMP: [0.5, 1.6] as const, // TUNE-LIFT-ZOOM-CLAMP: zoom scale factor applied to lift, min .. max
  PIECE_GAP: 0.6, // TUNE-PIECE-GAP: gap between neighbouring pieces of different kinds, m
  HINT_RADIUS: 3, // TUNE-HINT-RADIUS: lattice hint radius ÷ brush radius

  // Feel
  POP_DURATION: 340, // TUNE-POP-DURATION: claim pop length, ms
  POP_OVERSHOOT: 1.7, // TUNE-POP-OVERSHOOT: back-ease overshoot constant
  POP_FLASH: 200, // TUNE-POP-FLASH: flash fade length, ms
  POP_STAGGER: 1.4, // TUNE-POP-STAGGER: pop stagger for simultaneous claims, ms per metre from the cursor
  REVEAL_MAX: 900, // TUNE-REVEAL-MAX: longest load reveal, ms
  REDUCED_MOTION: 0.3, // TUNE-REDUCED-MOTION: duration factor with reduced motion

  // Camera
  ZOOM_MIN: 0.08, // TUNE-ZOOM-MIN: farthest zoom out, px/m
  ZOOM_MAX: 12, // TUNE-ZOOM-MAX: closest zoom in, px/m
  ZOOM_STEP: 1.6, // TUNE-ZOOM-STEP: zoom factor per zoom button press
  ZOOM_HALFLIFE: 70, // TUNE-ZOOM-HALFLIFE: zoom smoothing half-life, ms
  PAN_HALFLIFE: 160, // TUNE-PAN-HALFLIFE: pan coasting half-life, ms
};
