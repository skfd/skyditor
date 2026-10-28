"""Writes the answer-key squares for the replay benchmark: the careful squares of a run, with their centre,
city and street style. Usage: python replay_squares.py results-2026-10.json.gz work/areas.txt > replay-squares.txt"""
import sys
from report import careful, load, style

rows, _, _ = load(sys.argv[1])
centres = {}
for line in open(sys.argv[2], encoding="utf-8"):
    if line.strip() and not line.startswith("#"):
        name, lat, lon, *_ = line.split()
        centres[name] = (lat, lon)
print("# square lat lon city country style (careful squares, written by replay_squares.py)")
for r in sorted((r for r in rows if careful(r)), key=lambda r: r["name"]):
    lat, lon = centres[r["name"]]
    print(r["name"], lat, lon, r["city"], r["country"], style(r).replace(" ", "_"))
