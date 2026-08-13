#!/usr/bin/env python3
"""
build_district.py — flag administrative units (municipalities + districts) that
contain a flood forecast, telescoping from districts (coarse) to municipalities
(fine).

Self-contained, like build_basins.py: it reads the model CSVs directly (no
intermediate file, no shared helper). Every flooding GEOGLOWS reach and Flood Hub
gauge becomes a point, and each point is placed into the administrative unit that
contains it by a point-in-polygon test.

Levels (geoBoundaries CGAZ, WGS84 lon/lat):
    res 1  districts       ADM1  geoBoundariesCGAZ_ADM1.gpkg  (3,224 units)
    res 2  municipalities  ADM2  geoBoundariesCGAZ_ADM2.gpkg  (49,349 units)
The two levels are flagged independently (there is no parent key in the data),
which is all the front end needs: it shows the coarse level when zoomed out and
the fine level when zoomed in.

Reads:  ../Files/Geoglows_<date>.csv, ../Files/Flood_Hub_Global.csv
        ../Files/International_boundaries/geoBoundariesCGAZ_ADM{1,2}.gpkg
Writes: ../data_districts.geojson   one FeatureCollection, features tagged with `res`,
                                    kind "districts-telescoping"
"""

import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))   # <repo>/scripts
ROOT = os.path.dirname(HERE)                        # <repo>
FILES = os.path.join(ROOT, "Files")
BOUNDARIES = os.path.join(FILES, "International_boundaries")
PUBLIC = os.path.join(ROOT, "public")   # the app reads its data from here
os.makedirs(PUBLIC, exist_ok=True)
OUTPUT = os.path.join(PUBLIC, "data_districts.geojson")

GEOGLOWS_CSV = os.path.join(FILES, "Geoglows_2026-07-13-00.csv")
FLOOD_HUB_CSV = os.path.join(FILES, "Flood_Hub_Global.csv")

# res -> the geopackage for that level. res is what the front end telescopes on:
# lower res = coarser = shown when zoomed out.
ADMIN_LEVELS = [
    {"res": 1, "unit": "district",     "gpkg": "geoBoundariesCGAZ_ADM1.gpkg"},
    {"res": 2, "unit": "municipality", "gpkg": "geoBoundariesCGAZ_ADM2.gpkg"},
]
RESOLUTIONS = [lvl["res"] for lvl in ADMIN_LEVELS]

# Polygons per streamed read — keeps memory flat over the big ADM2 layer, the same
# batching idea build_basins.py uses for the HydroBASINS parquets.
READ_BATCH = 4000

SEVERITY_RANK = {"none": 0, "warning": 1, "danger": 2, "extreme": 3}

# GEOGLOWS has no severity label, only a return period (years). Same tiers the rest
# of the pipeline uses; below 2-year is not flagged. Streams below the mean-flow floor
# are dropped so tiny channels don't flag a district.
GEOGLOWS_SEVERITY_THRESHOLDS = [(20, "extreme"), (5, "danger"), (2, "warning")]
GEOGLOWS_MIN_MEAN_FLOW = 5
FLOOD_HUB_SEVERITY = {"ABOVE_NORMAL": "warning", "SEVERE": "danger", "EXTREME": "extreme"}

# Keys copied onto a flagged unit's forecasts. riverId is set separately to the
# unit's name (per spec: "use the district name as our gauge").
FORECAST_KEYS = [
    "model", "severity", "lat", "lon", "country",
    "returnPeriodYr", "peakDischargeCms",
    "issuedTime", "startTime", "peakTime", "endTime", "historicalComparison",
]


def _f(v):
    """Parse a CSV cell to float, or None if blank/non-numeric."""
    v = (v or "").strip()
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def geoglows_severity(ret_per):
    for thr, sev in GEOGLOWS_SEVERITY_THRESHOLDS:
        if ret_per >= thr:
            return sev
    return None


def read_geoglows_points(path):
    """Every flooding GEOGLOWS reach as a point (comid, ret_per, mean, lat, lon)."""
    out = []
    if not os.path.exists(path):
        print(f"  note: {os.path.basename(path)} not found; GEOGLOWS skipped.",
              file=sys.stderr)
        return out
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rp = _f(r.get("ret_per"))
            if rp is None:
                continue
            sev = geoglows_severity(int(rp))
            if sev is None:
                continue
            mean = _f(r.get("mean"))
            if GEOGLOWS_MIN_MEAN_FLOW and (mean is None or mean < GEOGLOWS_MIN_MEAN_FLOW):
                continue
            lat, lon = _f(r.get("lat")), _f(r.get("lon"))
            if lat is None or lon is None:
                continue
            out.append({
                "model": "geoglows", "severity": sev, "lat": lat, "lon": lon,
                "riverId": (r.get("comid") or "").strip(),
                "country": "", "returnPeriodYr": int(rp),
                "peakDischargeCms": (r.get("mean") or "").strip(),
                "issuedTime": "", "startTime": "", "peakTime": "", "endTime": "",
                "historicalComparison": "",
            })
    return out


