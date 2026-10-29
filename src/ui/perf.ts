// HUD-013: a readout of how smoothly the map redraws, for checking REN-008. Hidden unless the URL has `?perf`.
// The map draws on demand, so a frame rate only means something while it is redrawing: the readout counts
// redraws in the last second and says "idle" once none has happened for a while.

const WINDOW_MS = 1000;
const IDLE_MS = 500;
const REFRESH_MS = 250; // a DOM write four times a second, never per frame

interface Sample {
  t: number;
  draw: number; // ms inside Renderer.draw: command submission only, the GPU may finish later
  work: number; // ms inside the whole frame callback (preview catch-up, camera, draw)
  gap: number; // ms since the previous animation frame, unclamped
}

export class PerfMeter {
  private readonly el: HTMLElement | null = null;
  private samples: Sample[] = [];
  private shownAt = 0;

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

  /** One redraw. */
  record(t: number, draw: number, work: number, gap: number) {
    if (this.el) this.samples.push({ t, draw, work, gap });
  }

  /** Every animation frame. */
  tick(now: number) {
    if (!this.el || now - this.shownAt < REFRESH_MS) return;
    this.shownAt = now;
    const s = (this.samples = this.samples.filter((x) => now - x.t <= WINDOW_MS));
    if (!s.length || now - s[s.length - 1].t > IDLE_MS) {
      this.el.textContent = "idle";
      return;
    }
    const avg = (f: (x: Sample) => number) => s.reduce((a, x) => a + f(x), 0) / s.length;
    const max = (f: (x: Sample) => number) => Math.max(...s.map(f));
    const ms = (v: number) => v.toFixed(1);
    this.el.textContent =
      `${s.length} fps · draw ${ms(avg((x) => x.draw))} ms (worst ${ms(max((x) => x.draw))})` +
      ` · frame ${ms(avg((x) => x.work))} ms · stall ${Math.round(max((x) => x.gap))} ms`;
  }
}
