"""Build analysis-ready inputs from data/raw into data/input.

Run from the repository root (needs pandas, geopandas, pyarrow, shapely 2.1+):

    python3 -I tools/prepare_input.py

Study area: the 14 counties of the Carolinas Regional Explorer (CRE) tract data. Census tracts are the
unit of analysis. Only Mecklenburg County tracts are drawn on the map; every tract of the 14 counties
is a demand point for the accessibility calculations.

Inputs (data/raw)
  cre/total-population.json, population-density-sqmi.json, older-adults.json, median-age.json, household-income.json
                              CRE tract indicators, 2024 (ACS 5-year based)
  cre/acs5-nc-bg-b01001.json, acs5-sc-bg-b01001.json
                              ACS block-group tables; B01001_001E = total population
  cre/tl_2024_{37,45}_{tract,bg}.parquet
                              Census TIGER/Line 2024 boundaries and internal points (NC = 37, SC = 45)
  hospitals-3-geojson.geojson HIFLD hospitals (EPSG:3857)

Outputs (data/input)
  tracts_mecklenburg.geojson  Mecklenburg tract polygons (WGS84, simplified) + 2024 indicators
  tracts_all.csv              all tracts of the 14 counties: geoid, county_fips, pop, lon, lat, basis, int_lon, int_lat
                              (lon/lat = population-weighted centroid of the tract's block groups;
                              int_lon/int_lat = Census internal point, the fallback origin for routing)
  hospitals_input.geojson     hospitals in the 14 counties (WGS84)
  tracts.meta.json            provenance and QA numbers
"""
import csv
import json
import math
import os
from collections import Counter

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

RAW = "data/raw"
CRE = os.path.join(RAW, "cre")
OUT = "data/input"
YEAR = 2024
MECK = "37119"
UTM = "EPSG:32617"  # UTM 17N covers the whole study area
SIMPLIFY_M = 6.0  # coverage simplification tolerance for the map polygons, in metres
DECIMALS = 5  # coordinate precision of the written polygons (about 1 m)

R = 6378137.0


def merc_to_lonlat(x, y):
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return lon, lat


def read_json(path):
    with open(path) as fh:
        return json.load(fh)


def write_json(path, obj, indent=None):
    with open(path, "w") as fh:
        json.dump(obj, fh, separators=(",", ":") if indent is None else None, indent=indent, ensure_ascii=False)


def indicator(name):
    """tract geoid -> value for YEAR from a CRE indicator file."""
    d = read_json(os.path.join(CRE, name))
    assert d["geoLevel"] == "tract", name
    i = d["years"].index(YEAR)
    return {g: (v[i] if isinstance(v[i], (int, float)) else None) for g, v in d["values"].items()}, d


