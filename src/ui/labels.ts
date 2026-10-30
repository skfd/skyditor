// Name labels on named areas (NAME-008..NAME-010), and which of them have room to show (NAME-009).
import type { Label } from "../model/world";
import type { Camera } from "../render/camera";
import { TUNE } from "../tuning";

const BADGE = 9; // px; half the question-mark badge (REN-016, NAME-005) a quest's label starts after
const GAP = 3; // px between that badge and the label
const PAD = 3; // px of clear space kept round each label
const MARGIN = 24; // px; labels this far off screen are not placed

/** A label's box on screen, px from the top left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Candidate {
  label: Label;
  box: Box;
  room: number; // px; how wide the label's part of the area is on screen
}

/**
 * NAME-009: which labels show. Bigger areas claim room first, and within an area its bigger parts; a label shows if
 * it fits inside its part, overlaps no label already shown, and repeats no shown name within `same` px. Pure, so it
 * can be tested.
 */
export function fit(cands: Candidate[], same: number = TUNE.LABEL_SAME): boolean[] {
  const order = cands
    .map((_, i) => i)
    .sort((a, b) => cands[b].label.area - cands[a].label.area || cands[b].label.part - cands[a].label.part);
  const shown = cands.map(() => false);
  const placed: Candidate[] = [];
  for (const i of order) {
    const c = cands[i];
    if (c.box.w > c.room) continue;
    if (placed.some((o) => overlap(o.box, c.box) || (o.label.name === c.label.name && distance(o.box, c.box) < same))) continue;
    placed.push(c);
    shown[i] = true;
  }
  return shown;
}

const overlap = (a: Box, b: Box) =>
  a.x - PAD < b.x + b.w && b.x - PAD < a.x + a.w && a.y - PAD < b.y + b.h && b.y - PAD < a.y + a.h;

const distance = (a: Box, b: Box) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

interface Item {
  label: Label;
  el: HTMLElement;
  w: number; // px, measured once: the text never changes
  h: number;
}

export class Labels {
  private readonly layer = document.querySelector("#labels") as HTMLElement;
  private items = new Map<string, Item>(); // by area and position: a part that stays put keeps its element

  /** NAME-008: a label candidate on each part of each named area. */
  set(labels: Label[]) {
    const next = new Map<string, Item>();
    const fresh: Item[] = [];
    for (const label of labels) {
      const key = `${label.source}@${label.at[0].toFixed(1)},${label.at[1].toFixed(1)}`;
      const old = this.items.get(key);
      if (old && old.label.name === label.name && !next.has(key)) {
        old.label = label;
        next.set(key, old);
        continue;
      }
      const el = document.createElement("div");
      el.className = "label";
      el.textContent = label.name; // from OSM data: never as HTML
      el.style.maxWidth = `${TUNE.LABEL_WIDTH}px`; // NAME-010
      const item = { label, el, w: 0, h: 0 };
      next.set(key, item);
      fresh.push(item);
    }
    for (const [key, item] of this.items) if (next.get(key) !== item) item.el.remove();
    this.items = next;
    this.layer.append(...fresh.map((i) => i.el));
    for (const i of fresh) {
      const r = i.el.getBoundingClientRect();
      [i.w, i.h] = [r.width, r.height];
    }
  }

  /** NAME-008 / NAME-009: labels follow the map at a constant screen size, where they have room. */
  place(cam: Camera) {
    const cands: (Candidate & { item: Item })[] = [];
    for (const item of this.items.values()) {
      const { label, w, h } = item;
      const [sx, sy] = cam.toScreen(label.at[0], label.at[1]);
      const x = label.quest ? sx + BADGE + GAP : sx - w / 2;
      const box = { x, y: sy - h / 2, w, h };
      const off = box.x + w < -MARGIN || box.y + h < -MARGIN || box.x > cam.width + MARGIN || box.y > cam.height + MARGIN;
      if (off) item.el.hidden = true;
      else cands.push({ label, box, room: label.width * cam.scale, item });
    }
    const shown = fit(cands);
    cands.forEach((c, i) => {
      c.item.el.hidden = !shown[i];
      c.item.el.classList.toggle("quest", c.label.quest);
      if (shown[i]) c.item.el.style.transform = `translate(${Math.round(c.box.x)}px, ${Math.round(c.box.y)}px)`;
    });
  }
}
