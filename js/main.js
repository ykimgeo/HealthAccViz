(function () {
  "use strict";

  // ----- map -----
  var map = L.map("map").setView([35.227, -80.843], 10);

  // Esri World Light Gray Canvas: a muted, label-free basemap that suits a choropleth.
  // Note the ArcGIS tile order is {z}/{y}/{x}, not {z}/{x}/{y}.
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 16,
    maxZoom: 18,
    attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
  }).addTo(map);

  // ----- helpers -----
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fmt(value, opts) {
    if (value === null || value === undefined) return null;
    return value.toLocaleString("en-US", opts || {});
  }

  function setStatus(text, isError) {
    var s = document.getElementById("data-status");
    s.textContent = text;
    s.classList.toggle("is-error", !!isError);
  }

  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.json();
    });
  }

  // ----- NPA layer -----
  var NPA_STYLE = { color: "#4b6e8c", weight: 1, fillColor: "#4b6e8c", fillOpacity: 0.18 };
  var NPA_HOVER = { weight: 2, fillOpacity: 0.38 };
  var NPA_SELECTED = { color: "#0d2f4a", weight: 3, fillOpacity: 0.3 };

  var npaLayer = null;
  var selected = null;

  function detailRows(p) {
    return [
      ["Population (2020)", fmt(p.pop_2020), ""],
      ["Population density (2020)", fmt(p.pop_density_2020, { maximumFractionDigits: 1 }), " people/acre"],
      ["Aged 65+ (2024)", fmt(p.older_adult_pct_2024, { maximumFractionDigits: 1 }), "%"],
      ["Household income (2024)", fmt(p.household_income_2024), ""],
    ];
  }

  function showDetail(p) {
    var box = document.getElementById("npa-detail");
    box.replaceChildren();
    box.appendChild(el("p", "detail-title", p.npa_name));
    var dl = el("dl", "detail-list");
    detailRows(p).forEach(function (row) {
      dl.appendChild(el("dt", null, row[0]));
      var dd;
      if (row[1] === null) {
        dd = el("dd", "is-missing", "No data");
      } else {
        var prefix = row[0].indexOf("income") >= 0 ? "$" : "";
        dd = el("dd", null, prefix + row[1] + row[2]);
      }
      dl.appendChild(dd);
    });
    box.appendChild(dl);
  }

  function selectNPA(layer) {
    if (selected) npaLayer.resetStyle(selected);
    selected = layer;
    layer.setStyle(NPA_SELECTED);
    layer.bringToFront();
    showDetail(layer.feature.properties);
  }

  function addNPA(geojson) {
    npaLayer = L.geoJSON(geojson, {
      style: function () { return NPA_STYLE; },
      onEachFeature: function (feature, layer) {
        layer.bindTooltip(feature.properties.npa_name, { sticky: true });
        layer.on({
          mouseover: function () { if (layer !== selected) layer.setStyle(NPA_HOVER); },
          mouseout: function () { if (layer !== selected) npaLayer.resetStyle(layer); },
          click: function () { selectNPA(layer); },
        });
      },
    }).addTo(map);
    map.fitBounds(npaLayer.getBounds());
  }

  // ----- hospital layer -----
  map.createPane("hospitals");
  map.getPane("hospitals").style.zIndex = 450; // above polygons, below tooltips/popups

  function hospitalRadius(beds) {
    if (beds === null || beds === undefined) return 4;
    return Math.min(4 + Math.sqrt(beds) * 0.35, 18);
  }

  function hospitalTooltip(p) {
    var box = el("div");
    box.appendChild(el("div", "tip-title", p.name));
    box.appendChild(el("div", "tip-sub", p.type + " · " + p.status));
    box.appendChild(el("div", "tip-sub", p.beds === null ? "Beds: no data" : "Beds: " + fmt(p.beds)));
    box.appendChild(el("div", "tip-sub", p.county + ", " + p.state));
    return box;
  }

  function addHospitals(geojson) {
    return L.geoJSON(geojson, {
      pointToLayer: function (feature, latlng) {
        var p = feature.properties;
        var open = p.status === "OPEN";
        return L.circleMarker(latlng, {
          pane: "hospitals",
          radius: hospitalRadius(p.beds),
          color: open ? "#8a2b21" : "#777777",
          weight: 1.5,
          dashArray: open ? null : "3 3",
          fillColor: open ? "#c0392b" : "#ffffff",
          fillOpacity: open ? 0.8 : 0.9,
        });
      },
      onEachFeature: function (feature, layer) {
        layer.bindTooltip(hospitalTooltip(feature.properties), { direction: "top" });
      },
    }).addTo(map);
  }

  // ----- load data -----
  Promise.all([
    loadJSON("data/input/npa_input.geojson"),
    loadJSON("data/input/hospitals_input.geojson"),
  ])
    .then(function (res) {
      addNPA(res[0]);
      var hosp = addHospitals(res[1]);
      L.control.layers(null, { "NPA boundaries": npaLayer, "Hospitals": hosp }, { collapsed: false }).addTo(map);
      setStatus(res[0].features.length + " NPAs, " + res[1].features.length + " hospitals loaded.");
    })
    .catch(function (err) {
      console.error(err);
      setStatus("Data failed to load: " + err.message, true);
    });

  // Leaflet measures its container once; re-measure when the layout settles or changes.
  function refreshSize() { map.invalidateSize(); }
  window.addEventListener("load", refreshSize);
  window.addEventListener("resize", refreshSize);

  // ----- tabs -----
  var tabs = document.querySelectorAll(".tab");
  var views = {
    dashboard: document.getElementById("view-dashboard"),
    methods: document.getElementById("view-methods"),
  };

  function showView(name) {
    tabs.forEach(function (t) {
      var on = t.dataset.view === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    Object.keys(views).forEach(function (k) {
      views[k].hidden = k !== name;
    });
    if (name === "dashboard") refreshSize();
  }

  tabs.forEach(function (t) {
    t.addEventListener("click", function () { showView(t.dataset.view); });
  });
})();