# ---------------------------------------------------------------- tracts
def prepare_tracts():
    pop_t, d_pop = indicator("total-population.json")
    fips = sorted({g[:5] for g in pop_t})
    print(f"study area: {len(pop_t)} tracts in {len(fips)} counties: {', '.join(fips)}")
    assert all(v is not None for v in pop_t.values()), "tract population has missing values"

    tr = pd.concat([gpd.read_parquet(os.path.join(CRE, f"tl_2024_{s}_tract.parquet")) for s in ("37", "45")])
    tr = tr[tr["GEOID"].isin(pop_t)].copy()
    assert len(tr) == len(pop_t), "some CRE tracts are missing in TIGER"
    tr = tr.to_crs("EPSG:4326")

    # ---- block groups: ACS population + Census internal points
    acs = []
    for s in ("nc", "sc"):
        rows = read_json(os.path.join(CRE, f"acs5-{s}-bg-b01001.json"))
        df = pd.DataFrame(rows[1:], columns=rows[0])
        df["GEOID"] = df["GEO_ID"].str.replace("1500000US", "", regex=False)
        acs.append(df[["GEOID", "B01001_001E"]])
    acs = pd.concat(acs)
    acs["bg_pop"] = pd.to_numeric(acs["B01001_001E"], errors="raise")
    assert acs["GEOID"].is_unique

    bg = pd.concat([pd.read_parquet(os.path.join(CRE, f"tl_2024_{s}_bg.parquet"), columns=["GEOID", "INTPTLAT", "INTPTLON"]) for s in ("37", "45")])
    bg = bg[bg["GEOID"].str[:11].isin(pop_t)].merge(acs[["GEOID", "bg_pop"]], on="GEOID", how="left", validate="one_to_one")
    assert bg["bg_pop"].notna().all(), "block groups without an ACS row"
    bg["tract"] = bg["GEOID"].str[:11]
    sums = bg.groupby("tract")["bg_pop"].sum()
    tract_vs_bg = (sums.reindex(list(pop_t)).values - np.array(list(pop_t.values()))).astype(float)
    n_mismatch = int((np.abs(tract_vs_bg) > 0.5).sum())
    print(f"  block groups: {len(bg)}; tracts whose block-group sum differs from the CRE tract total: {n_mismatch}")
    if n_mismatch:
        raise SystemExit("block-group populations do not add up to the CRE tract populations")

    # population-weighted centroid of the block-group internal points, averaged in UTM
    pts = gpd.GeoSeries(gpd.points_from_xy(bg["INTPTLON"].astype(float), bg["INTPTLAT"].astype(float)), crs="EPSG:4269").to_crs(UTM)
    bg["x"], bg["y"] = pts.x.values, pts.y.values
    bg["wx"], bg["wy"] = bg["x"] * bg["bg_pop"], bg["y"] * bg["bg_pop"]
    agg = bg.groupby("tract").agg(w=("bg_pop", "sum"), wx=("wx", "sum"), wy=("wy", "sum"))

    tr = tr.set_index("GEOID")
    own = gpd.GeoSeries(gpd.points_from_xy(tr["INTPTLON"].astype(float), tr["INTPTLAT"].astype(float)), index=tr.index, crs="EPSG:4269").to_crs(UTM)
    rows = []
    for g in pop_t:
        a = agg.loc[g]
        if a["w"] > 0:
            x, y, basis = a["wx"] / a["w"], a["wy"] / a["w"], "pop-weighted block-group internal points"
        else:
            x, y, basis = own[g].x, own[g].y, "tract internal point (zero population)"
        rows.append((g, x, y, basis))
    cen = gpd.GeoSeries(gpd.points_from_xy([r[1] for r in rows], [r[2] for r in rows]), index=[r[0] for r in rows], crs=UTM)
    cen_ll = cen.to_crs("EPSG:4326")
    own_ll = own.to_crs("EPSG:4326")

    poly_utm = tr.geometry.to_crs(UTM)
    inside = cen.reindex(poly_utm.index).within(poly_utm)
    gap = cen.reindex(poly_utm.index).distance(poly_utm)  # 0 for points inside
    moved = cen.reindex(own.index).distance(own)
    print(f"  weighted centroids outside their tract polygon: {int((~inside).sum())} (max distance to the polygon {gap.max():.0f} m)")
    print(f"  weighted centroid vs tract internal point: median {moved.median():.0f} m, max {moved.max():.0f} m")

    out = pd.DataFrame({
        "geoid": [r[0] for r in rows],
        "county_fips": [r[0][:5] for r in rows],
        "pop": [int(pop_t[r[0]]) for r in rows],
        "lon": [round(p.x, 6) for p in cen_ll],
        "lat": [round(p.y, 6) for p in cen_ll],
        "basis": [r[3] for r in rows],
        "int_lon": [round(own_ll[r[0]].x, 6) for r in rows],
        "int_lat": [round(own_ll[r[0]].y, 6) for r in rows],
    }).sort_values("geoid")
    out.to_csv(os.path.join(OUT, "tracts_all.csv"), index=False)
    print(f"  tracts_all.csv: {len(out)} rows, population {int(out['pop'].sum()):,}; zero-population tracts: {int((out['pop'] == 0).sum())}")

    # ---- Mecklenburg polygons for the map
    dens, _ = indicator("population-density-sqmi.json")
    old, _ = indicator("older-adults.json")
    inc, _ = indicator("household-income.json")
    age, _ = indicator("median-age.json")
    m = tr[tr.index.str[:5] == MECK].copy()
    assert len(m) == sum(1 for g in pop_t if g[:5] == MECK)
    m_utm = m.geometry.to_crs(UTM)
    simp = shapely.coverage_simplify(m_utm.values, SIMPLIFY_M)
    simp = gpd.GeoSeries(simp, index=m.index, crs=UTM).to_crs("EPSG:4326")
    area_diff = float((gpd.GeoSeries(simp.values, crs="EPSG:4326").to_crs(UTM).area.sum() / m_utm.area.sum() - 1) * 100)
    feats = []
    for g in sorted(m.index):
        geom = shapely.geometry.mapping(simp[g])
        geom = json.loads(json.dumps(geom), parse_float=lambda s: round(float(s), DECIMALS))
        feats.append({
            "type": "Feature",
            "properties": {
                "id": g,
                "name": "Tract " + str(m.loc[g, "NAME"]),
                "pop": int(pop_t[g]),
                "pop_density": dens.get(g),  # people per square mile
                "older_adult_pct": old.get(g),  # share aged 65+, percent
                "median_age": age.get(g),  # median age, years
                "household_income": inc.get(g),  # median household income, US dollars
            },
            "geometry": geom,
        })
    write_json(os.path.join(OUT, "tracts_mecklenburg.geojson"), {"type": "FeatureCollection", "features": feats})
    kb = os.path.getsize(os.path.join(OUT, "tracts_mecklenburg.geojson")) / 1024
    nulls = {k: sum(f["properties"][k] is None for f in feats) for k in ("pop_density", "older_adult_pct", "median_age", "household_income")}
    print(f"  tracts_mecklenburg.geojson: {len(feats)} polygons, {kb:.0f} KB, area change by simplification {area_diff:+.3f}%, missing values {nulls}")
    print(f"  Mecklenburg population {sum(f['properties']['pop'] for f in feats):,}")
    return {
        "counties": fips,
        "tracts": len(out),
        "population_total": int(out["pop"].sum()),
        "mecklenburg_tracts": len(feats),
        "mecklenburg_population": int(sum(f["properties"]["pop"] for f in feats)),
        "block_groups": int(len(bg)),
        "tract_vs_block_group_sum_mismatches": n_mismatch,
        "centroids_outside_tract_polygon": int((~inside).sum()),
        "centroid_max_distance_to_polygon_m": round(float(gap.max()), 1),
        "centroid_vs_internal_point_median_m": round(float(moved.median()), 1),
        "zero_population_tracts": int((out["pop"] == 0).sum()),
        "polygon_simplify_tolerance_m": SIMPLIFY_M,
        "polygon_area_change_percent": round(area_diff, 4),
        "missing_indicator_values": nulls,
    }, fips