def read_flood_hub_points(path):
    """Every Flood Hub gauge alert as a point (with its coordinate)."""
    out = []
    if not os.path.exists(path):
        print(f"  note: {os.path.basename(path)} not found; Flood Hub skipped.",
              file=sys.stderr)
        return out
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            raw = (r.get("severity") or "").strip().upper()
            if raw not in FLOOD_HUB_SEVERITY:
                continue
            lat = _f(r.get("gaugeLocation.latitude"))
            lon = _f(r.get("gaugeLocation.longitude"))
            if lat is None or lon is None:
                continue
            out.append({
                "model": "flood_hub", "severity": FLOOD_HUB_SEVERITY[raw],
                "lat": lat, "lon": lon,
                "riverId": (r.get("gaugeId") or "").strip(),
                "country": (r.get("queriedCountryName") or "").strip(),
                "returnPeriodYr": "", "peakDischargeCms": "",
                "issuedTime": (r.get("issuedTime") or "").strip(),
                "startTime": (r.get("forecastTimeRange.start") or "").strip(),
                "peakTime": "",
                "endTime": (r.get("forecastTimeRange.end") or "").strip(),
                "historicalComparison": "",
            })
    return out


def load_points():
    """Combined flood points from both models, read straight from the CSVs."""
    pts = read_geoglows_points(GEOGLOWS_CSV) + read_flood_hub_points(FLOOD_HUB_CSV)
    return pts


def worst_severity(forecasts):
    """Highest-ranked severity among a unit's forecasts (drives its color)."""
    best, best_rank = "", -1
    for fc in forecasts:
        r = SEVERITY_RANK.get(str(fc.get("severity", "")).lower(), -1)
        if r > best_rank:
            best_rank, best = r, str(fc.get("severity", "")).lower()
    return best


def forecast_for(point, unit_name):
    """A forecast entry for a flagged unit: the flood point's fields, but with
    riverId replaced by the administrative unit's name."""
    fc = {k: point.get(k, "") for k in FORECAST_KEYS}
    fc["riverId"] = unit_name          # district / unit name is the "gauge" for now
    return fc


def flag_level(level, points, shapely_pts):
    """Point-in-polygon every flood point into one administrative level.

    Streams the geopackage in batches; for each batch, builds an STRtree over the
    polygons and queries all flood points, confirming with an exact contains().
    Returns a list of GeoJSON features for the units that caught at least one point.
    """
    from pyogrio.raw import read
    from shapely import from_wkb, STRtree
    from shapely.geometry import mapping

    path = os.path.join(BOUNDARIES, level["gpkg"])
    if not os.path.exists(path):
        sys.exit(f"Not found: {path}")

    res = level["res"]
    features = []
    assigned = set()          # point index -> already placed at this level (once)
    total_units = 0
    skip = 0
    while True:
        meta, _fid, geom, fields = read(
            path,
            columns=["shapeName", "shapeID", "shapeGroup"],
            skip_features=skip,
            max_features=READ_BATCH,
        )
        n = len(geom)
        if n == 0:
            break
        # pyogrio returns the field arrays in the file's schema order, which is not
        # guaranteed to match the order we requested (and it varies by GDAL version).
        # Index by name so `names` is always shapeName — not, say, the country code.
        col = {name: i for i, name in enumerate(meta["fields"])}
        names = fields[col["shapeName"]]
        ids = fields[col["shapeID"]]
        groups = fields[col["shapeGroup"]]
        polys = from_wkb([bytes(g) for g in geom])
        total_units += n

        # buckets[i] = list of point indices inside polygon i (this batch)
        buckets = {}
        if shapely_pts is not None:
            tree = STRtree(polys)
            pi, gi = tree.query(shapely_pts, predicate="intersects")
            for p_idx, g_idx in zip(pi, gi):
                if p_idx in assigned:
                    continue
                if polys[g_idx].contains(shapely_pts[p_idx]):
                    assigned.add(p_idx)
                    buckets.setdefault(g_idx, []).append(p_idx)

        for g_idx, pt_idxs in buckets.items():
            name = (names[g_idx] or "").strip() or str(ids[g_idx])
            fcs = [forecast_for(points[p], name) for p in pt_idxs]
            features.append({
                "type": "Feature",
                "geometry": mapping(polys[g_idx]),
                "properties": {
                    "res": res,
                    "cell_id": name,                 # shown in the panel/tooltip
                    "admin_id": str(ids[g_idx]),     # stable geoBoundaries id
                    "country": (groups[g_idx] or "").strip(),
                    "severity": worst_severity(fcs),
                    "model_count": len(fcs),
                    "forecasts": fcs,
                },
            })

        skip += n
        if n < READ_BATCH:
            break

    print(f"  res {res} ({level['unit']}): {len(features):,} flagged "
          f"of {total_units:,} units")
    return features


def main():
    from shapely import points as shapely_points

    points = load_points()
    print(f"Flood points: {len(points):,}")

    # One shapely Point per flood point (lon, lat), reused across both levels.
    coords, valid = [], []
    for p in points:
        try:
            coords.append((float(p["lon"]), float(p["lat"])))
            valid.append(p)
        except (KeyError, TypeError, ValueError):
            continue
    if len(valid) < len(points):
        print(f"  note: {len(points) - len(valid)} point(s) had no usable "
              f"coordinate and were skipped.", file=sys.stderr)
    points = valid
    shapely_pts = shapely_points(coords) if coords else None

    features = []
    for level in ADMIN_LEVELS:
        features.extend(flag_level(level, points, shapely_pts))

    fc = {
        "type": "FeatureCollection",
        "kind": "districts-telescoping",
        "resolutions": RESOLUTIONS,
        "features": features,
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f"Wrote {len(features):,} feature(s) across {len(RESOLUTIONS)} levels "
          f"-> {OUTPUT}")


if __name__ == "__main__":
    main()
