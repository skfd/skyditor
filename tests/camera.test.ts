import { describe, expect, it } from "vitest";
import { Camera } from "../src/render/camera";
import { TUNE } from "../src/tuning";

const camera = () => {
  const c = new Camera();
  c.width = 800;
  c.height = 600;
  c.bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  return c;
};

describe("camera", () => {
  it("CAM-009: zooming stays within its limits, and on the demo or a file the view centre stays within the area", () => {
    const c = camera();
    const settle = () => { for (let t = 0; t < 4000; t += 16) c.update(16, t); };
    c.zoomBy(1e6, 700, 100);
    settle();
    expect(c.scale).toBe(TUNE.ZOOM_MAX);
    c.zoomBy(1e-6, 700, 100);
    settle();
    expect(c.scale).toBe(TUNE.ZOOM_MIN);
    c.panBy(-1e7, 1e7);
    expect(c.cx).toBe(1000);
    expect(c.cy).toBe(-1000);
  });

  it("CAM-009: on a live map the view centre goes anywhere", () => {
    const c = camera();
    c.bounds = null;
    c.panBy(-1e6, 1e6);
    expect(c.cx).toBeGreaterThan(1000);
    expect(c.cy).toBeLessThan(-1000);
  });

  it("CAM-007: a zoom button step zooms towards the centre of the view", () => {
    const c = camera();
    c.zoomBy(TUNE.ZOOM_STEP, c.width / 2, c.height / 2);
    for (let t = 0; t < 2000; t += 16) c.update(16, t);
    expect(c.scale).toBeCloseTo(TUNE.ZOOM_STEP);
    expect(c.cx).toBeCloseTo(0);
    expect(c.cy).toBeCloseTo(0);
  });
});
