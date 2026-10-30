// Interprets existing OSM landuse as pieces (IMP-004..IMP-012, CORR-001).
import {
  type BBox, type Shape, area, bbox, bboxOverlap, components, containsDisc, difference, interiorPoint, intersect,
  isEmpty, narrowParts, offset, toM, touches, union,
} from "../geo/clip";
import type { AreaFeature } from "../osm/features";
import { TUNE } from "../tuning";
import { type CtxClass, type Kind, agree } from "./kinds";
import { type Atom, type Piece, type Rival, type TagIssue, World, makePiece, normalize } from "./world";

const DRIFT_STEP = 0.5; // m; how far each side's claim grows per round when a drift strip is split (IMP-010)

interface Ranked {
  f: AreaFeature;
  kind: Kind;
  ctx?: CtxClass;
  box: BBox;
  land: number; // m² inside atoms (CORR-001)
  lost: Shape[]; // parts of its land given to other features
  disputes: { shape: Shape; rival: Rival }[]; // IMP-012: parts it holds that another feature disagrees about
}

/**
 * `only`: the atoms that just loaded (LOAD-011). Only they get pieces; atoms loaded before keep theirs, with the
 * user's changes (LOAD-013). Overlaps are still measured over all loaded land, so both sides of an area that
 * loaded in two goes are judged alike.
 */
export function importLanduse(world: World, areas: AreaFeature[], only?: Set<Atom>): { pieces: number; dropped: number } {
  const known = (list: AreaFeature[]) => new Set(list.map((a) => a.id));
  const overlay = known(world.overlay), originals = known(world.originals);
  world.overlay.push(...areas.filter((a) => a.klass.cls === "overlay" && !overlay.has(a.id)));
  world.originals.push(...areas.filter((a) => a.klass.cls === "paintable" && !originals.has(a.id)));
  const live = (atom: Atom) => !only || only.has(atom);

  const ranked: Ranked[] = [];
  for (const f of areas) {
    if (f.klass.cls !== "paintable" && f.klass.cls !== "exclusive") continue;
    const box = bbox(f.shape);
    let land = 0;
    for (const atom of world.atomsIn(box)) land += area(intersect(atom.shape, f.shape));
    ranked.push({
      f,
      kind: f.klass.cls === "paintable" ? f.klass.kind : "CTX",
      ctx: f.klass.cls === "exclusive" ? f.klass.ctx : undefined,
      box,
      land,
      lost: [],
      disputes: [],
    });
  }
  ranked.sort((a, b) => a.land - b.land || a.f.area - b.f.area);
  resolveOverlaps(world, ranked, live);

  // Each feature keeps what it did not lose. Smaller ones go first, so round-off never books land twice.
  let taken: Shape = [];
  const footprints = ranked.map((r) => {
    const fp = difference(difference(r.f.shape, union(...r.lost)), taken);
    taken = union(taken, fp);
    return fp;
  });
  // Land that every feature covering it lost (a three-way cycle) goes to the smallest of them.
  ranked.forEach((r, i) => {
    if (r.lost.length === 0) return;
    const orphan = difference(r.f.shape, taken);
    if (isEmpty(orphan)) return;
    footprints[i] = union(footprints[i], orphan);
    taken = union(taken, orphan);
  });

  const perAtom = new Map<Atom, Piece[]>();
  let dropped = 0;
  ranked.forEach((r, i) => {
    const footprint = footprints[i];
    if (isEmpty(footprint)) return;
    // IMP-005
    for (const atom of world.atomsIn(bbox(footprint)).filter(live)) {
      for (const frag of components(intersect(atom.shape, footprint))) {
        // IMP-006
        if (!keepable(frag)) {
          dropped++;
          continue;
        }
        const list = perAtom.get(atom) ?? [];
        list.push(...piecesOf(atom, r, frag));
        perAtom.set(atom, list);
      }
    }
  });

  let count = 0;
  for (const [atom, pieces] of perAtom) {
    atom.pieces = snapImported(atom, normalize(atom, pieces, false));
    count += pieces.length;
  }
  const issues = missingLanduse(world, only ? ranked.filter((r) => world.atomsIn(r.box).some(live)) : ranked);
  const fresh = new Set(issues.map((i) => i.source));
  world.issues = [...world.issues.filter((i) => !fresh.has(i.source)), ...issues];
  return { pieces: count, dropped };
}

