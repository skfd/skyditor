// The OSM server the editor reads: its API 0.6 for the map call (LOAD-003) and for checking elements before
// they go out (OUT-008). The editor never writes to it (NG-007).
export const OSM = {
  name: "OpenStreetMap",
  api: "https://api.openstreetmap.org",
  web: "https://www.openstreetmap.org",
} as const;
