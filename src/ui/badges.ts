// Badges on land tagged without its landuse and on named areas without a type, and the card a badge or an
// unsure building's mark opens (REN-016, HUD-012, NAME-005, NAME-006, TYPE-015).
import { SERVER } from "../osm/server";
import type { Quest, TagIssue } from "../model/world";
import type { Camera } from "../render/camera";
import { TUNE } from "../tuning";

const OSM_ELEMENT = /^(way|relation)\/\d+$/;
const MARGIN = 24; // px; badges this far off screen are hidden

const code = (text: string) => {
  const c = document.createElement("code");
  c.textContent = text; // tags come from OSM data: never as HTML
  return c;
};

/** A link that opens an OSM element on openstreetmap.org in a new tab (HUD-012, NAME-006), or null. */
export function osmLink(source: string): HTMLAnchorElement | null {
  if (!OSM_ELEMENT.test(source)) return null;
  const a = document.createElement("a");
  a.href = `${SERVER.web}/${source}`; // DEV-001: the server this page edits
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `Open on ${SERVER.id === "main" ? "OpenStreetMap" : "the test server"} ↗`;
  return a;
}

interface Item {
  at: [number, number]; // m
  el: HTMLButtonElement;
  label: string; // the card's name for screen readers
  card: () => Node[];
  quest?: Quest; // NAME-005
}

export class Badges {
  private readonly layer = document.querySelector("#badges") as HTMLElement;
  private readonly card = document.querySelector("#issue") as HTMLElement;
  private items: Item[] = [];
  private quests: Item[] = []; // NAME-005
  private open: Item | null = null;
  private mark: [number, number] | null = null; // TYPE-015: the centre of the mark the card is open for, m

  constructor() {
    // HUD-012: pressing anywhere else closes the card.
    window.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Node;
        if (this.open && !this.card.contains(t) && !this.open.el.contains(t)) this.close();
        if (this.mark && !this.card.contains(t)) this.close();
      },
      true,
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  private badge(text: string, title: string, item: Omit<Item, "el">): Item {
    const el = document.createElement("button");
    el.type = "button";
    el.className = text === "?" ? "badge quest" : "badge";
    el.textContent = text;
    el.title = title;
    const it = { ...item, el };
    el.addEventListener("click", () => (this.open === it ? this.close() : this.show(it)));
    return it;
  }

  set(issues: TagIssue[]) {
    this.close();
    this.items = issues.map((issue) =>
      this.badge("!", `Missing ${issue.missing}`, { at: issue.at, label: "Missing landuse", card: () => issueCard(issue) }),
    );
    this.quests = [];
    this.layer.replaceChildren(...this.items.map((i) => i.el));
  }

  /**
   * NAME-005: one question-mark badge per named area still without a type; `card` builds what its card shows
   * (NAME-006). Badges whose area is still a question keep their element, so they do not blink on each change.
   */
  setQuests(quests: Quest[], card: (q: Quest) => Node[]) {
    const kept = new Map(this.quests.map((i) => [i.quest!.source, i]));
    this.quests = quests.map((q) => {
      const old = kept.get(q.source);
      if (old && old.at[0] === q.at[0] && old.at[1] === q.at[1]) return old;
      return this.badge("?", `${q.name}: what kind of housing?`, { at: q.at, label: "Kind of housing", card: () => card(q), quest: q });
    });
    if (this.open?.quest && !this.quests.includes(this.open)) this.close();
    this.layer.replaceChildren(...this.items.map((i) => i.el), ...this.quests.map((i) => i.el));
  }

  /** REN-016 / NAME-005: badges follow the map at a constant screen size. */
  place(cam: Camera) {
    for (const { at, el } of [...this.items, ...this.quests]) {
      const [x, y] = cam.toScreen(at[0], at[1]);
      const off = x < -MARGIN || y < -MARGIN || x > cam.width + MARGIN || y > cam.height + MARGIN;
      el.hidden = off;
      if (!off) el.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (this.open) this.placeCard(cam);
    if (this.mark) this.placeMark(cam);
  }

  /** TYPE-015: a card beside an unsure building's mark at `at` (metres), following the map like a badge's. */
  showMark(at: [number, number], nodes: Node[], cam: Camera) {
    this.close();
    this.mark = at;
    this.card.setAttribute("aria-label", "Building type");
    this.card.replaceChildren(...nodes);
    this.card.classList.add("show");
    this.placeMark(cam);
  }

  private show(item: Item) {
    this.open?.el.classList.remove("open");
    this.mark = null;
    this.open = item;
    item.el.classList.add("open");
    this.card.setAttribute("aria-label", item.label);
    this.card.replaceChildren(...item.card());
    this.card.classList.add("show");
    this.cardAt(item.el.getBoundingClientRect());
  }

  close() {
    if (!this.open && !this.mark) return;
    this.open?.el.classList.remove("open");
    this.open = null;
    this.mark = null;
    this.card.classList.remove("show");
  }

  private placeCard(cam: Camera) {
    if (this.open!.el.hidden) return this.close();
    this.cardAt(this.open!.el.getBoundingClientRect(), cam.width, cam.height);
  }

  private placeMark(cam: Camera) {
    const [x, y] = cam.toScreen(this.mark![0], this.mark![1]);
    if (x < -MARGIN || y < -MARGIN || x > cam.width + MARGIN || y > cam.height + MARGIN) return this.close();
    const r = TUNE.UNSURE_MARK, box = this.layer.getBoundingClientRect();
    this.cardAt({ left: box.left + x - r, right: box.left + x + r, top: box.top + y - r, height: 2 * r }, cam.width, cam.height);
  }

  /** Beside the badge or mark, kept on screen. */
  private cardAt(b: { left: number; right: number; top: number; height: number }, w = window.innerWidth, h = window.innerHeight) {
    const c = this.card.getBoundingClientRect();
    let x = b.right + 8, y = b.top + b.height / 2 - c.height / 2;
    if (x + c.width > w - 8) x = b.left - 8 - c.width;
    y = Math.max(8, Math.min(h - c.height - 8, y));
    this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

/** HUD-012: what the area is tagged as, the landuse tag it lacks, and a link to fix it in OSM. */
function issueCard(issue: TagIssue): Node[] {
  const p = document.createElement("p");
  p.append("Tagged ", code(issue.tagged), ", but missing ", code(issue.missing), ".");
  const a = osmLink(issue.source);
  return a ? [p, a] : [p];
}
