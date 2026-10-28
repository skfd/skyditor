// Replays one answer-key square: paints rough strokes inside every truth polygon, then scores the result.
import { type Shape, area, toM } from "../../src/geo/clip";
import { KINDS, type PaintKind } from "../../src/model/kinds";
import type { World } from "../../src/model/world";
import { Stroke } from "../../src/paint/stroke";
import { TUNE } from "../../src/tuning";
import { type Score, score, yardsticks } from "./score";
import { type SquareMeta, loadSquare, truthParts } from "./square";
import { DEFAULT_STROKES, type Pt, type StrokeOptions, hash, mulberry32, planPart } from "./strokes";

export interface Replay {
  name: string;
  city?: string;
  country?: string;
  style?: string;
  ms: number;
  truths: number;
  strokes: number;
  unreached_m2: number; // truth no brush fits into
  whole_m2: number; // claimed as whole pieces (SNAP-003/004 in the editor's terms)
  freeform_m2: number; // applied as freeform results
  score: Score;
}

export function replay(text: string, meta: SquareMeta, opts: StrokeOptions = DEFAULT_STROKES, svg = false) {
  const t0 = performance.now();
  const sq = loadSquare(text, meta);
  const ys = yardsticks(sq);
  const trails: { kind: string; radius: number; pts: Pt[] }[] = [];
  let unreached = 0, whole = 0, freeform = 0;
  sq.truth.forEach((t, i) => {
    const rand = mulberry32(hash(`${meta.name}/${i}`));
    for (const part of truthParts(t)) {
      const plan = planPart(part, opts, rand);
      if (!plan) {
        unreached += area(part);
        continue;
      }
      for (const pts of plan.trails) {
        trails.push({ kind: t.kind, radius: plan.radius, pts });
        for (const e of paint(sq.world, t.kind, plan.radius, pts))
          if (e.type === "claim") (e.whole ? (whole += area(e.region)) : (freeform += area(e.region)));
      }
    }
  });
  const result: Replay = {
    name: meta.name, city: meta.city, country: meta.country, style: meta.style,
    ms: 0, truths: sq.truth.length, strokes: trails.length,
    unreached_m2: unreached, whole_m2: whole, freeform_m2: freeform,
    score: score(sq, ys),
  };
  result.ms = Math.round(performance.now() - t0);
  return { result, svg: svg ? drawSvg(sq, trails) : undefined };
}

function paint(world: World, kind: PaintKind, r: number, pts: Pt[]) {
  const s = new Stroke(world, { type: "paint", kind }, r, pts[0][0], pts[0][1]);
  const events = [...s.start()];
  for (const p of densify(pts, r * TUNE.TRAIL_STEP * 0.5).slice(1)) events.push(...s.move(p[0], p[1]));
  events.push(...s.end(false).events);
  return events;
}

function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

const path = (s: Shape) =>
  s.map((r) => "M" + r.map((p) => `${toM(p.X).toFixed(1)} ${toM(p.Y).toFixed(1)}`).join("L") + "Z").join("");

/** Streets, context, the painted result, the truth outlines and the trails, in one picture. */
function drawSvg(sq: ReturnType<typeof loadSquare>, trails: { kind: string; pts: Pt[] }[]): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-350 -350 700 700" width="1400" height="1400">`,
    `<rect x="-350" y="-350" width="700" height="700" fill="#fff"/>`,
    `<path d="${path(sq.world.streets)}" fill="#ddd" fill-rule="evenodd"/>`,
    `<path d="${path(sq.world.water)}" fill="#bde" fill-rule="evenodd"/>`,
  ];
  for (const a of sq.world.atoms)
    for (const p of a.pieces) {
      if (!p.kind) continue;
      const fill = p.kind === "CTX" ? "#b8dca0" : KINDS[p.kind].color;
      out.push(`<path d="${path(p.shape)}" fill="${fill}" fill-opacity="0.75" fill-rule="evenodd"/>`);
    }
  for (const b of sq.features.buildings) {
    const pts: string[] = [];
    for (let i = 0; i < b.ring.length; i += 2) pts.push(`${b.ring[i].toFixed(1)} ${b.ring[i + 1].toFixed(1)}`);
    out.push(`<path d="M${pts.join("L")}Z" fill="#555" fill-opacity="0.5"/>`);
  }
  for (const t of trails)
    out.push(`<path d="M${t.pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}" fill="none" stroke="#c00" stroke-width="0.4" stroke-opacity="0.6"/>`);
  for (const t of sq.truth)
    out.push(`<path d="${path(t.shape)}" fill="none" stroke="#000" stroke-width="0.8" fill-rule="evenodd"/>`);
  out.push(`<rect x="-300" y="-300" width="600" height="600" fill="none" stroke="#08f" stroke-width="0.6" stroke-dasharray="4 4"/>`);
  out.push(`</svg>`);
  return out.join("\n");
}
