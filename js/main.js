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

  // ----- NPA choropleth -----
  // Quantile classification, 5 classes, ColorBrewer YlGn (low values = yellow).
  var YLGN = ["#ffffcc", "#c2e699", "#78c679", "#31a354", "#006837"];
  var NO_DATA_COLOR = "#bdbdbd";

  var INDICATORS = [
    { key: "pop_2020", label: "Population (2020)", decimals: 0, prefix: "", suffix: "", legendUnit: "people" },
    { key: "pop_density_2020", label: "Population density (2020)", decimals: 1, prefix: "", suffix: " people/acre", legendUnit: "people per acre" },
    { key: "older_adult_pct_2024", label: "Aged 65+ (2024)", decimals: 1, prefix: "", suffix: "%", legendUnit: "%" },
    { key: "household_income_2024", label: "Household income (2024)", decimals: 0, prefix: "$", suffix: "", legendUnit: "US dollars" },
  ];

  var current = INDICATORS[1]; // default view: population density (area-standardized)
  var breaks = [];             // 5 upper class bounds for `current`
  var minValue = 0;

  var npaLayer = null;
  var npaFeatures = [];
  var selected = null;

  function formatValue(ind, v) {
    if (v === null || v === undefined) return null;
    return ind.prefix + fmt(v, { minimumFractionDigits: ind.decimals, maximumFractionDigits: ind.decimals }) + ind.suffix;
  }

  // Number with prefix only; the unit is shown once in the legend subtitle.
  function formatPlain(ind, v) {
    return ind.prefix + fmt(v, { minimumFractionDigits: ind.decimals, maximumFractionDigits: ind.decimals });
  }

  // Linear-interpolation percentile (same definition as numpy.percentile default).
  function percentile(sorted, p) {
    var k = (sorted.length - 1) * p / 100;
    var f = Math.floor(k);
    var c = Math.min(f + 1, sorted.length - 1);
    return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
  }

  function computeBreaks(ind) {
    var vals = npaFeatures
      .map(function (f) { return f.properties[ind.key]; })
      .filter(function (v) { return v !== null && v !== undefined; })
      .sort(function (a, b) { return a - b; });
    minValue = vals[0];
    breaks = [20, 40, 60, 80, 100].map(function (p) { return percentile(vals, p); });
  }

  // Upper bound inclusive: class i holds values in (breaks[i-1], breaks[i]].
  function classOf(v) {
    for (var i = 0; i < breaks.length; i++) if (v <= breaks[i]) return i;
    return breaks.length - 1;
  }

  function baseStyle(feature) {
    var v = feature.properties[current.key];
    var missing = v === null || v === undefined;
    return {
      color: "#555555",
      weight: 0.6,
      opacity: 0.9,
      fillColor: missing ? NO_DATA_COLOR : YLGN[classOf(v)],
      fillOpacity: missing ? 0.6 : 0.82,
    };
  }

  var HOVER_STYLE = { color: "#222222", weight: 2 };
  var SELECTED_STYLE = { color: "#000000", weight: 3 };

  function updateLegend() {
    var box = document.getElementById("choropleth-legend");
    box.replaceChildren();
    box.appendChild(el("p", "legend-title", current.label));
    box.appendChild(el("p", "legend-sub", "Quantiles, 5 classes · " + current.legendUnit));

    var counts = [0, 0, 0, 0, 0], missing = 0;
    npaFeatures.forEach(function (f) {
      var v = f.properties[current.key];
      if (v === null || v === undefined) missing += 1; else counts[classOf(v)] += 1;
    });

    var ul = el("ul", "legend");
    for (var i = 0; i < YLGN.length; i++) {
      var lo = i === 0 ? minValue : breaks[i - 1];
      var li = el("li");
      var sw = el("span", "sw sw-class");
      sw.style.background = YLGN[i];
      li.appendChild(sw);
      li.appendChild(el("span", "legend-range", formatPlain(current, lo) + " – " + formatPlain(current, breaks[i])));
      li.appendChild(el("span", "legend-count", counts[i] + " NPAs"));
      ul.appendChild(li);
    }
    var nd = el("li");
    var ndSw = el("span", "sw sw-class");
    ndSw.style.background = NO_DATA_COLOR;
    nd.appendChild(ndSw);
    nd.appendChild(el("span", "legend-range", "No data"));
    nd.appendChild(el("span", "legend-count", missing + " NPAs"));
    ul.appendChild(nd);
    box.appendChild(ul);
  }

  function showDetail(p) {
    var box = document.getElementById("npa-detail");
    box.replaceChildren();
    box.appendChild(el("p", "detail-title", p.npa_name));
    var dl = el("dl", "detail-list");
    INDICATORS.forEach(function (ind) {
      var active = ind === current ? " is-active" : "";
      dl.appendChild(el("dt", active.trim(), ind.label));
      var text = formatValue(ind, p[ind.key]);
      dl.appendChild(text === null ? el("dd", "is-missing" + active, "No data") : el("dd", active.trim(), text));
    });
    box.appendChild(dl);
  }

  function selectNPA(layer) {
    if (selected) npaLayer.resetStyle(selected);
    selected = layer;
    layer.setStyle(SELECTED_STYLE);
    layer.bringToFront();
    showDetail(layer.feature.properties);
  }

  function tooltipFor(layer) {
    var p = layer.feature.properties;
    var box = el("div");
    box.appendChild(el("div", "tip-title", p.npa_name));
    var text = formatValue(current, p[current.key]);
    box.appendChild(el("div", "tip-sub", current.label + ": " + (text === null ? "No data" : text)));
    return box;
  }

  function setIndicator(ind) {
    current = ind;
    computeBreaks(ind);
    npaLayer.setStyle(baseStyle);
    if (selected) {
      selected.setStyle(SELECTED_STYLE);
      showDetail(selected.feature.properties);
    }
    updateLegend();
  }

  function buildIndicatorControl() {
    var box = document.getElementById("indicator-options");
    INDICATORS.forEach(function (ind) {
      var label = el("label", "indicator-option");
      var input = el("input");
      input.type = "radio";
      input.name = "indicator";
      input.value = ind.key;
      input.checked = ind === current;
      input.addEventListener("change", function () { setIndicator(ind); });
      label.appendChild(input);
      label.appendChild(el("span", null, ind.label));
      box.appendChild(label);
    });
  }

  function addNPA(geojson) {
    npaFeatures = geojson.features;
    computeBreaks(current);
    npaLayer = L.geoJSON(geojson, {
      style: baseStyle,
      onEachFeature: function (feature, layer) {
        layer.bindTooltip(tooltipFor, { sticky: true });
        layer.on({
          mouseover: function () { if (layer !== selected) layer.setStyle(HOVER_STYLE); },
          mouseout: function () { if (layer !== selected) npaLayer.resetStyle(layer); },
          click: function () { selectNPA(layer); },
        });
      },
    }).addTo(map);
    buildIndicatorControl();
    updateLegend();
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
      // Fit to NPAs and all hospitals, including those outside Mecklenburg County.
      map.fitBounds(npaLayer.getBounds().extend(hosp.getBounds()), { padding: [20, 20] });
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
