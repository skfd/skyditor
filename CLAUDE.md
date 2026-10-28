# Working on Skyditor

## Requirements first

`REQUIREMENTS.md` (EARS) is the primary source of truth. Behaviour flows from it into code.

- Before changing behaviour, change or add the requirement (or a `CORR-*` correction, see §0.3), then the
  code and tests.
- Feel numbers are code-level work: knobs are named `TUNE-*` and live in `src/tuning.ts` with their meaning.
  A requirement names a knob, never its value (§16). Tuning a value is not a spec change.
- Which OSM tags mean what is a reading, not a design decision: requirements state the principle with a few
  examples, and the full tag tables live in `src/osm/classes.ts`, citing their requirement.
- Cite requirement IDs in code comments where they are implemented (`// SNAP-103`) and in test titles
  (`it("SNAP-103: …")`).
- When a requirement is satisfied to the letter but the result is still wrong, add a correction instead of
  quietly reinterpreting the original. Read the `Why:` lines: they say what "right" means.
- Never renumber or reuse IDs. Retire with strikethrough.

## Checks

```sh
npm test            # vitest; includes tests/tuning.test.ts: every TUNE-* the spec names exists in src/tuning.ts
npm run typecheck   # tsc
npm run trace       # fails on IDs cited in code/tests that REQUIREMENTS.md doesn't define, and on
                    # requirements cited nowhere in code (unless marked `Trace: policy`, see §0.4)
```

Requirements checked by hand rather than by a unit test carry `Trace: manual`; `trace` lists the ones
that have neither a marker nor a test, so a new testable requirement without a test shows up there.

Tests build tiny maps in local metres with `Sketch` (`tests/helpers.ts`), e.g.
`new Sketch(300).grid(200)` → nine blocks, roads every 200 m.

## Things to keep true

- Users never see internal concepts (GEN-002): no atoms, pieces, thresholds or buffers in the UI.
- Animations explain changes; they never delay input or the model (FEEL-009).
- All model geometry is in local planar metres centred on the area (`src/geo/project.ts`); lon/lat exists
  only at the import and URL edges.
- Geometry goes through `src/geo/clip.ts` (integer Clipper ops at `TUNE.GEOM_SCALE`). Don't mix in float
  boolean ops: that is how the lattice grows cracks (GEN-004).
- Requirements say what the user gets, in the user's words. How it is done (order of operations, sampling,
  buffering, draw order) belongs in a code comment next to the requirement's citation.
- Pieces are immutable; replace them, never mutate. Renderer caches and undo depend on object identity.