# ---------------------------------------------------------------- hospitals
def prepare_hospitals(fips):
    src = read_json(os.path.join(RAW, "hospitals-3-geojson.geojson"))
    assert src["crs"]["properties"]["name"] == "EPSG:3857", "unexpected CRS"
    keep = set(fips)
    feats, maxdiff = [], 0.0
    for f in src["features"]:
        p = f["properties"]
        if p["COUNTYFIPS"] not in keep:
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
    ids = [f["properties"]["hid"] for f in feats]
    assert len(set(ids)) == len(ids), "duplicate hospital ids"
    pts = [(f["properties"]["name"], f["geometry"]["coordinates"]) for f in feats]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            (n1, (x1, y1)), (n2, (x2, y2)) = pts[i], pts[j]
            d = math.hypot((x1 - x2) * 91000, (y1 - y2) * 111000)
            if n1 == n2 or d < 150:
                print(f"  possible duplicate: {n1!r} / {n2!r} ({d:.0f} m)")
    return {"hospitals": len(feats), "by_type": dict(Counter(f["properties"]["type"] for f in feats))}


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    tract_meta, fips = prepare_tracts()
    hosp_meta = prepare_hospitals(fips)
    write_json(os.path.join(OUT, "tracts.meta.json"), {
        "source": "Carolinas Regional Explorer tract indicators (2024, ACS 5-year based), ACS block-group B01001, "
                  "Census TIGER/Line 2024 boundaries, HIFLD hospitals",
        "year": YEAR,
        "tracts": tract_meta,
        "hospitals": hosp_meta,
    }, indent=2)
    print("wrote tracts.meta.json")