/** IMP-014: school grounds mapped by their amenity (IMP-013) that no `landuse=education` outline covers. */
function missingLanduse(world: World, ranked: Ranked[]): TagIssue[] {
  const implied = ranked.filter((r) => r.f.klass.cls === "exclusive" && r.f.klass.implied && r.land > 0);
  if (implied.length === 0) return [];
  const landuse = union(
    ...ranked.filter((r) => r.f.klass.cls === "exclusive" && r.f.klass.ctx === "education" && !r.f.klass.implied)
      .map((r) => r.f.shape),
  );
  const issues: TagIssue[] = [];
  for (const r of implied) {
    const atoms = world.atomsIn(r.box);
    let covered = 0;
    if (!isEmpty(landuse)) for (const atom of atoms) covered += area(intersect(intersect(atom.shape, r.f.shape), landuse));
    if (covered >= TUNE.NEST_INSIDE * r.land) continue;
    // REN-016: the badge sits on the biggest piece the area kept, or else on its biggest bit of land.
    let spot: Shape = [];
    for (const atom of atoms)
      for (const p of atom.pieces) if (p.source === r.f.id && p.area > area(spot)) spot = p.shape;
    if (isEmpty(spot))
      for (const atom of atoms)
        for (const c of components(intersect(atom.shape, r.f.shape))) if (area(c) > area(spot)) spot = c;
    const [x, y] = interiorPoint(spot);
    const tagged = r.f.klass.cls === "exclusive" ? r.f.klass.label : "";
    issues.push({ source: r.f.id, tagged, missing: "landuse=education", at: [toM(x), toM(y)] });
  }
  return issues;
}

/** IMP-006: big enough, and thick enough, to be land anyone paints. */
const keepable = (s: Shape) => area(s) >= TUNE.IMPORT_MIN_FRAGMENT && containsDisc(s, TUNE.ATOM_MIN_RADIUS);

/** CORR-001, IMP-010..IMP-012: decides, pair by pair, who keeps each overlap. `ranked` is smallest first. */
function resolveOverlaps(world: World, ranked: Ranked[], live: (atom: Atom) => boolean) {
  for (let i = 0; i < ranked.length; i++) {
    const a = ranked[i];
    for (let j = i + 1; j < ranked.length; j++) {
      const b = ranked[j];
      if (!bboxOverlap(a.box, b.box)) continue;
      const overlap = intersect(a.f.shape, b.f.shape);
      if (isEmpty(overlap)) continue;
      // CORR-001: measured on land only; overlaps in street space don't matter.
      const parts: { atom: Atom; shape: Shape }[] = [];
      let inLand = 0;
      for (const atom of world.atomsIn(bbox(overlap))) {
        const shape = intersect(atom.shape, overlap);
        if (isEmpty(shape)) continue;
        if (live(atom)) parts.push({ atom, shape });
        inLand += area(shape);
      }
      if (inLand < 0.5) continue;
      if (inLand >= TUNE.NEST_INSIDE * a.land && a.land <= TUNE.NEST_SIZE * b.land) {
        b.lost.push(...parts.map((p) => p.shape));
        continue;
      }
      const agreeing = agree(a.kind, b.kind);
      // IMP-011: the tier wins over unspecified residential; IMP-012: context wins over landuse;
      // otherwise the smaller feature.
      const bWins = agreeing ? a.kind === "RU" && b.kind !== "RU" : b.kind === "CTX";
      const [win, lose] = bWins ? [b, a] : [a, b];
      for (const part of parts)
        for (const c of components(part.shape)) {
          if (!containsDisc(c, TUNE.IMPORT_SNAP)) {
            splitDrift(part.atom, c, a, b); // IMP-010
            continue;
          }
          lose.lost.push(c);
          if (!agreeing) win.disputes.push({ shape: c, rival: { kind: lose.kind, ctx: lose.ctx, source: lose.f.id } }); // IMP-012
        }
    }
  }
}

/**
 * IMP-010: splits a narrow overlap along its middle. Each side's own land grows into the strip in small
 * rounds; what both reach in the same round, or neither reaches, goes to the smaller feature `a`.
 */
