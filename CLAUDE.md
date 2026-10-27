# Working on Skyditor

## Requirements first

`REQUIREMENTS.md` (EARS) is the primary source of truth. Behaviour flows from it into code.

- Before changing behaviour, change or add the requirement (or a `CORR-*` correction, see §0.3), then the
  code and tests.
- Feel numbers live in the tuning table (§16) and are mirrored, with their IDs, in `src/tuning.ts`. Change
  the table first.
- Cite requirement IDs in code comments where they are implemented (`// SNAP-103`) and in test titles
  (`it("SNAP-103: …")`).
- When a requirement is satisfied to the letter but the result is still wrong, add a correction instead of
  quietly reinterpreting the original. Read the `Why:` lines: they say what "right" means.
- Never renumber or reuse IDs. Retire with strikethrough.

## Checks

```sh
npm test            # vitest
npm run typecheck   # tsc
npm run trace       # fails on IDs cited in code/tests that REQUIREMENTS.md doesn't define
```

Tests build tiny maps in local metres with `Sketch` (`tests/helpers.ts`), e.g.
`new Sketch(300).grid(200)` → nine blocks, roads every 200 m.

## Things to keep true

- Users never see internal concepts (GEN-002): no atoms, pieces, thresholds or buffers in the UI.
- Animations explain changes; they never delay input or the model (FEEL-009).
- Geometry goes through `src/geo/clip.ts` (integer Clipper ops). Don't mix in float boolean ops.
- Pieces are immutable; replace them, never mutate. Renderer caches and undo depend on object identity.
