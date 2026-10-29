// Canvas renderer (REN-001..REN-014, TYPE-004).
import { type Shape, contains, toI, toM } from "../geo/clip";
import { type Building, type BuildingGeom, statusOf } from "../model/buildings";
import { type BuildingLook, CTX_COLORS, type Kind, KINDS, disagreesWithLand, lookColor } from "../model/kinds";
import type { Atom, BuildingSet, Piece, Rival, World } from "../model/world";
import type { Stroke } from "../paint/stroke";
import { type Target, type Tool, onBuildings } from "../paint/snap";
import { type TileCache, tileAt, tileBounds, tileZoom } from "../osm/imagery";
import { TUNE } from "../tuning";
import type { Anims } from "./anim";
import type { Camera } from "./camera";
import { faces } from "./faces";
import { rippleT, spikePhase, spikesAlong } from "./marks";

const BUILDING_INK = [74, 52, 40];

export const COLORS = {
  street: "#e3dccf",
  lot: "#f7f3eb",
  lotEdge: "#ebe4d7",
  water: "#93c9e8",
  building: `rgba(${BUILDING_INK}, 0.17)`, // REN-010
  minor: "rgba(255, 255, 255, 0.75)",
  hint: "rgba(80, 64, 48, 0.55)",
  eraser: "#f4f1ea",
  dispute: "#d6363c", // REN-013
  unsure: "#e5961a", // TYPE-004: the unsure mark, the amber of the missing-landuse badge (REN-016)
  unsureHover: "#c27a06", // CORR-004: the mark under the cursor, as a badge darkens on hover
  agree: "#4f9d69", // TYPE-007
  camera: "#2b7de9", // PEEK-003: where a photo was taken
};

export interface RenderState {
  camera: Camera;
  stroke: Stroke | null;
  tool: Tool;
  target: Target; // TYPE-006
  brushPx: number;
  cursor: [number, number] | null; // screen px
  hover: Piece | Building | null; // REN-007 / CORR-004: a piece, or a building while the brush acts on buildings
  showBuildings: boolean;
  showOriginals: boolean;
  imagery: TileCache | null; // PEEK-001: set while the imagery peek is on
  photo: { x: number; y: number; azimuth: number | null } | null; // PEEK-003: where the shown photo was taken, metres
  anims: Anims;
  panning: boolean;
}

interface PieceGfx {
  of: readonly Piece[]; // the atom's pieces these were worked out among
  path: Path2D; // the piece's own top face
  cx: number;
  cy: number;
  group: GroupGfx | null; // REN-004: touching pieces of the same kind, drawn as one surface
}

interface GroupGfx {
  path: Path2D;
  outside: Path2D; // everything but the surface, to keep side faces off it
}

/** A building with a look, for REN-011. */
interface LookedBuilding {
  path: Path2D;
  look: BuildingLook;
  color: string;
  x: number; // centre, integer units
  y: number;
  r: number; // half its larger side, m
}

/** The drawable form of one building set (TYPE-001 states), cached on the set's items identity. */
interface SetGfx {
  items: Building[];
  faint: Path2D; // REN-010: typed buildings the palette has no kind for, and unsure buildings
  typed: [string, Path2D][]; // REN-009, by colour
  guessed: [string, Path2D][]; // TYPE-004, by colour
  marks: [number, number][]; // TYPE-004: centres of unsure buildings, metres
  looked: LookedBuilding[]; // REN-011 candidates
}

/** REN-012: the colour a rival kind would have. */
const rivalColor = (r: Rival) => (r.kind === "CTX" ? CTX_COLORS[r.ctx ?? "green"] : KINDS[r.kind].color);

export function toolColor(t: Tool): string {
  if (t.type === "paint") return KINDS[t.kind].color;
  if (t.type === "erase") return "#9a8f80";
  if (t.type === "agree") return COLORS.agree;
  return t.dir > 0 ? "#e2683c" : "#6f9bd1";
}

/** REN-002: slightly darker side face. */
export function darken(hex: string, f = 0.74): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