function splitDrift(atom: Atom, strip: Shape, a: Ranked, b: Ranked) {
  const reach = TUNE.IMPORT_SNAP + 2 * DRIFT_STEP;
  const near = intersect(offset(strip, reach), atom.shape);
  const aNear = intersect(a.f.shape, near), bNear = intersect(b.f.shape, near);
  const seedA = difference(aNear, bNear), seedB = difference(bNear, aNear);
  const toA: Shape[] = [], toB: Shape[] = [];
  let rest = strip;
  for (let d = DRIFT_STEP; d <= reach && !isEmpty(rest); d += DRIFT_STEP) {
    const gA = isEmpty(seedA) ? [] : intersect(rest, offset(seedA, d));
    const gB = isEmpty(seedB) ? [] : difference(intersect(rest, offset(seedB, d)), gA);
    toA.push(gA);
    toB.push(gB);
    rest = difference(rest, union(gA, gB));
  }
  toA.push(rest);
  b.lost.push(union(...toA));
  a.lost.push(union(...toB));
}

/** One imported fragment as pieces: its disputed parts (IMP-012) apart from the rest. */
function piecesOf(atom: Atom, r: Ranked, frag: Shape): Piece[] {
  const k = r.f.klass;
  const extra = { ctx: r.ctx, source: r.f.id, ...(k.cls === "paintable" ? { name: k.name, whole: k.whole } : {}) }; // NAME-001, NAME-008
  const disputed: Piece[] = [];
  let rest = frag;
  for (const d of r.disputes) {
    if (!bboxOverlap(bbox(d.shape), bbox(rest))) continue;
    for (const part of components(intersect(rest, d.shape))) {
      if (!keepable(part)) continue; // IMP-012: too small to stand on its own
      disputed.push(makePiece(atom, r.kind, part, { ...extra, rival: d.rival }));
      rest = difference(rest, part);
    }
  }
  if (disputed.length === 0) return [makePiece(atom, r.kind, frag, extra)];
  const plain: Piece[] = [];
  for (const c of components(rest)) {
    if (area(c) < 0.05) continue; // round-off crumbs
    // A crumb left beside a disputed part joins it rather than standing alone.
    const host = keepable(c) ? -1 : disputed.findIndex((p) => touches(p.shape, c));
    if (host < 0) plain.push(makePiece(atom, r.kind, c, extra));
    else {
      const h = disputed[host];
      disputed[host] = makePiece(atom, r.kind, union(h.shape, c), { ...extra, rival: h.rival });
    }
  }
  return [...disputed, ...plain];
}

/** IMP-007: narrow void next to imported paintable pieces closes up against the block edge. */
function snapImported(atom: Atom, pieces: Piece[]): Piece[] {
  const voids = pieces.filter((p) => p.kind === null);
  if (voids.length === 0) return pieces;
  let land = pieces.filter((p) => p.kind !== null);
  const paintable = () => land.filter((p) => p.kind !== "CTX");
  if (paintable().length === 0) return pieces;
  let changed = false;
  for (const v of voids) {
    for (const narrow of narrowParts(v.shape, TUNE.IMPORT_SNAP)) {
      const grown = offset(narrow, 0.1);
      let best: Piece | null = null;
      let bestA = 0;
      for (const p of paintable()) {
        const a = area(intersect(grown, p.shape));
        if (a > bestA) [best, bestA] = [p, a];
      }
      if (!best) continue;
      const merged = makePiece(atom, best.kind, union(best.shape, narrow), {
        source: best.source,
        modified: best.modified,
        rival: best.rival,
        name: best.name,
        whole: best.whole,
      });
      land = land.map((p) => (p === best ? merged : p));
      changed = true;
    }
  }
  if (!changed) return pieces;
  // Snapping can join two fragments of the same feature; that is still one untouched feature.
  const fresh = normalize({ ...atom, pieces }, land, false);
  return fresh.flatMap((p) => (p.kind !== null && p.kind !== "CTX" ? split(atom, p) : [p]));
}

const split = (atom: Atom, p: Piece) => {
  const comps = components(p.shape);
  return comps.length <= 1
    ? [p]
    : comps.map((c) => makePiece(atom, p.kind, c, { source: p.source, modified: p.modified, rival: p.rival, name: p.name, whole: p.whole }));
};
