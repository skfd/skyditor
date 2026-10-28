// Guessing what an untyped building is, from the building and its neighbours alone (TYPE-002, TYPE-003).
// Thresholds are TUNE-GUESS-*. The land under the building is never a signal (BLD-005).
import type { BuildingLook, PaintKind } from "./kinds";
import { addrCount, levelsOf } from "./kinds";
import { type Building, paintable, statusOf } from "./buildings";
import { TUNE } from "../tuning";

export interface Guess {
  /** The one look the signals agree on, or null while they allow several (TYPE-003). */
  readonly look: PaintKind | null;
  /** Every look the signals allow, in palette order. */
  readonly candidates: PaintKind[];
}

const ORDER: PaintKind[] = ["R1", "R2", "R3", "R4", "R5", "R6", "COM", "RET", "IND"];
const TIERS = new Set<PaintKind>(["R1", "R2", "R3", "R4", "R5", "R6"]);
const sorted = (s: Iterable<PaintKind>) => ORDER.filter((k) => new Set(s).has(k));

/**
 * TYPE-002: the guess for `b` among the buildings of its block (`block` includes `b`). Returns null for a
 * building that is typed or protected: there is nothing to guess (TYPE-001).
 */
export function guess(b: Building, block: readonly Building[]): Guess | null {
  if (statusOf(b) !== "untyped") return null;
  const g = b.geom;
  const levels = levelsOf(b.tags);
  const addr = addrCount(b.tags);
  const resOnly = b.look === "RU"; // `building=residential`: only a tier can refine it
  const n = g.clusterSize;
  const wall: PaintKind = n === 1 ? "R2" : n === 2 ? "R3" : "R4"; // shared walls, the strongest signal

  let c = new Set<PaintKind>();
  if (levels !== undefined && levels >= TUNE.HIGHRISE_LEVELS) c = new Set(["R6", "COM"]);
  else if (g.area >= TUNE.GUESS_BIG_AREA) {
    if ((levels ?? 0) >= TUNE.GUESS_APT_LEVELS || (addr ?? 0) >= TUNE.GUESS_MANY_ADDR) c = new Set(["R5"]);
    else if (levels !== undefined && levels <= 2) c = new Set(["RET", "IND", "COM"]); // a very large low footprint
    else c = new Set(["R5", "COM", "RET", "IND"]);
  } else if ((levels ?? 0) >= TUNE.GUESS_APT_LEVELS || (addr ?? 0) >= TUNE.GUESS_MANY_ADDR) c = new Set(["R5"]);
  else if (g.area <= TUNE.GUESS_HOUSE_AREA) {
    // Small: a house, a semi or a terraced unit by its walls; two to four addresses say it may be flats too.
    c = addr === undefined || addr <= 1 ? new Set([wall]) : new Set(n === 1 ? ["R3", "R5"] : [wall, "R5"]);
  } else {
    // Medium: too big for one house, too small to be sure of flats.
    if (addr !== undefined && addr >= 2) c = new Set(["R3", "R5"]);
    else c = new Set(n >= 3 ? ["R4", "R5"] : ["R2", "R5", "COM"]);
  }

  // Typed neighbours of similar size in the same block (TYPE-002, fourth signal).
  const hint = neighbourLook(b, block);
  if (hint) {
    if (c.has(hint)) c = new Set([hint]);
    else c.add(hint); // signals disagree: unsure, with both (TYPE-003)
  }

  if (resOnly) {
    const tiers = [...c].filter((k) => TIERS.has(k));
    c = new Set(tiers.length ? tiers : g.area > TUNE.GUESS_HOUSE_AREA ? ["R5"] : [wall]);
  }
  const candidates = sorted(c);
  return { look: candidates.length === 1 ? candidates[0] : null, candidates };
}

/** The look most typed buildings of similar size in the block share, when enough of them do. */
function neighbourLook(b: Building, block: readonly Building[]): PaintKind | null {
  const counts = new Map<PaintKind, number>();
  let total = 0;
  for (const o of block) {
    if (o === b || !paintable(o.look) || statusOf(o) !== "typed") continue;
    const ratio = o.geom.area / b.geom.area;
    if (ratio > TUNE.GUESS_SIMILAR || ratio < 1 / TUNE.GUESS_SIMILAR) continue;
    total++;
    counts.set(o.look, (counts.get(o.look) ?? 0) + 1);
  }
  if (total < TUNE.GUESS_NEIGHBOUR_MIN) return null;
  let best: PaintKind | null = null, bestN = 0;
  for (const [k, v] of counts) if (v > bestN) [best, bestN] = [k, v];
  return best && bestN / total >= TUNE.GUESS_NEIGHBOUR_SHARE ? best : null;
}

/** TYPE-005: the guess, in the user's words. */
export function describeGuess(g: Guess, label: (k: BuildingLook) => string): string {
  if (g.look) return `Looks like ${label(g.look).toLowerCase()}`;
  const names = g.candidates.map((k) => label(k).toLowerCase());
  return `Not sure: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
