// Badges on land tagged without its landuse, and the card a badge opens (REN-016, HUD-012).
import type { TagIssue } from "../model/world";
import type { Camera } from "../render/camera";

const OSM_ELEMENT = /^(way|relation)\/\d+$/;
const MARGIN = 24; // px; badges this far off screen are hidden

const code = (text: string) => {
  const c = document.createElement("code");
  c.textContent = text; // tags come from OSM data: never as HTML
  return c;
};

export class Badges {
  private readonly layer = document.querySelector("#badges") as HTMLElement;
  private readonly card = document.querySelector("#issue") as HTMLElement;
  private items: { issue: TagIssue; el: HTMLButtonElement }[] = [];
  private open: { issue: TagIssue; el: HTMLButtonElement } | null = null;

  constructor() {
    // HUD-012: pressing anywhere else closes the card.
    window.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Node;
        if (this.open && !this.card.contains(t) && !this.open.el.contains(t)) this.close();
      },
      true,
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  set(issues: TagIssue[]) {
    this.close();
    this.items = issues.map((issue) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "badge";
      el.textContent = "!";
      el.title = `Missing ${issue.missing}`;
      const item = { issue, el };
      el.addEventListener("click", () => (this.open === item ? this.close() : this.show(item)));
      return item;
    });
    this.layer.replaceChildren(...this.items.map((i) => i.el));
  }

  /** REN-016: badges follow the map at a constant screen size. */
  place(cam: Camera) {
    for (const { issue, el } of this.items) {
      const [x, y] = cam.toScreen(issue.at[0], issue.at[1]);
      const off = x < -MARGIN || y < -MARGIN || x > cam.width + MARGIN || y > cam.height + MARGIN;
      el.hidden = off;
      if (!off) el.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (this.open) this.placeCard(cam);
  }

  private show(item: { issue: TagIssue; el: HTMLButtonElement }) {
    this.open?.el.classList.remove("open");
    this.open = item;
    item.el.classList.add("open");
    const { issue } = item;
    const p = document.createElement("p");
    p.append("Tagged ", code(issue.tagged), ", but missing ", code(issue.missing), ".");
    const nodes: Node[] = [p];
    if (OSM_ELEMENT.test(issue.source)) {
      const a = document.createElement("a");
      a.href = `https://www.openstreetmap.org/${issue.source}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open on OpenStreetMap ↗";
      nodes.push(a);
    }
    this.card.replaceChildren(...nodes);
    this.card.classList.add("show");
    this.cardAt(item.el);
  }

  private close() {
    if (!this.open) return;
    this.open.el.classList.remove("open");
    this.open = null;
    this.card.classList.remove("show");
  }

  private placeCard(cam: Camera) {
    if (this.open!.el.hidden) return this.close();
    this.cardAt(this.open!.el, cam.width, cam.height);
  }

  /** Beside the badge, kept on screen. */
  private cardAt(badge: HTMLElement, w = window.innerWidth, h = window.innerHeight) {
    const b = badge.getBoundingClientRect();
    const c = this.card.getBoundingClientRect();
    let x = b.right + 8, y = b.top + b.height / 2 - c.height / 2;
    if (x + c.width > w - 8) x = b.left - 8 - c.width;
    y = Math.max(8, Math.min(h - c.height - 8, y));
    this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}
