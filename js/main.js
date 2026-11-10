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

  function byId(id) { return document.getElementById(id); }

  function fmt(value, opts) {
    if (value === null || value === undefined) return null;
    return value.toLocaleString("en-US", opts || {});
  }

  function sentence(s) {
    s = String(s).toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function setStatus(text, isError) {
    var s = byId("data-status");
    s.textContent = text;
    s.classList.toggle("is-error", !!isError);
  }

  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.json();
    });
  }

  function loadText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.text();
    });
  }

  // =====================================================================
  // Map layer model
  // `current` is the layer drawn as the choropleth, or null (boundaries only).
  // A layer is { kind, colors[5], valueOf(props), classOf(v), title, sub,
  //              labelFor(i), note, showPop, tooltipLine(props) }.
  //   kind "indicator": demographic indicator, quantile classes, YlGn (low = yellow)
  //   kind "access":    accessibility result, fixed classes, YlGn reversed
  //                     (shortest travel cost = darkest green = best access)
  // =====================================================================
  var YLGN = ["#ffffcc", "#c2e699", "#78c679", "#31a354", "#006837"];
  var ACCESS_COLORS = YLGN.slice().reverse();
  var NO_DATA_COLOR = "#bdbdbd";

  var INDICATORS = [
    { key: "pop_2020", label: "Population (2020)", decimals: 0, prefix: "", suffix: "", legendUnit: "people" },
    { key: "pop_density_2020", label: "Population density (2020)", decimals: 1, prefix: "", suffix: " people/acre", legendUnit: "people per acre" },
    { key: "older_adult_pct_2024", label: "Aged 65+ (2024)", decimals: 1, prefix: "", suffix: "%", legendUnit: "%" },
    { key: "household_income_2024", label: "Household income (2024)", decimals: 0, prefix: "$", suffix: "", legendUnit: "US dollars" },
  ];

  var current = null;
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

  function makeIndicatorLayer(ind) {
    var vals = npaFeatures
      .map(function (f) { return f.properties[ind.key]; })
      .filter(function (v) { return v !== null && v !== undefined; })
      .sort(function (a, b) { return a - b; });
    var min = vals[0];
    var br = [20, 40, 60, 80, 100].map(function (p) { return percentile(vals, p); });
    return {
      kind: "indicator",
      ind: ind,
      colors: YLGN,
      valueOf: function (p) { return p[ind.key]; },
      // Upper bound inclusive: class i holds values in (br[i-1], br[i]].
      classOf: function (v) {
        for (var i = 0; i < br.length; i++) if (v <= br[i]) return i;
        return br.length - 1;
      },
      title: ind.label,
      sub: "Quantiles, 5 classes · " + ind.legendUnit,
      labelFor: function (i) { return formatPlain(ind, i === 0 ? min : br[i - 1]) + " – " + formatPlain(ind, br[i]); },
      note: "Each class includes its upper bound.",
      showPop: false,
      tooltipLine: function (p) {
        var t = formatValue(ind, p[ind.key]);
        return ind.label + ": " + (t === null ? "No data" : t);
      },
    };
  }

  // ---------- accessibility result layer ----------
  var METHOD_LABELS = { closest: "Closest facility", container: "Container" };
  var BASIS_LABELS = { network: "road network", euclid: "Euclidean distance" };
  var IMPEDANCE_LABELS = { time: "travel time", distance: "travel distance" };

  function fmtCost(v, unit) {
    return unit === "min" ? fmt(v, { maximumFractionDigits: 0 }) + " min" : v.toFixed(1) + " km";
  }

  // Closest facility: cost (min or km) from the NPA to its nearest included hospital.
  function makeClosestLayer(settings, results) {
    var fb = Access.fixedBreaks(settings.impedance);
    var b = fb.breaks;
    return {
      kind: "access",
      settings: settings,
      results: results,
      unit: fb.unit,
      colors: ACCESS_COLORS,
      valueOf: function (p) { return results.has(p.id) ? results.get(p.id).cost : null; },
      classOf: function (v) { return Access.classifyFixed(v, b); },
      title: METHOD_LABELS[settings.method] + ": " + IMPEDANCE_LABELS[settings.impedance] + " to nearest hospital",
      sub: "Fixed classes · " + BASIS_LABELS[settings.basis] + " · " + fb.unit,
      labelFor: function (i) {
        if (i === 0) return "0 – " + b[0];
        if (i < b.length) return b[i - 1] + " – " + b[i];
        return "> " + b[b.length - 1];
      },
      note: "Darker green = shorter = better access. Class upper bounds are inclusive. People = 2020 population.",
      showPop: true,
      tooltipLine: function (p) {
        var r = results.get(p.id);
        if (!r) return "No hospital included in this analysis";
        return fmtCost(r.cost, fb.unit) + " · " + hospitals.get(r.hid).name;
      },
      // what to draw on the map for the selected NPA: a line to the nearest hospital and a ring on it
      overlayFor: function (id) {
        var r = results.get(id);
        return r ? { line: r.hid, rings: [r.hid] } : { line: null, rings: [] };
      },
      appendDetail: function (box, p) {
        box.appendChild(el("p", "detail-sub", "Nearest hospital"));
        var r = results.get(p.id);
        if (!r) {
          box.appendChild(el("p", "placeholder", "No hospital included in this analysis"));
          return;
        }
        var h = hospitals.get(r.hid);
        box.appendChild(detailList([
          { label: "Name", value: h.name },
          { label: "Type", value: sentence(h.type) + " · " + sentence(h.status) },
          { label: "Beds", value: h.beds === null ? null : fmt(h.beds) },
          { label: sentence(IMPEDANCE_LABELS[settings.impedance]), value: fmtCost(r.cost, fb.unit), active: true },
        ]));
        box.appendChild(el("p", "legend-note", "Line on the map is straight, not the route."));
      },
    };
  }

  // Container: hospitals (or beds) located inside the NPA boundary. No distance is used.
  function makeContainerLayer(settings, results) {
    var cls = Access.containerClasses(settings.measure);
    var isCount = settings.measure === "count";
    // four classes keep the two ends and the middle of the five-colour ramp (light = none, dark = most)
    var colors = cls.labels.length === 4 ? [YLGN[0], YLGN[1], YLGN[2], YLGN[4]] : YLGN;
    return {
      kind: "access",
      settings: settings,
      results: results,
      unit: cls.unit,
      colors: colors,
      valueOf: function (p) {
        var r = results.get(p.id);
        return r ? (isCount ? r.n : r.beds) : null;
      },
      classOf: function (v) { return Access.classifyFixed(v, cls.breaks); },
      title: "Container: " + (isCount ? "number of hospitals" : "number of beds"),
      sub: "Fixed classes · hospitals inside each NPA · " + cls.unit,
      labelFor: function (i) { return cls.labels[i]; },
      note: "Darker green = more = better access. Class upper bounds are inclusive. People = 2020 population. Hospitals outside every NPA are not counted.",
      showPop: true,
      tooltipLine: function (p) {
        var r = results.get(p.id);
        if (!r || r.n === 0) return "No hospital inside";
        return r.n + (r.n === 1 ? " hospital" : " hospitals") + " · " + fmt(r.beds) + " beds" +
          (r.bedsMissing ? " (+" + r.bedsMissing + " without bed count)" : "");
      },
      overlayFor: function (id) {
        var r = results.get(id);
        return { line: null, rings: r ? r.hids : [] };
      },
      appendDetail: function (box, p) {
        box.appendChild(el("p", "detail-sub", "Hospitals in this NPA"));
        var r = results.get(p.id);
        if (!r || r.n === 0) {
          box.appendChild(el("p", "placeholder", "No hospital inside this NPA"));
          return;
        }
        box.appendChild(detailList([
          { label: "Hospitals", value: String(r.n), active: isCount },
          { label: "Beds", value: fmt(r.beds), active: !isCount },
        ]));
        box.appendChild(detailList(r.hids.map(function (hid) {
          var h = hospitals.get(hid);
          return { label: h.name, value: h.beds === null ? null : fmt(h.beds) + " beds" };
        })));
        if (r.bedsMissing) box.appendChild(el("p", "legend-note", r.bedsMissing + " hospital(s) without a bed count are left out of the bed total."));
      },
    };
  }

  // ---------- NPA styling ----------
  // Boundaries-only look, used while no layer is selected.
  var NEUTRAL_STYLE = { color: "#4b6e8c", weight: 1, opacity: 0.9, fillColor: "#4b6e8c", fillOpacity: 0.18 };
  var HOVER_STYLE = { color: "#222222", weight: 2 };
  var SELECTED_STYLE = { color: "#000000", weight: 3 };

  function baseStyle(feature) {
    if (!current) return NEUTRAL_STYLE;
    var v = current.valueOf(feature.properties);
    var missing = v === null || v === undefined;
    return {
      color: "#555555",
      weight: 0.6,
      opacity: 0.9,
      fillColor: missing ? NO_DATA_COLOR : current.colors[current.classOf(v)],
      fillOpacity: missing ? 0.6 : 0.82,
    };
  }

  function updateLegend() {
    var box = byId("choropleth-legend");
    box.replaceChildren();
    if (!current) {
      var plain = el("ul", "legend");
      var item = el("li");
      item.appendChild(el("span", "sw sw-npa"));
      item.appendChild(document.createTextNode("NPA boundary"));
      plain.appendChild(item);
      box.appendChild(plain);
      return;
    }
    box.appendChild(el("p", "legend-title", current.title));
    box.appendChild(el("p", "legend-sub", current.sub));

    var counts = current.colors.map(function () { return 0; });
    var pops = current.colors.map(function () { return 0; });
    var missing = 0, missingPop = 0;
    npaFeatures.forEach(function (f) {
      var v = current.valueOf(f.properties);
      var pop = f.properties.pop_2020 || 0;
      if (v === null || v === undefined) { missing += 1; missingPop += pop; }
      else { var c = current.classOf(v); counts[c] += 1; pops[c] += pop; }
    });

    function row(color, label, n, pop) {
      var li = el("li");
      var sw = el("span", "sw sw-class");
      sw.style.background = color;
      li.appendChild(sw);
      li.appendChild(el("span", "legend-range", label));
      li.appendChild(el("span", "legend-count", current.showPop ? String(n) : n + " NPAs"));
      if (current.showPop) li.appendChild(el("span", "legend-pop", fmt(Math.round(pop))));
      return li;
    }

    var ul = el("ul", "legend legend-grid" + (current.showPop ? " has-pop" : ""));
    if (current.showPop) {
      var head = el("li", "legend-head");
      head.appendChild(el("span"));
      head.appendChild(el("span"));
      head.appendChild(el("span", "legend-count", "NPAs"));
      head.appendChild(el("span", "legend-pop", "People"));
      ul.appendChild(head);
    }
    for (var i = 0; i < current.colors.length; i++) ul.appendChild(row(current.colors[i], current.labelFor(i), counts[i], pops[i]));
    ul.appendChild(row(NO_DATA_COLOR, "No data", missing, missingPop));
    box.appendChild(ul);
    box.appendChild(el("p", "legend-note", current.note));
  }

  // ---------- selected NPA detail ----------
  function detailList(rows) {
    var dl = el("dl", "detail-list");
    rows.forEach(function (r) {
      var active = r.active ? " is-active" : "";
      dl.appendChild(el("dt", active.trim(), r.label));
      dl.appendChild(r.value === null ? el("dd", "is-missing" + active, "No data") : el("dd", active.trim(), r.value));
    });
    return dl;
  }

  function showDetail(p) {
    var box = byId("npa-detail");
    box.replaceChildren();
    box.appendChild(el("p", "detail-title", p.npa_name));
    box.appendChild(detailList(INDICATORS.map(function (ind) {
      return { label: ind.label, value: formatValue(ind, p[ind.key]), active: !!current && current.kind === "indicator" && current.ind === ind };
    })));

    if (current && current.kind === "access") current.appendDetail(box, p);
  }

  function tooltipFor(layer) {
    var p = layer.feature.properties;
    var box = el("div");
    box.appendChild(el("div", "tip-title", p.npa_name));
    if (current) box.appendChild(el("div", "tip-sub", current.tooltipLine(p)));
    return box;
  }

  // ---------- link to the nearest hospital ----------
  map.createPane("links");
  map.getPane("links").style.zIndex = 445; // above polygons, below hospital markers
  var linkGroup = L.layerGroup().addTo(map);

  // Draws, for the selected NPA, the hospitals the active result links it to:
  // a ring on each, and (closest facility only) a straight line to the nearest one.
  function updateLink() {
    linkGroup.clearLayers();
    var line = false, ring = false;
    if (selected && current && current.kind === "access") {
      var ov = current.overlayFor(selected.feature.properties.id);
      ov.rings.forEach(function (hid) {
        var marker = hospMarkers.get(hid);
        if (!marker) return;
        L.circleMarker(marker.getLatLng(), { pane: "hospitals", radius: hospitalRadius(hospitals.get(hid).beds) + 5, color: "#0d2f4a", weight: 3, fill: false, interactive: false }).addTo(linkGroup);
        ring = true;
      });
      var target = ov.line && hospMarkers.get(ov.line);
      if (target) {
        L.polyline([selected.getCenter(), target.getLatLng()], { pane: "links", color: "#0d2f4a", weight: 2, dashArray: "5 4", interactive: false }).addTo(linkGroup);
        line = true;
      }
    }
    byId("legend-link").hidden = !line;
    byId("legend-ring").hidden = !ring;
  }

  function clearSelection() {
    if (!selected) return;
    npaLayer.resetStyle(selected);
    selected = null;
    byId("npa-detail").replaceChildren(el("p", "placeholder", "Click an area on the map"));
    updateLink();
  }

  function selectNPA(layer) {
    if (selected) npaLayer.resetStyle(selected);
    selected = layer;
    layer.setStyle(SELECTED_STYLE);
    layer.bringToFront();
    showDetail(layer.feature.properties);
    updateLink();
  }

  function setLayer(layer) {
    current = layer;
    npaLayer.setStyle(baseStyle);
    if (selected) {
      selected.setStyle(SELECTED_STYLE);
      showDetail(selected.feature.properties);
    }
    updateLegend();
    updateLink();
  }

  // ---------- choropleth radio list ----------
  var accessRadio = null;
  var accessRadioText = null;

  function buildIndicatorControl() {
    var box = byId("indicator-options");
    function option(value, text, onChoose, checked, disabled) {
      var label = el("label", "indicator-option");
      var input = el("input");
      input.type = "radio";
      input.name = "indicator";
      input.value = value;
      input.checked = checked;
      input.disabled = !!disabled;
      input.addEventListener("change", onChoose);
      var span = el("span", null, text);
      label.appendChild(input);
      label.appendChild(span);
      box.appendChild(label);
      return { input: input, span: span };
    }
    option("none", "None (boundaries only)", function () { setLayer(null); }, true);
    INDICATORS.forEach(function (ind) {
      option(ind.key, ind.label, function () { setLayer(makeIndicatorLayer(ind)); }, false);
    });
    var a = option("access", "Accessibility result (press Apply)", function () { setLayer(accessLayer); }, false, true);
    accessRadio = a.input;
    accessRadioText = a.span;
  }

  function addNPA(geojson) {
    npaFeatures = geojson.features;
    npaLayer = L.geoJSON(geojson, {
      style: baseStyle,
      bubblingMouseEvents: false, // a click on a polygon must not reach the map's own click handler
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

  // Clicking the map outside any NPA polygon, or pressing Esc, clears the selection.
  // (Dragging the map does not fire "click", so panning keeps the selection.)
  map.on("click", clearSelection);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") clearSelection();
  });

  // =====================================================================
  // Hospitals
  // =====================================================================
  map.createPane("hospitals");
  map.getPane("hospitals").style.zIndex = 450; // above polygons, below tooltips/popups

  var hospitals = new Map();   // hid -> properties
  var hospMarkers = new Map(); // hid -> circle marker
  var supplyIncluded = null;   // Set of hids counted in the applied analysis; null before the first Apply

  function hospitalRadius(beds) {
    if (beds === null || beds === undefined) return 4;
    return Math.min(4 + Math.sqrt(beds) * 0.35, 18);
  }

  function hospitalStyle(p) {
    var open = p.status === "OPEN";
    if (supplyIncluded && !supplyIncluded.has(p.hid)) {
      return { color: "#9e9e9e", weight: 1.5, dashArray: null, fillColor: "#bdbdbd", fillOpacity: 0.45, opacity: 0.8 };
    }
    return {
      color: open ? "#8a2b21" : "#777777",
      weight: 1.5,
      dashArray: open ? null : "3 3",
      fillColor: open ? "#c0392b" : "#ffffff",
      fillOpacity: open ? 0.8 : 0.9,
      opacity: 1,
    };
  }

  function refreshHospitalStyles() {
    hospMarkers.forEach(function (m) { m.setStyle(hospitalStyle(m.feature.properties)); });
  }

  function hospitalTooltip(p) {
    var box = el("div");
    box.appendChild(el("div", "tip-title", p.name));
    box.appendChild(el("div", "tip-sub", p.type + " · " + p.status));
    box.appendChild(el("div", "tip-sub", p.beds === null ? "Beds: no data" : "Beds: " + fmt(p.beds)));
    box.appendChild(el("div", "tip-sub", p.county + ", " + p.state));
    if (supplyIncluded) box.appendChild(el("div", "tip-sub", "Included in analysis: " + (supplyIncluded.has(p.hid) ? "yes" : "no")));
    return box;
  }

  function addHospitals(geojson) {
    return L.geoJSON(geojson, {
      pointToLayer: function (feature, latlng) {
        var p = feature.properties;
        hospitals.set(p.hid, p);
        var m = L.circleMarker(latlng, Object.assign({
          pane: "hospitals",
          bubblingMouseEvents: false, // clicking a hospital leaves the NPA selection unchanged
          radius: hospitalRadius(p.beds),
        }, hospitalStyle(p)));
        hospMarkers.set(p.hid, m);
        return m;
      },
      onEachFeature: function (feature, layer) {
        layer.bindTooltip(function () { return hospitalTooltip(feature.properties); }, { direction: "top" });
      },
    }).addTo(map);
  }

  // =====================================================================
  // Accessibility panel: choose settings, then press Apply
  // =====================================================================
  var odByNpa = null;
  var hospFeatures = [];
  var accessLayer = null;
  var appliedKey = null;

  var selMethod = byId("sel-method");
  var selMeasure = byId("sel-measure");
  var selNetwork = byId("sel-network");
  var selImpedance = byId("sel-impedance");
  var chkClosed = byId("chk-closed");
  var btnApply = byId("btn-apply");
  var hint = byId("access-hint");

  function checkedTypes() {
    return Array.prototype.slice.call(document.querySelectorAll("#type-filters input:checked")).map(function (i) { return i.value; });
  }

  function readSettings() {
    return {
      method: selMethod.value,
      measure: selMeasure.value,
      basis: selNetwork.value,
      impedance: selImpedance.value,
      includeClosed: chkClosed.checked,
      types: checkedTypes(),
    };
  }

  // Container does not use distance basis or impedance, so they are left out of its key.
  function settingsKey(s) {
    var core = s.method === "container" ? [s.method, s.measure] : [s.method, s.basis, s.impedance];
    return JSON.stringify(core.concat([s.includeClosed, s.types.slice().sort()]));
  }

  function describe(s) {
    if (s.method === "container") return "Container · " + (s.measure === "count" ? "number of hospitals" : "number of beds");
    return METHOD_LABELS[s.method] + " · " + BASIS_LABELS[s.basis] + " · " + IMPEDANCE_LABELS[s.impedance];
  }

  // What is still unchosen before Apply can run, or null when the form is complete.
  function missingChoice(s) {
    if (!s.method) return "Select a method";
    if (s.method === "container") return s.measure ? null : "Select a container measure";
    var gaps = [];
    if (!s.basis) gaps.push("distance basis");
    if (!s.impedance) gaps.push("travel impedance");
    return gaps.length ? "Select " + gaps.join(" and ") : null;
  }

  function updateHint() {
    var s = readSettings();
    var gap = missingChoice(s);
    var changed = appliedKey !== null && !gap && settingsKey(s) !== appliedKey;
    var msg;
    var enabled = true;
    if (gap) { msg = gap + ", then press Apply."; enabled = false; }
    else if (s.types.length === 0) { msg = "Select at least one hospital type."; enabled = false; }
    else if (s.method === "closest" && !odByNpa) { msg = "OD matrix not available."; enabled = false; }
    else if (appliedKey === null) msg = "Press Apply to show the result.";
    else if (changed) msg = "Settings changed. Press Apply to update the map.";
    else msg = "Showing: " + describe(s);
    var n = 0;
    hospitals.forEach(function (h) { if ((h.status === "OPEN" || s.includeClosed) && s.types.indexOf(h.type) >= 0) n += 1; });
    byId("hosp-count").textContent = "(" + n + " of " + hospitals.size + ")";
    btnApply.disabled = !enabled;
    hint.textContent = msg;
    hint.classList.toggle("is-pending", enabled && changed);
  }

  // Travel time exists only for the road network, so Euclidean forces travel distance.
  function syncImpedance() {
    var timeOption = selImpedance.querySelector('option[value="time"]');
    var euclid = selNetwork.value === "euclid";
    timeOption.disabled = euclid;
    timeOption.textContent = euclid ? "Travel time (road network only)" : "Travel time";
    if (euclid && selImpedance.value === "time") selImpedance.value = "distance";
  }

  // Container needs a container measure instead of distance basis and impedance.
  function syncMethod() {
    var container = selMethod.value === "container";
    byId("field-measure").hidden = !container;
    byId("method-note").hidden = !container;
    selNetwork.disabled = container;
    selImpedance.disabled = container;
  }

  function apply() {
    var s = readSettings();
    if (missingChoice(s)) return;
    var included = new Set();
    hospitals.forEach(function (p, hid) {
      if ((p.status === "OPEN" || s.includeClosed) && s.types.indexOf(p.type) >= 0) included.add(hid);
    });
    if (s.method === "container") {
      accessLayer = makeContainerLayer(s, Access.container(npaFeatures, hospFeatures, included));
    } else {
      accessLayer = makeClosestLayer(s, Access.closestFacility(odByNpa, included, s.basis, s.impedance));
    }

    supplyIncluded = included;
    refreshHospitalStyles();
    byId("legend-hosp-excluded").hidden = false;

    appliedKey = settingsKey(s);
    accessRadio.disabled = false;
    accessRadio.checked = true;
    accessRadioText.textContent = "Accessibility: " + describe(s);
    setLayer(accessLayer);
    updateHint();
  }

  function initAccessPanel(hospitalFeatures, od) {
    odByNpa = od;
    hospFeatures = hospitalFeatures;
    var counts = {};
    hospitalFeatures.forEach(function (f) { counts[f.properties.type] = (counts[f.properties.type] || 0) + 1; });
    var box = byId("type-filters");
    Object.keys(counts).sort().forEach(function (t) {
      var label = el("label", "check");
      var input = el("input");
      input.type = "checkbox";
      input.value = t;
      input.checked = true; // specialty hospitals are included by default
      input.addEventListener("change", updateHint);
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + sentence(t) + " (" + counts[t] + ")"));
      box.appendChild(label);
    });
    [selMeasure, selImpedance, chkClosed].forEach(function (c) { c.addEventListener("change", updateHint); });
    selMethod.addEventListener("change", function () { syncMethod(); updateHint(); });
    selNetwork.addEventListener("change", function () { syncImpedance(); updateHint(); });
    btnApply.addEventListener("click", apply);
    syncMethod();
    syncImpedance();
    updateHint();
  }

  // ----- legend: collapsible, starts collapsed on narrow screens where the map is short -----
  (function () {
    var toggle = byId("legend-toggle");
    var body = byId("legend-body");
    function setOpen(open) {
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    }
    setOpen(window.innerWidth > 1100);
    toggle.addEventListener("click", function () { setOpen(body.hidden); });
  })();

  // =====================================================================
  // Load data
  // =====================================================================
  var odError = null;
  var odPromise = loadText("data/input/od_matrix.csv")
    .then(Access.parseOD)
    .catch(function (err) { console.error(err); odError = err.message; return null; });

  Promise.all([
    loadJSON("data/input/npa_input.geojson"),
    loadJSON("data/input/hospitals_input.geojson"),
    odPromise,
  ])
    .then(function (res) {
      addNPA(res[0]);
      var hosp = addHospitals(res[1]);
      // Fit to NPAs and all hospitals, including those outside Mecklenburg County.
      map.fitBounds(npaLayer.getBounds().extend(hosp.getBounds()), { padding: [20, 20] });
      L.control.layers(null, { "NPA boundaries": npaLayer, "Hospitals": hosp }, { collapsed: false }).addTo(map);
      initAccessPanel(res[1].features, res[2]);
      if (odError) setStatus("OD matrix failed to load: " + odError, true);
      else setStatus(res[0].features.length + " NPAs, " + res[1].features.length + " hospitals, OD matrix loaded.");
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
    dashboard: byId("view-dashboard"),
    methods: byId("view-methods"),
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
