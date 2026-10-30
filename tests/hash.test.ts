import { describe, expect, it } from "vitest";
import { mapHash, osmZoom, parseMapHash, zoomScale } from "../src/geo/project";

describe("map links", () => {
  it("LOAD-019: reads #map=<zoom>/<lat>/<lon> and the older #map=<lat>/<lon>", () => {
    expect(parseMapHash("#map=17/59.42250/24.70900")).toEqual({ zoom: 17, lat: 59.4225, lon: 24.709 });
    expect(parseMapHash("#map=59.42250/24.70900")).toEqual({ zoom: null, lat: 59.4225, lon: 24.709 });
    expect(parseMapHash("#map=17/95/24")).toBe(null);
    expect(parseMapHash("#demo")).toBe(null);
  });

  it("LOAD-019: writes the view as openstreetmap.org links do", () => {
    expect(mapHash(17, 59.4225, 24.709)).toBe("#map=17/59.42250/24.70900");
    expect(mapHash(15.5, 43.65, -79.38)).toBe("#map=15.5/43.65000/-79.38000");
    expect(mapHash(13, 43.65, -79.38)).toBe("#map=13/43.6500/-79.3800");
  });

  it("LOAD-019: zoom levels and pixels per metre convert both ways", () => {
    // OSM zoom 17 at 60° N: about 0.6 m per pixel.
    expect(1 / zoomScale(17, 60)).toBeCloseTo(0.597, 2);
    expect(osmZoom(zoomScale(16.3, 43.7), 43.7)).toBeCloseTo(16.3, 9);
  });
});
