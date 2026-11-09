"""Build analysis-ready inputs from data/raw into data/input.

Run from the repository root:  python3 -I tools/prepare_input.py

Outputs
  data/input/hospitals_input.geojson   hospitals in Mecklenburg + adjacent counties (WGS84)
  data/input/npa_input.geojson         459 NPA polygons + joined attributes (WGS84)
  data/input/npa_input.csv             same attributes, no geometry
"""
import csv
import json
import math
import os
from collections import Counter

RAW = "data/raw"
OUT = "data/input"

# Mecklenburg County, NC plus counties adjacent to it. Adjacency is taken from
# general knowledge, NOT computed from county polygons (no county boundary file
# was available). Verify with Queen contiguity on Census TIGER county boundaries.
REGION = {
    "37119": "Mecklenburg, NC",
    "37025": "Cabarrus, NC",
    "37071": "Gaston, NC",
    "37097": "Iredell, NC",
    "37109": "Lincoln, NC",
    "37179": "Union, NC",
    "45057": "Lancaster, SC",
    "45091": "York, SC",
}

NPA_FILES = {
    "age": "Age of Residents.geojson",
    "income": "Household Income.geojson",
    "older": "Population - Older Adult.geojson",
    "density": "Population Density.geojson",
}

R = 6378137.0


def merc_to_lonlat(x, y):
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return lon, lat


def load(name):
    with open(os.path.join(RAW, name)) as fh:
        return json.load(fh)


def write_json(path, obj):
    with open(path, "w") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)


def num(v):
    """None for non-numeric; keep ints/floats as they are."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def prepare_hospitals():
    src = load("hospitals-3-geojson.geojson")
    assert src["crs"]["properties"]["name"] == "EPSG:3857", "unexpected CRS"
    feats, maxdiff = [], 0.0
    for f in src["features"]:
        p = f["properties"]
        if p["COUNTYFIPS"] not in REGION:
            continue
        lon, lat = merc_to_lonlat(*f["geometry"]["coordinates"])
        maxdiff = max(maxdiff, abs(lon - p["LONGITUDE"]), abs(lat - p["LATITUDE"]))
        beds = p["BEDS"] if isinstance(p["BEDS"], (int, float)) and p["BEDS"] >= 0 else None
        feats.append({
            "type": "Feature",
            "properties": {
                "hid": p["ID"],
                "name": p["NAME"],
                "address": p["ADDRESS"],
                "city": p["CITY"],
                "state": p["STATE"],
                "zip": p["ZIP"],
                "county": p["COUNTY"],
                "county_fips": p["COUNTYFIPS"],
                "type": p["TYPE"],
                "status": p["STATUS"],
                "beds": beds,  # -999 (missing) -> null
                "trauma": p["TRAUMA"],
                "helipad": p["HELIPAD"],
                "owner": p["OWNER"],
                "source_date": p["SOURCEDATE"],
            },
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        })
    feats.sort(key=lambda f: (f["properties"]["county_fips"], f["properties"]["name"]))
    write_json(os.path.join(OUT, "hospitals_input.geojson"), {"type": "FeatureCollection", "features": feats})

    print(f"hospitals: {len(feats)} written (max |mercator->lonlat - LON/LAT fields| = {maxdiff:.2e} deg)")
    print("  by county:", dict(Counter(f["properties"]["county"] for f in feats)))
    print("  by status:", dict(Counter(f["properties"]["status"] for f in feats)))
    print("  by type:  ", dict(Counter(f["properties"]["type"] for f in feats)))
    print("  beds missing:", sum(f["properties"]["beds"] is None for f in feats))
    # potential duplicates: same name or < 150 m apart (reported, not removed)
    pts = [(f["properties"]["name"], f["properties"]["status"], f["geometry"]["coordinates"]) for f in feats]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            (n1, s1, (x1, y1)), (n2, s2, (x2, y2)) = pts[i], pts[j]
            d = math.hypot((x1 - x2) * 91000, (y1 - y2) * 111000)
            if n1 == n2 or d < 150:
                print(f"  possible duplicate: {n1!r} / {n2!r} ({d:.0f} m)")


def prepare_npa():
    d = {k: load(v) for k, v in NPA_FILES.items()}
    base = d["density"]["features"]
    ids = [f["properties"]["id"] for f in base]
    for k, fc in d.items():
        assert [f["properties"]["id"] for f in fc["features"]] == ids, f"id order differs: {k}"
        assert [f["geometry"] for f in fc["features"]] == [f["geometry"] for f in base], f"geometry differs: {k}"

    years = [y for y in (k for k in base[0]["properties"] if k.isdigit())]
    cols = ["id", "npa_name"]
    cols += [f"pop_density_{y}" for y in years]  # people per acre
    cols += [f"pop_{y}" for y in years]  # population count (from '<year>-raw')
    cols += ["older_adult_pct_2024", "household_income_2024", "age_residents_2024"]

    rows, feats = [], []
    for i, bf in enumerate(base):
        pid = ids[i]
        dp = bf["properties"]
        row = {"id": pid, "npa_name": f"NPA {pid}"}
        for y in years:
            row[f"pop_density_{y}"] = num(dp.get(y))
            row[f"pop_{y}"] = num(dp.get(f"{y}-raw"))
        row["older_adult_pct_2024"] = num(d["older"]["features"][i]["properties"].get("2024"))
        row["household_income_2024"] = num(d["income"]["features"][i]["properties"].get("2024"))
        row["age_residents_2024"] = num(d["age"]["features"][i]["properties"].get("2024"))
        rows.append(row)
        feats.append({"type": "Feature", "properties": row, "geometry": bf["geometry"]})

    write_json(os.path.join(OUT, "npa_input.geojson"), {"type": "FeatureCollection", "features": feats})
    with open(os.path.join(OUT, "npa_input.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    print(f"npa: {len(rows)} rows x {len(cols)} columns written")
    for c in cols[2:]:
        print(f"  {c:24s} null={sum(r[c] is None for r in rows)}")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    prepare_hospitals()
    prepare_npa()
