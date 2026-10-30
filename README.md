# Skyditor

A focused, game-feel OpenStreetMap editor for **landuse only** — mainly cities. You paint residential,
commercial, retail and industrial land, and it snaps into place by itself.

This is milestone **M0, the toy**: it reads OSM data and lets you paint, snap and undo. It does not
write anything back to OSM yet.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173  (add #demo to jump straight into the demo area)
npm test           # unit tests, named after the requirements they verify
npm run trace      # requirement ↔ code ↔ test traceability (-v for file names)
```

Load an area by:
- **Demo district** — bundled, works offline (`public/fixtures/demo-tallinn.json`).
- **Search** — Nominatim, then a square around the result from Overpass (fallback: OSM API).
- **Drop a file** — `.osm` XML or Overpass JSON.
- **URL** — `#map=<lat>/<lon>`.

## How it works, in one paragraph

Roads, railways and rivers are buffered into *street space*; what's left are *atoms*, roughly city blocks.
Every atom is fully divided into *pieces*, each with one landuse value or none. A piece small enough
relative to the brush is a *unit*: scrub enough of it, or click it, and it flips whole. A bigger piece is
painted freeform, then snapped. The snap takes whole cells cut out by footpaths and service roads, takes
or leaves whole buildings with a small yard, and swallows any leftover strip too narrow to stand on its
own. Zoom is precision: zoomed out, you paint whole blocks; zoomed in, you paint parts of them. None of
these words appear in the UI.

Buildings get the same treatment. Most are `building=yes`, so the editor guesses what they are from the
building alone: shared walls (one, a pair, a row), footprint size and levels, addresses on the building, and
the typed buildings of similar size in the same block. A guess is drawn hatched; brush over it with *Agree*
to accept. Where the signals disagree the building wears a `?` and the editor says what it could be; switch
the brush to buildings (`T`), pick a tile and click to decide. The land under a building is never a signal.
To check, hold `V` for aerial imagery under the outlines, or press `P` and point at a building for the nearest
open street photo of it (Panoramax, with links to Mapillary and KartaView). Only sources OSM may be edited
from are used.

## Development model

[`REQUIREMENTS.md`](REQUIREMENTS.md) is the source of truth. It's written in
[EARS](https://alistairmavin.com/ears/) syntax, with a tuning table for all feel numbers and a
*corrections* section for "formally compliant but not right" fixes. Code and tests cite requirement IDs.
See §0 of that file for the rules.

## Layout

```
REQUIREMENTS.md     source of truth (EARS)
src/tuning.ts       mirror of the tuning table
src/geo/            integer polygon ops (Clipper) and local projection
src/osm/            parsing, feature extraction, network fetches
src/lattice/        street space and atoms
src/model/          kinds, world (atoms/pieces), import, history, loading
src/paint/          strokes, unit coverage, freeform snapping
src/render/         camera, animation, canvas renderer
src/ui/             HUD, icons, sound
tests/              vitest, synthetic map sketches (tests/helpers.ts)
scripts/            fixture builder, traceability
```

## Licence

The code is public domain: [CC0 1.0](LICENSE). Use it for anything, no credit needed.

Map data is not. Everything under `public/fixtures/`, and anything the app loads from OSM, is
© OpenStreetMap contributors and licensed under the [ODbL](https://www.openstreetmap.org/copyright).
Bundled libraries keep their own licences: rbush (MIT), quickselect (ISC), clipper-lib (Boost).
