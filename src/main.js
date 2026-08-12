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

  // ---- Dataset switcher + basin-context state (logic further down) -----------
  const CDN = "https://cdn.apps.geoglows.org/fews4all/";
  const DATASETS_MENU = [
    {key: "basins", label: "Basins", file: "data_basins.geojson"},
    {key: "h3", label: "H3 cells", file: "data_h3cells.geojson"},
    {key: "s2", label: "S2 cells", file: "data_s2cells.geojson"},
  ];
  let currentDatasetKey = "basins";
  let datasetControlEl = null;
  let contextControlEl = null;
  let interactionsBound = false;      // cell hover/click handlers bound once

  // Streams + districts context — only shown for the basins dataset, only for the
  // selected basin. `data` is cached once fetched; `on` is the toggle state.
  const ctx = {
    streams: {file: "data_basin_streams.geojson", data: null, on: false, loading: false},
    districts: {file: "data_basin_districts.geojson", data: null, on: false, loading: false},
  };
  let selectedBasinId = null;
  let zoomExtent = "basin";           // basin | river | district
  // MapLibre zoom sits ~1 below Leaflet, so the "show all tributaries" zoom is a
  // step lower than the local build's 10.
  const STREAM_ALL_ZOOM = 9;
  function streamMinOrder(z) {
    return z >= STREAM_ALL_ZOOM ? 1 : Math.max(1, STREAM_ALL_ZOOM - Math.floor(z) + 1);
  }

  // Flood Hub flash-flood polygons — a global overlay (available in every dataset
  // view) toggled from the Flood Hub tile in the side panel. Two polygon types:
  // "highly_likely" and "likely".
  let flashOn = false;
  let flashData = null;
  let flashLoading = false;
  const FLASH_SRC = "flash-src";
  const FLASH_FILL = "flash-fill";
  const FLASH_LAYERS = [FLASH_FILL, "flash-line-high", "flash-line-likely"];

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

  // Basemap set mirrored from the River Forecast System companion app. All are free,
  // no-key raster tile services. Esri/USGS serve tiles in {z}/{y}/{x} order, so their
  // thumbnails use z/y/x too. (Esri's "Environment" basemap is a vector style needing
  // an API key, so it's intentionally left out for now.)
  const CARTO_ATTR = `${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`;
  const ESRI_ATTR = '&copy; <a href="https://www.esri.com">Esri</a>';
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
  const cartoThumb = (style) => `https://a.basemaps.cartocdn.com/${style}/${THUMB.z}/${THUMB.x}/${THUMB.y}.png`;
  const esriThumb = (svc) => `${ESRI}/${svc}/MapServer/tile/${THUMB.z}/${THUMB.y}/${THUMB.x}`;

  const BASEMAPS = [
    {
      id: "carto-light",
      name: "Light grey (CARTO)",
      thumb: cartoThumb("light_all"),
      source: {
        type: "raster",
        tiles: shards(["a", "b", "c", "d"], "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"),
        tileSize: 256, maxzoom: 20, attribution: CARTO_ATTR,
      },
    },
    {
      id: "carto-dark",
      name: "Dark (CARTO)",
      thumb: cartoThumb("dark_all"),
      source: {
        type: "raster",
        tiles: shards(["a", "b", "c", "d"], "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"),
        tileSize: 256, maxzoom: 20, attribution: CARTO_ATTR,
      },
    },
    {
      id: "osm",
      name: "Streets (OSM)",
      thumb: `https://a.tile.openstreetmap.org/${THUMB.z}/${THUMB.x}/${THUMB.y}.png`,
      source: {
        type: "raster",
        tiles: shards(["a", "b", "c"], "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"),
        tileSize: 256, maxzoom: 19, attribution: OSM_ATTR,
      },
    },
    {
      id: "esri-imagery",
      name: "Satellite (Esri)",
      thumb: esriThumb("World_Imagery"),
      source: {
        type: "raster",
        tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256, maxzoom: 19,
        attribution: `${ESRI_ATTR}, Maxar, Earthstar Geographics, and the GIS User Community`,
      },
    },
    {
      id: "esri-topo",
      name: "Topographic (Esri)",
      thumb: esriThumb("World_Topo_Map"),
      source: {
        type: "raster",
        tiles: [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256, maxzoom: 19,
        attribution: `${ESRI_ATTR}, HERE, Garmin, FAO, NOAA, USGS, ${OSM_ATTR}, and the GIS User Community`,
      },
    },
    {
      id: "usgs-topo",
      name: "Topographic (USGS)",
      thumb: `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${THUMB.z}/${THUMB.y}/${THUMB.x}`,
      source: {
        type: "raster",
        tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 16,
        attribution: 'Tiles courtesy of the <a href="https://www.usgs.gov/">U.S. Geological Survey</a>',
      },
    },
  ];
  const DEFAULT_BASEMAP = "carto-light";

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

  // ---- Shared dropdown controls (top-right column) --------------------------
  // Each is an icon button that opens a panel to its left. Opening one closes the
  // others; the button's `title` shows the tool's name on hover.
  const openDropdowns = [];
  function closeOtherDropdowns(self) {
    openDropdowns.forEach((close) => { if (close !== self) close(); });
  }

  function dropdownControl(opts) {
    // opts: { iconName, title, panelStyle?, render(panel), onReady?(container) }
    let container = null, panel = null, closeOnDoc = null;
    const close = () => { if (panel && !panel.hidden) panel.hidden = true; };
    function toggle() {
      if (panel.hidden) { closeOtherDropdowns(close); panel.hidden = false; }
      else close();
    }
    return {
      onAdd() {
        container = document.createElement("div");
        container.className = "maplibregl-ctrl";
        container.style.cssText = "position:relative;background:#fff;border-radius:4px;box-shadow:0 0 0 2px rgb(0 0 0 / .1)";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("aria-label", opts.title);
        btn.style.cssText = "display:flex;align-items:center;justify-content:center;width:29px;height:29px;cursor:pointer;background:none;border:0";
        btn.innerHTML = icon(opts.iconName, "text-[19px] text-slate-700");
        panel = document.createElement("div");
        panel.hidden = true;
        panel.style.cssText = "position:absolute;top:0;right:34px;background:#fff;border-radius:6px;" +
          "box-shadow:0 1px 6px rgb(0 0 0 / .3);" + (opts.panelStyle || "padding:6px");
        // Name label that pops up to the left on hover (native title is too slow).
        const tip = document.createElement("div");
        tip.textContent = opts.title;
        tip.style.cssText = "position:absolute;right:36px;top:50%;transform:translateY(-50%);white-space:nowrap;" +
          "background:#0f172a;color:#fff;font:600 11px system-ui,sans-serif;padding:3px 7px;border-radius:5px;" +
          "pointer-events:none;opacity:0;transition:opacity .1s;box-shadow:0 1px 4px rgb(0 0 0 / .3)";
        btn.addEventListener("mouseenter", () => { if (panel.hidden) tip.style.opacity = "1"; });
        btn.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
        container.append(btn, panel, tip);
        opts.render(panel);
        btn.addEventListener("click", toggle);
        container.addEventListener("click", (e) => e.stopPropagation());
        closeOnDoc = () => close();
        document.addEventListener("click", closeOnDoc);
        openDropdowns.push(close);
        if (opts.onReady) opts.onReady(container, panel);
        return container;
      },
      onRemove() {
        document.removeEventListener("click", closeOnDoc);
        const i = openDropdowns.indexOf(close);
        if (i >= 0) openDropdowns.splice(i, 1);
        container.remove();
      },
    };
  }

  // Base-map switcher: a gallery of thumbnails.
  function basemapControl() {
    return dropdownControl({
      iconName: "square-3-stack-3d",
      title: "Base Map Layers",
      panelStyle: "padding:0 4px 4px",
      render(panel) {
        panel.innerHTML = BASEMAPS.map((b) =>
          `<button type="button" class="basemap-row" data-basemap="${b.id}">` +
          `<img src="${b.thumb}" alt="" loading="lazy"><span>${b.name}</span></button>`).join("");
        const rows = [...panel.querySelectorAll(".basemap-row")];
        const highlight = (id) => rows.forEach((r) => r.classList.toggle("basemap-selected", r.dataset.basemap === id));
        rows.forEach((r) => r.addEventListener("click", () => {
          BASEMAPS.forEach((b) => map.setLayoutProperty(b.id, "visibility", b.id === r.dataset.basemap ? "visible" : "none"));
          highlight(r.dataset.basemap);
        }));
        highlight(DEFAULT_BASEMAP);
      },
    });
  }

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

  const MODEL_HOME = {
    geoglows: "https://hydroviewer.geoglows.org/",
    flood_hub: "https://sites.research.google/floods/",
  };
  const PANEL_MODELS = ["geoglows", "flood_hub"];

  // The panel always lists both models. A model shows a full card when the selected
  // feature carries its forecast, otherwise a shrunken "standby" card (name linked to
  // its own app). The Flood Hub tile always carries the flash-flood polygon toggle.
  function renderPanel(props) {
    panelEmpty.hidden = true;
    panelContent.hidden = false;
    const selected = !!props;

    const badge = (sev, color) =>
      `<span class="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold capitalize text-[#10161d]" style="background:${color}">${sev || "—"}</span>`;

    function modelTitle(m, fc) {
      const label = modelLabel(m);
      const href = (fc && modelLink(fc)) || MODEL_HOME[m];
      return `<a href="${href}" target="_blank" rel="noopener noreferrer" title="Open ${label}"
         class="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 hover:underline">${label}${
        icon("arrow-top-right-on-square", "text-[11px] opacity-80")}</a>`;
    }
    const flashToggle =
      `<label class="flex items-center gap-1.5 text-[11px] font-medium text-slate-300 cursor-pointer select-none shrink-0" title="Toggle Flood Hub flash-flood polygons">` +
      `<input type="checkbox" id="flash-toggle" class="accent-violet-500 w-3.5 h-3.5"${flashOn ? " checked" : ""}>Flash floods</label>`;

    function modelTile(m) {
      const fcs = selected ? props.forecasts.filter((f) => f.model === m) : [];
      const has = fcs.length > 0;
      const head =
        `<div class="flex items-center justify-between gap-2 mb-1.5">` +
        `<span class="flex items-center gap-1.5 font-semibold text-[13px] capitalize ${has ? "text-slate-100" : "text-slate-400"}">` +
        icon("chart-bar", has ? "text-sky-300" : "text-slate-500") + modelTitle(m, fcs[0]) + `</span>` +
        (m === "flood_hub" ? flashToggle : "") + `</div>`;
      if (!has) {
        return `<div class="bg-[#141e2a] border border-slate-700/60 rounded-[10px] px-3.5 py-2.5 mb-3">` + head +
          `<div class="text-slate-500 text-[11px]">On standby — ${selected ? "no forecast for this area" : "no area selected"}.</div></div>`;
      }
      const body = fcs.map((fc, i) => {
        const rows = FIELD_LABELS.filter(([k]) => k !== "historicalComparison").map(([k, label]) => {
          const dt = `<dt class="text-slate-400">${label}</dt>`;
          return k === "severity"
            ? `${dt}<dd class="m-0">${badge(fc.severity, sevColor(fc.severity))}</dd>`
            : `${dt}<dd class="m-0 text-slate-100 break-words">${fmtValue(k, fc[k])}</dd>`;
        }).join("");
        const note = fc.historicalComparison
          ? `<div class="flex items-start gap-1.5 text-xs text-slate-400 italic mt-2">${icon("clock", "text-sm mt-0.5")}<span>“${fc.historicalComparison}”</span></div>`
          : "";
        return `<dl class="grid grid-cols-[128px_1fr] gap-x-2.5 gap-y-1 text-[12.5px]${i ? " mt-2 pt-2 border-t border-slate-700/50" : ""}">${rows}</dl>${note}`;
      }).join("");
      return `<div class="bg-[#1b2a3a] border border-slate-700 border-l-4 rounded-[10px] px-3.5 py-3 mb-3" style="border-left-color:${sevColor(worstSeverity(fcs))}">` +
        head + body + `</div>`;
    }

    // The "All models" filter also controls which tiles appear here.
    const tiles = PANEL_MODELS.filter((m) => visibleModels.has(m)).map(modelTile).join("");

    let head;
    if (selected) {
      const worst = (props.severity || "").toLowerCase();
      const worstColor = sevColor(worst);
      const nModels = (props.models || []).length;
      const confidence = nModels >= 2
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800">${icon("check-badge")}${nModels} models agree</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">Single model</span>`;
      head =
        `<h2 class="flex items-center gap-2 text-slate-800 font-semibold text-[15px] mb-0.5">` +
        `<span class="inline-flex" style="color:${worstColor}">${icon("squares-2x2")}</span> ${unitLabel(props)} ${props.cell_id} ${badge(worst, worstColor)}</h2>` +
        `<div class="flex items-center gap-2 mb-3.5">${confidence}` +
        `<span class="text-slate-500 text-xs">${props.model_count} forecast${props.model_count === 1 ? "" : "s"} · worst-case above</span></div>`;
    } else {
      head = `<div class="text-slate-500 text-[13px] mb-3.5">Select a highlighted ${dataset.unit.toLowerCase()} on the map to see its forecasts.</div>`;
    }

    const imp = selected ? props.impact : null;
    const impTile = (name, label, value, span) =>
      `<div class="${span ? "col-span-2 " : ""}rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">` +
      `<div class="flex items-center gap-1 text-slate-400 text-[10px] font-semibold uppercase tracking-wide mb-1">${icon(name, "text-[12px]")}${label}</div>` +
      `<div class="text-slate-800 font-bold text-[15px] leading-none">${value}</div></div>`;
    const impactHtml = imp
      ? `<div class="mt-4 pt-3 border-t border-slate-200"><h3 class="flex items-center gap-1.5 text-slate-800 font-semibold text-[11px] uppercase tracking-wider mb-2">${icon("exclamation-triangle", "text-amber-500 text-sm")}Impact</h3>` +
        `<div class="grid grid-cols-2 gap-2">` +
        impTile("building-office-2", "Buildings", fmtCount(imp.buildings)) +
        impTile("rectangle-group", "Farmland", fmtCount(imp.farmland_m2 / 1e6) + " km²") +
        impTile("map", "Roads", fmtCount(imp.highway_km) + " km") +
        impTile("arrows-right-left", "Railways", fmtCount(imp.railway_km) + " km") +
        impTile("users", "Population", fmtCount(imp.population), true) +
        `</div><p class="text-slate-400 text-[10px] mt-1.5">Totals across the whole basin.</p></div>`
      : "";

    panelContent.innerHTML = head + tiles + impactHtml;

    const cb = document.getElementById("flash-toggle");
    if (cb) cb.addEventListener("change", () => setFlashOn(cb.checked));
  }

  let resolutions = [];
  const byRes = {};

  // ---- Model filter (toggle at the top of the panel) ------------------------
  const visibleModels = new Set();
  const MODEL_LABELS = {geoglows: "GEOGLOWS", flood_hub: "Flood Hub"};

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
    selectedBasinId = null;
    refreshContext();                 // hide any per-basin context
    renderPanel(null);                // standby tiles (both models still listed)
  }

  function selectFeature(id) {
    const feature = featureById.get(id);
    if (!feature) return;
    setFeatureState(selectedId, {selected: false});
    selectedId = id;
    setFeatureState(selectedId, {selected: true});
    renderPanel(feature.properties);
    selectedBasinId = String(feature.properties.cell_id);
    refreshContext();                 // reveal this basin's streams/districts (if armed)
    zoomToSelection(feature);          // frame per the "Zoom to" choice
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

  function buildFromGeojson(geo, fit) {
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
    // Order the filter to match the panel tiles (GEOGLOWS first), unknowns after.
    renderModelToggle([...models].sort((a, b) => {
      const ia = PANEL_MODELS.indexOf(a), ib = PANEL_MODELS.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    }));

    addCellLayers();
    // Bind hover/click once, now that the fill layer first exists; the layer id is
    // reused on every dataset switch so the delegated handlers keep working.
    if (!interactionsBound) { bindCellInteractions(); interactionsBound = true; }
    raiseFlash();        // flash polygons stay above the freshly (re)added cells

    showRes(resolutions[0]);
    if (fit) {
      const extent = boundsOf(fcFor(resolutions[0]).features);
      if (!extent.isEmpty()) map.fitBounds(extent, {padding: 40, maxZoom: 5, duration: 0});
    }
    showRes(zoomToRes(map.getZoom()));
  }

  function panelError(err) {
    panelContent.hidden = true;
    panelEmpty.hidden = false;
    document.getElementById("panel-empty").innerHTML =
      "<h2 class=\"text-slate-800 font-semibold text-[15px] mb-1\">Couldn't load forecast data</h2>" +
      "<p class=\"text-sm leading-relaxed max-w-[240px]\">" +
      String(err && err.message ? err.message : err) +
      "</p>";
  }

  // ---- Flood Hub flash-flood polygons (global overlay) ----------------------

  function loadFlash(cb) {
    if (flashData) return cb(flashData);
    if (flashLoading) return;
    flashLoading = true;
    fetch(CDN + "data_flash_floods.geojson")
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => { flashData = data; flashLoading = false; cb(data); })
      .catch((err) => { flashLoading = false; console.warn("flash floods:", err.message); cb(null); });
  }

  // Violet, distinct from severity (yellow/orange/red), streams (cyan) and districts
  // (magenta). "highly_likely" = darker fill + solid outline; "likely" = lighter fill
  // + dashed outline.
  function ensureFlashLayers() {
    if (map.getSource(FLASH_SRC) || !flashData) return;
    map.addSource(FLASH_SRC, {type: "geojson", data: flashData});
    map.addLayer({
      id: FLASH_FILL, type: "fill", source: FLASH_SRC,
      paint: {
        "fill-color": ["match", ["get", "polygon_type"], "highly_likely", "#6d28d9", "#a78bfa"],
        "fill-opacity": ["match", ["get", "polygon_type"], "highly_likely", 0.5, 0.32],
      },
    });
    map.addLayer({
      id: "flash-line-high", type: "line", source: FLASH_SRC,
      filter: ["==", ["get", "polygon_type"], "highly_likely"],
      paint: {"line-color": "#4c1d95", "line-width": 1.8, "line-opacity": 0.95},
    });
    map.addLayer({
      id: "flash-line-likely", type: "line", source: FLASH_SRC,
      filter: ["==", ["get", "polygon_type"], "likely"],
      paint: {"line-color": "#7c3aed", "line-width": 1.1, "line-opacity": 0.9, "line-dasharray": [2, 1.5]},
    });
  }

  function setFlashOn(on) {
    flashOn = on;
    if (!on) {
      FLASH_LAYERS.forEach((id) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none"); });
      return;
    }
    loadFlash((data) => {
      if (!data) { flashOn = false; const cb = document.getElementById("flash-toggle"); if (cb) cb.checked = false; return; }
      ensureFlashLayers();
      FLASH_LAYERS.forEach((id) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible"); });
    });
  }

  // Keep the flash polygons above the cell layers after a dataset (re)build.
  function raiseFlash() {
    if (map.getLayer(FLASH_FILL)) FLASH_LAYERS.forEach((id) => map.moveLayer(id));
  }

  // ---- Dataset switching (basins / h3 / s2) ---------------------------------

  function teardown() {
    clearSelection();
    setHover(null);
    tooltip.remove();
    removeContext();
    for (const id of [LINE, FILL]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
    for (const k in fcByRes) delete fcByRes[k];
    for (const k in byRes) delete byRes[k];
    featureById.clear();
    resolutions = [];
    currentRes = null;
  }

  function loadDataset(key, fit) {
    const ds = DATASETS_MENU.find((d) => d.key === key);
    if (!ds) return;
    currentDatasetKey = key;
    highlightDataset();
    updateContextControlsVisibility();   // context is basins-only
    teardown();
    fetch(CDN + ds.file)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status + " for " + ds.file); return r.json(); })
      .then((geo) => buildFromGeojson(geo, fit))
      .catch(panelError);
  }

  function onZoomEnd() {
    showRes(zoomToRes(map.getZoom()));
    updateStreamsLOD();                  // stream LOD depends on zoom
  }

  // ---- Basin context: streams + districts (MapLibre sources/layers) ---------

  const ctxSrc = (which) => "ctx-" + which + "-src";
  const ctxLayers = (which) => which === "streams"
    ? ["ctx-streams-casing", "ctx-streams-line"]
    : ["ctx-districts-casing", "ctx-districts-line"];

  function loadCtx(which, cb) {
    const c = ctx[which];
    if (c.data) return cb(c.data);
    if (c.loading) return;
    c.loading = true;
    fetch(CDN + c.file)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => { c.data = data; c.loading = false; cb(data); })
      .catch((err) => { c.loading = false; console.warn(which + ":", err.message); cb(null); });
  }

  // Add the source + layers for a context type once its data is available. Streams
  // get a dark casing + a bright cyan line (in-basin solid-ish, downstream lighter);
  // districts get a dark casing + a dashed magenta outline.
  function ensureCtxLayers(which) {
    if (currentDatasetKey !== "basins" || map.getSource(ctxSrc(which)) || !ctx[which].data) return;
    map.addSource(ctxSrc(which), {type: "geojson", data: ctx[which].data});
    if (which === "streams") {
      map.addLayer({
        id: "ctx-streams-casing", type: "line", source: ctxSrc("streams"),
        layout: {"line-cap": "round"},
        paint: {"line-color": "#0b1220", "line-width": 5, "line-opacity": 0.85},
      });
      map.addLayer({
        id: "ctx-streams-line", type: "line", source: ctxSrc("streams"),
        layout: {"line-cap": "round"},
        paint: {
          "line-color": ["match", ["get", "reach"], "downstream", "#7dd3fc", "#22d3ee"],
          "line-width": ["match", ["get", "reach"], "downstream", 2, 2.8],
          "line-opacity": ["match", ["get", "reach"], "downstream", 0.9, 1],
        },
      });
    } else {
      map.addLayer({
        id: "ctx-districts-casing", type: "line", source: ctxSrc("districts"),
        layout: {"line-cap": "round"},
        paint: {"line-color": "#0b1220", "line-width": 5, "line-opacity": 0.8},
      });
      map.addLayer({
        id: "ctx-districts-line", type: "line", source: ctxSrc("districts"),
        paint: {"line-color": "#e879f9", "line-width": 2.5, "line-opacity": 1, "line-dasharray": [2, 1.5]},
      });
    }
  }

  // Show a context type's layers filtered to the selected basin (+ stream LOD),
  // or hide them when it's off / not a basin view / nothing selected.
  function updateCtx(which) {
    const active = ctx[which].on && currentDatasetKey === "basins" && selectedBasinId;
    if (!active) {
      ctxLayers(which).forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      });
      return;
    }
    ensureCtxLayers(which);
    const base = ["in", selectedBasinId, ["get", "basins"]];
    const filter = which === "streams"
      ? ["all", base, [">=", ["get", "ord"], streamMinOrder(map.getZoom())]]
      : base;
    ctxLayers(which).forEach((id) => {
      if (map.getLayer(id)) {
        map.setFilter(id, filter);
        map.setLayoutProperty(id, "visibility", "visible");
      }
    });
  }

  function setCtxOn(which, on) {
    ctx[which].on = on;
    if (on) loadCtx(which, (data) => { if (!data) { ctx[which].on = false; return; } updateCtx(which); });
    else updateCtx(which);
  }

  function refreshContext() {
    updateCtx("streams");
    updateCtx("districts");
  }

  function updateStreamsLOD() {
    if (ctx.streams.on) updateCtx("streams");
  }

  function removeContext() {
    ["streams", "districts"].forEach((which) => {
      ctxLayers(which).forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(ctxSrc(which))) map.removeSource(ctxSrc(which));
    });
  }

  // ---- Zoom extent: basin / river / district --------------------------------

  function zoomToSelection(feature) {
    const basinFit = () => map.fitBounds(boundsOf([feature]), {maxZoom: 11, padding: 40});
    if (zoomExtent === "river") return fitContext("streams", feature, basinFit);
    if (zoomExtent === "district") return fitContext("districts", feature, basinFit);
    basinFit();
  }

  function fitContext(which, feature, fallback) {
    loadCtx(which, (data) => {
      if (!data) return fallback();
      const id = String(feature.properties.cell_id);
      const feats = data.features.filter((f) => ((f.properties && f.properties.basins) || []).includes(id));
      if (!feats.length) return fallback();
      const b = boundsOf(feats);
      if (b.isEmpty()) return fallback();
      map.fitBounds(b, {maxZoom: 12, padding: 40});
    });
  }

  // ---- Controls: dataset toggle + basin-context panel -----------------------

  function highlightDataset() {
    if (!datasetControlEl) return;
    datasetControlEl.querySelectorAll(".ds-row").forEach((b) => {
      const on = b.dataset.ds === currentDatasetKey;
      b.style.background = on ? "#0284c7" : "transparent";
      b.style.color = on ? "#fff" : "#334155";
    });
  }

  // Data-layer picker: Basins / H3 / S2.
  function datasetControl() {
    return dropdownControl({
      iconName: "squares-2x2",
      title: "Flagged Area Type",
      panelStyle: "padding:4px;min-width:118px;font:600 12px system-ui,sans-serif",
      render(panel) {
        panel.innerHTML = DATASETS_MENU.map((d) =>
          `<button type="button" data-ds="${d.key}" class="ds-row" style="display:block;width:100%;text-align:left;` +
          `border:0;background:transparent;padding:6px 9px;border-radius:5px;cursor:pointer;color:#334155;white-space:nowrap">${d.label}</button>`).join("");
        panel.querySelectorAll(".ds-row").forEach((b) => b.addEventListener("click", () => {
          panel.hidden = true;
          if (b.dataset.ds !== currentDatasetKey) loadDataset(b.dataset.ds, false);
        }));
      },
      onReady(container) { datasetControlEl = container; highlightDataset(); },
    });
  }

  function updateContextControlsVisibility() {
    if (contextControlEl) contextControlEl.style.display = currentDatasetKey === "basins" ? "" : "none";
  }

  // Selected-basin context: streams/districts overlays + zoom-to extent.
  function contextControl() {
    return dropdownControl({
      iconName: "rectangle-group",
      title: "Context Layers",
      panelStyle: "padding:6px 9px;font:600 12px system-ui,sans-serif;color:#0f172a;min-width:118px",
      render(panel) {
        const head = (t) => `<div style="font-size:10px;color:#64748b;text-transform:uppercase;` +
          `letter-spacing:.04em;margin-bottom:4px">${t}</div>`;
        panel.innerHTML =
          head("Selected basin") +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:2px">' +
          '<input type="checkbox" id="ctx-streams" style="accent-color:#22d3ee">Streams</label>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="ctx-districts" style="accent-color:#e879f9">Districts</label>' +
          '<div style="margin-top:6px">' + head("Zoom to") +
          ["basin", "river", "district"].map((v, i) =>
            `<label style="display:flex;align-items:center;gap:6px;cursor:pointer${i < 2 ? ";margin-bottom:2px" : ""}">` +
            `<input type="radio" name="zoomext" value="${v}"${v === "basin" ? " checked" : ""} ` +
            `style="accent-color:#0284c7">${v[0].toUpperCase() + v.slice(1)}</label>`).join("") +
          "</div>";
        panel.querySelector("#ctx-streams").addEventListener("change", (e) => setCtxOn("streams", e.target.checked));
        panel.querySelector("#ctx-districts").addEventListener("change", (e) => setCtxOn("districts", e.target.checked));
        panel.querySelectorAll('input[name="zoomext"]').forEach((rb) => rb.addEventListener("change", () => {
          if (!rb.checked) return;
          zoomExtent = rb.value;
          const f = featureById.get(selectedId);
          if (f) zoomToSelection(f);
        }));
      },
      onReady(container) { contextControlEl = container; updateContextControlsVisibility(); },
    });
  }

  // ---- Boot -----------------------------------------------------------------

  map.once("load", () => {
    map.on("zoomend", onZoomEnd);
    // Three stacked dropdowns in the top-right column.
    map.addControl(basemapControl(), "top-right");
    map.addControl(datasetControl(), "top-right");
    map.addControl(contextControl(), "top-right");
    loadDataset("basins", true);           // interactions bind on first dataset build
  });
})();
