import { describe, expect, it } from "vitest";
import { applyCapture, planCapture } from "../src/model/capture";
import type { World } from "../src/model/world";
import { type Tool } from "../src/paint/snap";
import { Stroke, answerWhole } from "../src/paint/stroke";
import { Sketch, at, paint } from "./helpers";

const R2: Tool = { type: "paint", kind: "R2" };
const UP: Tool = { type: "density", dir: 1 };
const ERASE: Tool = { type: "erase" };
const NAMED = { landuse: "residential", name: "Pärnaõue" };
const DETACHED = { landuse: "residential", residential: "detached" };

/** Nine blocks, roads every 200 m; a named complex across the centre block and the one east of it. */
async function complex(tags: Record<string, string> = NAMED) {
  const s = new Sketch(300).grid(200);
  s.rect(-95, -95, 290, 95, tags);
  return s.world();
}

/** The complex, with the rest of it not loaded yet (World.loading). */
async function loadingComplex(tags: Record<string, string> = NAMED) {
  const w = await complex(tags);
  w.loading.add(at(w, 0, 0)!.source!);
  return w;
}

const kinds = (w: World) => [at(w, 0, 0)?.kind, at(w, 200, 0)?.kind];
const rejects = (events: { type: string }[]) => events.filter((e) => e.type === "reject").length;

describe("named areas not loaded whole", () => {
  it("LOAD-015: a tap with a tier changes nothing and rejects once; once loaded, the same tap claims it whole", async () => {
    const w = await loadingComplex();
    const { events, step } = paint(w, R2, 10, [[0, 0]], true);
    expect(rejects(events)).toBe(1);
    expect(events.some((e) => e.type === "claim")).toBe(false);
    expect(step).toBeNull();
    expect(kinds(w)).toEqual(["RU", "RU"]);

    w.loading.delete(at(w, 0, 0)!.source!);
    const done = paint(w, R2, 10, [[0, 0]], true);
    expect(rejects(done.events)).toBe(0);
    expect(done.step).not.toBeNull();
    expect(kinds(w)).toEqual(["R2", "R2"]);
  });

  it("LOAD-015: a stroke over most of it neither charges nor claims it, and rejects once", async () => {
    const w = await loadingComplex();
    const s = new Stroke(w, R2, 60, -60, 0);
    const events = [...s.start()];
    for (let x = -54; x <= 260; x += 6) events.push(...s.move(x, 0));
    expect([...s.charging()].filter(([p]) => p.whole)).toEqual([]);
    const end = s.end(false);
    events.push(...end.events);
    expect(rejects(events)).toBe(1);
    expect(events.some((e) => e.type === "claim")).toBe(false);
    expect(end.step).toBeNull();
    expect(kinds(w)).toEqual(["RU", "RU"]);
  });

  it("LOAD-015: the eraser leaves it as well, rejecting once", async () => {
    const w = await loadingComplex({ ...NAMED, residential: "terrace" });
    const { events, step } = paint(w, ERASE, 10, [[0, 0], [200, 0], [0, 50]]);
    expect(rejects(events)).toBe(1);
    expect(step).toBeNull();
    expect(kinds(w)).toEqual(["R4", "R4"]);
  });

  it("LOAD-015: a density step leaves it and rejects once", async () => {
    const w = await loadingComplex({ ...NAMED, residential: "single_family" });
    const { events, step } = paint(w, UP, 10, [[0, 0], [200, 0], [0, 50]]);
    expect(rejects(events)).toBe(1);
    expect(events.some((e) => e.type === "tier")).toBe(false);
    expect(step).toBeNull();
    expect(kinds(w)).toEqual(["R2", "R2"]);

    w.loading.clear();
    paint(w, UP, 10, [[0, 0]]);
    expect(kinds(w)).toEqual(["R3", "R3"]);
  });

  it("LOAD-015: its question-mark badge shows only once it is loaded whole; its name shows all along", async () => {
    const w = await loadingComplex();
    const source = at(w, 0, 0)!.source!;
    expect(w.labels().map((l) => l.name)).toContain("Pärnaõue");
    expect(w.labels().some((l) => l.quest)).toBe(false);
    expect(w.quests()).toEqual([]);
    // The badge's choice (NAME-006) changes nothing while it loads either.
    expect(answerWhole(w, source, "R4")).toEqual({ events: [], step: null });
    expect(kinds(w)).toEqual(["RU", "RU"]);

    w.loading.delete(source);
    expect(w.quests().map((q) => q.source)).toEqual([source]);
  });
});

describe("captures of areas not loaded whole", () => {
  /** Two touching areas of one kind in the centre block. */
  async function pair() {
    const s = new Sketch(300).grid(200);
    s.rect(-95, -95, 0, 95, DETACHED);
    s.rect(0, -95, 95, 95, DETACHED);
    return s.world();
  }
  const plan = (w: World) => planCapture(w, at(w, -50, 0)!, at(w, 50, 0)!);

  it("LOAD-021: a capture whose source or target is still loading is refused; once both are loaded it works", async () => {
    for (const x of [-50, 50]) {
      const w = await pair();
      const id = at(w, x, 0)!.feature!;
      w.loading.add(id);
      expect(plan(w)).toBeNull();
      w.loading.delete(id);
      const p = plan(w);
      expect(p).not.toBeNull();
      applyCapture(w, p!);
      expect(at(w, 50, 0)!.feature).toBe(at(w, -50, 0)!.feature);
    }
  });
});
