// Glue: input, the frame loop, and turning model events into feedback.
import { area, toI, toM } from "./geo/clip";
import { squareAround } from "./geo/project";
import { History, type Step } from "./model/history";
import { KINDS, type Kind } from "./model/kinds";
import { type Stage, worldFromText } from "./model/load";
import type { Piece, World } from "./model/world";
import { fetchArea, searchPlaces } from "./osm/fetch";
import type { Tool } from "./paint/snap";
import { Stroke, type StrokeEvent } from "./paint/stroke";
import { Anims } from "./render/anim";
import { Camera } from "./render/camera";
import { Renderer, pathOf } from "./render/renderer";
import { TUNE } from "./tuning";
import { Sound } from "./ui/audio";
import { Badges } from "./ui/badges";
import { Hud, TOOLS } from "./ui/hud";
import { ICONS } from "./ui/icons";

const PREVIEW_BUDGET_MS = 9;

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(`skyditor.${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`skyditor.${k}`, v);
    } catch {
      /* private mode: fine */
    }
  },
};

export class App {
  private readonly canvas = document.getElementById("map") as HTMLCanvasElement;
  private readonly camera = new Camera();
  private readonly anims = new Anims(matchMedia("(prefers-reduced-motion: reduce)").matches);
  private readonly sound = new Sound(store.get("sound") !== "off");
  private readonly hud: Hud;
  private world: World | null = null;
  private renderer: Renderer | null = null;
  private history = new History();

  private toolId = "R2";
  private tool: Tool = { type: "paint", kind: "R2" };
  private brushPx: number = TUNE.BRUSH_DEFAULT;
  private stroke: Stroke | null = null;
  private strokeStart = { sx: 0, sy: 0, t: 0, moved: 0 };
  private cursor: [number, number] | null = null;
  private hover: Piece | null = null;
  private showBuildings = store.get("buildings") !== "off";
  private showOriginals = false;
  private pan: { id: number; x: number; y: number; t: number; vx: number; vy: number } | null = null;
  private space = false;
  // CAM-006: touch pointers on the map, the two-finger gesture, and PAINT-011's lock until all fingers lift.
  private touches = new Map<number, [number, number]>();
  private pinch: { mid: [number, number]; dist: number; t: number; vx: number; vy: number } | null = null;
  private touchLock = false;
  private arrows = new Set<string>();
  private dirty = true;
  private ambient = false; // REN-014: only slow marks are moving
  private lastDraw = 0;
  private disputes = 0; // HUD-009
  private lastDispute: [number, number] | null = null; // HUD-010: where the last jump went
  private lastFrame = performance.now();
  private loadingBusy = false;
  private readonly badges = new Badges(); // REN-016 / HUD-012

  constructor() {
    this.hud = new Hud((id) => this.selectTool(id));
    this.hud.selectTool(this.toolId);
    this.hud.setSound(this.sound.enabled, { on: ICONS.SOUND_ON, off: ICONS.SOUND_OFF });
    this.hud.setBrush(this.brushPx);
    this.hud.setLayers(this.showBuildings, this.showOriginals);
    this.bindInput();
    this.bindStart();
    window.addEventListener("resize", () => this.resize());
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
    this.routeFromHash();
  }

  // ---------- loading ----------

  private async load(getText: () => Promise<string>, place: string, hash: string) {
    if (this.loadingBusy) return;
    this.loadingBusy = true;
    const stage = (s: Stage) => this.hud.loading(s);
    try {
      stage("fetching");
      const text = await getText();
      const { world, report } = await worldFromText(text, stage);
      if (world.atoms.length === 0) throw new Error("No land found in this area");
      this.setWorld(world, place);
      history.replaceState(null, "", hash || location.pathname + location.search);
      this.hud.toast(`${report.atoms} blocks · ${report.pieces} landuse pieces · ${Math.round(report.ms)} ms`);
      if (report.skippedRings) console.info(`Skipped ${report.skippedRings} incomplete multipolygon rings`);
    } catch (e) {
      // LOAD-008: the current area, if any, stays as it was.
      console.error(e);
      this.hud.toast(`Couldn't load: ${(e as Error).message}`, "error");
      if (!this.world) this.hud.showStart(true);
    } finally {
      this.hud.loading(null);
      this.loadingBusy = false;
    }
  }

  private loadDemo() {
    this.hud.showStart(false);
    // LOAD-001
    void this.load(async () => {
      const res = await fetch("fixtures/demo-tallinn.json");
      if (!res.ok) throw new Error(`demo data missing (HTTP ${res.status})`);
      return res.text();
    }, "Tallinn · Kristiine (demo)", "#demo");
  }

  private loadAround(lat: number, lon: number, name: string) {
    this.hud.showStart(false);
    const side = Number(store.get("side")) || TUNE.AREA_SIDE;
    const b = squareAround(lat, lon, side); // LOAD-002
    void this.load(() => fetchArea(b), name, `#map=${lat.toFixed(5)}/${lon.toFixed(5)}`); // LOAD-003, LOAD-009
  }

  private loadFile(file: File) {
    this.hud.showStart(false);
    // LOAD-004
    void this.load(() => file.text(), file.name, "");
  }

  /** LOAD-009 */
  private routeFromHash() {
    const h = location.hash;
    const m = /^#map=(-?[\d.]+)\/(-?[\d.]+)/.exec(h);
    if (m) this.loadAround(Number(m[1]), Number(m[2]), `${Number(m[1]).toFixed(4)}, ${Number(m[2]).toFixed(4)}`);
    else if (h === "#demo") this.loadDemo();
    else this.hud.showStart(true);
  }

  private setWorld(world: World, place: string) {
    this.world = world;
    this.history = new History();
    this.syncHistory();
    this.stroke = null;
    this.hover = null;
    if (this.renderer) this.renderer.setWorld(world);
    else this.renderer = new Renderer(this.canvas, world);
    this.resize();
    const f = world.features.frame;
    const box = { minX: toM(f.minX), minY: toM(f.minY), maxX: toM(f.maxX), maxY: toM(f.maxY) };
    this.camera.bounds = box;
    const now = performance.now();
    // CAM-004: start a little zoomed in and settle out to fit the area.
    this.camera.fit({ minX: box.minX * 0.6, minY: box.minY * 0.6, maxX: box.maxX * 0.6, maxY: box.maxY * 0.6 }, 0, now);
    this.camera.fit(box, this.anims.dur(900), now);
    this.reveal(now);
    this.hud.setPlace(place);
    this.badges.set(world.issues);
    this.lastDispute = null;
    this.updateMix(true);
    this.dirty = true;
  }

  /** FEEL-007: a pop wave from the centre outwards. */
  private reveal(now: number) {
    const w = this.world!;
    const spread = this.anims.dur(TUNE.REVEAL_MAX - TUNE.POP_DURATION);
    let maxD = 1;
    for (const a of w.atoms) maxD = Math.max(maxD, Math.hypot(toM(a.bbox.maxX), toM(a.bbox.maxY)));
    for (const a of w.atoms)
      for (const p of a.pieces) {
        if (p.kind === null || p.kind === "CTX") continue;
        const d = Math.hypot(toM((p.bbox.minX + p.bbox.maxX) / 2), toM((p.bbox.minY + p.bbox.maxY) / 2));
        this.anims.pop(p, now, { appear: true, delay: 150 + (d / maxD) * spread });
      }
  }

  private bindStart() {
    document.getElementById("btn-demo")!.addEventListener("click", () => {
      this.sound.unlock();
      this.loadDemo();
    });
    const form = document.getElementById("search") as HTMLFormElement;
    const input = form.querySelector("input")!;
    const results = document.getElementById("results")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      this.sound.unlock();
      const q = input.value.trim();
      if (!q) return;
      const ll = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(q);
      if (ll) return this.loadAround(Number(ll[1]), Number(ll[2]), q);
      results.innerHTML = `<li class="muted">Searching…</li>`;
      try {
        const places = await searchPlaces(q);
        results.innerHTML = places.length ? "" : `<li class="muted">Nothing found</li>`;
        for (const p of places) {
          const li = document.createElement("li");
          li.textContent = p.name;
          li.tabIndex = 0;
          const go = () => this.loadAround(p.lat, p.lon, p.name.split(",").slice(0, 2).join(","));
          li.addEventListener("click", go);
          li.addEventListener("keydown", (ev) => ev.key === "Enter" && go());
          results.append(li);
        }
      } catch (err) {
        results.innerHTML = `<li class="muted">${(err as Error).message}</li>`;
      }
    });
    const sizes = document.querySelectorAll<HTMLButtonElement>("#sizes button");
    const side = Number(store.get("side")) || TUNE.AREA_SIDE;
    sizes.forEach((b) => {
      b.classList.toggle("on", Number(b.dataset.side) === side);
      b.addEventListener("click", () => {
        store.set("side", b.dataset.side!);
        sizes.forEach((x) => x.classList.toggle("on", x === b));
      });
    });
    document.getElementById("btn-file")!.addEventListener("click", () => document.getElementById("file")!.click());
    document.getElementById("file")!.addEventListener("change", (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) this.loadFile(f);
    });
    document.getElementById("btn-place")!.addEventListener("click", () => this.hud.showStart(true));
    document.getElementById("start-close")!.addEventListener("click", () => this.world && this.hud.showStart(false));
    document.getElementById("btn-help")!.addEventListener("click", () => this.hud.toggleHelp());
    document.getElementById("btn-sound")!.addEventListener("click", () => this.toggleSound());
    // HUD-006 / HUD-007 (GEN-005): every key has a button.
    const on = (id: string, f: () => void) => document.getElementById(id)!.addEventListener("click", f);
    on("btn-undo", () => this.undo());
    on("btn-redo", () => this.redo());
    on("btn-zoom-in", () => this.zoomStep(1));
    on("btn-zoom-out", () => this.zoomStep(-1));
    on("btn-fit", () => this.fitArea());
    on("btn-brush-up", () => this.setBrush(this.brushPx * TUNE.BRUSH_STEP));
    on("btn-brush-down", () => this.setBrush(this.brushPx / TUNE.BRUSH_STEP));
    on("btn-buildings", () => this.toggleBuildings());
    on("btn-outlines", () => this.toggleOriginals());
    on("btn-disputes", () => this.nextDispute());
  }

  // ---------- tools ----------

  private selectTool(id: string) {
    const t = TOOLS.find((x) => x.id === id);
    if (!t) return;
    this.toolId = id;
    this.tool = t.tool;
    this.hud.selectTool(id);
    this.dirty = true;
  }

  private toggleSound() {
    this.sound.unlock();
    this.sound.enabled = !this.sound.enabled;
    store.set("sound", this.sound.enabled ? "on" : "off");
    this.hud.setSound(this.sound.enabled, { on: ICONS.SOUND_ON, off: ICONS.SOUND_OFF });
  }

  private setBrush(px: number) {
    this.brushPx = Math.max(TUNE.BRUSH_MIN, Math.min(TUNE.BRUSH_MAX, px)); // INP-001
    this.hud.setBrush(this.brushPx);
    this.dirty = true;
  }

  private toggleBuildings() {
    this.showBuildings = !this.showBuildings;
    store.set("buildings", this.showBuildings ? "on" : "off");
    this.hud.setLayers(this.showBuildings, this.showOriginals);
    this.dirty = true;
  }

  private toggleOriginals() {
    this.showOriginals = !this.showOriginals; // IMP-009
    this.hud.setLayers(this.showBuildings, this.showOriginals);
    this.hud.toast(this.showOriginals ? "Showing original OSM outlines" : "Original outlines hidden");
    this.dirty = true;
  }

  /** HUD-010: flies to the next disputed piece, north to south, and flashes it. */
  private nextDispute() {
    if (!this.world) return;
    const list = this.world.disputed();
    if (!list.length) return;
    const after = this.lastDispute;
    const p =
      (after && list.find((q) => q.bbox.minY > after[1] || (q.bbox.minY === after[1] && q.bbox.minX > after[0]))) || list[0];
    this.lastDispute = [p.bbox.minX, p.bbox.minY];
    const b = { minX: toM(p.bbox.minX), minY: toM(p.bbox.minY), maxX: toM(p.bbox.maxX), maxY: toM(p.bbox.maxY) };
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const hw = Math.max(TUNE.DISPUTE_VIEW, (b.maxX - b.minX) * 1.3) / 2;
    const hh = Math.max(TUNE.DISPUTE_VIEW, (b.maxY - b.minY) * 1.3) / 2;
    const now = performance.now();
    const dur = this.anims.dur(600);
    this.camera.fit({ minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh }, dur, now);
    this.anims.flash({ path: pathOf(p.shape), color: "#fff", cx, cy, mode: "light" }, now, dur, 420);
    this.dirty = true;
  }

  /** CAM-007 */
  private zoomStep(dir: 1 | -1) {
    this.camera.zoomBy(dir > 0 ? TUNE.ZOOM_STEP : 1 / TUNE.ZOOM_STEP, this.camera.width / 2, this.camera.height / 2);
    this.dirty = true;
  }

  /** CAM-004 */
  private fitArea() {
    if (!this.world) return;
    const f = this.world.features.frame;
    this.camera.fit({ minX: toM(f.minX), minY: toM(f.minY), maxX: toM(f.maxX), maxY: toM(f.maxY) }, this.anims.dur(600), performance.now());
    this.dirty = true;
  }

  // ---------- input ----------

  private bindInput() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault()); // INP-004
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("pointerleave", () => {
      if (!this.stroke && !this.pan) {
        this.cursor = null;
        this.hover = null;
        this.dirty = true;
      }
    });
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => {
      this.space = false;
      this.arrows.clear();
    });
    // LOAD-004
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      document.body.classList.add("dropping");
    });
    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null) document.body.classList.remove("dropping");
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      document.body.classList.remove("dropping");
      const f = e.dataTransfer?.files?.[0];
      if (f) this.loadFile(f);
    });
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onDown(e: PointerEvent) {
    this.sound.unlock();
    const [sx, sy] = this.local(e);
    this.cursor = [sx, sy];
    this.dirty = true;
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, [sx, sy]);
      if (this.touches.size >= 2) return this.startPinch();
      if (this.touchLock) return; // PAINT-011
    }
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.space)) {
      // CAM-002
      this.pan = { id: e.pointerId, x: sx, y: sy, t: performance.now(), vx: 0, vy: 0 };
      this.canvas.setPointerCapture(e.pointerId);
      document.body.classList.add("panning");
      return;
    }
    if (e.button !== 0 || !this.world || this.stroke) return;
    const [wx, wy] = this.camera.toWorld(sx, sy);
    if (e.altKey) {
      // PAINT-008
      const p = this.world.pieceAt(toI(wx), toI(wy));
      if (p && p.kind && p.kind in KINDS && TOOLS.some((t) => t.id === p.kind)) this.selectTool(p.kind);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.hover = null;
    // PAINT-001: the brush radius is fixed in metres for the whole stroke.
    this.stroke = new Stroke(this.world, this.tool, this.brushPx / this.camera.scale, wx, wy, TUNE.TAP_MOVE / this.camera.scale);
    this.strokeStart = { sx, sy, t: performance.now(), moved: 0 };
    this.handle(this.stroke.start(), [wx, wy]);
  }

  private onMove(e: PointerEvent) {
    const [sx, sy] = this.local(e);
    this.cursor = [sx, sy];
    this.dirty = true;
    if (this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [sx, sy]);
      if (this.touchLock) {
        if (this.pinch) this.movePinch();
        return;
      }
    }
    if (this.pan && e.pointerId === this.pan.id) {
      const now = performance.now();
      const dt = Math.max(1, now - this.pan.t);
      const dx = sx - this.pan.x, dy = sy - this.pan.y;
      this.camera.panBy(dx, dy);
      // Smoothed release velocity for coasting.
      this.pan.vx = this.pan.vx * 0.6 + (dx / dt) * 0.4;
      this.pan.vy = this.pan.vy * 0.6 + (dy / dt) * 0.4;
      Object.assign(this.pan, { x: sx, y: sy, t: now });
      return;
    }
    if (!this.world) return;
    if (this.stroke) {
      this.strokeStart.moved = Math.max(this.strokeStart.moved, Math.hypot(sx - this.strokeStart.sx, sy - this.strokeStart.sy));
      const points = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      for (const pe of points.length ? points : [e]) {
        const [px, py] = this.local(pe);
        const w = this.camera.toWorld(px, py);
        this.handle(this.stroke.move(w[0], w[1]), w);
      }
      return;
    }
    const [wx, wy] = this.camera.toWorld(sx, sy);
    this.hover = this.world.pieceAt(toI(wx), toI(wy)); // REN-007
  }

  private onUp(e: PointerEvent) {
    if (this.touches.delete(e.pointerId) && this.touchLock) {
      if (this.touches.size === 0) this.touchLock = false;
      if (this.pinch) {
        if (this.touches.size >= 2) Object.assign(this.pinch, this.pinchFrame());
        else this.endPinch();
      }
      return;
    }
    if (this.pan && e.pointerId === this.pan.id) {
      const idle = performance.now() - this.pan.t > 80;
      this.camera.release(idle ? 0 : this.pan.vx, idle ? 0 : this.pan.vy);
      this.pan = null;
      document.body.classList.remove("panning");
      return;
    }
    if (!this.stroke) return;
    const s = this.stroke;
    this.stroke = null;
    const isTap = this.strokeStart.moved < TUNE.TAP_MOVE && performance.now() - this.strokeStart.t < TUNE.TAP_TIME;
    const { events, step } = s.end(isTap);
    const [sx, sy] = this.local(e);
    this.handle(events, this.camera.toWorld(sx, sy));
    if (step) this.history.push(step); // PAINT-005 / PAINT-006
    this.syncHistory();
    this.dirty = true;
  }

  /** CAM-006 / PAINT-010: a second finger turns whatever the first one started into a pan and zoom. */
  private startPinch() {
    if (this.stroke) {
      const reverted = this.stroke.cancel();
      this.stroke = null;
      if (reverted) this.settle(reverted, "before");
    }
    this.pan = null;
    this.hover = null;
    this.touchLock = true;
    this.pinch = { ...this.pinchFrame(), t: performance.now(), vx: 0, vy: 0 };
    document.body.classList.add("panning");
  }

  private pinchFrame() {
    const [[ax, ay], [bx, by]] = [...this.touches.values()];
    return { mid: [(ax + bx) / 2, (ay + by) / 2] as [number, number], dist: Math.hypot(bx - ax, by - ay) };
  }

  private movePinch() {
    const p = this.pinch!;
    const { mid, dist } = this.pinchFrame();
    const now = performance.now();
    const dt = Math.max(1, now - p.t);
    const dx = mid[0] - p.mid[0], dy = mid[1] - p.mid[1];
    this.camera.panBy(dx, dy);
    if (p.dist > 0 && dist > 0) this.camera.zoomNow(dist / p.dist, mid[0], mid[1]);
    // Smoothed release velocity for coasting, as for a mouse pan.
    p.vx = p.vx * 0.6 + (dx / dt) * 0.4;
    p.vy = p.vy * 0.6 + (dy / dt) * 0.4;
    Object.assign(p, { mid, dist, t: now });
    this.dirty = true;
  }

  private endPinch() {
    const p = this.pinch!;
    const idle = performance.now() - p.t > 80;
    this.camera.release(idle ? 0 : p.vx, idle ? 0 : p.vy);
    this.pinch = null;
    document.body.classList.remove("panning");
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;
    if (e.shiftKey) {
      // INP-001
      this.setBrush(this.brushPx * Math.exp(-(dy || e.deltaX * unit) * 0.002));
      return;
    }
    const [sx, sy] = this.local(e);
    // CAM-001: pinch arrives as ctrl+wheel with small deltas.
    this.camera.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016)), sx, sy);
    this.dirty = true;
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    const k = e.key;
    if (k === " ") {
      this.space = down;
      document.body.classList.toggle("space", down);
      e.preventDefault();
      return;
    }
    if (k.startsWith("Arrow")) {
      // CAM-003
      if (down) this.arrows.add(k);
      else this.arrows.delete(k);
      e.preventDefault();
      this.dirty = true;
      return;
    }
    if (!down) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (k === "z" || k === "Z")) {
      e.preventDefault();
      return e.shiftKey ? this.redo() : this.undo();
    }
    if (mod && (k === "y" || k === "Y")) {
      e.preventDefault();
      return this.redo();
    }
    if (mod || e.altKey) return;
    const upper = k.toUpperCase();
    const t = TOOLS.find((x) => x.key === upper); // INP-002
    if (t) return this.selectTool(t.id);
    // INP-003 and friends
    switch (k) {
      case "[":
        return this.setBrush(this.brushPx / TUNE.BRUSH_STEP);
      case "]":
        return this.setBrush(this.brushPx * TUNE.BRUSH_STEP);
      case "b":
      case "B":
        return this.toggleBuildings();
      case "o":
      case "O":
        return this.toggleOriginals();
      case "m":
      case "M":
        return this.toggleSound();
      case "h":
      case "H":
      case "?":
        return this.hud.toggleHelp();
      case "f":
      case "F":
        return this.fitArea();
      case "n":
      case "N":
        return this.nextDispute(); // HUD-010
      case "Escape":
        this.hud.toggleHelp(false);
        return;
    }
  }

  // ---------- undo ----------

  private undo() {
    if (this.stroke) return;
    const s = this.history.undo(); // UNDO-001
    if (s) this.settle(s, "before");
    this.syncHistory();
  }
  private redo() {
    if (this.stroke) return;
    const s = this.history.redo(); // UNDO-002
    if (s) this.settle(s, "after");
    this.syncHistory();
  }
  private syncHistory() {
    this.hud.setHistory(this.history.canUndo, this.history.canRedo); // HUD-006
  }

  /** UNDO-004 / FEEL-006 */
  private settle(step: Step, side: "before" | "after") {
    const now = performance.now();
    const r = this.renderer!;
    for (const a of step.atoms) {
      const shown = side === "before" ? a.before : a.after;
      const other = new Set(side === "before" ? a.after : a.before);
      for (const p of shown) {
        if (other.has(p)) continue;
        if (p.kind && p.kind !== "CTX") this.anims.pop(p, now, { short: true, from: r.liftPx(p.kind, this.camera.scale) * 0.3 });
        this.anims.flash({ path: pathOf(p.shape), color: "#fff", cx: 0, cy: 0, mode: "light" }, now, 0, 160);
      }
    }
    this.sound.rewind(side === "after");
    this.updateMix();
    this.dirty = true;
  }

  // ---------- feedback ----------

  private handle(events: StrokeEvent[], cursor: [number, number]) {
    if (!events.length) return;
    const now = performance.now();
    const r = this.renderer!;
    const s = this.camera.scale;
    const claims = events.filter((e) => e.type === "claim").length;
    for (const e of events) {
      // FEEL-002: simultaneous claims ripple outwards from the cursor.
      const delay = claims > 1 ? TUNE.POP_STAGGER * Math.hypot(e.at[0] - cursor[0], e.at[1] - cursor[1]) : 0;
      switch (e.type) {
        case "claim": {
          const path = pathOf(e.region);
          const [cx, cy] = e.at;
          if (e.piece) {
            // FEEL-001: rise from the old height; merged slabs only flash, they don't bounce as a whole.
            // Context settled by a tap (DISP-004) is flat land: it only flashes.
            if (e.piece.kind !== "CTX" && e.piece.area <= area(e.region) * 1.05)
              this.anims.pop(e.piece, now, { from: r.liftPx(e.prevKind, s), delay });
            this.anims.flash({ path, color: "#fff", cx, cy, mode: "light" }, now, delay);
            this.sound.pop(KINDS[e.piece.kind as Kind].pitch, delay);
          } else {
            const color = e.prevKind ? KINDS[e.prevKind].color : "#ddd";
            this.anims.flash({ path, color, cx, cy, mode: "ghost" }, now, delay, TUNE.POP_DURATION);
            this.sound.pop(-9, delay, 0.6);
          }
          break;
        }
        case "tier":
          this.anims.pop(e.piece, now, { from: r.liftPx(e.prevKind, s) });
          this.anims.flash({ path: pathOf(e.piece.shape), color: "#fff", cx: 0, cy: 0, mode: "light" }, now);
          this.sound.pop(KINDS[e.piece.kind as Kind].pitch);
          break;
        case "bump":
          this.anims.hop(e.piece, now); // FEEL-005
          this.sound.bump();
          break;
        case "reject":
          this.anims.shake(now); // FEEL-004
          this.sound.reject();
          break;
      }
    }
    this.updateMix();
    this.dirty = true;
  }

  private updateMix(loaded = false) {
    if (!this.world) return;
    this.hud.updateMix(this.world.mix(), this.world.totalLand);
    // HUD-009 / HUD-011
    const n = this.world.disputed().length;
    if (!loaded && this.disputes > 0 && n === 0) this.hud.toast("The map no longer disagrees with itself anywhere");
    this.disputes = n;
    this.hud.setDisputes(n);
  }

  // ---------- frame loop ----------

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.width = w;
    this.camera.height = h;
    this.renderer?.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
    this.dirty = true;
  }

  private frame(now: number) {
    const dt = Math.min(50, now - this.lastFrame);
    this.lastFrame = now;
    if (this.arrows.size) {
      const v = 0.9; // px per ms
      const ax = (this.arrows.has("ArrowRight") ? 1 : 0) - (this.arrows.has("ArrowLeft") ? 1 : 0);
      const ay = (this.arrows.has("ArrowDown") ? 1 : 0) - (this.arrows.has("ArrowUp") ? 1 : 0);
      this.camera.nudge(ax * v, ay * v);
    }
    const moving = this.camera.update(dt, now);
    // SNAP-105: the freeform preview catches up every frame, time-boxed so a long stroke never stalls one.
    if (this.stroke?.previewPending) {
      this.stroke.updatePreview(PREVIEW_BUDGET_MS);
      this.dirty = true;
    }
    const animating = this.anims.active(now) || !!this.stroke?.preview.size;
    // REN-014: ripples and spikes alone get a slower frame rate.
    const ambientDue = this.ambient && now - this.lastDraw >= TUNE.AMBIENT_INTERVAL;
    // REN-008: draw only when something changed or moves.
    if (this.renderer && this.world && (this.dirty || moving || animating || ambientDue)) {
      this.lastDraw = now;
      this.ambient = this.renderer.draw(
        {
          camera: this.camera,
          stroke: this.stroke,
          tool: this.tool,
          brushPx: this.brushPx,
          cursor: this.cursor,
          hover: this.hover,
          showBuildings: this.showBuildings,
          showOriginals: this.showOriginals,
          anims: this.anims,
          panning: !!this.pan || this.touchLock || this.space,
        },
        now,
      );
      this.badges.place(this.camera);
      this.dirty = false;
    }
    requestAnimationFrame((t) => this.frame(t));
  }
}

