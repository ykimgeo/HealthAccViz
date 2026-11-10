"""Build the NPA-to-hospital OD matrix (car driving) with r5py and OSM data.

Steps
  1. Download the North Carolina and South Carolina OSM extracts from Geofabrik.
  2. Clip each extract to the study area (NPAs + all hospitals + buffer) and merge.
  3. Route from every NPA centroid to every hospital with r5py (car mode):
       - travel time           TravelTimeMatrix
       - network distance      DetailedItineraries (sum of leg distances)
  4. Add Euclidean distance (UTM 17N, EPSG:32617) and write the CSV + a metadata file.

Run from the repository root, inside the conda env from environment.yml:

    python tools/build_od_matrix.py --limit-npa 5      # quick smoke test first
    python tools/build_od_matrix.py                    # full run

Outputs
    data/input/od_matrix.csv        npa_id, hid, euclid_km, network_km, network_min
    data/input/od_matrix.meta.json  provenance (OSM file dates, versions, settings, QA)

Notes
  * Travel time is free-flow driving time from OSM speed limits / road-class
    defaults used by R5. It does not include traffic, signals or parking.
  * Routes run from the NPA centroid to the hospital, so one-way streets and
    turn restrictions apply in that direction only.
  * r5py snaps origins and destinations to the nearest street.
  * Geofabrik extracts are large; they are stored in --workdir (build/), which
    is git-ignored. Only the OD matrix and its metadata are committed.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

import geopandas as gpd
import numpy as np
import pandas as pd

GEOFABRIK = {
    "nc": "https://download.geofabrik.de/north-america/us/north-carolina-latest.osm.pbf",
    "sc": "https://download.geofabrik.de/north-america/us/south-carolina-latest.osm.pbf",
}
UTM = "EPSG:32617"  # UTM zone 17N, covers the whole study area
# Fixed departure so runs are reproducible. Car routing here uses no schedules,
# so the value only has to be a valid date and time.
DEPARTURE = dt.datetime(2025, 1, 15, 8, 0)


# ---------------------------------------------------------------- helpers
def log(msg):
    print(msg, flush=True)


def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def download(url, dest):
    """Download url to dest unless dest exists. Returns Last-Modified header (or None)."""
    last_modified = None
    if os.path.exists(dest):
        log(f"  exists, skipping download: {dest}")
        return last_modified
    log(f"  downloading {url}")
    tmp = dest + ".part"
    try:
        resp = urllib.request.urlopen(url)
    except urllib.error.HTTPError as e:
        raise SystemExit(
            f"Download failed: HTTP {e.code} for {url}\n"
            "Check the file name on https://download.geofabrik.de/north-america/us.html "
            "and update GEOFABRIK in tools/build_od_matrix.py."
        )
    with resp, open(tmp, "wb") as out:
        last_modified = resp.headers.get("Last-Modified")
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            out.write(block)
            done += len(block)
            if total:
                print(f"\r    {done / 1e6:7.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    os.replace(tmp, dest)
    return last_modified


def osm_data_timestamp(pbf):
    """Timestamp stored in the PBF header (the date the extract's data was current), or None."""
    try:
        out = subprocess.run(["osmium", "fileinfo", "-j", pbf], check=True, capture_output=True, text=True).stdout
        info = json.loads(out)
    except Exception as e:  # keep the run going; the gap is visible as null in the metadata
        log(f"  could not read the PBF header of {pbf}: {e}")
        return None

    def find(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k == "osmosis_replication_timestamp":
                    return v
                r = find(v)
                if r:
                    return r
        elif isinstance(x, list):
            for v in x:
                r = find(v)
                if r:
                    return r
        return None

    return find(info)


def run(cmd):
    log("  $ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


# ---------------------------------------------------------------- inputs
def load_inputs(npa_path, hosp_path, limit_npa):
    npa = gpd.read_file(npa_path)
    hosp = gpd.read_file(hosp_path)
    if npa.crs is None or hosp.crs is None:
        raise SystemExit("input GeoJSON has no CRS; expected EPSG:4326")
    npa = npa.to_crs("EPSG:4326")
    hosp = hosp.to_crs("EPSG:4326")

    # study-area bounding box is taken from ALL NPAs and hospitals (before any --limit-npa)
    minx = min(npa.total_bounds[0], hosp.total_bounds[0])
    miny = min(npa.total_bounds[1], hosp.total_bounds[1])
    maxx = max(npa.total_bounds[2], hosp.total_bounds[2])
    maxy = max(npa.total_bounds[3], hosp.total_bounds[3])
    bbox = (minx, miny, maxx, maxy)

    if limit_npa:
        npa = npa.iloc[:limit_npa].copy()

    # geometric centroids computed in a projected CRS
    poly_utm = npa.to_crs(UTM).geometry
    cen = poly_utm.centroid
    npa_pts = gpd.GeoDataFrame({"npa_id": npa["id"].astype(str).values}, geometry=cen.to_crs("EPSG:4326").values, crs="EPSG:4326")
    n_outside = int((~cen.within(poly_utm)).sum())  # both are GeoSeries with the same index
    log(f"  {len(npa_pts)} NPA centroids ({n_outside} fall outside their own polygon)")

    hosp_pts = gpd.GeoDataFrame({"hid": hosp["hid"].astype(str).values}, geometry=hosp.geometry.values, crs="EPSG:4326")
    log(f"  {len(hosp_pts)} hospitals")
    return npa_pts, hosp_pts, bbox, n_outside


# ---------------------------------------------------------------- OSM
def prepare_osm(workdir, bbox, buffer_deg, skip_download):
    os.makedirs(workdir, exist_ok=True)
    meta = {}
    clipped = []
    minx, miny, maxx, maxy = bbox
    b = f"{minx - buffer_deg:.5f},{miny - buffer_deg:.5f},{maxx + buffer_deg:.5f},{maxy + buffer_deg:.5f}"
    for key, url in GEOFABRIK.items():
        raw = os.path.join(workdir, f"{key}-latest.osm.pbf")
        existed = os.path.exists(raw)
        if not skip_download:
            lm = download(url, raw)
        elif not existed:
            raise SystemExit(f"--skip-download set but {raw} is missing")
        else:
            lm = None
        mtime = dt.datetime.fromtimestamp(os.path.getmtime(raw), dt.timezone.utc).isoformat(timespec="seconds")
        meta[key] = {
            "url": url,
            # when the data inside the extract was current (from the PBF header); the date to cite
            "osm_data_timestamp": osm_data_timestamp(raw),
            # HTTP header of the download; null when an existing file was reused
            "last_modified_header": lm,
            "downloaded_this_run": not existed,
            # local file time: when this copy was written to disk, not the OSM data date
            "file_modified_utc": mtime,
            "checked_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "bytes": os.path.getsize(raw),
            "sha256": sha256(raw),
        }
        log(f"  {key}: OSM data timestamp = {meta[key]['osm_data_timestamp']}")
        out = os.path.join(workdir, f"{key}-clip.osm.pbf")
        run(["osmium", "extract", "--bbox", b, raw, "-o", out, "--overwrite"])
        clipped.append(out)
    region = os.path.join(workdir, "region.osm.pbf")
    run(["osmium", "merge", *clipped, "-o", region, "--overwrite"])
    meta["clip_bbox_minx_miny_maxx_maxy"] = b
    return region, meta


# ---------------------------------------------------------------- routing
def route(region_pbf, origins, destinations, max_time_min):
    import r5py

    log(f"  r5py {r5py.__version__}")
    o = origins.copy()
    d = destinations.copy()
    # r5py identifies every point by its "id" column and only requires the values to be
    # unique (r5py/util/data_validation.py); strings are fine. We use the datasets' own
    # identifiers as strings: the NPA number for origins and the hospital hid for
    # destinations. r5py's from_id / to_id therefore ARE the NPA number and the hospital
    # hid, with leading zeros intact, and no mapping back is needed.
    # An origin id must never equal a destination id: r5py sets the travel time of every
    # pair with from_id == to_id to 0 (r5py/r5/travel_time_matrix.py), which is what made
    # origin index i and destination index i come back as 0 minutes.
    o["id"] = o["npa_id"].astype(str)
    d["id"] = d["hid"].astype(str)
    for name, ids in (("origin", o["id"]), ("destination", d["id"])):
        if not ids.is_unique:
            raise SystemExit(f"{name} ids are not unique")
    shared = sorted(set(o["id"]) & set(d["id"]))
    if shared:
        raise SystemExit(f"origin and destination ids overlap: {shared[:10]}; r5py needs them distinct")

    net = r5py.TransportNetwork(region_pbf)
    max_time = dt.timedelta(minutes=max_time_min)

    log("  travel times ...")
    ttm = r5py.TravelTimeMatrix(
        net,
        origins=o,
        destinations=d,
        transport_modes=[r5py.TransportMode.CAR],
        departure=DEPARTURE,
        max_time=max_time,
    )
    ttm = pd.DataFrame(ttm)
    if "travel_time" not in ttm.columns:
        raise SystemExit(f"unexpected TravelTimeMatrix columns: {list(ttm.columns)}")

    log("  network distances (detailed itineraries; this is the slow step) ...")
    it = r5py.DetailedItineraries(
        net,
        origins=o,
        destinations=d,
        transport_modes=[r5py.TransportMode.CAR],
        departure=DEPARTURE,
        max_time=max_time,
    )
    it = pd.DataFrame(it)
    if "distance" not in it.columns:
        raise SystemExit(f"unexpected DetailedItineraries columns: {list(it.columns)}")
    # one car leg per pair; summing legs keeps this correct if a pair has several
    dist = it.groupby(["from_id", "to_id"], as_index=False)["distance"].sum()

    for frame in (ttm, dist):
        frame["from_id"] = frame["from_id"].astype(str)
        frame["to_id"] = frame["to_id"].astype(str)
    m = ttm.merge(dist, on=["from_id", "to_id"], how="outer")
    m["npa_id"] = m["from_id"]  # the r5py ids are the NPA number and the hospital hid
    m["hid"] = m["to_id"]
    m["network_min"] = m["travel_time"].astype(float)
    m["network_km"] = m["distance"].astype(float) / 1000.0
    return m[["npa_id", "hid", "network_km", "network_min"]]


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--npa", default="data/input/npa_input.geojson")
    ap.add_argument("--hospitals", default="data/input/hospitals_input.geojson")
    ap.add_argument("--workdir", default="build/osm")
    ap.add_argument("--out", default="data/input/od_matrix.csv")
    ap.add_argument("--buffer-deg", type=float, default=0.1, help="padding around the study area when clipping OSM (degrees)")
    ap.add_argument("--max-time-min", type=int, default=240, help="routing time limit; pairs above it come back empty")
    ap.add_argument("--limit-npa", type=int, default=0, help="only use the first N NPAs (smoke test)")
    ap.add_argument("--skip-download", action="store_true", help="reuse PBFs already in --workdir")
    args = ap.parse_args()

    if shutil.which("osmium") is None:
        raise SystemExit("osmium not found. Activate the conda env from environment.yml (it provides osmium-tool).")

    log("Inputs")
    origins, dests, bbox, n_outside = load_inputs(args.npa, args.hospitals, args.limit_npa)

    log("OSM extracts")
    region, osm_meta = prepare_osm(args.workdir, bbox, args.buffer_deg, args.skip_download)

    log("Routing")
    od = route(region, origins, dests, args.max_time_min)

    log("Euclidean distances")
    o_utm = origins.to_crs(UTM).set_index("npa_id").geometry
    d_utm = dests.to_crs(UTM).set_index("hid").geometry
    ox = od["npa_id"].map(o_utm.x)
    oy = od["npa_id"].map(o_utm.y)
    dx = od["hid"].map(d_utm.x)
    dy = od["hid"].map(d_utm.y)
    od["euclid_km"] = np.hypot(ox - dx, oy - dy) / 1000.0

    od = od[["npa_id", "hid", "euclid_km", "network_km", "network_min"]]
    od = od.sort_values(["npa_id", "hid"], key=lambda s: s.astype(str)).reset_index(drop=True)

    # ---- QA
    n_pairs = len(od)
    expected = len(origins) * len(dests)
    n_nan = int(od[["network_km", "network_min"]].isna().any(axis=1).sum())
    circuity = (od["network_km"] / od["euclid_km"].replace(0, np.nan)).dropna()
    qa = {
        "pairs": n_pairs,
        "pairs_expected": expected,
        "pairs_missing_network": n_nan,
        "pairs_zero_minutes_but_over_1km": int(((od["network_min"] == 0) & (od["network_km"] > 1)).sum()),
        "npa_centroids_outside_polygon": n_outside,
        "circuity_ratio_network_over_euclid": {
            "min": round(float(circuity.min()), 3) if len(circuity) else None,
            "median": round(float(circuity.median()), 3) if len(circuity) else None,
            "max": round(float(circuity.max()), 3) if len(circuity) else None,
            "share_below_0.95": round(float((circuity < 0.95).mean()), 4) if len(circuity) else None,
        },
    }
    log("QA")
    for k, v in qa.items():
        log(f"  {k}: {v}")
    if n_pairs != expected:
        log("  WARNING: pair count differs from origins x destinations")
    if qa["pairs_zero_minutes_but_over_1km"]:
        log("  WARNING: pairs with 0 minutes but more than 1 km; check the origin/destination ids")
    if n_nan:
        log("  WARNING: some pairs have no route (raise --max-time-min or check snapping)")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    od.round({"euclid_km": 3, "network_km": 3, "network_min": 2}).to_csv(args.out, index=False)
    log(f"wrote {args.out}")

    import r5py

    meta = {
        "created_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "mode": "car (free-flow, OSM speeds as used by R5)",
        "origins": "NPA geometric centroids (computed in " + UTM + ")",
        "destinations": "hospitals_input.geojson (all rows, open and closed)",
        "euclid_crs": UTM,
        "departure": DEPARTURE.isoformat(),
        "max_time_min": args.max_time_min,
        "limit_npa": args.limit_npa or None,
        "versions": {"python": sys.version.split()[0], "r5py": r5py.__version__, "geopandas": gpd.__version__, "pandas": pd.__version__},
        "osm": osm_meta,
        "attribution": "Contains data from OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
        "qa": qa,
    }
    with open(os.path.splitext(args.out)[0] + ".meta.json", "w") as fh:
        json.dump(meta, fh, indent=2)
    log("wrote metadata")


if __name__ == "__main__":
    main()
