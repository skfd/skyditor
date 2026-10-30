// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { SCOPES, authorizeUrl, challengeFor, finishLogin, forgetToken, savedToken } from "../src/osm/auth";
import { SERVERS } from "../src/osm/server";

const DEV = { ...SERVERS.dev, clientId: "abc123" };

describe("logging in", () => {
  it("AUTH-001: the challenge is the S256 of the verifier (RFC 7636's example)", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("AUTH-001: the authorization request names the app, the page, the scopes and the challenge", () => {
    const u = new URL(authorizeUrl(DEV, "CH", "ST", "https://example.org/skyditor/dev/"));
    expect(u.origin + u.pathname).toBe("https://master.apis.dev.openstreetmap.org/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("abc123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://example.org/skyditor/dev/");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe(SCOPES);
    expect(SCOPES).toContain("write_api");
    expect(u.searchParams.get("state")).toBe("ST");
    expect(u.searchParams.get("code_challenge")).toBe("CH");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("AUTH-001 / AUTH-002: on return, the code and the kept verifier buy a token, which is remembered, and the address is restored", async () => {
    sessionStorage.setItem("skyditor.login", JSON.stringify({ verifier: "VER", state: "ST", hash: "#map=17/59.43/24.74" }));
    history.replaceState(null, "", "/skyditor/dev/?code=CODE&state=ST");
    const calls: { url: string; body: string }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ access_token: "TOKEN", token_type: "Bearer" }), { status: 200 });
    }) as typeof fetch;
    expect(await finishLogin(DEV, f)).toBe("TOKEN");
    expect(calls[0].url).toBe("https://master.apis.dev.openstreetmap.org/oauth2/token");
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("code_verifier")).toBe("VER");
    expect(body.get("client_id")).toBe("abc123");
    expect(body.get("client_secret")).toBeNull();
    expect(savedToken(DEV)).toBe("TOKEN");
    expect(location.search).toBe("");
    expect(location.hash).toBe("#map=17/59.43/24.74");
    forgetToken(DEV);
    expect(savedToken(DEV)).toBeNull();
  });

  it("AUTH-001: a return whose state is not the one kept is refused", async () => {
    sessionStorage.setItem("skyditor.login", JSON.stringify({ verifier: "VER", state: "ST", hash: "" }));
    history.replaceState(null, "", "/skyditor/dev/?code=CODE&state=OTHER");
    await expect(finishLogin(DEV, (async () => new Response("")) as typeof fetch)).rejects.toThrow(/try again/);
  });

  it("AUTH-001: a page that is not a return does nothing", async () => {
    history.replaceState(null, "", "/skyditor/dev/#demo");
    expect(await finishLogin(DEV, (async () => new Response("")) as typeof fetch)).toBeNull();
  });
});
