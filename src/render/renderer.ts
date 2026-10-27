// Canvas renderer (REN-001..REN-008).
import { type Shape, offset, toI, toM } from "../geo/clip";
import { CTX_COLORS, type Kind, KINDS } from "../model/kinds";
import type { Piece, World } from "../model/world";
import type { Stroke } from "../paint/stroke";
import type { Tool } from "../paint/snap";
import { TUNE } from "../tuning";
import type { Anims } from "./anim";
import type { Camera } from "./camera";

export const COLORS = {
  street: "#e3dccf",
  lot: "#f7f3eb",
  lotEdge: "#ebe4d7",
  water: "#93c9e8",
  building: "rgba(74, 52, 40, 0.17)",
  minor: "rgba(255, 255, 255, 0.75)",
  hint: "rgba(80, 64, 48, 0.55)",
  eraser: "#f4f1ea",
};

export interface RenderState {
  camera: Camera;
  stroke: Stroke | null;
  tool: Tool;
  brushPx: number;
  cursor: [number, number] | null; // screen px
  hover: Piece | null;
  showBuildings: boolean;
  showOriginals: boolean;
  anims: Anims;
  panning: boolean;
}

interface PieceGfx {
  path: Path2D;
  cx: number;
  cy: number;
}

export function toolColor(t: Tool): string {
  if (t.type === "paint") return KINDS[t.kind].color;
  if (t.type === "erase") return "#9a8f80";
  return t.dir > 0 ? "#e2683c" : "#6f9bd1";
}

/** REN-002: slightly darker side face. */
export function darken(hex: string, f = 0.74): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
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
  private lots!: Path2D;
  private water!: Path2D;
  private buildings!: Path2D;
  private minorMajor!: Path2D;
  private minorPaths!: Path2D;
  private overlay!: [string, Path2D][];
  private originals!: Path2D;
  private hatch: CanvasPattern | null = null;
  private dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement, private world: World) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.setWorld(world);
  }

  setWorld(world: World) {
    this.world = world;
    this.atomPaths.clear();
    const lots = new Path2D();
    for (const a of world.atoms) {
      const p = pathOf(a.shape);
      this.atomPaths.set(a.id, p);
      lots.addPath(p);
    }
    this.lots = lots;
    this.water = pathOf(world.water);
    this.buildings = pathOfFloatRings(world.features.buildings, true);
    this.minorMajor = pathOfFloatRings(world.features.minorLines.filter((l) => l.major).map((l) => l.pts), false);
    this.minorPaths = pathOfFloatRings(world.features.minorLines.filter((l) => !l.major).map((l) => l.pts), false);
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
    let g = this.pieceGfx.get(p);
    if (!g) {
      // REN-004: a hairline gap between neighbouring pieces.
      const inset = p.kind === null ? p.shape : offset(p.shape, -TUNE.PIECE_GAP / 2);
      const b = p.bbox;
      g = { path: pathOf(inset.length ? inset : p.shape), cx: toM((b.minX + b.maxX) / 2), cy: toM((b.minY + b.maxY) / 2) };
      this.pieceGfx.set(p, g);
    }
    return g;
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

  /** REN-002 lift for a kind at the current zoom. */
  liftPx(kind: Kind | null, scale: number) {
    if (!kind || kind === "CTX") return 0;
    const [lo, hi] = TUNE.LIFT_ZOOM_CLAMP;
    return KINDS[kind].lift * Math.max(lo, Math.min(hi, scale));
  }

  draw(st: RenderState, now: number) {
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
    for (const a of atoms)
      for (const p of a.pieces) {
        if (p.kind === "CTX") ctxPieces.push(p);
        else if (p.kind !== null) slabs.push(p);
      }

    // Exclusive context: flat.
    for (const p of ctxPieces) {
      ctx.fillStyle = CTX_COLORS[p.ctx ?? "green"];
      ctx.fill(this.gfx(p).path, "evenodd");
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
    for (const p of slabs) this.drawSlab(p, s, now, st.anims, p === st.hover);

    // REN-005
    if (st.showBuildings) {
      ctx.fillStyle = COLORS.building;
      ctx.fill(this.buildings, "nonzero");
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

    // IMP-009
    if (st.showOriginals) {
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeStyle = "rgba(40, 30, 80, 0.8)";
      ctx.lineWidth = 1.5 * px;
      ctx.stroke(this.originals);
      ctx.setLineDash([]);
    }

    const painting = st.tool.type !== "density";
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

    // HUD-004: brush cursor, in screen space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (st.cursor && !st.panning) this.drawCursor(st, now);
  }

  private drawSlab(p: Piece, s: number, now: number, anims: Anims, hovered: boolean) {
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
      ctx.fillStyle = darken(kd.color);
      const steps = Math.min(6, Math.ceil(lift));
      for (let i = steps; i >= 1; i--) {
        ctx.save();
        ctx.translate(0, ((lift * i) / steps) * px);
        ctx.fill(g.path, "evenodd");
        ctx.restore();
      }
    }
    if (p.kind === "RU") {
      // KIND-004: a translucent, hatched placeholder.
      ctx.globalAlpha = alpha * 0.72;
      ctx.fillStyle = this.hatchPattern() ?? kd.color;
      this.hatch?.setTransform(new DOMMatrix().scale(px, px));
    } else ctx.fillStyle = kd.color;
    ctx.fill(g.path, "evenodd");
    ctx.globalAlpha = alpha;
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
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = tint > 0 ? `rgba(214, 60, 60, ${0.5 + tint / 2})` : st.tool.type === "erase" ? "#7d7366" : darken(color, 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }
}
