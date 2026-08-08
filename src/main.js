// Entry point. Vite bundles these imports — no CDN <script>/<link> tags needed.
import "./style.css" // Tailwind + custom theme + MapLibre overrides
import "maplibre-gl/dist/maplibre-gl.css" // MapLibre's own stylesheet (from npm)
import {AttributionControl, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl} from "maplibre-gl";
// MapLibre 6 runs its tiling in a worker it loads from a sibling file resolved
// off `import.meta.url`. Once Vite pre-bundles or hashes the library that path
// no longer exists, and the failure is silent and easy to misread: raster tiles
// are loaded on the main thread so the basemap looks fine, while every GeoJSON
// source stays stuck at `isSourceLoaded() === false` and paints nothing. Hand
// MapLibre a worker URL that Vite actually emits.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {icon} from "./icons.js"; // heroicons, inlined as SVG at build time

(function () {
  "use strict";

  setWorkerUrl(maplibreWorkerUrl);

  const SEVERITY = {
    warning: {rank: 1, color: "#ffd21f", label: "Warning"},
    danger: {rank: 2, color: "#ff8c00", label: "Danger"},
    extreme: {rank: 3, color: "#e0201b", label: "Extreme"},
  };
  const DEFAULT_COLOR = "#4da3ff";

  // MapLibre measures zoom against a 512px world where Leaflet used 256px, so
  // every zoom number in this file sits one step below the Leaflet equivalent
  // for the same view on screen.
  const RES_START_ZOOM = 2;
  const RES_ZOOM_STEP = 2;

  function sevColor(s) {
    const k = (s || "").toLowerCase();
    return SEVERITY[k] ? SEVERITY[k].color : DEFAULT_COLOR;
  }

  const FIELD_LABELS = [
    ["severity", "Severity"],
    ["riverId", "Gauge / River ID"],
    ["country", "Country"],
    ["returnPeriodYr", "Return period"],
    ["peakDischargeCms", "Mean discharge"], //this will need to be changed into peak, the info from geoglows is in mean discharge.
    ["issuedTime", "Issued"],
    ["startTime", "Start"],
    ["peakTime", "Peak"],
    ["endTime", "End"],
    ["historicalComparison", "Historical"],
  ];

  // Every pipeline stamps the FeatureCollection with a `kind`, so all the
  // user-facing wording (readout, attribution, panel copy) comes from one place
  // instead of being hardcoded to H3.
  const DATASETS = {
    "basins-telescoping": {
      unit: "Basin",
      resLabel: "Basin level",
      attribution: "HydroBASINS",
      emptyTitle: "No basin selected",
      emptyBody: "Click a highlighted basin on the map to see every forecast inside it.",
      pipeline: ["csv_to_json_basins.py", "build_basins.py"],
    },
    "h3-telescoping": {
      unit: "Cell",
      resLabel: "H3 res",
      attribution: "Grid: H3 (Uber H3)",
      emptyTitle: "No cell selected",
      emptyBody: "Click a highlighted grid cell on the map to see every forecast inside it.",
      pipeline: ["csv_to_json_vgrid.py", "build_cells_h3.py"],
    },
    "s2-telescoping": {
      unit: "Cell",
      resLabel: "S2 level",
      attribution: "Grid: S2 (Google S2)",
      emptyTitle: "No cell selected",
      emptyBody: "Click a highlighted grid cell on the map to see every forecast inside it.",
      pipeline: ["csv_to_json_vgrid.py", "build_cells_s2.py"],
    },
  };

  // Until the data lands we don't know which build it is; stay neutral.
  let dataset = {
    unit: "Area", resLabel: "Level", attribution: "",
    emptyTitle: "No area selected",
    emptyBody: "Click a highlighted area on the map to see every forecast inside it.",
    pipeline: ["csv_to_json_vgrid.py", "build_cells_h3.py"],
  };

  function unitLabel(props) {
    // Fall back to the per-feature tag if a file predates the `kind` member.
    if (props && props.basin_id && dataset.unit === "Area") return "Basin";
    return dataset.unit;
  }

  // Compact counts for the impact tiles: 8_181_280 -> "8.2M".
  function fmtCount(n) {
    if (n === null || n === undefined || !isFinite(n)) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(n).toLocaleString();
  }

  function fmtValue(key, val) {
    if (val === undefined || val === null || val === "") return "—";
    if (key === "returnPeriodYr") return val + "-year";
    if (key === "peakDischargeCms") return val + " m³/s";
    if (key.endsWith("Time")) {
      const d = new Date(val);
      if (!isNaN(d)) {
        return d.toLocaleString(undefined, {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          hour12: false, timeZoneName: "short",
        });
      }
    }
    return String(val);
  }

  // ---- Base maps ------------------------------------------------------------

  // Every base map here is openly licensed and free to use with attribution.
  // Tile sources carry only their own imagery credit; the grid/basin credit sits
  // on the GeoJSON source instead, so it survives base-layer switches and can be
  // written from whatever the data turns out to be.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // MapLibre has no `{s}` placeholder; listing the shards as separate URLs is how
  // it spreads requests across hostnames.
  const shards = (subdomains, url) => subdomains.map((s) => url.replace("{s}", s));

  function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const latRad = (lat * Math.PI) / 180;
    return {
      z,
      x: Math.floor(((lon + 180) / 360) * n),
      y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    };
  }

  // Each base map gets a thumbnail preview, gallery-style. The thumbnail is just
  // one real tile of the same location from that layer's own source, so every
  // preview shows the area in that layer's actual style.
  // San Francisco Bay at z11 — a recognizable mix of city, water, and bridges.
  const THUMB = lonLatToTile(-122.40, 37.80, 11);

  const BASEMAPS = [
    {
      id: "osm",
      name: "OpenStreetMap",
      thumb: `https://a.tile.openstreetmap.org/${THUMB.z}/${THUMB.x}/${THUMB.y}.png`,
      source: {
        type: "raster",
        tiles: shards(["a", "b", "c"], "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
        tileSize: 256,
        maxzoom: 19,
        attribution: OSM_ATTR,
      },
    },
    {
      // A deliberately washed-out base: the severity fills and the white
      // selection ring are the only saturated things on the map.
      id: "carto-positron",
      name: "Light (CARTO)",
      thumb: `https://a.basemaps.cartocdn.com/light_all/${THUMB.z}/${THUMB.x}/${THUMB.y}.png`,
      source: {
        type: "raster",
        tiles: shards(["a", "b", "c", "d"], "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"),
        tileSize: 256,
        maxzoom: 20,
        attribution: `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
      },
    },
    {
      // Contours and relief — the closest thing to a terrain view now that the
      // satellite layers are gone, and the most useful one for reading a basin.
      id: "opentopomap",
      name: "Topographic",
      thumb: `https://a.tile.opentopomap.org/${THUMB.z}/${THUMB.x}/${THUMB.y}.png`,
      source: {
        type: "raster",
        tiles: shards(["a", "b", "c"], "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"),
        tileSize: 256,
        maxzoom: 17,
        attribution: `${OSM_ATTR}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
      },
    },
  ];
  const DEFAULT_BASEMAP = "osm";

  // ---- Map ------------------------------------------------------------------

  // A single copy of the world. The data only exists once, so `renderWorldCopies`
  // stays off; otherwise you can scroll into empty repeated tiles where no
  // cells/basins are drawn. That alone clamps panning to one world width, which
  // is what Leaflet needed `maxBounds` for — and just as well, because a
  // whole-world `maxBounds` crashes maplibre-gl 6.2.0 inside the constructor's
  // first resize (a small regional one is fine).
  const map = new MapLibreMap({
    container: "map",
    style: {
      version: 8,
      sources: Object.fromEntries(BASEMAPS.map((b) => [b.id, b.source])),
      // All three base maps live in the style at once; switching just flips
      // which one is visible, so no restyle and no re-fetch of tiles already
      // cached. Only the visible one's attribution shows.
      layers: BASEMAPS.map((b) => ({
        id: b.id,
        type: "raster",
        source: b.id,
        layout: {visibility: b.id === DEFAULT_BASEMAP ? "visible" : "none"},
      })),
    },
    center: [0, 20],
    zoom: 1,
    minZoom: 1,
    maxZoom: 19,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({showCompass: false}), "top-left");
  map.addControl(new AttributionControl({compact: false}), "bottom-right");

  // Base-map switcher: one icon button that opens a gallery of thumbnails,
  // instead of an always-expanded radio list.
  function basemapControl() {
    let container = null;
    let closeOnDocClick = null;

    return {
      onAdd(mapInstance) {
        container = document.createElement("div");
        // Deliberately not `maplibregl-ctrl-group`: that class carries a pile of
        // fixed button sizing that would squash the thumbnail rows. The group's
        // chrome (white card, rounded, shadow) is reproduced in style.css.
        container.className = "maplibregl-ctrl basemap-ctrl";
        container.innerHTML =
          `<button type="button" class="basemap-toggle" title="Base map" aria-label="Base map">` +
          icon("square-3-stack-3d", "text-[19px] text-slate-700") +
          `</button>` +
          `<div class="basemap-list" hidden>` +
          BASEMAPS.map((b) =>
            `<button type="button" class="basemap-row" data-basemap="${b.id}">` +
            `<img src="${b.thumb}" alt="" loading="lazy"><span>${b.name}</span></button>`
          ).join("") +
          `</div>`;

        const toggle = container.querySelector(".basemap-toggle");
        const list = container.querySelector(".basemap-list");
        const rows = [...container.querySelectorAll(".basemap-row")];

        function highlight(id) {
          rows.forEach((r) => r.classList.toggle("basemap-selected", r.dataset.basemap === id));
        }

        function select(id) {
          BASEMAPS.forEach((b) => {
            mapInstance.setLayoutProperty(b.id, "visibility", b.id === id ? "visible" : "none");
          });
          highlight(id);
        }

        // Controls are added before the style finishes loading, and
        // `setLayoutProperty` throws until it has. The style already ships with
        // the default visible, so this only has to match the marker to it.
        highlight(DEFAULT_BASEMAP);
        toggle.addEventListener("click", () => {
          list.hidden = !list.hidden;
          container.classList.toggle("basemap-open", !list.hidden);
        });
        rows.forEach((r) => r.addEventListener("click", () => select(r.dataset.basemap)));
        // Clicks inside the control (including picking a layer) keep it open;
        // any click elsewhere — the map or the page — closes it.
        container.addEventListener("click", (e) => e.stopPropagation());
        closeOnDocClick = () => {
          list.hidden = true;
          container.classList.remove("basemap-open");
        };
        document.addEventListener("click", closeOnDocClick);
        return container;
      },
      onRemove() {
        document.removeEventListener("click", closeOnDocClick);
        container.remove();
      },
    };
  }

  map.addControl(basemapControl(), "top-right");

  // Current resolution readout, bottom-left.
  map.addControl({
    onAdd() {
      this._el = document.createElement("div");
      this._el.className = "maplibregl-ctrl res-readout";
      this._el.id = "res-readout";
      this._el.textContent = dataset.resLabel + " —";
      return this._el;
    },
    onRemove() {
      this._el.remove();
    },
  }, "bottom-left");

  function updateResReadout(res) {
    const el = document.getElementById("res-readout");
    if (el) el.textContent = dataset.resLabel + " " + res;
  }

  const legendEl = document.getElementById("legend");
  legendEl.innerHTML = Object.keys(SEVERITY)
      .filter((k) => k !== "none")
      .map((k) => `<span class="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
        <span class="w-3.5 h-3.5 rounded-sm border border-black/30" style="background:${SEVERITY[k].color}"></span>${SEVERITY[k].label}
      </span>`)
      .join("") +
    `<span class="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
        <span class="w-3.5 h-3.5 rounded-sm bg-white border-2 border-slate-900"></span>Multi-model
      </span>`;

  const panelEmpty = document.getElementById("panel-empty");
  const panelContent = document.getElementById("panel-content");

  function showCell(props) {
    panelEmpty.hidden = true;
    panelContent.hidden = false;

    const worst = (props.severity || "").toLowerCase();
    const worstColor = sevColor(worst);

    const badge = (sev, color) =>
      `<span class="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold capitalize text-[#10161d]" style="background:${color}">${sev || "—"}</span>`;

    const cards = props.forecasts.map((fc) => {
      const label = modelLabel(fc.model || "model");
      const href = modelLink(fc);
      // Linked when we have a coordinate; a plain span otherwise so a missing
      // coordinate degrades to unlinked text rather than a dead link.
      const title = href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer"
              title="Open this forecast in ${label}"
              class="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 hover:underline">${label}${
          icon("arrow-top-right-on-square", "text-[11px] opacity-80")}</a>`
        : label;
      const rows = FIELD_LABELS
        .filter(([k]) => k !== "historicalComparison")
        .map(([k, label]) => {
          const dt = `<dt class="text-slate-400">${label}</dt>`;
          if (k === "severity") {
            return `${dt}<dd class="m-0">${badge(fc.severity, sevColor(fc.severity))}</dd>`;
          }
          return `${dt}<dd class="m-0 text-slate-100 break-words">${fmtValue(k, fc[k])}</dd>`;
        })
        .join("");
      const note = fc.historicalComparison
        ? `<div class="flex items-start gap-1.5 text-xs text-slate-400 italic mt-2">
             ${icon("clock", "text-sm mt-0.5")}
             <span>“${fc.historicalComparison}”</span>
           </div>` : "";
      return `
        <div class="bg-[#1b2a3a] border border-slate-700 border-l-4 rounded-[10px] px-3.5 py-3 mb-3" style="border-left-color:${sevColor(fc.severity)}">
          <div class="flex items-center justify-between mb-2">
            <span class="flex items-center gap-1.5 font-semibold text-[13px] capitalize text-slate-100">
              ${icon("chart-bar", "text-sky-300")}
              ${title}
            </span>
          </div>
          <dl class="grid grid-cols-[128px_1fr] gap-x-2.5 gap-y-1 text-[12.5px]">${rows}</dl>
          ${note}
        </div>`;
    }).join("");

    const imp = props.impact;
    const tile = (name, label, value, span) => `
      <div class="${span ? "col-span-2 " : ""}rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
        <div class="flex items-center gap-1 text-slate-400 text-[10px] font-semibold uppercase tracking-wide mb-1">
          ${icon(name, "text-[12px]")}${label}
        </div>
        <div class="text-slate-800 font-bold text-[15px] leading-none">${value}</div>
      </div>`;
    const impactHtml = imp ? `
      <div class="mt-4 pt-3 border-t border-slate-200">
        <h3 class="flex items-center gap-1.5 text-slate-800 font-semibold text-[11px] uppercase tracking-wider mb-2">
          ${icon("exclamation-triangle", "text-amber-500 text-sm")}Impact
        </h3>
        <div class="grid grid-cols-2 gap-2">
          ${tile("building-office-2", "Buildings", fmtCount(imp.buildings))}
          ${tile("rectangle-group", "Farmland", fmtCount(imp.farmland_m2 / 1e6) + " km²")}
          ${tile("map", "Roads", fmtCount(imp.highway_km) + " km")}
          ${tile("arrows-right-left", "Railways", fmtCount(imp.railway_km) + " km")}
          ${tile("users", "Population", fmtCount(imp.population), true)}
        </div>
        <p class="text-slate-400 text-[10px] mt-1.5">Totals across the whole basin.</p>
      </div>` : "";

    const nModels = (props.models || []).length;
    const confidence = nModels >= 2
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800">
           ${icon("check-badge")}${nModels} models agree</span>`
      : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">Single model</span>`;

    panelContent.innerHTML = `
      <h2 class="flex items-center gap-2 text-slate-800 font-semibold text-[15px] mb-0.5">
        <span class="inline-flex" style="color:${worstColor}">${icon("squares-2x2")}</span>
        ${unitLabel(props)} ${props.cell_id}
        ${badge(worst, worstColor)}
      </h2>
      <div class="flex items-center gap-2 mb-3.5">
        ${confidence}
        <span class="text-slate-500 text-xs">${props.model_count} forecast${props.model_count === 1 ? "" : "s"} · worst-case above</span>
      </div>
      ${cards}
      ${impactHtml}`;
  }

  let resolutions = [];
  const byRes = {};

  // ---- Model filter (toggle at the top of the panel) ------------------------
  const visibleModels = new Set();
  const MODEL_LABELS = {flood_hub: "Flood Hub", geoglows: "GEOGLOWS"};

  function modelLabel(m) {
    return MODEL_LABELS[m] || m.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Deep link a single forecast back into its source application, centered on the
  // reach/gauge coordinate the pipeline now carries. Returns null when there's no
  // usable coordinate (older data, or a model we don't have a URL scheme for), so
  // the caller can fall back to a plain, unlinked title. URL patterns live here in
  // one place — if a provider changes routing, this is the only thing to update.
  const LINK_ZOOM = {geoglows: 13, flood_hub: 10};

  function modelLink(fc) {
    const lat = Number(fc && fc.lat);
    const lon = Number(fc && fc.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const m = String((fc && fc.model) || "").toLowerCase();
    if (m === "geoglows") {
      // Hydroviewer is location-only; centering on the reach shows the stream.
      return `https://hydroviewer.geoglows.org/#lon=${lon}&lat=${lat}&zoom=${LINK_ZOOM.geoglows}&definition=`;
    }
    if (m === "flood_hub") {
      // /l/{lat}/{lng}/{zoom}[/g/{gaugeId}] — the id pins the specific gauge.
      const base = `https://sites.research.google/floods/l/${lat}/${lon}/${LINK_ZOOM.flood_hub}`;
      return fc.riverId ? `${base}/g/${encodeURIComponent(fc.riverId)}` : base;
    }
    return null;
  }

  function worstSeverity(forecasts) {
    let best = "", bestRank = -1;
    for (const fc of forecasts) {
      const info = SEVERITY[(fc.severity || "").toLowerCase()];
      const r = info ? info.rank : -1;
      if (r > bestRank) {
        bestRank = r;
        best = (fc.severity || "").toLowerCase();
      }
    }
    return best;
  }

  // ---- Cell/basin layer -----------------------------------------------------

  const SRC = "cells";
  const FILL = "cells-fill";
  const LINE = "cells-line";
  const EMPTY_FC = {type: "FeatureCollection", features: []};

  // MapLibre flattens feature properties through its tiling pipeline, so the
  // nested `forecasts`/`impact`/`models` members come back from a rendered
  // feature as JSON strings. Keep the real objects here, keyed by the id we
  // stamp on each feature, and read everything for the panel out of this map.
  const featureById = new Map();
  let nextFeatureId = 1;

  // Keep only forecasts from visible models; drop empty cells; recolour the rest.
  function visibleFeatures(features) {
    const out = [];
    for (const f of features) {
      const fcs = f.properties.forecasts.filter((x) => visibleModels.has(x.model));
      if (!fcs.length) continue;
      const modelNames = [...new Set(fcs.map((x) => x.model))];
      const feature = {
        type: "Feature",
        id: nextFeatureId++,
        geometry: f.geometry,
        properties: Object.assign({}, f.properties, {
          forecasts: fcs, model_count: fcs.length, severity: worstSeverity(fcs),
          models: modelNames, agree: modelNames.length >= 2,
        }),
      };
      featureById.set(feature.id, feature);
      out.push(feature);
    }
    return out;
  }

  const stateOn = (key) => ["boolean", ["feature-state", key], false];
  const severityColor = [
    "match", ["coalesce", ["get", "severity"], ""],
    ...Object.entries(SEVERITY).flatMap(([k, v]) => [k, v.color]),
    DEFAULT_COLOR,
  ];

  function addCellLayers() {
    const source = {type: "geojson", data: EMPTY_FC};
    if (dataset.attribution) source.attribution = dataset.attribution;
    map.addSource(SRC, source);
    map.addLayer({
      id: FILL,
      type: "fill",
      source: SRC,
      paint: {
        "fill-color": severityColor,
        "fill-opacity": [
          "case",
          stateOn("selected"), 0.2,
          stateOn("hover"), 0.6,
          0.3,
        ],
      },
    });
    map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      paint: {
        "line-color": [
          "case",
          stateOn("selected"), "#ffffff",
          ["get", "agree"], "#0f172a",
          severityColor,
        ],
        "line-width": [
          "case",
          stateOn("selected"), 4,
          stateOn("hover"), 3,
          ["get", "agree"], 2.5,
          1,
        ],
        "line-opacity": ["case", ["get", "agree"], 1, 0.85],
      },
    });
  }

  // Leaflet handed us `layer.getBounds()`; with MapLibre we walk the coordinates.
  function boundsOf(features) {
    const b = new LngLatBounds();
    const walk = (c) => (Array.isArray(c[0]) ? c.forEach(walk) : b.extend(c));
    for (const f of features) if (f.geometry) walk(f.geometry.coordinates);
    return b;
  }

  const tooltip = new Popup({
    closeButton: false, closeOnClick: false, className: "cell-tooltip", offset: 12, maxWidth: "340px",
  });

  function tooltipHtml(p) {
    return `${unitLabel(p)} ${p.cell_id} · <b>${p.severity || "?"}</b> ` +
      `(${p.model_count} forecast${p.model_count === 1 ? "" : "s"})` +
      (p.agree ? ` · ✓ ${p.models.length} models` : "");
  }

  let hoveredId = null;
  let selectedId = null;

  function setFeatureState(id, patch) {
    if (id != null) map.setFeatureState({source: SRC, id}, patch);
  }

  function setHover(id) {
    if (hoveredId === id) return;
    setFeatureState(hoveredId, {hover: false});
    hoveredId = id;
    setFeatureState(hoveredId, {hover: true});
  }

  function clearSelection() {
    setFeatureState(selectedId, {selected: false});
    selectedId = null;
    panelContent.hidden = true;
    panelEmpty.hidden = false;
  }

  function selectFeature(id) {
    const feature = featureById.get(id);
    if (!feature) return;
    setFeatureState(selectedId, {selected: false});
    selectedId = id;
    setFeatureState(selectedId, {selected: true});
    showCell(feature.properties);
    map.fitBounds(boundsOf([feature]), {maxZoom: 11, padding: 40});
  }

  function bindCellInteractions() {
    map.on("mousemove", FILL, (e) => {
      const f = e.features[0];
      if (!f) return;
      map.getCanvas().style.cursor = "pointer";
      setHover(f.id);
      tooltip.setLngLat(e.lngLat).setHTML(tooltipHtml(featureById.get(f.id).properties)).addTo(map);
    });
    map.on("mouseleave", FILL, () => {
      map.getCanvas().style.cursor = "";
      setHover(null);
      tooltip.remove();
    });
    // One handler for both cases: a hit selects, a miss clears — which also
    // covers "click the basemap to deselect".
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, {layers: [FILL]});
      if (hits.length) selectFeature(hits[0].id);
      else clearSelection();
    });
  }

  // ---- Resolution switching -------------------------------------------------

  const fcByRes = {};

  function fcFor(res) {
    if (!fcByRes[res]) {
      fcByRes[res] = {
        type: "FeatureCollection",
        features: visibleFeatures(byRes[String(res)].features),
      };
    }
    return fcByRes[res];
  }

  function zoomToRes(zoom) {
    let chosen = resolutions[0];
    resolutions.forEach((r, i) => {
      if (zoom >= RES_START_ZOOM + i * RES_ZOOM_STEP) chosen = r;
    });
    return chosen;
  }

  let currentRes = null;

  function showRes(res) {
    if (res === currentRes) return;
    clearSelection();
    setHover(null);
    tooltip.remove();
    map.getSource(SRC).setData(fcFor(res));
    currentRes = res;
    updateResReadout(res);
  }

  // Rebuild the current data after a model toggle (cached collections are stale).
  function refreshFeatures() {
    for (const k in fcByRes) delete fcByRes[k];
    featureById.clear();
    const res = currentRes;
    currentRes = null;
    if (res != null) showRes(res);
  }

  function renderModelToggle(models) {
    const el = document.getElementById("model-toggle");
    if (!el || models.length < 2) {
      if (el) el.innerHTML = "";
      return;
    }
    el.innerHTML =
      '<div class="relative mb-3 pb-3 border-b border-slate-200">' +
      '  <button id="model-dd-btn" type="button" class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-300 bg-white text-[13px] font-medium text-slate-700 hover:bg-slate-50">' +
      '    <span class="flex items-center gap-1.5">' + icon("funnel", "text-sky-500") +
      '<span id="model-dd-label">All models</span></span>' +
      '    <span id="model-dd-caret" class="inline-flex transition-transform">' +
      icon("chevron-down", "text-slate-400") + '</span>' +
      '  </button>' +
      '  <div id="model-dd-menu" class="hidden absolute z-[1000] left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg p-1.5">' +
      models.map((m) =>
        `<label class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 text-[13px] text-slate-700 cursor-pointer select-none">` +
        `<input type="checkbox" data-model="${m}" checked class="accent-sky-500 w-3.5 h-3.5">${modelLabel(m)}</label>`
      ).join("") +
      "  </div></div>";

    const root = el.firstElementChild;
    const btn = document.getElementById("model-dd-btn");
    const menu = document.getElementById("model-dd-menu");
    const caret = document.getElementById("model-dd-caret");
    const label = document.getElementById("model-dd-label");

    function updateLabel() {
      const n = models.filter((m) => visibleModels.has(m)).length;
      label.textContent = n === models.length ? "All models"
        : n === 0 ? "No models" : n + " of " + models.length + " models";
    }

    function closeMenu() {
      menu.classList.add("hidden");
      caret.style.transform = "";
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle("hidden");
      caret.style.transform = open ? "" : "rotate(180deg)";
    });
    document.addEventListener("click", (e) => {
      if (!root.contains(e.target)) closeMenu();
    });

    el.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) visibleModels.add(cb.dataset.model);
        else visibleModels.delete(cb.dataset.model);
        updateLabel();
        refreshFeatures();
      });
    });
    updateLabel();
  }

  function buildFromGeojson(geo) {
    // Resolve the wording before anything renders — the attribution is baked
    // into the GeoJSON source, so it has to be known before we add it.
    if (geo && DATASETS[geo.kind]) dataset = DATASETS[geo.kind];

    const feats = (geo && geo.features) || [];
    const grouped = {};
    for (const f of feats) {
      const r = (f.properties && f.properties.res != null) ? f.properties.res : 0;
      (grouped[r] = grouped[r] || []).push(f);
    }
    resolutions = (Array.isArray(geo.resolutions) && geo.resolutions.length
      ? geo.resolutions.map(Number)
      : Object.keys(grouped).map(Number)).sort((a, b) => a - b);
    for (const r of resolutions) {
      byRes[String(r)] = {type: "FeatureCollection", features: grouped[r] || []};
    }

    if (!resolutions.some((r) => byRes[String(r)].features.length)) {
      document.getElementById("panel-empty").innerHTML =
        `<h2>No ${dataset.unit.toLowerCase()} data</h2><p>Run ` +
        `<code>python ${dataset.pipeline[0]}</code> then ` +
        `<code>python ${dataset.pipeline[1]}</code> to generate <code>data.geojson</code>.</p>`;
      return;
    }

    const emptyH = document.querySelector("#panel-empty h2");
    const emptyP = document.querySelector("#panel-empty p");
    if (emptyH) emptyH.textContent = dataset.emptyTitle;
    if (emptyP) emptyP.textContent = dataset.emptyBody;

    const models = new Set();
    for (const f of byRes[String(resolutions[0])].features) {
      for (const fc of f.properties.forecasts) if (fc.model) models.add(fc.model);
    }
    models.forEach((m) => visibleModels.add(m));
    renderModelToggle([...models].sort());

    addCellLayers();
    bindCellInteractions();
    map.on("zoomend", () => showRes(zoomToRes(map.getZoom())));

    showRes(resolutions[0]);
    const extent = boundsOf(fcFor(resolutions[0]).features);
    if (!extent.isEmpty()) map.fitBounds(extent, {padding: 40, maxZoom: 5, duration: 0});
    showRes(zoomToRes(map.getZoom()));
  }

  function panelError(err) {
    document.getElementById("panel-empty").innerHTML =
      "<h2 class=\"text-slate-800 font-semibold text-[15px] mb-1\">Couldn't load forecast data</h2>" +
      "<p class=\"text-sm leading-relaxed max-w-[240px]\">" +
      String(err && err.message ? err.message : err) +
      "</p>";
  }

  // data_basins.geojson or data_hexagons.geojson. The style has to finish
  // loading before we can add the source, so wait on both.
  Promise.all([
    fetch("https://cdn.apps.geoglows.org/fews4all/data_basins.geojson").then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }),
    new Promise((resolve) => map.once("load", resolve)),
  ])
    .then(([geo]) => buildFromGeojson(geo))
    .catch(panelError);
})();
