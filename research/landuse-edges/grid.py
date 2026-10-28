"""Cuts a grid of sample squares around every city in cities.txt and extracts them from regional PBFs.

    python grid.py cities.txt work/            # writes work/areas.txt and work/squares/<city>_<r>_<c>.osm.gz

Each city gets N x N squares (default 9) whose centres are SPACING m apart (default 1200), so the grid
reaches from the centre to the suburbs. Each square is 700 m wide; analyze.py uses its central 600 m.
Regions come from the osm-extracts store (osm_extracts.py path <region>); osmium runs in docker, one
pass per region file cuts each city's bbox, then the squares are cut from the small city files,
renumbered first so osmium's id sets stay small. The smart
strategy keeps multipolygons crossing a square's edge complete.
"""
import argparse, json, math, os, subprocess, sys
from pathlib import Path

HALF = 350
IMAGE = os.environ.get("OSM_EXTRACTS_OSMIUM_IMAGE") or "name-ru-repair-osmium"
TOOL = os.environ.get("OSM_EXTRACTS_TOOL") or str(Path.home() / "Code" / "osm-extracts" / "osm_extracts.py")


def bbox(lat, lon, half):
    dlat = half / 110574
    dlon = half / (111320 * math.cos(math.radians(lat)))
    return [lon - dlon, lat - dlat, lon + dlon, lat + dlat]


def cities(path):
    for line in open(path):
        f = line.split("#")[0].split()
        if len(f) == 5:
            yield f[0], f[1], f[2], float(f[3]), float(f[4])


def region_file(region, here):
    p = here / region
    if region.endswith(".pbf"):
        return p.resolve()
    out = subprocess.run([sys.executable, TOOL, "path", region], capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(out.stderr.strip())
    return Path(out.stdout.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cities")
    ap.add_argument("work")
    ap.add_argument("-n", type=int, default=9)
    ap.add_argument("--spacing", type=float, default=1200)
    ap.add_argument("--only", nargs="*", help="cities to (re)extract")
    a = ap.parse_args()
    here = Path(a.cities).resolve().parent
    work = Path(a.work).resolve()
    (work / "squares").mkdir(parents=True, exist_ok=True)
    by_region, rows = {}, []
    k = (a.n - 1) / 2
    for name, country, region, lat, lon in cities(a.cities):
        for r in range(a.n):
            for c in range(a.n):
                dy, dx = (k - r) * a.spacing, (c - k) * a.spacing
                slat = lat + dy / 110574
                slon = lon + dx / (111320 * math.cos(math.radians(lat)))
                sq = f"{name}_{r}_{c}"
                rows.append(f"{sq} {slat:.6f} {slon:.6f} {name} {country}")
                if not a.only or name in a.only:
                    by_region.setdefault(region, {}).setdefault(name, (lat, lon, []))[2].append(
                        {"output": f"{sq}.osm.gz", "output_format": "osm.gz", "bbox": bbox(slat, slon, HALF)})
    (work / "areas.txt").write_text("# square lat lon city country (written by grid.py)\n" + "\n".join(rows) + "\n")
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    osmium = lambda mounts, *args: subprocess.run(["docker", "run", "--rm", *mounts, IMAGE, *args], check=True, env=env)
    (work / "cities").mkdir(exist_ok=True)
    for region, group in by_region.items():
        # Pass 1: one bbox per city out of the region file.
        src = region_file(region, here)
        cfg = work / "cities" / f"{Path(region).name.split('.')[0]}.json"
        cfg.write_text(json.dumps({"extracts": [
            {"output": f"{city}.osm.pbf", "bbox": bbox(lat, lon, k * a.spacing + HALF + 500)} for city, (lat, lon, _) in group.items()]}))
        print(f"{region}: {', '.join(group)} from {src.name}", flush=True)
        osmium(["-v", f"{src.parent}:/in:ro", "-v", f"{work}:/w"],
               "extract", "-s", "smart", "-c", f"/w/cities/{cfg.name}", "-d", "/w/cities", f"/in/{src.name}", "--overwrite")
        # Pass 2: renumber each city file, then cut its squares. Each extract keeps id sets sized by the spread
        # of the ids it sees, about a gigabyte with planet ids; dense ids from renumber make them tiny.
        for city, (_, _, ex) in group.items():
            osmium(["-v", f"{work}:/w"], "renumber", f"/w/cities/{city}.osm.pbf", "-o", f"/w/cities/{city}.dense.osm.pbf",
                   "--overwrite")
            cfg = work / "cities" / f"{city}-squares.json"
            cfg.write_text(json.dumps({"extracts": ex}))
            osmium(["-v", f"{work}:/w"], "extract", "-s", "smart", "-c", f"/w/cities/{cfg.name}", "-d", "/w/squares",
                   f"/w/cities/{city}.dense.osm.pbf", "--overwrite")
            print(f"  {city}: {len(ex)} squares", flush=True)

if __name__ == "__main__":
    main()
