// Small, purposeful animations (FEEL-001..FEEL-009). The model is already final; these only show it.
import type { Piece } from "../model/world";
import { TUNE } from "../tuning";

export const ease = {
  outBack: (t: number, s: number) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

interface LiftAnim {
  from: number; // px, starting lift
  t0: number;
  dur: number;
  overshoot: number;
  appear: boolean; // fade in from nothing (load reveal)
}
export interface Flash {
  path: Path2D;
  color: string;
  t0: number;
  dur: number;
  cx: number;
  cy: number;
  mode: "light" | "ghost"; // light: white flash; ghost: old colour shrinking away
}

export class Anims {
  readonly reduced: boolean;
  private readonly lifts = new WeakMap<Piece, LiftAnim>();
  private readonly hops = new WeakMap<Piece, number>();
  private liveUntil = 0;
  flashes: Flash[] = [];
  shakeT0 = -1e9;

  constructor(reducedMotion: boolean) {
    this.reduced = reducedMotion;
  }

  /** FEEL-008 */
  dur(ms: number) {
    return this.reduced ? ms * TUNE.REDUCED_MOTION : ms;
  }
  private overshoot(s: number) {
    return this.reduced ? 0 : s;
  }
  private keepAlive(until: number) {
    this.liveUntil = Math.max(this.liveUntil, until);
  }

  /** FEEL-001 / FEEL-006 / FEEL-007 */
  pop(p: Piece, now: number, opts: { from?: number; delay?: number; short?: boolean; appear?: boolean } = {}) {
    const dur = this.dur(opts.short ? TUNE.POP_DURATION * 0.55 : TUNE.POP_DURATION);
    const delay = this.reduced ? 0 : (opts.delay ?? 0);
    const a: LiftAnim = {
      from: opts.from ?? 0,
      t0: now + delay,
      dur,
      overshoot: opts.short ? 0 : this.overshoot(TUNE.POP_OVERSHOOT),
      appear: !!opts.appear,
    };
    this.lifts.set(p, a);
    this.keepAlive(a.t0 + dur);
  }

  flash(f: Omit<Flash, "t0" | "dur">, now: number, delay = 0, durMs: number = TUNE.POP_FLASH) {
    const dur = this.dur(durMs);
    const t0 = now + (this.reduced ? 0 : delay);
    this.flashes.push({ ...f, t0, dur });
    this.keepAlive(t0 + dur);
  }

  /** FEEL-005 */
  hop(p: Piece, now: number) {
    if (this.reduced) return;
    this.hops.set(p, now);
    this.keepAlive(now + 260);
  }

  /** FEEL-004 */
  shake(now: number) {
    this.shakeT0 = now;
    this.keepAlive(now + this.dur(260));
  }
  shakeOffset(now: number): number {
    if (this.reduced) return 0;
    const t = (now - this.shakeT0) / 260;
    if (t < 0 || t > 1) return 0;
    return Math.sin(t * Math.PI * 6) * 6 * (1 - t);
  }
  rejectTint(now: number): number {
    const t = (now - this.shakeT0) / this.dur(260);
    return t < 0 || t > 1 ? 0 : 1 - t;
  }

  /** Lift multiplier state for a piece: lift in px, alpha, scale. */
  liftOf(p: Piece, target: number, now: number): { lift: number; alpha: number; scale: number } {
    let lift = target, alpha = 1, scale = 1;
    const a = this.lifts.get(p);
    if (a) {
      const t = (now - a.t0) / a.dur;
      if (t < 0) {
        lift = a.from;
        if (a.appear) alpha = 0;
      } else if (t < 1) {
        const e = a.overshoot ? ease.outBack(t, a.overshoot) : ease.outCubic(t);
        lift = a.from + (target - a.from) * e;
        if (a.appear) alpha = Math.min(1, t * 3);
        scale = 0.965 + 0.035 * e;
      }
    }
    const h = this.hops.get(p);
    if (h !== undefined) {
      const t = (now - h) / 260;
      if (t >= 0 && t < 1) lift += Math.sin(t * Math.PI) * 5 * (1 - t * 0.5);
    }
    return { lift, alpha, scale };
  }

  active(now: number) {
    if (now > this.liveUntil) this.flashes = [];
    else this.flashes = this.flashes.filter((f) => now < f.t0 + f.dur);
    return now <= this.liveUntil;
  }
}
