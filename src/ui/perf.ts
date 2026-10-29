// HUD-013: a readout of how smoothly the map redraws, for checking REN-008. Hidden unless the URL has `?perf`.
// The map draws on demand, so a frame rate only means something while it is redrawing: the readout counts
// redraws in the last second, says "idle" once none has happened for a while, and says "ambient" while only
// the slow ripples and spikes are redrawing (REN-014), whose low rate is by design.
//
// Reading it: few fps with small frame ms means the browser's own pixel work (canvas size, dpr); frame ms
// near 16 means our drawing or the preview; large late ms means work that ran before the frame (input).

const WINDOW_MS = 1000;
const IDLE_MS = 500;
const REFRESH_MS = 250; // a DOM write four times a second, never per frame

export interface PerfSample {
  t: number;
  draw: number; // ms inside Renderer.draw: command submission only, the GPU may finish later
  preview: number; // ms catching up the freeform preview while painting (SNAP-105)
  work: number; // ms inside the whole frame callback (preview catch-up, camera, draw)
  late: number; // ms between the frame's start and our callback: input handlers and the like
  gap: number; // ms since the previous animation frame, unclamped
  ambient: boolean; // only REN-014's slow marks moved
}

export class PerfMeter {
  private readonly el: HTMLElement | null = null;
  private samples: PerfSample[] = [];
  private shownAt = 0;
  private canvas = "";

  constructor(on = new URLSearchParams(location.search).has("perf")) {
    if (!on) return;
    this.el = document.createElement("div");
    this.el.id = "perf";
    this.el.textContent = "idle";
    document.body.append(this.el);
  }

  get on() {
    return this.el !== null;
  }

  /** The canvas in CSS pixels, the pixel ratio it is drawn at, and the screen's own when that is capped. */
  size(w: number, h: number, dpr: number, screenDpr: number) {
    this.canvas = `${w}×${h} @${+dpr.toFixed(2)}${screenDpr !== dpr ? ` (screen ${+screenDpr.toFixed(2)})` : ""}`;
  }

  /** One redraw. */
  record(s: PerfSample) {
    if (this.el) this.samples.push(s);
  }

  /** Every animation frame. */
  tick(now: number) {
    if (!this.el || now - this.shownAt < REFRESH_MS) return;
    this.shownAt = now;
    const s = (this.samples = this.samples.filter((x) => now - x.t < WINDOW_MS));
    if (!s.length || now - s[s.length - 1].t > IDLE_MS) {
      this.el.textContent = `idle · ${this.canvas}`;
      return;
    }
    const avg = (f: (x: PerfSample) => number) => s.reduce((a, x) => a + f(x), 0) / s.length;
    const max = (f: (x: PerfSample) => number) => Math.max(...s.map(f));
    const ms = (v: number) => v.toFixed(1);
    const rate = s.every((x) => x.ambient) ? `ambient ${s.length}/s` : `${s.length} fps`;
    this.el.textContent =
      `${rate} · draw ${ms(avg((x) => x.draw))} ms (worst ${ms(max((x) => x.draw))})` +
      (s.some((x) => x.preview > 0) ? ` · preview ${ms(avg((x) => x.preview))} ms` : "") +
      ` · frame ${ms(avg((x) => x.work))} ms · late ${ms(avg((x) => x.late))} ms` +
      ` · stall ${Math.round(max((x) => x.gap))} ms · ${this.canvas}`;
  }
}
