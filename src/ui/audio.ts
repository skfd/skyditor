// Small synthesized sounds (FEEL-001, FEEL-003..FEEL-005). No samples, nothing to download.

const BASE_HZ = 329.63; // E4: R1. The ladder climbs a major scale (KINDS[*].pitch).

export class Sound {
  enabled: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastPop = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** Must be called from a user gesture before the first sound. */
  unlock() {
    if (this.ctx || typeof AudioContext === "undefined") return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
  }

  private voice(type: OscillatorType, f0: number, f1: number, at: number, dur: number, gain: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(f1, at + dur * 0.6);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master!);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  /** FEEL-003: the pop, pitched by kind. */
  pop(semitones: number, delayMs = 0, strength = 1) {
    if (!this.enabled || !this.ctx) return;
    const at = this.ctx.currentTime + delayMs / 1000;
    if (at - this.lastPop < 0.025) return; // a burst of claims should not turn into noise
    this.lastPop = at;
    const f = BASE_HZ * Math.pow(2, semitones / 12);
    this.voice("triangle", f * 1.5, f, at, 0.16, 0.5 * strength);
    this.voice("sine", f / 2, f / 2, at, 0.12, 0.35 * strength);
  }

  /** FEEL-004 */
  reject() {
    if (!this.enabled || !this.ctx) return;
    const at = this.ctx.currentTime;
    this.voice("square", 150, 120, at, 0.09, 0.12);
    this.voice("square", 120, 95, at + 0.08, 0.12, 0.12);
  }

  /** FEEL-005 */
  bump() {
    if (!this.enabled || !this.ctx) return;
    this.voice("sine", 140, 70, this.ctx.currentTime, 0.14, 0.5);
  }

  /** FEEL-006 */
  rewind(up: boolean) {
    if (!this.enabled || !this.ctx) return;
    const at = this.ctx.currentTime;
    this.voice("triangle", up ? 520 : 700, up ? 700 : 520, at, 0.1, 0.25);
  }
}
