import { describe, expect, it } from "vitest";
import { Projection } from "../src/geo/project";
import { IMAGERY, tileAt, tileBounds, tileZoom } from "../src/osm/imagery";
import { type Photo, bestPhoto, photoLinks } from "../src/osm/photos";
import { TUNE } from "../src/tuning";

describe("imagery tiles", () => {
  it("PEEK-001: a tile's bounds round-trip through the tile maths, and a point lands in its own tile", () => {
    const [x, y] = tileAt(24.7, 59.42, 17);
    const b = tileBounds(Math.floor(x), Math.floor(y), 17);
    expect(b.minLon).toBeLessThanOrEqual(24.7);
    expect(b.maxLon).toBeGreaterThan(24.7);
    expect(b.minLat).toBeLessThanOrEqual(59.42);
    expect(b.maxLat).toBeGreaterThan(59.42);
    const [x2, y2] = tileAt(b.minLon, b.maxLat, 17);
    expect(x2).toBeCloseTo(Math.floor(x), 6);
    expect(y2).toBeCloseTo(Math.floor(y), 6);
  });

  it("PEEK-001: the tile zoom keeps a tile pixel no larger than a screen pixel, within the source's range", () => {
    expect(tileZoom(TUNE.ZOOM_MAX, 59.4)).toBe(IMAGERY.maxZoom);
    expect(tileZoom(TUNE.ZOOM_MIN, 59.4)).toBeGreaterThanOrEqual(IMAGERY.minZoom);
    const z = tileZoom(1, 59.4); // 1 px per metre
    const metresPerTilePx = (40075016.686 * Math.cos((59.4 * Math.PI) / 180)) / 256 / 2 ** z;
    expect(metresPerTilePx).toBeLessThanOrEqual(1);
    expect(tileZoom(1, 59.4, 2)).toBe(z + 1); // a sharper screen wants the next zoom
  });

  it("PEEK-002: imagery comes from Esri, with its attribution", () => {
    expect(IMAGERY.url(17, 74287, 37562)).toMatch(/^https:\/\/server\.arcgisonline\.com\//);
    expect(IMAGERY.attribution).toContain("Esri");
  });
});

describe("street photos", () => {
  const proj = new Projection(24.7, 59.42);
  const photo = (id: string, x: number, y: number, azimuth: number | null): Photo => ({
    id, provider: "Panoramax", lon: proj.lon(x), lat: proj.lat(y), azimuth, thumb: "t", sd: "s", date: "2025-05-05T06:35:15Z", url: `u/${id}`,
  });

  it("PEEK-003: the photo that faces the building beats a nearer one looking away", () => {
    // The building is at the origin. One camera 20 m south looking north (azimuth 0): straight at it.
    // Another 10 m east looking east (90): away from it, which is 90° off.
    const facing = photo("facing", 0, 20, 0);
    const nearer = photo("nearer", 10, 0, 90);
    const best = bestPhoto([nearer, facing], proj, 0, 0)!;
    expect(best.photo.id).toBe("facing");
    expect(best.distance).toBeCloseTo(20, 3);
  });

  it("PEEK-003: with no direction known a photo still counts, as if half turned away", () => {
    const unknown = photo("unknown", 0, 10, null);
    const far = photo("far", 0, 60, 0);
    expect(bestPhoto([far, unknown], proj, 0, 0)!.photo.id).toBe("unknown");
    const close = photo("close", 0, 10, 0); // 10 m south of the spot (y points south), looking north: right at it
    expect(bestPhoto([unknown, close], proj, 0, 0)!.photo.id).toBe("close");
  });

  it("PEEK-004: nothing within the radius means no photo, and the links still point at the spot", () => {
    const far = photo("far", 0, TUNE.PHOTO_RADIUS + 1, 0);
    expect(bestPhoto([far], proj, 0, 0)).toBeNull();
    const links = photoLinks(59.42, 24.7);
    expect(links.map((l) => l.name)).toEqual(["Panoramax", "Mapillary", "KartaView"]);
    for (const l of links) expect(l.url, l.name).toMatch(/59\.42/);
    for (const l of links) expect(l.url, l.name).toMatch(/24\.7/);
    expect(photoLinks(59.42, 24.7, far)[0].url).toBe("u/far");
  });

  it("PEEK-002: no link goes to Google", () => {
    for (const l of photoLinks(59.42, 24.7)) expect(l.url).not.toMatch(/google/);
  });
});
