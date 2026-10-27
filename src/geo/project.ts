// Local planar projection (GEN-003): metres, x east, y south (screen-like), centred on the area.
export interface LonLatBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const R = 6378137;
const DEG = Math.PI / 180;

export class Projection {
  readonly kx: number;
  readonly ky: number;
  constructor(readonly lon0: number, readonly lat0: number) {
    this.ky = R * DEG;
    this.kx = R * DEG * Math.cos(lat0 * DEG);
  }
  static centredOn(b: LonLatBounds) {
    return new Projection((b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2);
  }
  x(lon: number) {
    return (lon - this.lon0) * this.kx;
  }
  y(lat: number) {
    return -(lat - this.lat0) * this.ky;
  }
  lon(x: number) {
    return x / this.kx + this.lon0;
  }
  lat(y: number) {
    return -y / this.ky + this.lat0;
  }
}

/** Square bounds of side `sideM` metres centred on a point. */
export function squareAround(lat: number, lon: number, sideM: number): LonLatBounds {
  const dLat = sideM / 2 / (R * DEG);
  const dLon = sideM / 2 / (R * DEG * Math.cos(lat * DEG));
  return { minLon: lon - dLon, minLat: lat - dLat, maxLon: lon + dLon, maxLat: lat + dLat };
}
