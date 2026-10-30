// JOSM-001 / JOSM-002: the changes go to JOSM through its remote control on this computer. Browsers let an
// https page call plain http on 127.0.0.1, as openstreetmap.org's own "Edit with Remote Control" does; `localhost`
// would be blocked, and Safari blocks both.
import type { Fetch } from "./verify";

export const JOSM = "http://127.0.0.1:8111";
/** A URL longer than this is not worth trying: browsers cap the address, and JOSM reads the whole data from it. */
export const URL_MAX = 1_500_000;

export class JosmError extends Error {
  constructor(message: string, readonly tooBig = false) {
    super(message);
  }
}

/** The remote control `load_data` call: the file in the address, as JOSM documents it (GET only). */
export function loadDataUrl(xml: string, layerName: string): string {
  const q = new URLSearchParams({ new_layer: "true", layer_name: layerName, data: xml });
  return `${JOSM}/load_data?${q}`;
}

/** Whether JOSM answers, with a remote control of the protocol this code speaks. */
export async function josmListens(fetchFn: Fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${JOSM}/version`);
    if (!res.ok) return false;
    const v = (await res.json()) as { protocolversion?: { major?: number } };
    return v.protocolversion?.major === 1;
  } catch {
    return false;
  }
}

/** JOSM-001: sends the file to JOSM as a new layer. Throws a JosmError saying what to do when it cannot. */
export async function sendToJosm(xml: string, layerName: string, fetchFn: Fetch = fetch): Promise<void> {
  const url = loadDataUrl(xml, layerName);
  if (url.length > URL_MAX) throw new JosmError("Too many changes to hand to JOSM at once: save the file and open it in JOSM.", true);
  if (!(await josmListens(fetchFn)))
    throw new JosmError("JOSM did not answer. Start JOSM and turn on Remote Control (Preferences → Remote Control), or save the file instead.");
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch {
    throw new JosmError("JOSM stopped answering. Save the file instead.");
  }
  if (!res.ok) throw new JosmError(`JOSM refused the data (HTTP ${res.status}). Allow "Import data from URL" in its Remote Control preferences, or save the file.`);
}
