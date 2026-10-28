"""Writes an osmium extract config for every area in areas.txt, so one pass over the planet cuts them all.

    python extracts.py areas.txt > extracts.json
    osmium extract -c extracts.json -s smart -d extracts/ planet.osm.pbf
"""
import json, math, sys

HALF = 350  # m; the analysis uses the central 300 m around the centre, the rest is context
out = []
for line in open(sys.argv[1]):
    f = line.split("#")[0].split()
    if len(f) != 3:
        continue
    name, lat, lon = f[0], float(f[1]), float(f[2])
    dlat = HALF / 110574
    dlon = HALF / (111320 * math.cos(math.radians(lat)))
    out.append({"output": f"{name}.osm", "output_format": "xml", "bbox": [lon - dlon, lat - dlat, lon + dlon, lat + dlat]})
json.dump({"extracts": out}, sys.stdout, indent=1)
