# Flood Forecast Viewer

A map that flags flood-forecast locations and shows each model's forecast on click.
Open it through a local server (VS Code **Go Live**) — double-clicking `index.html`
shows an empty map because browsers block file loading on `file://`.

## Layout
- `Front_End/` — the web app: `index.html`, `app.js`, `styles.css`, logo. It reads
  a `data.geojson` sitting next to `index.html`.
- `Back_End/` — the Python pipeline that generates `data.geojson`.

## Run it (grid view)
```
cd Back_End
python csv_to_json_vgrid.py     # model CSVs -> flood_points.json
python build_cells_h3.py        # points     -> data.geojson
```
Then open `Front_End/index.html` via Go Live.

## Run it (basin view)
```
cd Back_End
python csv_to_json_basins.py    # model CSVs        -> flood_state.json
python build_basins.py          # + HUC.parquet     -> data.geojson
```
Both views write the same `data.geojson`, so whichever build you run last is what
the map shows.

## Back_End files
- `csv_to_json_vgrid.py` — merges Flood Hub + GEOGLOWS into `flood_points.json`
  (severity mapping and mean-flow floor are configured at the top of the file).
- `build_cells_h3.py` — bins points into H3 hexagons (`RESOLUTIONS` knob at top).
- `build_cells_s2.py` — S2 four-sided cells (same `data.geojson` format).
- `csv_to_json_basins.py` / `build_basins.py` — the HydroBASINS basin pipeline.
