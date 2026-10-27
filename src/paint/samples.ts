// Evenly spread sample points per piece, used to measure stroke coverage (SNAP-002).
import { contains, offset, toM } from "../geo/clip";
import type { Piece } from "../model/world";
import { TUNE } from "../tuning";

const cache = new WeakMap<Piece, Float64Array>(); // x,y pairs in metres

export function samplesOf(p: Piece): Float64Array {
  let s = cache.get(p);
  if (!s) {
    s = generate(p);
    cache.set(p, s);
  }
  return s;
}

function generate(p: Piece): Float64Array {
  const b = p.bbox;
  let spacing = Math.max(0.5, Math.sqrt(p.area / TUNE.UNIT_SAMPLES)) * TUNE.GEOM_SCALE;
  let rand = mulberry32(p.id * 2654435761);
  for (let attempt = 0; attempt < 3; attempt++) {
    const pts: number[] = [];
    for (let y = b.minY + spacing / 2; y < b.maxY; y += spacing)
      for (let x = b.minX + spacing / 2; x < b.maxX; x += spacing) {
        // Jittered grid: even coverage without visible alignment artefacts.
        const jx = x + (rand() - 0.5) * spacing * 0.8;
        const jy = y + (rand() - 0.5) * spacing * 0.8;
        if (contains(p.shape, Math.round(jx), Math.round(jy))) pts.push(toM(jx), toM(jy));
      }
    if (pts.length >= 16 || attempt === 2) {
      if (pts.length === 0) return interiorPoint(p);
      return new Float64Array(pts);
    }
    spacing /= 2;
    rand = mulberry32(p.id * 2654435761 + attempt + 1);
  }
  return interiorPoint(p);
}

function interiorPoint(p: Piece): Float64Array {
  const inner = offset(p.shape, -0.05);
  const r = (inner[0] ?? p.shape[0])[0];
  return new Float64Array([toM(r.X), toM(r.Y)]);
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}
