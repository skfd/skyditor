// @vitest-environment happy-dom
// DEV-001: the test-server page, built with VITE_OSM_SERVER=dev, says what it is and has its own buttons.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// In the DOM environment `URL` is the browser's, so resolve paths through node:url instead.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const demo = readFileSync(resolve(root, "public/fixtures/demo-tallinn.json"), "utf8");
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const until = async (ok: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};

const inert = (): any => new Proxy({}, { get: (_, k) => (k === "getTransform" ? () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) : () => inert()) });
const errors: unknown[] = [];

beforeAll(async () => {
  vi.stubEnv("VITE_OSM_SERVER", "dev");
  vi.stubEnv("VITE_OSM_CLIENT_ID", "");
  HTMLCanvasElement.prototype.getContext = () => inert();
  vi.stubGlobal("Path2D", class { constructor() { return inert(); } });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/user/details")) return new Response(JSON.stringify({ user: { display_name: "tester" } }), { status: 200 });
    return new Response(demo, { status: 200 });
  });
  vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  localStorage.setItem("skyditor.dev.token", "TOKEN"); // AUTH-002: a login kept from last time
  const { App } = await import("../src/app");
  new App();
  await until(() => $("#btn-login")!.textContent!.includes("tester"));
});
afterAll(() => vi.unstubAllEnvs());

describe("the test-server page", () => {
  it("DEV-001: says it is the test server, in the title, the top bar and the start screen", () => {
    expect(errors).toEqual([]);
    expect(document.title).toBe("Skyditor · test server");
    expect($("#server-tag")!.hidden).toBe(false);
    expect($("#server-note")!.hidden).toBe(false);
    expect($("#server-note")!.textContent).toContain("master.apis.dev.openstreetmap.org");
    expect($("#help-note")!.textContent).toContain("test server");
  });

  it("AUTH-001 / AUTH-002: the kept login shows the user, with log out; copy and upload are there", () => {
    expect($("#btn-login")!.hidden).toBe(false);
    expect($("#btn-login")!.textContent).toBe("tester · Log out");
    expect($<HTMLButtonElement>("#btn-seed")!.hidden).toBe(false);
    expect($<HTMLButtonElement>("#btn-seed")!.disabled).toBe(false);
    expect($<HTMLButtonElement>("#btn-upload")!.hidden).toBe(false);
    expect($<HTMLButtonElement>("#btn-upload")!.disabled).toBe(true); // UPL-001: nothing to upload yet
  });

  it("AUTH-001: logging out forgets the token and offers log in", () => {
    $("#btn-login")!.click();
    expect($("#btn-login")!.textContent).toBe("Log in");
    expect(localStorage.getItem("skyditor.dev.token")).toBeNull();
    expect($<HTMLButtonElement>("#btn-seed")!.disabled).toBe(true);
  });

  it("AUTH-003: with no application registered, log in says so", async () => {
    $("#btn-login")!.click();
    await until(() => ($("#toast")!.textContent ?? "").includes("no application"));
    expect($("#toast")!.textContent).toContain("no application registered");
  });
});
