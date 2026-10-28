import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { replay } from "../bench/replay/run";

// One answer-key square from the 44-city run (research/landuse-edges/replay-squares.txt), so the replay
// benchmark keeps running as the editor changes. The full run is `npm run replay`.
const text = gunzipSync(readFileSync(new URL("./fixtures/replay-turku_4_0.osm.gz", import.meta.url))).toString("utf8");
const meta = { name: "turku_4_0", lat: 60.4518, lon: 22.179165, style: "property_line" };

describe("replay benchmark", () => {
  it("paints every truth polygon of a square and scores the result against it", () => {
    const { result: r, svg } = replay(text, meta, undefined, true);
    const s = r.score;
    expect(r.truths).toBeGreaterThan(0);
    expect(r.strokes).toBeGreaterThanOrEqual(r.truths);
    expect(s.truth_m2).toBeGreaterThan(10_000);
    // A rough stroke inside every truth polygon gets most of it, and little else.
    const iou = s.overlap_m2 / (s.truth_m2 + s.result_m2 - s.overlap_m2);
    expect(iou).toBeGreaterThan(0.7);
    // The yardsticks see the same buildings on both sides.
    expect(s.result.buildings.touching).toBeGreaterThan(0);
    expect(Math.abs(s.result.buildings.touching - s.truth.buildings.touching)).toBeLessThan(0.2 * s.truth.buildings.touching);
    expect(svg).toContain("<svg");
  }, 60_000);
});
