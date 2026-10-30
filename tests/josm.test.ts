import { describe, expect, it } from "vitest";
import { JOSM, JosmError, URL_MAX, josmListens, loadDataUrl, sendToJosm } from "../src/output/josm";

const answer = (status: number, body = "") => new Response(body, { status });
const stub = (handler: (url: string) => Response | Promise<Response>) => {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return handler(url);
  };
  return { f, calls };
};

describe("JOSM remote control", () => {
  it("JOSM-001: the data goes in the address of load_data, into a new layer named after the place", () => {
    const url = loadDataUrl(`<osm version="0.6"><node id="-1" lat="1" lon="2"/></osm>`, "Skyditor · Tallinn");
    expect(url.startsWith(`${JOSM}/load_data?`)).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("new_layer")).toBe("true");
    expect(q.get("layer_name")).toBe("Skyditor · Tallinn");
    expect(q.get("data")).toContain(`<node id="-1" lat="1" lon="2"/>`);
    expect(url).not.toContain("<"); // encoded, with &, = and ? as JOSM asks
  });

  it("JOSM-001: JOSM is asked for its version first, and must speak protocol 1", async () => {
    const yes = stub(() => answer(200, `{"protocolversion":{"major":1,"minor":12},"application":"JOSM RemoteControl"}`));
    expect(await josmListens(yes.f)).toBe(true);
    const old = stub(() => answer(200, `{"protocolversion":{"major":2,"minor":0}}`));
    expect(await josmListens(old.f)).toBe(false);
    const down = stub(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await josmListens(down.f)).toBe(false);
  });

  it("JOSM-001: sending checks the version, then loads the data", async () => {
    const s = stub((url) => answer(200, url.includes("/version") ? `{"protocolversion":{"major":1,"minor":12}}` : "OK"));
    await sendToJosm("<osm/>", "L", s.f);
    expect(s.calls.length).toBe(2);
    expect(s.calls[0]).toBe(`${JOSM}/version`);
    expect(s.calls[1]).toContain("/load_data?");
  });

  it("JOSM-002: when JOSM does not answer, the error says how to turn Remote Control on and offers the file", async () => {
    const s = stub(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(sendToJosm("<osm/>", "L", s.f)).rejects.toThrow(/Remote Control.*save the file/i);
  });

  it("JOSM-002: a refusal by JOSM says which permission it needs", async () => {
    const s = stub((url) => (url.includes("/version") ? answer(200, `{"protocolversion":{"major":1,"minor":12}}`) : answer(403)));
    await expect(sendToJosm("<osm/>", "L", s.f)).rejects.toThrow(/Import data from URL/);
  });

  it("JOSM-002: a file too big for the address goes as a file instead", async () => {
    const s = stub(() => answer(200, `{"protocolversion":{"major":1,"minor":12}}`));
    const err = await sendToJosm("x".repeat(URL_MAX), "L", s.f).catch((e) => e as JosmError);
    expect(err).toBeInstanceOf(JosmError);
    expect((err as JosmError).tooBig).toBe(true);
    expect(s.calls).toEqual([]);
  });
});
