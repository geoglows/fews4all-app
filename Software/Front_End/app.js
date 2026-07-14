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
    none:     { rank: 0, color: "#7d8b99", label: "None" },
    minor:    { rank: 1, color: "#ffe08a", label: "Minor" },
    moderate: { rank: 2, color: "#ffc24d", label: "Moderate" },
    major:    { rank: 3, color: "#ff8a3d", label: "Major" },
    severe:   { rank: 4, color: "#ff4d4d", label: "Severe" },
    extreme:  { rank: 5, color: "#b026ff", label: "Extreme" },
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
    .join("");

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

    panelContent.innerHTML = `
      <h2 class="flex items-center gap-2 text-slate-800 font-semibold text-[15px] mb-0.5">
        <iconify-icon icon="heroicons:squares-2x2" style="color:${worstColor}"></iconify-icon>
        Cell ${props.cell_id}
        ${badge(worst, worstColor)}
      </h2>
      <p class="text-slate-500 text-xs mb-3.5">${props.model_count} forecast${props.model_count === 1 ? "" : "s"} in this cell · worst-case shown above</p>
      ${cards}`;
  }

  let resolutions = [];
  const byRes = {};

  function baseStyle(feature) {
    const c = sevColor(feature.properties.severity);
    return { color: c, weight: 1.5, opacity: 1, fillColor: c, fillOpacity: 0.4 };
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
      `Cell ${p.cell_id} · <b>${p.severity || "?"}</b> (${p.model_count} forecast${p.model_count === 1 ? "" : "s"})`,
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
    group = L.geoJSON(byRes[String(res)], {
      style: baseStyle,
      onEachFeature: (feature, lyr) => bindFeature(feature, lyr, () => group),
    });
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
