// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { PerfMeter, type PerfSample } from "../src/ui/perf";

const sample = (t: number, over: Partial<PerfSample> = {}): PerfSample => ({
  t, draw: 1, preview: 0, work: 2, late: 0.5, gap: 16.7, ambient: false, ...over,
});

describe("HUD-013: the ?perf readout", () => {
  afterEach(() => document.getElementById("perf")?.remove());

  it("HUD-013: shows nothing unless asked for", () => {
    const m = new PerfMeter(false);
    m.record(sample(0));
    m.tick(300);
    expect(m.on).toBe(false);
    expect(document.getElementById("perf")).toBeNull();
  });

  it("HUD-013: counts redraws in the last second and names the canvas", () => {
    const m = new PerfMeter(true);
    m.size(1280, 800, 2, 2.5);
    for (let t = 0; t < 1000; t += 1000 / 60) m.record(sample(t));
    m.tick(1000);
    const text = document.getElementById("perf")!.textContent!;
    expect(text).toMatch(/^60 fps · draw 1\.0 ms/);
    expect(text).toContain("1280×800 @2 (screen 2.5)");
    expect(text).not.toContain("preview");
  });

  it("HUD-013: calls slow ripple-only redraws ambient, not a low frame rate", () => {
    const m = new PerfMeter(true);
    for (let t = 50; t <= 1000; t += 50) m.record(sample(t, { ambient: true }));
    m.tick(1000);
    expect(document.getElementById("perf")!.textContent).toMatch(/^ambient 20\/s/);
  });

  it("HUD-013: says idle once nothing has been redrawn for a while", () => {
    const m = new PerfMeter(true);
    m.record(sample(0));
    m.tick(900);
    expect(document.getElementById("perf")!.textContent).toMatch(/^idle/);
  });
});