/** REN-009: a look's colour, mixed TUNE-BUILDING-SHADE towards the neutral building colour. */
export function buildingColor(look: BuildingLook): string {
  const n = parseInt(lookColor(look).slice(1), 16);
  const t = TUNE.BUILDING_SHADE;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v * (1 - t) + BUILDING_INK[i] * t));
  return `rgb(${r},${g},${b})`;
}

export function pathOf(shape: Shape): Path2D {
  const p = new Path2D();
  for (const ring of shape) {
    if (ring.length < 2) continue;
    p.moveTo(toM(ring[0].X), toM(ring[0].Y));
    for (let i = 1; i < ring.length; i++) p.lineTo(toM(ring[i].X), toM(ring[i].Y));
    p.closePath();
  }
  return p;
}

const geomPaths = new WeakMap<BuildingGeom, Path2D>();
/** A building's footprint as a path, built once per footprint. */
export function buildingPath(g: BuildingGeom): Path2D {
  let p = geomPaths.get(g);
  if (!p) {
    p = pathOfFloatRings([g.ring], true);
    geomPaths.set(g, p);
  }
  return p;
}

function pathOfFloatRings(rings: Float32Array[], closed: boolean): Path2D {
  const p = new Path2D();
  for (const r of rings) {
    if (r.length < 4) continue;
    p.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]);
    if (closed) p.closePath();
  }
  return p;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pieceGfx = new WeakMap<Piece, PieceGfx>();
  private readonly atomPaths = new Map<number, Path2D>();
  private readonly atomById = new Map<number, Atom>();
  private lots!: Path2D;
  private water!: Path2D;
  private readonly setGfx = new Map<number, SetGfx>(); // TYPE-004, per building set
  private readonly guessHatch = new Map<string, CanvasPattern | null>(); // TYPE-004, by colour
  private minorMajor!: Path2D;
  private minorPaths!: Path2D;
  private overlay!: [string, Path2D][];
  private originals!: Path2D;
  private hatch: CanvasPattern | null = null;
  private readonly stripes = new Map<string, CanvasPattern | null>(); // REN-012, by rival colour
  private readonly disagreeing = new Map<number, { pieces: Piece[]; items: Building[]; list: LookedBuilding[] }>(); // REN-011
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement, private world: World) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.setWorld(world);
  }

  setWorld(world: World) {
    this.world = world;
    this.atomPaths.clear();
    this.atomById.clear();
    for (const a of world.atoms) this.atomById.set(a.id, a);
    const lots = new Path2D();
    for (const a of world.atoms) {
      const p = pathOf(a.shape);
      this.atomPaths.set(a.id, p);
      lots.addPath(p);
    }
    this.lots = lots;
    this.water = pathOf(world.water);
    this.setGfx.clear();
    this.disagreeing.clear();
    this.minorMajor = pathOfFloatRings(world.features.minorLines.filter((l) => l.major).map((l) => l.pts), false);
    this.minorPaths = pathOfFloatRings(world.features.minorLines.filter((l) => !l.major && !l.fence).map((l) => l.pts), false);
    const byCtx = new Map<string, Path2D>();
    for (const o of world.overlay) {
      if (o.klass.cls !== "overlay") continue;
      const c = CTX_COLORS[o.klass.ctx];
      if (!byCtx.has(c)) byCtx.set(c, new Path2D());
      byCtx.get(c)!.addPath(pathOf(o.shape));
    }
    this.overlay = [...byCtx];
    this.originals = new Path2D();
    for (const o of world.originals) this.originals.addPath(pathOf(o.shape));
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  gfx(p: Piece): PieceGfx {
    const pieces = this.atomById.get(p.atom)?.pieces;
    const known = this.pieceGfx.get(p);
    const current = !!pieces?.includes(p);
    if (known && (known.of === pieces || !current)) return known;
    // REN-004: a face depends on the neighbours, so the atom's pieces are worked out together.
    const of = current ? pieces! : [p];
    const groups = new Map<Shape, GroupGfx>();
    for (const [q, f] of faces(of, TUNE.PIECE_GAP)) {
      let group: GroupGfx | null = null;
      if (f.group) {
        group = groups.get(f.group) ?? null;
        if (!group) {
          const path = pathOf(f.group);
          const outside = new Path2D();
          outside.rect(-1e6, -1e6, 2e6, 2e6);
          outside.addPath(path);
          groups.set(f.group, (group = { path, outside }));
        }
      }
      const b = q.bbox;
      this.pieceGfx.set(q, { of, path: pathOf(f.top), cx: toM((b.minX + b.maxX) / 2), cy: toM((b.minY + b.maxY) / 2), group });
    }
    return this.pieceGfx.get(p)!;
  }

  private hatchPattern(): CanvasPattern | null {
    if (this.hatch) return this.hatch;
    const c = document.createElement("canvas");
    c.width = c.height = 10;
    const g = c.getContext("2d")!;
    g.fillStyle = KINDS.RU.color;
    g.fillRect(0, 0, 10, 10);
    g.strokeStyle = darken(KINDS.RU.color, 0.95);
    g.lineWidth = 1.6;
    g.beginPath();
    for (const o of [-10, 0, 10]) {
      g.moveTo(o, 10);
      g.lineTo(o + 10, 0);
    }
    g.stroke();
    this.hatch = this.ctx.createPattern(c, "repeat");
    return this.hatch;
  }

  /** REN-012: the rival's colour on half of each stripe, the piece's own colour showing through between. */
  private stripePattern(color: string): CanvasPattern | null {
    if (this.stripes.has(color)) return this.stripes.get(color)!;
    const n = TUNE.DISPUTE_STRIPE;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const g = c.getContext("2d")!;
    g.strokeStyle = color;
    g.lineWidth = n / (2 * Math.SQRT2);
    g.beginPath();
    for (const o of [-n, 0, n]) {
      g.moveTo(o, 0);
      g.lineTo(o + n, n);
    }
    g.stroke();
    const pat = this.ctx.createPattern(c, "repeat");
    this.stripes.set(color, pat);
    return pat;
  }

  private fillStripes(p: Piece, path: Path2D, px: number) {
    const pat = this.stripePattern(rivalColor(p.rival!));
    if (!pat) return;
    pat.setTransform(new DOMMatrix().scale(px, px)); // stripes keep their size on screen
    this.ctx.fillStyle = pat;
    this.ctx.fill(path, "evenodd");
  }

  /** TYPE-001 / TYPE-004: the paths of a building set, by state, rebuilt when the set changes. */
  private gfxOf(set: BuildingSet): SetGfx {
    let g = this.setGfx.get(set.atom);
    if (g && g.items === set.items) return g;
    const faint = new Path2D();
    const typed = new Map<string, Path2D>();
    const guessed = new Map<string, Path2D>();
    const marks: [number, number][] = [];
    const looked: LookedBuilding[] = [];
    const add = (m: Map<string, Path2D>, c: string, p: Path2D) => {
      if (!m.has(c)) m.set(c, new Path2D());
      m.get(c)!.addPath(p);
    };
    for (const b of set.items) {
      const path = buildingPath(b.geom);
      const guess = this.world.guessOf(b);
      if (guess) {
        // TYPE-004: a guess is hatched in its look's colour; an unsure building is faint with a mark.
        if (guess.look) add(guessed, buildingColor(guess.look), path);
        else {
          faint.addPath(path);
          marks.push([toM(b.geom.cx), toM(b.geom.cy)]);
        }
        continue;
      }
      if (!b.look || b.look === "RU" || statusOf(b) === "protected" && !b.look) {
        faint.addPath(path); // REN-010
        continue;
      }
      add(typed, buildingColor(b.look), path); // REN-009
      const geo = b.geom;
      const r = Math.max(0.5, toM(geo.maxX - geo.minX) / 2, toM(geo.maxY - geo.minY) / 2);
      looked.push({ path, look: b.look, color: darken(lookColor(b.look), 0.6), x: geo.cx, y: geo.cy, r });
    }
    g = { items: set.items, faint, typed: [...typed], guessed: [...guessed], marks, looked };
    this.setGfx.set(set.atom, g);
    return g;
  }

  /** TYPE-004: the hatch over a guessed building, a darker shade of its colour on a transparent ground. */
  private guessHatchPattern(color: string): CanvasPattern | null {
    if (this.guessHatch.has(color)) return this.guessHatch.get(color)!;
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d")!;
    g.strokeStyle = darken(color, 0.7);
    g.lineWidth = 1.4;
    g.beginPath();
    for (const o of [-8, 0, 8]) {
      g.moveTo(o, 8);
      g.lineTo(o + 8, 0);
    }
    g.stroke();
    const pat = this.ctx.createPattern(c, "repeat");
    this.guessHatch.set(color, pat);
    return pat;
  }

  /** BLD-007 / REN-011: the typed buildings in an atom that disagree with the land under them. TYPE-014: guesses never do. */
  private disagreeingIn(atom: Atom, set: BuildingSet | undefined): LookedBuilding[] {
    if (!set) return [];
    let d = this.disagreeing.get(atom.id);
    if (!d || d.pieces !== atom.pieces || d.items !== set.items) {
      const list = this.gfxOf(set).looked.filter((b) => {
        const under = atom.pieces.find(
          (p) => b.x >= p.bbox.minX && b.x <= p.bbox.maxX && b.y >= p.bbox.minY && b.y <= p.bbox.maxY && contains(p.shape, b.x, b.y),
        );
        return disagreesWithLand(b.look, under?.kind ?? null);
      });
      d = { pieces: atom.pieces, items: set.items, list };
      this.disagreeing.set(atom.id, d);
    }
    return d.list;
  }

  /** REN-002 lift for a kind at the current zoom. */
  liftPx(kind: Kind | null, scale: number) {
    if (!kind || kind === "CTX") return 0;
    const [lo, hi] = TUNE.LIFT_ZOOM_CLAMP;
    return KINDS[kind].lift * Math.max(lo, Math.min(hi, scale));
  }

  /** Draws a frame. Returns true when ambient marks (REN-011, REN-013) are on screen and moving (REN-014). */
  draw(st: RenderState, now: number): boolean {
    const { ctx, dpr } = this;
    const cam = st.camera;
    const s = cam.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.street;
    ctx.fillRect(0, 0, cam.width, cam.height);
    const toWorld = () =>
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cam.width / 2 - cam.cx * s), dpr * (cam.height / 2 - cam.cy * s));
    toWorld();
    const px = 1 / s; // one screen pixel in metres

    // REN-001: void land, water.
    ctx.fillStyle = COLORS.lot;
    ctx.fill(this.lots, "evenodd");
    ctx.strokeStyle = COLORS.lotEdge;
    ctx.lineWidth = px;
    ctx.stroke(this.lots);
    ctx.fillStyle = COLORS.water;
    ctx.fill(this.water, "evenodd");

    const v = cam.view();
    const margin = 20 * px;
    const atoms = this.world.atomsIn({
      minX: toI(v.minX - margin), minY: toI(v.minY - margin), maxX: toI(v.maxX + margin), maxY: toI(v.maxY + 30 * px),
    });

    const ctxPieces: Piece[] = [];
    const slabs: Piece[] = [];
    const disputed: Piece[] = [];
    for (const a of atoms)
      for (const p of a.pieces) {
        if (p.kind === "CTX") ctxPieces.push(p);
        else if (p.kind !== null) slabs.push(p);
        if (p.rival) disputed.push(p);
      }

    // Exclusive context: flat. REN-004: a surface of several pieces is filled once.
    const filled = new Set<GroupGfx>();
    for (const p of ctxPieces) {
      const g = this.gfx(p);
      if (g.group && filled.has(g.group)) continue;
      if (g.group) filled.add(g.group);
      const path = g.group?.path ?? g.path;
      ctx.fillStyle = CTX_COLORS[p.ctx ?? "green"];
      ctx.fill(path, "evenodd");
      if (p.rival) this.fillStripes(p, path, px); // REN-012
    }

    // Overlay context (IMP-003) sits under the landuse it belongs to.
    ctx.globalAlpha = 0.75;
    for (const [color, path] of this.overlay) {
      ctx.fillStyle = color;
      ctx.fill(path, "evenodd");
    }
    ctx.globalAlpha = 1;

    // REN-003: north to south, so southern slabs cover the sides of northern ones.
    slabs.sort((a, b) => a.bbox.maxY - b.bbox.maxY);
    // REN-004: a surface of several pieces gets its top with its southernmost piece, over all their sides.
    const lastOf = new Map<GroupGfx, Piece>();
    for (const p of slabs) {
      const g = this.gfx(p).group;
      if (g) lastOf.set(g, p);
    }
    for (const p of slabs) {
      const g = this.gfx(p);
      const top = !g.group ? g.path : lastOf.get(g.group) === p ? g.group.path : null;
      this.drawSlab(p, top, s, now, st.anims, p === st.hover);
    }

    const moving = !st.anims.reduced;
    let ambient = false;
    const marks: [number, number][] = [];
    if (st.showBuildings) {
      // The sets of the atoms in view, and the buildings standing outside every atom.
      const sets = new Map<number, BuildingSet>();
      for (const s of this.world.buildingSets()) sets.set(s.atom, s);
      const shown = [sets.get(-1), ...atoms.map((a) => sets.get(a.id))].filter((s): s is BuildingSet => !!s);
      const gfx = shown.map((s) => this.gfxOf(s));
      // REN-010
      ctx.fillStyle = COLORS.building;
      for (const g of gfx) ctx.fill(g.faint, "nonzero");
      // REN-009
      ctx.globalAlpha = TUNE.BUILDING_ALPHA;
      for (const g of gfx)
        for (const [color, path] of g.typed) {
          ctx.fillStyle = color;
          ctx.fill(path, "nonzero");
        }
      // TYPE-004: guesses, fainter and hatched.
      for (const g of gfx)
        for (const [color, path] of g.guessed) {
          ctx.globalAlpha = TUNE.GUESS_ALPHA;
          ctx.fillStyle = color;
          ctx.fill(path, "nonzero");
          const pat = this.guessHatchPattern(color);
          if (pat) {
            pat.setTransform(new DOMMatrix().scale(px, px));
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = pat;
            ctx.fill(path, "nonzero");
          }
        }
      ctx.globalAlpha = 1;
      for (const g of gfx) marks.push(...g.marks);
      // REN-011: a steady edge, and an outline of the footprint growing out of it like a ping. With reduced
      // motion only the edge is left (FEEL-008).
      const odd = atoms.flatMap((a) => this.disagreeingIn(a, sets.get(a.id)));
      ctx.lineJoin = "round";
      for (const b of odd) {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = (moving ? 1.5 : 2.5) * px;
        ctx.stroke(b.path);
        if (!moving) continue;
        ambient = true;
        const t = rippleT(now, b.x, b.y);
        const k = 1 + (TUNE.RIPPLE_REACH * t * px) / b.r;
        const [cx, cy] = [toM(b.x), toM(b.y)];
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(k, k);
        ctx.translate(-cx, -cy);
        // A light under-stroke keeps the ring readable on any land colour.
        ctx.globalAlpha = Math.pow(1 - t, 1.3);
        ctx.strokeStyle = "rgba(255, 252, 246, 0.8)";
        ctx.lineWidth = (5 * px) / k;
        ctx.stroke(b.path);
        ctx.strokeStyle = b.color;
        ctx.lineWidth = (2.5 * px) / k;
        ctx.stroke(b.path);
        ctx.restore();
      }
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = COLORS.minor;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = Math.max(1.5 * px, 2.5);
    ctx.stroke(this.minorMajor);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1 * px, 1);
    ctx.stroke(this.minorPaths);
    ctx.globalAlpha = 1;

    // REN-013: red spikes creeping round each disputed piece; they stand still with reduced motion.
    if (disputed.length) {
      if (moving) ambient = true;
      const spacing = TUNE.SPIKE_SPACING * px;
      const phase = moving ? spikePhase(now, s) : 0;
      const spikes = new Path2D();
      const edges = new Path2D();
      for (const p of disputed) {
        edges.addPath(pathOf(p.shape));
        for (const [ax, ay, bx, by, tx, ty] of spikesAlong(p.shape, spacing, TUNE.SPIKE_SIZE * px, phase)) {
          spikes.moveTo(ax, ay);
          spikes.lineTo(tx, ty);
          spikes.lineTo(bx, by);
          spikes.closePath();
        }
      }
      ctx.strokeStyle = COLORS.dispute;
      ctx.lineWidth = 1.5 * px;
      ctx.lineJoin = "round";
      ctx.stroke(edges);
      ctx.fillStyle = COLORS.dispute;
      ctx.fill(spikes, "nonzero");
    }

    // IMP-009
    if (st.showOriginals) {
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeStyle = "rgba(40, 30, 80, 0.8)";
      ctx.lineWidth = 1.5 * px;
      ctx.stroke(this.originals);
      ctx.setLineDash([]);
    }

    // PEEK-001: imagery over the map, with every building outline on top of it.
    if (st.imagery) {
      this.drawImagery(st.imagery, cam, px);
      if (st.showBuildings) {
        ctx.lineJoin = "round";
        ctx.lineWidth = 1.4 * px;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
        const sets = new Map<number, BuildingSet>();
        for (const s of this.world.buildingSets()) sets.set(s.atom, s);
        for (const s of [sets.get(-1), ...atoms.map((a) => sets.get(a.id))]) {
          if (!s) continue;
          const g = this.gfxOf(s);
          ctx.stroke(g.faint);
          for (const [, path] of g.typed) ctx.stroke(path);
          for (const [, path] of g.guessed) ctx.stroke(path);
        }
      }
    }

    // PEEK-003: the camera that took the shown photo, and the way it looks.
    if (st.photo) {
      const { x, y, azimuth } = st.photo;
      ctx.save();
      ctx.translate(x, y);
      if (azimuth !== null) {
        ctx.rotate((azimuth * Math.PI) / 180);
        const reach = 28 * px;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, reach, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45);
        ctx.closePath();
        ctx.fillStyle = "rgba(43, 125, 233, 0.28)";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 5 * px, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.camera;
      ctx.fill();
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
    }

    const painting = st.tool.type !== "density" && !onBuildings(st.tool, st.target); // TYPE-006: no lattice hints on buildings
    // REN-006: lattice hints around the cursor.
    if (st.cursor && painting && !st.panning) {
      const [wx, wy] = cam.toWorld(st.cursor[0], st.cursor[1]);
      const R = TUNE.HINT_RADIUS * st.brushPx * px;
      ctx.lineWidth = 1.25 * px;
      for (const a of this.world.atomsIn({ minX: toI(wx - R), minY: toI(wy - R), maxX: toI(wx + R), maxY: toI(wy + R) })) {
        const dx = Math.max(toM(a.bbox.minX) - wx, 0, wx - toM(a.bbox.maxX));
        const dy = Math.max(toM(a.bbox.minY) - wy, 0, wy - toM(a.bbox.maxY));
        const d = Math.hypot(dx, dy);
        const k = Math.max(0, 1 - d / R);
        if (k <= 0) continue;
        ctx.globalAlpha = 0.45 * k;
        ctx.strokeStyle = COLORS.hint;
        ctx.stroke(this.atomPaths.get(a.id)!);
      }
      ctx.globalAlpha = 1;
    }

    if (st.stroke) this.drawStroke(st.stroke, st.tool, s, now);

    // Flashes.
    for (const f of st.anims.flashes) {
      const t = (now - f.t0) / f.dur;
      if (t < 0 || t > 1) continue;
      ctx.save();
      if (f.mode === "light") {
        ctx.globalAlpha = 0.55 * Math.pow(1 - t, 2);
        ctx.fillStyle = "#fffdf6";
        ctx.fill(f.path, "evenodd");
      } else {
        const k = 1 - 0.06 * t;
        ctx.translate(f.cx, f.cy);
        ctx.scale(k, k);
        ctx.translate(-f.cx, -f.cy);
        ctx.globalAlpha = 0.85 * (1 - t);
        ctx.fillStyle = f.color;
        ctx.fill(f.path, "evenodd");
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // CORR-004: the building a tap would change. A light under-stroke keeps the edge readable on any colour.
    const hb = st.hover && "geom" in st.hover ? st.hover : null;
    if (hb) {
      const path = buildingPath(hb.geom);
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.fill(path, "nonzero");
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(255, 252, 246, 0.9)";
      ctx.lineWidth = 3.5 * px;
      ctx.stroke(path);
      ctx.strokeStyle = "rgba(40, 32, 24, 0.75)";
      ctx.lineWidth = 1.5 * px;
      ctx.stroke(path);
    }

    // TYPE-004: the unsure marks, at a constant screen size.
    if (marks.length) {
      const r = TUNE.UNSURE_MARK * px;
      const [hx, hy] = hb ? [toM(hb.geom.cx), toM(hb.geom.cy)] : [NaN, NaN];
      ctx.font = `800 ${11 * px}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1.6 * px;
      for (const [x, y] of marks) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = x === hx && y === hy ? COLORS.unsureHover : COLORS.unsure;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.fillText("?", x, y + 0.5 * px);
      }
    }

    // HUD-004: brush cursor, in screen space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (st.cursor && !st.panning) this.drawCursor(st, now);
    return ambient;
  }

  /** PEEK-001: the tiles under the view, each placed by its lon/lat corners through the area's projection. */
  private drawImagery(tiles: TileCache, cam: Camera, px: number) {
    const { ctx } = this;
    const proj = this.world.features.proj;
    const z = tileZoom(cam.scale, proj.lat0, this.dpr);
    const v = cam.view();
    const [x0, y0] = tileAt(proj.lon(v.minX), proj.lat(v.minY), z);
    const [x1, y1] = tileAt(proj.lon(v.maxX), proj.lat(v.maxY), z);
    ctx.save();
    ctx.globalAlpha = TUNE.PEEK_ALPHA;
    ctx.imageSmoothingEnabled = true;
    for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++)
      for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
        const img = tiles.get(z, tx, ty);
        if (!img) continue;
        const b = tileBounds(tx, ty, z);
        const left = proj.x(b.minLon), top = proj.y(b.maxLat);
        // A hair of overlap hides the seams between tiles.
        ctx.drawImage(img, left, top, proj.x(b.maxLon) - left + px, proj.y(b.minLat) - top + px);
      }
    ctx.restore();
  }

  /** Draws a piece's side face, then `top` as its top face (none while it is not its surface's turn, REN-004). */
  private drawSlab(p: Piece, top: Path2D | null, s: number, now: number, anims: Anims, hovered: boolean) {
    const { ctx } = this;
    const g = this.gfx(p);
    const kd = KINDS[p.kind!];
    const target = this.liftPx(p.kind, s);
    const { lift, alpha, scale } = anims.liftOf(p, target, now);
    if (alpha <= 0) return;
    const px = 1 / s;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (scale !== 1) {
      ctx.translate(g.cx, g.cy);
      ctx.scale(scale, scale);
      ctx.translate(-g.cx, -g.cy);
    }
    // REN-002: the top face stays at its true position; the side face hangs below it by the lift.
    if (lift > 0.3) {
      ctx.save();
      if (g.group) ctx.clip(g.group.outside, "evenodd"); // REN-004: no side shows on its own surface
      ctx.fillStyle = darken(kd.color);
      const steps = Math.min(6, Math.ceil(lift));
      for (let i = steps; i >= 1; i--) {
        ctx.save();
        ctx.translate(0, ((lift * i) / steps) * px);
        ctx.fill(g.path, "evenodd");
        ctx.restore();
      }
      ctx.restore();
    }
    if (top && p.kind === "RU") {
      // KIND-004: a translucent, hatched placeholder.
      ctx.globalAlpha = alpha * 0.72;
      ctx.fillStyle = this.hatchPattern() ?? kd.color;
      this.hatch?.setTransform(new DOMMatrix().scale(px, px));
    } else ctx.fillStyle = kd.color;
    if (top) ctx.fill(top, "evenodd");
    ctx.globalAlpha = alpha;
    if (top && p.rival) this.fillStripes(p, top, px); // REN-012
    // REN-007
    if (hovered) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
      ctx.fill(g.path, "evenodd");
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 1.5 * px;
      ctx.stroke(g.path);
    }
    ctx.restore();
  }

  private drawStroke(stroke: Stroke, tool: Tool, s: number, now: number) {
    const { ctx } = this;
    const px = 1 / s;
    const color = toolColor(tool);
    // SNAP-005: charging unit pieces — light and dashed, never mistakable for a claimed slab.
    for (const [p, cov] of stroke.coverage) {
      if (cov.count === 0) continue;
      const k = Math.min(1, cov.count / cov.covered.length / TUNE.CLAIM_COVERAGE);
      const path = this.gfx(p).path;
      ctx.globalAlpha = 0.06 + 0.2 * k;
      ctx.fillStyle = tool.type === "erase" ? COLORS.eraser : color;
      ctx.fill(path, "evenodd");
      ctx.globalAlpha = 0.45 + 0.55 * k;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.lineDashOffset = -(now / 30) * px;
      ctx.strokeStyle = tool.type === "erase" ? "#8d8273" : darken(color, 0.7);
      ctx.lineWidth = (1.2 + 1.8 * k) * px;
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    // PAINT-003: soft trail.
    if (stroke.trail.length) {
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke.radius * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(stroke.trail[0][0], stroke.trail[0][1]);
      for (const [x, y] of stroke.trail) ctx.lineTo(x, y);
      if (stroke.trail.length === 1) ctx.lineTo(stroke.trail[0][0] + 0.01, stroke.trail[0][1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // SNAP-105: snapped freeform preview with marching outline.
    for (const ff of stroke.preview.values()) {
      const path = pathOf(ff.region);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = tool.type === "erase" ? COLORS.eraser : color;
      ctx.fill(path, "evenodd");
      ctx.globalAlpha = 1;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.lineDashOffset = -(now / 40) * px;
      ctx.strokeStyle = tool.type === "erase" ? "#8d8273" : darken(color, 0.6);
      ctx.lineWidth = 1.6 * px;
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  }

  private drawCursor(st: RenderState, now: number) {
    const { ctx } = this;
    const [sx0, sy] = st.cursor!;
    const sx = sx0 + st.anims.shakeOffset(now);
    const color = toolColor(st.tool);
    const tint = st.anims.rejectTint(now);
    ctx.beginPath();
    if (st.tool.type === "density") {
      // Density tools act on what is under the pointer, so the cursor is a small reticle with an arrow.
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = tint > 0 ? `rgba(214, 60, 60, ${0.5 + tint / 2})` : color;
      ctx.stroke();
      ctx.beginPath();
      const d = st.tool.dir;
      ctx.moveTo(sx - 4, sy + 2 * d);
      ctx.lineTo(sx, sy - 3 * d);
      ctx.lineTo(sx + 4, sy + 2 * d);
      ctx.stroke();
      return;
    }
    const r = st.brushPx;
    const buildings = onBuildings(st.tool, st.target);
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
    // TYPE-006: on buildings the ring is dashed, so the target shows in the brush itself.
    if (buildings) ctx.setLineDash([Math.max(4, r / 4), Math.max(3, r / 6)]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = tint > 0 ? `rgba(214, 60, 60, ${0.5 + tint / 2})` : st.tool.type === "erase" ? "#7d7366" : darken(color, 0.85);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }
}
