// @vitest-environment happy-dom
// Smoke test: the app mounts into index.html with its controls in place, then loads the demo area without
// a network or a real canvas. This is the test that notices when the page itself breaks.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// In the DOM environment `URL` is the browser's, so resolve paths through node:url instead.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const demo = readFileSync(resolve(root, "public/fixtures/demo-tallinn.json"), "utf8");

/** An object on which every method is a no-op and every property can be set: enough for drawing calls. */
const inert = (): object =>
  new Proxy(Object.create(null), {
    // getTransform answers with the identity, as a fresh context's would: the renderer reads the matrix back.
    get: (_, key) => (key === "then" ? undefined : key === "getTransform" ? () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) : () => undefined),
    set: () => true,
  });

const errors: unknown[] = [];

beforeAll(() => {
  // happy-dom has no canvas drawing and no Path2D; the renderer only needs them to accept calls.
  HTMLCanvasElement.prototype.getContext = (() => inert()) as never;
  vi.stubGlobal("Path2D", class { constructor() { return inert(); } });
  // LOAD-001: the demo is bundled, not fetched over the network.
  vi.stubGlobal("fetch", async () => new Response(demo));
  vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
  // The page body as served, minus the module script (the test constructs the app itself).
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/, "");
});

afterAll(() => vi.restoreAllMocks());

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

const until = async (ok: () => boolean, ms = 30_000) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("the app mounts", () => {
  it("starts without errors and shows the start screen", async () => {
    const { App } = await import("../src/app");
    new App();
    expect(errors).toEqual([]);
    expect($("#start")!.classList.contains("show")).toBe(true);
  });

  it("HUD-001 / KIND-001 / DENS-001 / TYPE-007 / KIND-007 / CAP-001 / NAME-007: the palette has the ladder, the business kinds, density, agree, the eraser and capture, and no mixed", () => {
    const tiles = $$("#palette button.tile");
    expect(tiles.map((t) => t.dataset.tool)).toEqual([
      "R1", "R2", "R3", "R4", "R5", "R6", "COM", "RET", "IND", "UP", "DOWN", "AGREE", "ERASE", "CAPTURE",
    ]);
    expect(tiles.map((t) => t.querySelector(".key")?.textContent)).toEqual([
      "1", "2", "3", "4", "5", "6", "Q", "W", "E", "A", "Z", "G", "X", "C",
    ]);
    // KIND-002: the six tiers sit together as one ladder.
    expect($$("#palette .ladder button.tile")).toHaveLength(6);
    for (const t of tiles) expect(t.innerHTML, `${t.dataset.tool} has an icon`).toContain("<svg");
  });

  it("HUD-006: the map controls are there, with undo and redo disabled while there is nothing to undo", () => {
    for (const id of ["undo", "redo", "zoom-in", "zoom-out", "fit", "brush-up", "brush-down"]) {
      const b = $<HTMLButtonElement>(`#btn-${id}`);
      expect(b, id).not.toBeNull();
      expect(b!.innerHTML.length, `${id} has an icon`).toBeGreaterThan(0);
    }
    expect($<HTMLButtonElement>("#btn-undo")!.disabled).toBe(true);
    expect($<HTMLButtonElement>("#btn-redo")!.disabled).toBe(true);
  });

  it("HUD-007 / TYPE-006: the layer toggles and the target switch show their state", () => {
    expect($("#btn-buildings")!.getAttribute("aria-pressed")).toBe("true");
    expect($("#btn-outlines")!.getAttribute("aria-pressed")).toBe("false");
    expect($("#btn-target")!.getAttribute("aria-pressed")).toBe("false");
    expect($("#btn-target")!.innerHTML).toContain("<svg");
  });

  it("PEEK-001 / PEEK-003: the peek buttons are there, off, and the photo panel and imagery credit are hidden", () => {
    for (const id of ["imagery", "photos"]) {
      const b = $(`#btn-${id}`)!;
      expect(b.getAttribute("aria-pressed")).toBe("false");
      expect(b.innerHTML, `${id} has an icon`).toContain("<svg");
    }
    expect($("#photo")!.hidden).toBe(true);
    expect($("#imagery-credit")!.hidden).toBe(true);
  });

  it("HUD-005: the OSM attribution is on the page", () => {
    expect($("#attribution")!.textContent).toContain("OpenStreetMap contributors");
  });

  it("JOSM-001 / JOSM-003 / HUD-008: the JOSM and save buttons are there, disabled while there is nothing to send, and in the help", () => {
    const josm = $<HTMLButtonElement>("#btn-josm")!, save = $<HTMLButtonElement>("#btn-save")!;
    expect(josm.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    expect(josm.title).toContain("(K)");
    expect($("#help")!.textContent).toContain("JOSM");
    expect($("#help")!.textContent).not.toContain("toy");
    // NG-007 / DEV-001: no upload, copy or login on the main page.
    for (const id of ["btn-upload", "btn-seed", "btn-login", "server-tag"]) expect($(`#${id}`)!.hidden).toBe(true);
  });
});

describe("the demo loads", () => {
  it("LOAD-001 / HUD-003: pressing the demo button loads the area and fills the district mix", async () => {
    $<HTMLButtonElement>("#btn-demo")!.click();
    await until(() => ($("#place")!.textContent ?? "").includes("Tallinn"));
    expect(errors).toEqual([]);
    expect($("#toast")!.textContent).toMatch(/\d+ blocks/);
    const segs = $$("#mix .bar > *");
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.some((s) => parseFloat(s.style.width || s.style.flexGrow || "0") > 0)).toBe(true);
    // TYPE-012: the demo has plenty of `building=yes`, so the to-decide count shows.
    const todo = $<HTMLButtonElement>("#btn-guesses")!;
    expect(todo.hidden).toBe(false);
    expect(Number(todo.dataset.n)).toBeGreaterThan(0);
  }, 60_000);

  it("CAP-001 / CAP-006: `C` picks the capture tool; an arrow called off with the other button or Escape changes nothing", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    expect($('#palette button.tile[data-tool="CAPTURE"]')!.classList.contains("on")).toBe(true);
    const map = $<HTMLCanvasElement>("#map")!;
    const pointer = (type: string, x: number, y: number, button = 0) =>
      map.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button, pointerId: 1, pointerType: "mouse", bubbles: true }));
    const [cx, cy] = [window.innerWidth / 2, window.innerHeight / 2];
    pointer("pointerdown", cx, cy);
    pointer("pointermove", cx + 80, cy);
    pointer("pointerdown", cx + 80, cy, 2);
    pointer("pointerup", cx + 80, cy, 2);
    pointer("pointerdown", cx, cy);
    pointer("pointermove", cx, cy + 80);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    pointer("pointerup", cx, cy + 80);
    expect($<HTMLButtonElement>("#btn-undo")!.disabled).toBe(true);
    expect(errors).toEqual([]);
  });
});
