// UPL-001 / UPL-002: one changeset on the server: open it, upload the diff, close it.
import type { Server } from "../osm/server";
import { GENERATOR, toOsmChange } from "./osmxml";
import type { Changes } from "./changes";
import type { Fetch } from "./verify";

export const VERSION = "0.1"; // what `created_by` says

export interface Uploaded {
  changeset: number;
  url: string; // the changeset on the server's site
  /** New ids by the placeholder, as `way/-3` -> 123, and new versions by element, as `way/123` -> 2. */
  ids: Map<string, number>;
  versions: Map<string, number>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function changesetXml(tags: Record<string, string>): string {
  const t = Object.entries({ created_by: `${GENERATOR} ${VERSION}`, ...tags })
    .map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`)
    .join("");
  return `<osm><changeset>${t}</changeset></osm>`;
}

/** The API's diffResult: which placeholder became which element, and the new versions. */
export function parseDiffResult(xml: string): Pick<Uploaded, "ids" | "versions"> {
  const ids = new Map<string, number>(), versions = new Map<string, number>();
  for (const m of xml.matchAll(/<(node|way|relation)\b([^>]*)\/?>/g)) {
    const a: Record<string, string> = {};
    for (const x of m[2].matchAll(/([\w:]+)="([^"]*)"/g)) a[x[1]] = x[2];
    const old = Number(a.old_id);
    if (a.new_id === undefined) continue; // deleted
    const id = Number(a.new_id);
    if (old < 0) ids.set(`${m[1]}/${old}`, id);
    if (a.new_version !== undefined) versions.set(`${m[1]}/${id}`, Number(a.new_version));
  }
  return { ids, versions };
}

async function call(fetchFn: Fetch, token: string, method: string, url: string, body?: string): Promise<string> {
  const res = await fetchFn(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "text/xml" } : {}) },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(describe(res.status, text));
  return text;
}

/** UPL-002: why an upload failed, in the user's words. */
function describe(status: number, text: string): string {
  const reason = text.trim().split("\n")[0].slice(0, 160);
  switch (status) {
    case 401:
      return "You are logged out: log in again";
    case 403:
      return "Your account may not write to this server";
    case 409:
      return `Someone changed an element meanwhile: ${reason}`;
    case 410:
      return `An element was deleted meanwhile: ${reason}`;
    case 412:
      return `The server refused the diff: ${reason}`;
    default:
      return `HTTP ${status}${reason ? `: ${reason}` : ""}`;
  }
}

/** UPL-001: opens a changeset with `comment`, uploads the changes and closes it. Throws on failure, changing nothing. */
export async function upload(server: Server, token: string, changes: Changes, comment: string, fetchFn: Fetch = fetch, extraTags: Record<string, string> = {}): Promise<Uploaded> {
  const api = `${server.api}/api/0.6`;
  const id = Number(await call(fetchFn, token, "PUT", `${api}/changeset/create`, changesetXml({ comment, ...extraTags })));
  if (!Number.isFinite(id)) throw new Error("The server gave no changeset id");
  try {
    const result = parseDiffResult(await call(fetchFn, token, "POST", `${api}/changeset/${id}/upload`, toOsmChange(changes, id)));
    return { changeset: id, url: `${server.web}/changeset/${id}`, ...result };
  } finally {
    await call(fetchFn, token, "PUT", `${api}/changeset/${id}/close`).catch(() => undefined);
  }
}
