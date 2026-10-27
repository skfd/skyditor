// HUD: palette, district mix, tooltip, help, start screen, loading and toasts (HUD-*, LOAD-007).
import { KINDS, type Kind, PAINT_KINDS, TIERS, tagString } from "../model/kinds";
import type { Stage } from "../model/load";
import type { Tool } from "../paint/snap";
import { ICONS } from "./icons";

export interface ToolDef {
  id: string;
  tool: Tool;
  label: string;
  key: string;
  icon: string;
  color: string;
  tags: string;
}

export const TOOLS: ToolDef[] = [
  ...PAINT_KINDS.map((k) => ({
    id: k,
    tool: { type: "paint", kind: k } as Tool,
    label: KINDS[k].label,
    key: KINDS[k].key!,
    icon: ICONS[k],
    color: KINDS[k].color,
    tags: tagString(k),
  })),
  { id: "UP", tool: { type: "density", dir: 1 }, label: "Density up", key: "A", icon: ICONS.UP, color: "#e2683c", tags: "one step up the residential ladder" },
  { id: "DOWN", tool: { type: "density", dir: -1 }, label: "Density down", key: "Z", icon: ICONS.DOWN, color: "#6f9bd1", tags: "one step down the residential ladder" },
  { id: "ERASE", tool: { type: "erase" }, label: "Eraser", key: "X", icon: ICONS.ERASE, color: "#9a8f80", tags: "removes painted landuse" },
];

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const el = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class Hud {
  private tiles = new Map<string, HTMLElement>();
  private mixSegs = new Map<string, HTMLElement>();
  private tooltip = $("#tooltip");
  private toastTimer = 0;

  constructor(private onTool: (id: string) => void) {
    this.buildPalette();
    this.buildMix();
  }

  /** HUD-001 */
  private buildPalette() {
    const root = $("#palette");
    const ladder = el("div", "group ladder");
    ladder.append(el("div", "ladder-ramp"));
    const rest = el("div", "group");
    const tools = el("div", "group");
    for (const t of TOOLS) {
      const b = el("button", "tile", `${t.icon}<span class="key">${t.key}</span>`);
      b.style.setProperty("--c", t.color);
      b.dataset.tool = t.id;
      b.addEventListener("click", () => this.onTool(t.id));
      // HUD-002
      b.addEventListener("pointerenter", () => this.showTip(b, t));
      b.addEventListener("pointerleave", () => this.hideTip());
      this.tiles.set(t.id, b);
      if (TIERS.includes(t.id as never)) ladder.append(b);
      else if (t.tool.type === "paint") rest.append(b);
      else tools.append(b);
    }
    root.append(ladder, rest, tools);
  }

  private showTip(anchor: HTMLElement, t: ToolDef) {
    const tip = this.tooltip;
    tip.innerHTML = `<b>${t.label}</b> <span class="kbd">${t.key}</span><div class="tags">${t.tags}</div>`;
    tip.classList.add("show");
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 10}px`;
  }
  private hideTip() {
    this.tooltip.classList.remove("show");
  }

  selectTool(id: string) {
    for (const [k, b] of this.tiles) b.classList.toggle("on", k === id);
    const b = this.tiles.get(id);
    if (b) {
      b.classList.remove("boing");
      void b.offsetWidth; // restart the CSS animation
      b.classList.add("boing");
    }
  }

  /** HUD-003 */
  private static MIX_ORDER: (Kind | "void")[] = [...TIERS, "RU", "COM", "RET", "IND", "CTX", "void"];
  private buildMix() {
    const bar = $("#mix .bar");
    for (const k of Hud.MIX_ORDER) {
      const seg = el("div", `seg seg-${k}`);
      seg.style.background = k === "void" ? "#efe9de" : k === "CTX" ? "#bcdba3" : KINDS[k].color;
      seg.title = k === "void" ? "Unpainted" : KINDS[k].label;
      bar.append(seg);
      this.mixSegs.set(k, seg);
    }
  }
  updateMix(mix: Record<string, number>, total: number) {
    for (const [k, seg] of this.mixSegs) {
      const share = total > 0 ? (mix[k] ?? 0) / total : 0;
      seg.style.width = `${(share * 100).toFixed(2)}%`;
      const label = k === "void" ? "Unpainted" : KINDS[k as Kind].label;
      seg.title = `${label}: ${(share * 100).toFixed(1)}% · ${((mix[k] ?? 0) / 10000).toFixed(1)} ha`;
    }
  }

  setPlace(name: string) {
    $("#place").textContent = name;
  }

  setSound(on: boolean, icons: { on: string; off: string }) {
    $("#btn-sound").innerHTML = on ? icons.on : icons.off;
    $("#btn-sound").title = on ? "Sound on (M)" : "Sound off (M)";
  }

  toggleHelp(force?: boolean) {
    $("#help").classList.toggle("show", force);
  }

  toast(msg: string, kind: "info" | "error" = "info") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = `show ${kind}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.className = ""), kind === "error" ? 6000 : 3200);
  }

  showStart(show: boolean) {
    $("#start").classList.toggle("show", show);
  }

  /** LOAD-007 */
  loading(stage: Stage | null) {
    const box = $("#loading");
    box.classList.toggle("show", stage !== null);
    if (!stage) return;
    const order: Stage[] = ["fetching", "reading", "blocks", "landuse"];
    const at = order.indexOf(stage);
    box.querySelectorAll<HTMLElement>("li").forEach((li, i) => {
      li.classList.toggle("done", i < at);
      li.classList.toggle("now", i === at);
    });
  }
}
