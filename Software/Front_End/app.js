/* app.js — renders flagged grid cells (or basins) on a Leaflet map and shows each
 * model's forecast when a cell is clicked, with zoom-driven resolution telescoping.
 *
 * In:  data.geojson (fetched) — one FeatureCollection, features tagged with `res`.
 * Out: the interactive map that index.html mounts.
 * Serve via a local server (VS Code "Go Live"); fetch() is blocked on file://.
 */

(function () {
  "use strict";

  const SEVERITY = {
    warning: { rank: 1, color: "#ffd21f", label: "Warning" },
    danger:  { rank: 2, color: "#ff8c00", label: "Danger" },
    extreme: { rank: 3, color: "#e0201b", label: "Extreme" },
  };
  const DEFAULT_COLOR = "#4da3ff";

  const RES_START_ZOOM = 3;
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
    ["peakDischargeCms", "Peak discharge"],
    ["issuedTime", "Issued"],
    ["startTime", "Start"],
    ["peakTime", "Peak"],
    ["endTime", "End"],
    ["historicalComparison", "Historical"],
  ];

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

  const map = L.map("map", { zoomControl: true, minZoom: 2, maxZoom: 20 });
  map.setView([20, 0], 2);

  const googleAttr = "Imagery &copy; Google · Grid: H3 (Uber H3)";
  const googleSub = ["mt0", "mt1", "mt2", "mt3"];

  const baseLayers = {
    "Google Hybrid": L.tileLayer("https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
      subdomains: googleSub, maxZoom: 20, attribution: googleAttr,
    }),
    "Google Satellite": L.tileLayer("https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
      subdomains: googleSub, maxZoom: 20, attribution: googleAttr,
    }),
    "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors · Grid: H3",
    }),
  };

  baseLayers["Google Hybrid"].addTo(map);
  L.control.layers(baseLayers, null, { position: "topright", collapsed: false }).addTo(map);

  const resControl = L.control({ position: "bottomleft" });
  resControl.onAdd = function () {
    const div = L.DomUtil.create("div", "");
    div.style.cssText =
      "background:rgba(255,255,255,.92);padding:3px 9px;border-radius:6px;" +
      "font:600 12px system-ui,sans-serif;color:#0f172a;box-shadow:0 1px 4px rgba(0,0,0,.35)";
    div.id = "res-readout";
    div.textContent = "H3 res —";
    return div;
  };
  resControl.addTo(map);
  function updateResReadout(res) {
    const el = document.getElementById("res-readout");
    if (el) el.textContent = "H3 res " + res;
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
             <iconify-icon icon="heroicons:clock" class="text-sm mt-0.5 not-italic shrink-0"></iconify-icon>
             <span>“${fc.historicalComparison}”</span>
           </div>` : "";
      return `
        <div class="bg-[#1b2a3a] border border-slate-700 border-l-4 rounded-[10px] px-3.5 py-3 mb-3" style="border-left-color:${sevColor(fc.severity)}">
          <div class="flex items-center justify-between mb-2">
            <span class="flex items-center gap-1.5 font-semibold text-[13px] capitalize text-slate-100">
              <iconify-icon icon="heroicons:chart-bar" class="text-sky-300"></iconify-icon>
              ${(fc.model || "model").replace(/_/g, " ")}
            </span>
          </div>
          <dl class="grid grid-cols-[128px_1fr] gap-x-2.5 gap-y-1 text-[12.5px]">${rows}</dl>
          ${note}
        </div>`;
    }).join("");

    const nModels = (props.models || []).length;
    const confidence = nModels >= 2
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800">
           <iconify-icon icon="heroicons:check-badge"></iconify-icon>${nModels} models agree</span>`
      : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">Single model</span>`;

    panelContent.innerHTML = `
      <h2 class="flex items-center gap-2 text-slate-800 font-semibold text-[15px] mb-0.5">
        <iconify-icon icon="heroicons:squares-2x2" style="color:${worstColor}"></iconify-icon>
        Cell ${props.cell_id}
        ${badge(worst, worstColor)}
      </h2>
      <div class="flex items-center gap-2 mb-3.5">
        ${confidence}
        <span class="text-slate-500 text-xs">${props.model_count} forecast${props.model_count === 1 ? "" : "s"} · worst-case above</span>
      </div>
      ${cards}`;
  }

  let resolutions = [];
  const byRes = {};

  // ---- Model filter (toggle at the top of the panel) ------------------------
  const visibleModels = new Set();
  const MODEL_LABELS = { flood_hub: "Flood Hub", geoglows: "GEOGLOWS" };
  function modelLabel(m) {
    return MODEL_LABELS[m] || m.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function worstSeverity(forecasts) {
    let best = "", bestRank = -1;
    for (const fc of forecasts) {
      const info = SEVERITY[(fc.severity || "").toLowerCase()];
      const r = info ? info.rank : -1;
      if (r > bestRank) { bestRank = r; best = (fc.severity || "").toLowerCase(); }
    }
    return best;
  }
  // Keep only forecasts from visible models; drop empty cells; recolour the rest.
  function visibleFeatures(features) {
    const out = [];
    for (const f of features) {
      const fcs = f.properties.forecasts.filter((x) => visibleModels.has(x.model));
      if (!fcs.length) continue;
      const modelNames = [...new Set(fcs.map((x) => x.model))];
      out.push({
        type: "Feature",
        geometry: f.geometry,
        properties: Object.assign({}, f.properties, {
          forecasts: fcs, model_count: fcs.length, severity: worstSeverity(fcs),
          models: modelNames, agree: modelNames.length >= 2,
        }),
      });
    }
    return out;
  }

  function baseStyle(feature) {
    const p = feature.properties;
    const c = sevColor(p.severity);
    // Colour = severity; outline = model agreement. Multi-model cells get a bold
    // dark ring + more opaque fill so higher-confidence areas stand out.
    if (p.agree) {
      return { color: "#0f172a", weight: 2.5, opacity: 1, fillColor: c, fillOpacity: 0.6 };
    }
    return { color: c, weight: 1, opacity: 0.85, fillColor: c, fillOpacity: 0.32 };
  }
  const HOVER_STYLE = { weight: 3, fillOpacity: 0.6 };
  const SELECT_STYLE = { weight: 4, fillOpacity: 0.6, color: "#ffffff" };

  let selected = null;
  let selectedGroup = null;

  function clearSelection() {
    if (selected && selectedGroup) selectedGroup.resetStyle(selected);
    selected = null;
    selectedGroup = null;
    panelContent.hidden = true;
    panelEmpty.hidden = false;
  }

  function bindFeature(feature, lyr, getGroup) {
    const p = feature.properties;
    lyr.bindTooltip(
      `Cell ${p.cell_id} · <b>${p.severity || "?"}</b> (${p.model_count} forecast${p.model_count === 1 ? "" : "s"})` +
      (p.agree ? ` · ✓ ${p.models.length} models` : ""),
      { sticky: true }
    );
    lyr.on({
      mouseover: () => { if (lyr !== selected) lyr.setStyle(HOVER_STYLE); },
      mouseout: () => { if (lyr !== selected) getGroup().resetStyle(lyr); },
      click: (e) => {
        L.DomEvent.stopPropagation(e);
        if (selected && selectedGroup) selectedGroup.resetStyle(selected);
        selected = lyr;
        selectedGroup = getGroup();
        lyr.setStyle(SELECT_STYLE);
        showCell(p);
        map.fitBounds(lyr.getBounds(), { maxZoom: 12, padding: [40, 40] });
      },
    });
  }

  const layers = {};

  function layerFor(res) {
    if (layers[res]) return layers[res];
    let group;
    group = L.geoJSON(
      { type: "FeatureCollection", features: visibleFeatures(byRes[String(res)].features) },
      {
        style: baseStyle,
        onEachFeature: (feature, lyr) => bindFeature(feature, lyr, () => group),
      }
    );
    layers[res] = group;
    return group;
  }

  function zoomToRes(zoom) {
    let chosen = resolutions[0];
    resolutions.forEach((r, i) => {
      if (zoom >= RES_START_ZOOM + i * RES_ZOOM_STEP) chosen = r;
    });
    return chosen;
  }

  let currentRes = null;
  let activeLayer = null;

  function showRes(res) {
    if (res === currentRes) return;
    if (activeLayer) map.removeLayer(activeLayer);
    clearSelection();
    activeLayer = layerFor(res).addTo(map);
    currentRes = res;
    updateResReadout(res);
  }

  // Rebuild the current layer after a model toggle (cached layers are now stale).
  function refreshLayers() {
    for (const k in layers) delete layers[k];
    const res = currentRes;
    if (activeLayer) { map.removeLayer(activeLayer); activeLayer = null; }
    currentRes = null;
    if (res != null) showRes(res);
  }

  function renderModelToggle(models) {
    const el = document.getElementById("model-toggle");
    if (!el || models.length < 2) { if (el) el.innerHTML = ""; return; }
    el.innerHTML =
      '<div class="relative mb-3 pb-3 border-b border-slate-200">' +
      '  <button id="model-dd-btn" type="button" class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-300 bg-white text-[13px] font-medium text-slate-700 hover:bg-slate-50">' +
      '    <span class="flex items-center gap-1.5"><iconify-icon icon="heroicons:funnel" class="text-sky-500"></iconify-icon><span id="model-dd-label">All models</span></span>' +
      '    <iconify-icon id="model-dd-caret" icon="heroicons:chevron-down" class="text-slate-400 transition-transform"></iconify-icon>' +
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
    document.addEventListener("click", (e) => { if (!root.contains(e.target)) closeMenu(); });

    el.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) visibleModels.add(cb.dataset.model);
        else visibleModels.delete(cb.dataset.model);
        updateLabel();
        refreshLayers();
      });
    });
    updateLabel();
  }

  function buildFromGeojson(geo) {
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
      byRes[String(r)] = { type: "FeatureCollection", features: grouped[r] || [] };
    }

    if (!resolutions.some((r) => byRes[String(r)].features.length)) {
      document.getElementById("panel-empty").innerHTML =
        "<h2>No cell data</h2><p>Run <code>python csv_to_json_vgrid.py</code> then " +
        "<code>python build_cells_h3.py</code> to generate <code>data.geojson</code>.</p>";
      return;
    }

    const models = new Set();
    for (const f of byRes[String(resolutions[0])].features) {
      for (const fc of f.properties.forecasts) if (fc.model) models.add(fc.model);
    }
    models.forEach((m) => visibleModels.add(m));
    renderModelToggle([...models].sort());

    map.on("zoomend", () => showRes(zoomToRes(map.getZoom())));
    map.on("click", clearSelection);

    showRes(resolutions[0]);
    map.fitBounds(activeLayer.getBounds(), { padding: [40, 40], maxZoom: 6 });
    showRes(zoomToRes(map.getZoom()));
  }

  fetch("data.geojson")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(buildFromGeojson)
    .catch((err) => {
      document.getElementById("panel-empty").innerHTML =
        "<h2>Couldn't load data.geojson</h2><p>" + String(err) + "</p>" +
        "<p>Open this page through a local server (VS Code “Go Live”), not by " +
        "double-clicking the file — browsers block <code>fetch()</code> on " +
        "<code>file://</code>.</p>";
    });
})();
