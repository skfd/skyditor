// Geometry for the marks that point at errors in the map (REN-011, REN-013). Pure, so it can be tested.
import ClipperLib from "clipper-lib";
import { type Shape, toM } from "../geo/clip";
import { TUNE } from "../tuning";

/**
 * REN-013: spikes along every ring of `shape`, `spacing` metres apart starting `phase` metres in, each
 * `size` metres long and pointing away from the shape. Returns triangles as [baseX1, baseY1, baseX2,
 * baseY2, tipX, tipY] in metres.
 */
export function spikesAlong(shape: Shape, spacing: number, size: number, phase: number): number[][] {
  const out: number[][] = [];
  if (spacing <= 0) return out;
  // Clipper keeps the land on the same side of every ring, outer and hole alike; this sign says which.
  let signed = 0;
  for (const r of shape) signed += ClipperLib.Clipper.Area(r);
  const out1 = signed >= 0 ? 1 : -1;
  const half = size * 0.55;
  for (const ring of shape) {
    let next = ((phase % spacing) + spacing) % spacing;
    let walked = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const ax = toM(ring[i].X), ay = toM(ring[i].Y);
      const bx = toM(ring[(i + 1) % n].X), by = toM(ring[(i + 1) % n].Y);
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const tx = (bx - ax) / len, ty = (by - ay) / len;
      const nx = ty * out1, ny = -tx * out1;
      while (next <= walked + len) {
        const d = next - walked;
        const px = ax + tx * d, py = ay + ty * d;
        out.push([px - tx * half, py - ty * half, px + tx * half, py + ty * half, px + nx * size, py + ny * size]);
        next += spacing;
      }
      walked += len;
    }
  }
  return out;
}

/** REN-013: how far the spikes have crept, in metres at `scale` px/m. */
export const spikePhase = (now: number, scale: number) => ((now / 1000) * TUNE.SPIKE_SPEED) / scale;

/**
 * REN-011: where a ripple is in its cycle (0 = leaving the footprint, 1 = gone). The offset comes from the
 * building's position, so neighbours ripple out of step.
 */
export function rippleT(now: number, x: number, y: number): number {
  const h = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  const p = TUNE.RIPPLE_PERIOD;
  return (((now + h * p) % p) + p) % p / p;
}
