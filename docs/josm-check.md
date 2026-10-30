# Checking the output in JOSM

`npm run outcheck` proves what can be proved without JOSM: every reference resolves, every ring is simple,
no street node is taken, untouched areas are left alone, and the file reads back as the land that was painted
(OUT-001 to OUT-010). What only JOSM can confirm is below: its remote control, its validator, and how the
diff reads to a mapper. Run it once after any change to `src/output/`, on the demo district, which is
bundled and never changes under you.

Takes about ten minutes. You need JOSM 18000 or later with remote control on (it is on by default:
*Preferences → Remote Control → Enable remote control*), and Firefox or Chrome. Safari blocks the call.

## 1. Send changes to JOSM (JOSM-001, JOSM-002)

1. Start JOSM. Start the editor (`npm run dev`), open `http://localhost:5173/#demo`.
2. Before painting anything: the **JOSM** and **Save** buttons (top right) are disabled, and `K` does nothing.
3. Stop JOSM, or turn remote control off. Paint one block, press `K`.
   - [ ] One message says JOSM did not answer, tells you how to turn remote control on, and offers Save.
   - [ ] Pressing `K` again gives the same message, once, not two.
4. Start JOSM again (remote control on). Press `K`.
   - [ ] JOSM gets a new layer named `Skyditor · Tallinn · Kristiine (demo)`.
   - [ ] The editor says what went: `1 new area opened in JOSM`, in these words, no element counts.
   - [ ] In the layer, the painted area is one closed way, drawn as new (JOSM's green-ish "new" style),
         tagged `landuse=residential` plus the `residential=*` for the kind you painted (R2 → `single_family`).

## 2. What the diff looks like (OUT-002, OUT-003, OUT-005)

In the editor, undo (`Z`) to an empty history. Then:

1. Paint commercial over the right third of an existing residential area, so the area is cut.
2. Press `K`. In JOSM, select the changed residential way (it is marked modified; *Edit → Select → Modified*).
   - [ ] Its nodes on the stretch you did not touch are the ones it had before (positive ids, in the same
         order); the diff is a few deleted and added nodes along the cut, not a redrawn way.
   - [ ] The new commercial way and the residential way share the nodes along the cut: select one, hover a
         shared node, and both ways are listed in it.
   - [ ] Neither way uses a node of the street (select the street: its nodes belong to the street alone).
   - [ ] The residential way kept every other tag it had (`name=*`, `source=*`, …); only `landuse` and
         `residential` are the editor's.
3. Undo, then erase an area whole. Press `K`.
   - [ ] The way is marked deleted, and so are the nodes only it used; a node another way uses stays.

## 3. The validator (OUT-004, OUT-010)

With the layer from step 2 (or after a few more edits of your own: a strip across a block, an erase along a
street, a density step, paint in an empty block near buildings):

1. *Validation → Validate* (or the Validation panel's button) on the Skyditor layer.
   - [ ] No *self-intersecting ways* and no *crossing ways* among the written ways.
   - [ ] No *duplicated nodes* or *nodes at the same position* among the new nodes.
   - [ ] No *way contains segment twice* and no *zero-length segments*.
   - [ ] No multipolygon warnings for areas with holes: the relation has `type=multipolygon`, its `landuse`
         tags, one `outer` and the `inner` rings; member ways carry no landuse tags of their own.
   - [ ] Warnings about overlapping landuse, if any, are between a written area and one that was already
         overlapping in OSM, never between two written areas.
2. Note anything the validator says that `npm run outcheck` did not catch, and add it to
   `bench/output/check.ts`.

## 4. The file (JOSM-003)

1. In the editor, press **Save**. A file `skyditor-tallinn-kristiine-demo.osm` downloads.
2. *File → Open* it in JOSM.
   - [ ] It opens as a layer with the same changed, new and deleted elements as step 1 showed, upload-ready
         (*File → Upload data* lists them; cancel the upload).

## 5. Left out when changed meanwhile (OUT-008)

This one needs a live place, not the demo, and someone else's edit, so it is rarely run. If you do:
search a small place, paint one area, then in JOSM change that area's way on OSM (move one node, upload),
then press `K` in the editor.
   - [ ] The editor says the area was left out, by name, and sends the rest.

Do not upload anything from these sessions. Delete the JOSM layer afterwards (*Layer → Delete*).
