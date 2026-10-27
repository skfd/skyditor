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
  it("CAM-006: pinching keeps the map point under the fingers where it is", () => {
    const c = camera();
    const before = c.toWorld(600, 150);
    c.zoomNow(2.5, 600, 150);
    expect(c.scale).toBeCloseTo(2.5);
    const [sx, sy] = c.toScreen(before[0], before[1]);
    expect(sx).toBeCloseTo(600);
    expect(sy).toBeCloseTo(150);
    expect(c.update(16, 0)).toBe(false); // no smoothing left to run
  });

  it("CAM-006 / CAM-005: pinching stays within the zoom limits", () => {
    const c = camera();
    c.zoomNow(1e6, 400, 300);
    expect(c.scale).toBe(TUNE.ZOOM_MAX);
    c.zoomNow(1e-6, 400, 300);
    expect(c.scale).toBe(TUNE.ZOOM_MIN);
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
