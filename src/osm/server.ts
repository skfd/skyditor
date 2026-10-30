// DEV-001: which OSM server this page is built for. The main page reads the main database and never writes to it
// (NG-007); the test-server page reads and writes the test server, which has its own accounts and data.
export interface Server {
  readonly id: "main" | "dev";
  readonly name: string; // what the user sees
  readonly api: string; // API 0.6 base, no trailing slash
  readonly web: string; // element links, changeset links
  readonly clientId: string; // AUTH-001: the OAuth 2 application registered for this page, "" when there is none
  readonly writes: boolean; // UPL-001 / SEED-001: whether this page uploads
}

const MAIN: Server = {
  id: "main",
  name: "OpenStreetMap",
  api: "https://api.openstreetmap.org",
  web: "https://www.openstreetmap.org",
  clientId: "",
  writes: false,
};

const DEV: Server = {
  id: "dev",
  name: "the OSM test server",
  api: "https://master.apis.dev.openstreetmap.org",
  web: "https://master.apis.dev.openstreetmap.org",
  clientId: import.meta.env?.VITE_OSM_CLIENT_ID ?? "",
  writes: true,
};

export const SERVERS = { main: MAIN, dev: DEV };

/** The server this build targets: `VITE_OSM_SERVER=dev` makes the test-server page. */
export const SERVER: Server = import.meta.env?.VITE_OSM_SERVER === "dev" ? DEV : MAIN;
