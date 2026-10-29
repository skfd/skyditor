// Smooth zoom towards the cursor and coasting pan (CAM-001..CAM-005).
import { TUNE } from "../tuning";

export interface ViewBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const decay = (dtMs: number, halfLifeMs: number) => Math.pow(0.5, dtMs / halfLifeMs);

export class Camera {
  // Current state: world point at screen centre, pixels per metre.
  cx = 0;
  cy = 0;
  scale = 1;
  // Targets the current state eases towards.
  private tScale = 1;
  private anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private vx = 0; // pan velocity, m/ms
  private vy = 0;
  private fly: { from: [number, number, number]; to: [number, number, number]; t0: number; dur: number } | null = null;
  width = 1;
  height = 1;
  bounds: ViewBox = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.width / 2, (y - this.cy) * this.scale + this.height / 2];
  }
  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.scale + this.cx, (sy - this.height / 2) / this.scale + this.cy];
  }
  view(): ViewBox {
    const [minX, minY] = this.toWorld(0, 0);
    const [maxX, maxY] = this.toWorld(this.width, this.height);
    return { minX, minY, maxX, maxY };
  }

  /** Whether the zoom is still easing towards its target, or flying (CAM-004). */
  get settling(): boolean {
    return this.fly !== null || this.scale !== this.tScale;
  }

  /** CAM-001: multiplies the zoom target, keeping the world point under (sx, sy) fixed. */
  zoomBy(factor: number, sx: number, sy: number) {
    this.fly = null;
    this.tScale = clamp(this.tScale * factor, TUNE.ZOOM_MIN, TUNE.ZOOM_MAX);
    const [wx, wy] = this.toWorld(sx, sy);
    this.anchor = { sx, sy, wx, wy };
  }

  /** CAM-002: direct drag; `release` hands over the last velocity for coasting. */
  panBy(dxPx: number, dyPx: number) {
    this.fly = null;
    this.cx -= dxPx / this.scale;
    this.cy -= dyPx / this.scale;
    if (this.anchor) {
      this.anchor.wx -= dxPx / this.scale;
      this.anchor.wy -= dyPx / this.scale;
    }
    this.clampCentre();
  }
  release(vxPxPerMs: number, vyPxPerMs: number) {
    this.vx = -vxPxPerMs / this.scale;
    this.vy = -vyPxPerMs / this.scale;
  }
  /** CAM-003: a nudge in screen pixels per millisecond. */
  nudge(vxPx: number, vyPx: number) {
    this.vx = vxPx / this.scale;
    this.vy = vyPx / this.scale;
  }

  /** CAM-004: fly to fit a box, with an ease-in-out. */
  fit(b: ViewBox, durMs: number, now: number) {
    const s = clamp(
      Math.min(this.width / (b.maxX - b.minX), this.height / (b.maxY - b.minY)) * 0.92,
      TUNE.ZOOM_MIN,
      TUNE.ZOOM_MAX,
    );
    const to: [number, number, number] = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, s];
    this.anchor = null;
    this.vx = this.vy = 0;
    this.tScale = s;
    if (durMs <= 0) {
      [this.cx, this.cy, this.scale] = to;
      return;
    }
    this.fly = { from: [this.cx, this.cy, this.scale], to, t0: now, dur: durMs };
  }

  /** Advances the motion. Returns true while still moving. */
  update(dt: number, now: number): boolean {
    if (this.fly) {
      const { from, to, t0, dur } = this.fly;
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      // Interpolate zoom geometrically so the motion feels even.
      this.scale = from[2] * Math.pow(to[2] / from[2], e);
      this.cx = from[0] + (to[0] - from[0]) * e;
      this.cy = from[1] + (to[1] - from[1]) * e;
      if (t >= 1) this.fly = null;
      return true;
    }
    let moving = false;
    if (Math.abs(this.scale - this.tScale) / this.tScale > 1e-4) {
      const k = decay(dt, TUNE.ZOOM_HALFLIFE);
      this.scale = this.tScale + (this.scale - this.tScale) * k;
      if (this.anchor) {
        this.cx = this.anchor.wx - (this.anchor.sx - this.width / 2) / this.scale;
        this.cy = this.anchor.wy - (this.anchor.sy - this.height / 2) / this.scale;
      }
      moving = true;
    } else {
      this.scale = this.tScale;
      this.anchor = null;
    }
    if (Math.abs(this.vx) + Math.abs(this.vy) > 1e-5 / this.scale) {
      this.cx += this.vx * dt;
      this.cy += this.vy * dt;
      const k = decay(dt, TUNE.PAN_HALFLIFE);
      this.vx *= k;
      this.vy *= k;
      moving = true;
    } else this.vx = this.vy = 0;
    this.clampCentre();
    return moving;
  }

  /** CAM-005 */
  private clampCentre() {
    this.cx = clamp(this.cx, this.bounds.minX, this.bounds.maxX);
    this.cy = clamp(this.cy, this.bounds.minY, this.bounds.maxY);
  }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
