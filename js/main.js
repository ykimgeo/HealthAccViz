(function () {
  "use strict";

  // ----- map -----
  // zoomSnap 0.25: the initial fit to Mecklenburg County can use a fractional zoom, so the county fills the map
  // instead of leaving up to half of it empty (integer zoom levels only).
  var map = L.map("map", { zoomSnap: 0.25 }).setView([35.227, -80.843], 10);

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
    { key: "pop", label: "Population (2024)", decimals: 0, prefix: "", suffix: "", legendUnit: "people" },
    { key: "pop_density", label: "Population density (2024)", decimals: 0, prefix: "", suffix: " people/sq mi", legendUnit: "people per square mile (land area)" },
    { key: "older_adult_pct", label: "Aged 65+ (2024)", decimals: 1, prefix: "", suffix: "%", legendUnit: "%" },
    { key: "household_income", label: "Household income (2024)", decimals: 0, prefix: "$", suffix: "", legendUnit: "US dollars" },
  ];

  var current = null;
  var tractLayer = null;
  var tractFeatures = [];
  var selected = null;
  var selectedHosp = null;   // hid of the selected hospital (never together with a selected tract)
  var highlightIds = null;   // Set of tract ids served by the selected hospital
  var tractProps = new Map();  // tract id -> properties of the Mecklenburg County tracts drawn on the map
  var demandPop = new Map();   // tract id -> 2024 population, all tracts of the 14 counties (demand for 2SFCA)

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
    var vals = tractFeatures
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
  var METHOD_LABELS = { closest: "Closest facility", container: "Container", gravity: "Gravity", "2sfca": "2SFCA" };
  function usesDecay(method) { return method === "gravity" || method === "2sfca"; }
  var DECAY_LABELS = { binary: "Binary", negexp: "Negative exponential", gaussian: "Gaussian" };
  var BASIS_LABELS = { network: "road network", euclid: "Euclidean distance" };
  var IMPEDANCE_LABELS = { time: "travel time", distance: "travel distance" };

  function fmtCost(v, unit) {
    return unit === "min" ? fmt(v, { maximumFractionDigits: 0 }) + " min" : v.toFixed(1) + " km";
  }

  // ---------- shared helpers for the selected-hospital view and the Summary card ----------
  function popOf(id) { var p = tractProps.get(id); return p ? p.pop || 0 : 0; }
  function pct(part, whole) { return whole > 0 ? (100 * part / whole).toFixed(1) + "%" : "–"; }
  function people(n) { return fmt(Math.round(n)); }
  function share(part, whole) { return pct(part, whole) + " · " + people(part); }

  // Values and populations of the tracts that have a value in the active layer.
  function popItems(valueOf) {
    var items = [], missing = 0, missingPop = 0;
    tractFeatures.forEach(function (f) {
      var v = valueOf(f.properties), w = f.properties.pop || 0;
      if (v === null || v === undefined) { missing += 1; missingPop += w; } else items.push({ v: v, w: w });
    });
    return { items: items, stats: Access.weightedStats(items), missing: missing, missingPop: missingPop };
  }

  function summaryHead(pi) {
    var rows = [{ label: "People counted (2024)", value: people(pi.stats.total) }, { label: "Tracts counted", value: String(pi.items.length) }];
    if (pi.missing) rows.push({ label: "Tracts without a value", value: pi.missing + " · " + people(pi.missingPop) + " people" });
    return rows;
  }

  // Closest facility: cost (min or km) from the tract to its nearest included hospital.
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
      sub: fb.unit,
      labelFor: function (i) {
        if (i === 0) return "0 – " + b[0];
        if (i < b.length) return b[i - 1] + " – " + b[i];
        return "> " + b[b.length - 1];
      },
      note: "Darker green = shorter = better access. Class upper bounds are inclusive. People = 2024 population (ACS).",
      showPop: true,
      tooltipLine: function (p) {
        var r = results.get(p.id);
        if (!r) return "No included hospital is reachable";
        return fmtCost(r.cost, fb.unit) + " · " + hospitals.get(r.hid).name;
      },
      summary: function () {
        var pi = popItems(function (p) { return results.has(p.id) ? results.get(p.id).cost : null; });
        var st = pi.stats, rows = summaryHead(pi);
        function c(v) { return v.toFixed(1) + " " + fb.unit; }
        rows.push({ label: "Mean " + (fb.unit === "min" ? "travel time" : "travel distance"), value: c(st.mean) });
        rows.push({ label: "Median", value: c(st.median) });
        b.forEach(function (x) { rows.push({ label: "Within " + x + " " + fb.unit, value: share(st.within(x), st.total) }); });
        rows.push({ label: "Farther than " + b[b.length - 1] + " " + fb.unit, value: share(st.total - st.within(b[b.length - 1]), st.total) });
        return { rows: rows, note: "Each tract counts as many times as it has residents (population-weighted). Percentages are shares of the people counted. The median is the value at which half of those people are reached." };
      },
      serviceLegend: "Tract whose nearest hospital is the selected one",
      serviceOf: function (hid) {
        var ids = new Set(), pop = 0, w = 0, worst = 0;
        results.forEach(function (r, id) {
          if (r.hid !== hid || !tractProps.has(id)) return; // tracts of the other counties are not drawn
          ids.add(id); pop += popOf(id); w += popOf(id) * r.cost; if (r.cost > worst) worst = r.cost;
        });
        var rows = [{ label: "Tracts served", value: String(ids.size), active: true }, { label: "People served (2024)", value: people(pop) }];
        if (ids.size) {
          rows.push({ label: "Mean " + (fb.unit === "min" ? "travel time" : "travel distance"), value: (w / pop).toFixed(1) + " " + fb.unit });
          rows.push({ label: "Farthest tract", value: worst.toFixed(1) + " " + fb.unit });
        }
        return { ids: ids, rows: rows, note: ids.size ? "Served = this hospital is the closest included hospital. Only Mecklenburg County tracts are counted. Mean is weighted by population." : "No Mecklenburg County tract has this hospital as its closest one." };
      },
      // what to draw on the map for the selected tract: a line to the nearest hospital and a ring on it
      overlayFor: function (id) {
        var r = results.get(id);
        return r ? { line: r.hid, rings: [r.hid] } : { line: null, rings: [] };
      },
      appendDetail: function (box, p) {
        box.appendChild(el("p", "detail-sub", "Nearest hospital"));
        var r = results.get(p.id);
        if (!r) {
          box.appendChild(el("p", "placeholder", "No included hospital is reachable"));
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

  // Container: hospitals (or beds) located inside the tract boundary. No distance is used.
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
      sub: cls.unit,
      labelFor: function (i) { return cls.labels[i]; },
      note: "Darker green = more = better access. Class upper bounds are inclusive. People = 2024 population (ACS). Hospitals outside every tract are not counted.",
      showPop: true,
      tooltipLine: function (p) {
        var r = results.get(p.id);
        if (!r || r.n === 0) return "No hospital inside";
        return r.n + (r.n === 1 ? " hospital" : " hospitals") + " · " + fmt(r.beds) + " beds" +
          (r.bedsMissing ? " (+" + r.bedsMissing + " without bed count)" : "");
      },
      summary: function () {
        var pi = popItems(function (p) { var r = results.get(p.id); return r ? (isCount ? r.n : r.beds) : null; });
        var st = pi.stats, rows = summaryHead(pi);
        var none = st.within(0);
        rows.push({ label: "In a tract with no " + (isCount ? "hospital" : "bed"), value: share(none, st.total) });
        rows.push({ label: "In a tract with at least one " + (isCount ? "hospital" : "bed"), value: share(st.total - none, st.total) });
        rows.push({ label: "Mean " + (isCount ? "hospitals" : "beds") + " in the tract", value: isCount ? st.mean.toFixed(2) : fmt(Math.round(st.mean)) });
        return { rows: rows, note: "Population-weighted: each tract counts as many times as it has residents. Only the tract that contains a hospital is credited; no distance is used." };
      },
      serviceLegend: "Tract containing the selected hospital",
      serviceOf: function (hid) {
        var ids = new Set();
        results.forEach(function (r, id) { if (r.hids.indexOf(hid) >= 0) ids.add(id); });
        if (!ids.size) return { ids: ids, rows: [], note: "This hospital lies outside every tract, so it is not counted anywhere." };
        var id = ids.values().next().value;
        return { ids: ids, rows: [{ label: "Tract containing it", value: tractProps.get(id).name, active: true }, { label: "People in that tract (2024)", value: people(popOf(id)) }], note: "Container credits only the tract that holds the hospital." };
      },
      overlayFor: function (id) {
        var r = results.get(id);
        return { line: null, rings: r ? r.hids : [] };
      },
      appendDetail: function (box, p) {
        box.appendChild(el("p", "detail-sub", "Hospitals in this tract"));
        var r = results.get(p.id);
        if (!r || r.n === 0) {
          box.appendChild(el("p", "placeholder", "No hospital inside this tract"));
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

  // Gravity and 2SFCA share one layer builder: a score per tract classed in five quantiles of the result
  // (the range moves a lot with the threshold, the decay function and outlying hospitals, so neither
  // fixed nor equal-interval bounds would hold up).
  //   Gravity: score = sum_j(beds_j * f(d_ij)), in weighted beds
  //   2SFCA:   score = 1000 * sum_j(R_j * f(d_ij)), in beds per 1,000 people
  var SCORE_SPECS = {
    gravity: {
      title: "Gravity: access score (Σ beds × f(d))",
      unitText: "weighted beds",
      noteStart: "Score = Σ(beds × f(d)), the beds of every included hospital weighted by distance decay.",
      score: function (v) { return fmt(Math.round(v)); },
      scoreLabel: "Score (weighted beds)",
      tip: function (v) { return fmt(Math.round(v)) + " weighted beds"; },
      contribution: function (t) { return "f = " + t.f.toFixed(2); },
      contributionsTitle: "Largest contributions",
    },
    "2sfca": {
      title: "2SFCA: beds per 1,000 people",
      unitText: "beds per 1,000 people",
      noteStart: "Step 1: for each hospital, R = beds ÷ Σ(population × f(d)) of the tracts around it. Step 2: score = 1,000 × Σ(R × f(d)) over the hospitals around the tract.",
      score: function (v) { return v.toFixed(2); },
      scoreLabel: "Beds per 1,000 people",
      tip: function (v) { return v.toFixed(2) + " beds per 1,000 people"; },
      contribution: function (t) { return "f = " + t.f.toFixed(2) + " · R = " + t.r.toFixed(2); },
      contributionsTitle: "Largest contributions (R = beds per 1,000 people around the hospital)",
      extraNote: " Demand = 2024 population of the tracts of all 14 counties around Mecklenburg. Hospitals near the outer edge of those counties still have incomplete catchments, so their R is overstated.",
    },
  };

  function makeScoreLayer(settings, results) {
    var spec = SCORE_SPECS[settings.method];
    var vals = []; // only the tracts drawn on the map; the results also hold the other counties' tracts
    tractFeatures.forEach(function (f) { var r = results.get(f.properties.id); if (r) vals.push(r.score); });
    var ei = Access.quantiles(vals, 5);
    var unit = settings.impedance === "time" ? "min" : "km";
    var dec = ei.flat ? (settings.method === "2sfca" ? 2 : 0) : settings.method === "2sfca" ? Math.max(ei.decimals, 1) : ei.decimals; // beds per 1,000 people: at least one decimal
    return {
      kind: "access",
      settings: settings,
      results: results,
      unit: unit,
      colors: YLGN,
      valueOf: function (p) { var r = results.get(p.id); return r ? r.score : null; },
      classOf: function (v) { return ei.flat ? 4 : Access.classifyFixed(v, ei.breaks); },
      title: spec.title,
      sub: spec.unitText,
      labelFor: function (i) {
        if (ei.flat) return i === 4 ? ei.max.toFixed(dec) : "—";
        var lo = i === 0 ? ei.min : ei.breaks[i - 1];
        var hi = i < 4 ? ei.breaks[i] : ei.max;
        return lo.toFixed(dec) + " – " + hi.toFixed(dec);
      },
      note: spec.noteStart + " Darker green = higher = better access. Five quantile classes (about the same number of tracts in each) computed from this result; class upper bounds are inclusive. Hospitals without a bed count are not in the supply. People = 2024 population (ACS)." +
        (spec.extraNote || "") + (ei.flat ? " All tracts have the same score." : ""),
      showPop: true,
      tooltipLine: function (p) {
        var r = results.get(p.id);
        return r ? spec.tip(r.score) : "No data";
      },
      flat: ei.flat,
      summary: function () {
        var pi = popItems(function (p) { var r = results.get(p.id); return r ? r.score : null; });
        var st = pi.stats, rows = summaryHead(pi);
        rows.push({ label: "Mean", value: spec.score(st.mean) });
        rows.push({ label: "Median", value: spec.score(st.median) });
        if (!ei.flat) {
          var low = pi.items.filter(function (it) { return Access.classifyFixed(it.v, ei.breaks) === 0; }).reduce(function (s, it) { return s + it.w; }, 0);
          rows.push({ label: "People in the lowest class", value: share(low, st.total) });
        }
        return { rows: rows, note: "Unit: " + spec.unitText + ". Population-weighted: each tract counts as many times as it has residents. The median is the value at which half of those people are reached. Lowest class = the bottom fifth of tracts by score." };
      },
      serviceLegend: "Tract within the threshold of the selected hospital",
      serviceOf: function (hid) {
        var cat = Access.catchment(odByTract, hid, settings.basis, settings.impedance, { kind: settings.decay, d0: settings.d0, beta: settings.beta });
        var ids = new Set(), pop = 0, popAll = 0, wpopAll = 0;
        cat.forEach(function (c) {
          var dp = demandPop.get(c.tractId) || 0;
          popAll += dp; wpopAll += dp * c.f; // every county: this is the demand behind R
          if (tractProps.has(c.tractId)) { ids.add(c.tractId); pop += popOf(c.tractId); }
        });
        var beds = hospitals.get(hid).beds;
        var rows = [{ label: "Tracts within threshold", value: String(ids.size), active: true }, { label: "People in those tracts (2024)", value: people(pop) }, { label: "Beds", value: fmt(beds) }];
        if (settings.method === "2sfca" && wpopAll > 0) {
          rows.push({ label: "People within threshold, all counties", value: people(popAll) });
          rows.push({ label: "People weighted by f(d), all counties", value: people(wpopAll) });
          rows.push({ label: "R: beds per 1,000 people", value: (1000 * beds / wpopAll).toFixed(2) });
        }
        var note = !ids.size ? "No Mecklenburg County tract lies within the threshold of this hospital."
          : settings.method === "2sfca" ? "R = beds ÷ Σ(population × f(d)) over the tracts of all 14 counties around the hospital, times 1,000. Only Mecklenburg County tracts are highlighted."
          : "Highlighted tracts (Mecklenburg County) have a weight f(d) > 0 for this hospital.";
        return { ids: ids, rows: rows, note: note };
      },
      overlayFor: function (id) {
        var r = results.get(id);
        return { line: null, rings: r ? r.top.map(function (t) { return t.hid; }) : [] };
      },
      appendDetail: function (box, p) {
        box.appendChild(el("p", "detail-sub", METHOD_LABELS[settings.method] + " access"));
        var r = results.get(p.id);
        if (!r) { box.appendChild(el("p", "placeholder", "No data")); return; }
        box.appendChild(detailList([
          { label: spec.scoreLabel, value: spec.score(r.score), active: true },
          { label: "Hospitals within threshold", value: String(r.n) },
        ]));
        if (!r.top.length) {
          box.appendChild(el("p", "placeholder", "No included hospital within the threshold"));
          return;
        }
        box.appendChild(el("p", "detail-sub", spec.contributionsTitle));
        box.appendChild(detailList(r.top.map(function (t) {
          return { label: hospitals.get(t.hid).name, value: fmtCost(t.cost, unit) + " · " + spec.contribution(t) };
        })));
        box.appendChild(el("p", "legend-note", "Rings on the map mark these hospitals."));
      },
    };
  }

  // ---------- tract styling ----------
  // Boundaries-only look, used while no layer is selected.
  var NEUTRAL_STYLE = { color: "#4b6e8c", weight: 1, opacity: 0.9, fillColor: "#4b6e8c", fillOpacity: 0.18 };
  var HOVER_STYLE = { color: "#222222", weight: 2 };
  var SELECTED_STYLE = { color: "#000000", weight: 3 };

  function baseStyle(feature) {
    if (!current) return NEUTRAL_STYLE;
    var v = current.valueOf(feature.properties);
    var missing = v === null || v === undefined;
    var style = {
      color: "#555555",
      weight: 0.6,
      opacity: 0.9,
      fillColor: missing ? NO_DATA_COLOR : current.colors[current.classOf(v)],
      fillOpacity: missing ? 0.6 : 0.82,
    };
    if (highlightIds) { // a hospital is selected: outline the tracts it serves, fade the rest
      if (highlightIds.has(feature.properties.id)) { style.color = "#0d2f4a"; style.weight = 2.2; style.opacity = 1; }
      else style.fillOpacity = 0.18;
    }
    return style;
  }

  function updateLegend() {
    var box = byId("choropleth-legend");
    box.replaceChildren();
    if (!current) {
      var plain = el("ul", "legend");
      var item = el("li");
      item.appendChild(el("span", "sw sw-tract"));
      item.appendChild(document.createTextNode("Tract boundary"));
      plain.appendChild(item);
      box.appendChild(plain);
      return;
    }
    box.appendChild(el("p", "legend-title", current.title));
    box.appendChild(el("p", "legend-sub", current.sub));

    var counts = current.colors.map(function () { return 0; });
    var pops = current.colors.map(function () { return 0; });
    var missing = 0, missingPop = 0;
    tractFeatures.forEach(function (f) {
      var v = current.valueOf(f.properties);
      var pop = f.properties.pop || 0;
      if (v === null || v === undefined) { missing += 1; missingPop += pop; }
      else { var c = current.classOf(v); counts[c] += 1; pops[c] += pop; }
    });

    function row(color, label, n, pop) {
      var li = el("li");
      var sw = el("span", "sw sw-class");
      sw.style.background = color;
      li.appendChild(sw);
      li.appendChild(el("span", "legend-range", label));
      li.appendChild(el("span", "legend-count", current.showPop ? String(n) : n + " tracts"));
      if (current.showPop) li.appendChild(el("span", "legend-pop", fmt(Math.round(pop))));
      return li;
    }

    var ul = el("ul", "legend legend-grid" + (current.showPop ? " has-pop" : ""));
    if (current.showPop) {
      var head = el("li", "legend-head");
      head.appendChild(el("span"));
      head.appendChild(el("span"));
      head.appendChild(el("span", "legend-count", "Tracts"));
      head.appendChild(el("span", "legend-pop", "People"));
      ul.appendChild(head);
    }
    for (var i = 0; i < current.colors.length; i++) ul.appendChild(row(current.colors[i], current.labelFor(i), counts[i], pops[i]));
    ul.appendChild(row(NO_DATA_COLOR, "No data", missing, missingPop));
    box.appendChild(ul);
    box.appendChild(el("p", "legend-note", current.note));
  }

  // ---------- selected tract detail ----------
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
    var box = byId("selection-detail");
    box.replaceChildren();
    box.appendChild(el("p", "detail-title", p.name));
    box.appendChild(detailList(INDICATORS.map(function (ind) {
      return { label: ind.label, value: formatValue(ind, p[ind.key]), active: !!current && current.kind === "indicator" && current.ind === ind };
    })));

    if (current && current.kind === "access") current.appendDetail(box, p);
  }

  // Detail of the selected hospital, with the tracts it serves under the active measure.
  function renderHospSelection() {
    var box = byId("selection-detail");
    box.replaceChildren();
    var p = hospitals.get(selectedHosp);
    box.appendChild(el("p", "detail-title", p.name));
    box.appendChild(detailList([
      { label: "Type", value: sentence(p.type) + " · " + sentence(p.status) },
      { label: "Beds", value: p.beds === null ? null : fmt(p.beds) },
      { label: "County", value: sentence(p.county) + ", " + p.state },
    ]));
    highlightIds = null;
    var legendText = null;
    if (current && current.kind === "access") {
      box.appendChild(el("p", "detail-sub", METHOD_LABELS[current.settings.method] + ": tracts served"));
      if (!supplyIncluded || !supplyIncluded.has(selectedHosp)) {
        box.appendChild(el("p", "placeholder", "This hospital is not included in the applied analysis."));
      } else {
        var svc = current.serviceOf(selectedHosp);
        highlightIds = svc.ids;
        legendText = current.serviceLegend;
        if (svc.rows.length) box.appendChild(detailList(svc.rows));
        box.appendChild(el("p", "legend-note", svc.note));
      }
    } else {
      box.appendChild(el("p", "placeholder", "Apply an accessibility measure to see the tracts this hospital serves."));
    }
    byId("legend-served-text").textContent = legendText || "";
    byId("legend-served").hidden = !highlightIds;
  }

  function tooltipFor(layer) {
    var p = layer.feature.properties;
    var box = el("div");
    box.appendChild(el("div", "tip-title", p.name));
    if (current) box.appendChild(el("div", "tip-sub", current.tooltipLine(p)));
    return box;
  }

  // ---------- link to the nearest hospital ----------
  map.createPane("links");
  map.getPane("links").style.zIndex = 445; // above polygons, below hospital markers
  var linkGroup = L.layerGroup().addTo(map);

  // Draws, for the selected tract, the hospitals the active result links it to:
  // a ring on each, and (closest facility only) a straight line to the nearest one.
  function updateLink() {
    linkGroup.clearLayers();
    var line = false, ring = false;
    byId("legend-ring-text").textContent = "Hospital linked to the selected tract";
    if (selectedHosp && hospMarkers.get(selectedHosp)) {
      var hm = hospMarkers.get(selectedHosp);
      L.circleMarker(hm.getLatLng(), { pane: "hospitals", radius: hospitalRadius(hospitals.get(selectedHosp).beds) + 5, color: "#0d2f4a", weight: 3, fill: false, interactive: false }).addTo(linkGroup);
      ring = true;
      byId("legend-ring-text").textContent = "Selected hospital";
    }
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

  function clearHospSelection() {
    selectedHosp = null;
    highlightIds = null;
    byId("legend-served").hidden = true;
    tractLayer.setStyle(baseStyle);
  }

  function clearSelection() {
    if (!selected && !selectedHosp) return;
    if (selected) { tractLayer.resetStyle(selected); selected = null; }
    if (selectedHosp) clearHospSelection();
    byId("selection-detail").replaceChildren(el("p", "placeholder", "Click an area or a hospital on the map"));
    updateLink();
  }

  function selectTract(layer) {
    if (selectedHosp) clearHospSelection(); // a tract and a hospital are never selected together
    if (selected) tractLayer.resetStyle(selected);
    selected = layer;
    layer.setStyle(SELECTED_STYLE);
    layer.bringToFront();
    showDetail(layer.feature.properties);
    updateLink();
  }

  function selectHospital(hid) {
    if (selected) { tractLayer.resetStyle(selected); selected = null; }
    selectedHosp = hid;
    renderHospSelection();
    tractLayer.setStyle(baseStyle);
    updateLink();
  }

  // ---------- Summary card: population-weighted statistics of the active accessibility result ----------
  function updateSummary() {
    var box = byId("summary-body");
    box.replaceChildren();
    if (!current || current.kind !== "access") {
      box.appendChild(el("p", "placeholder", "Apply an accessibility measure to see population-weighted statistics."));
      return;
    }
    var s = current.summary();
    box.appendChild(el("p", "detail-sub summary-title", METHOD_LABELS[current.settings.method]));
    box.appendChild(detailList(s.rows));
    box.appendChild(el("p", "legend-note", s.note));
  }

  function setLayer(layer) {
    current = layer;
    if (selectedHosp) renderHospSelection(); // sets highlightIds for the new layer
    tractLayer.setStyle(baseStyle);
    if (selected) {
      selected.setStyle(SELECTED_STYLE);
      showDetail(selected.feature.properties);
    }
    updateLegend();
    updateLink();
    updateSummary();
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

  function addTracts(geojson) {
    tractFeatures = geojson.features;
    tractFeatures.forEach(function (f) { tractProps.set(f.properties.id, f.properties); });
    tractLayer = L.geoJSON(geojson, {
      style: baseStyle,
      bubblingMouseEvents: false, // a click on a polygon must not reach the map's own click handler
      onEachFeature: function (feature, layer) {
        layer.bindTooltip(tooltipFor, { sticky: true });
        layer.on({
          mouseover: function () { if (layer !== selected) layer.setStyle(HOVER_STYLE); },
          mouseout: function () { if (layer !== selected) tractLayer.resetStyle(layer); },
          click: function () { selectTract(layer); },
        });
      },
    }).addTo(map);
    buildIndicatorControl();
    updateLegend();
  }

  // Clicking the map outside any tract polygon, or pressing Esc, clears the selection.
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
          bubblingMouseEvents: false, // a click on a hospital must not reach the map's own click handler (which clears the selection)
          radius: hospitalRadius(p.beds),
        }, hospitalStyle(p)));
        hospMarkers.set(p.hid, m);
        return m;
      },
      onEachFeature: function (feature, layer) {
        layer.bindTooltip(function () { return hospitalTooltip(feature.properties); }, { direction: "top" });
        layer.on("click", function () { selectHospital(feature.properties.hid); });
      },
    }).addTo(map);
  }

  // =====================================================================
  // Accessibility panel: choose settings, then press Apply
  // =====================================================================
  var odByTract = null;
  var hospFeatures = [];
  var accessLayer = null;
  var appliedKey = null;

  var selMethod = byId("sel-method");
  var selMeasure = byId("sel-measure");
  var selNetwork = byId("sel-network");
  var selImpedance = byId("sel-impedance");
  var selDecay = byId("sel-decay");
  var chkClosed = byId("chk-closed");
  var btnApply = byId("btn-apply");
  var hint = byId("access-hint");

  function checkedTypes() {
    return Array.prototype.slice.call(document.querySelectorAll("#type-filters input:checked")).map(function (i) { return i.value; });
  }

  function readSettings() {
    var g = gpValue[selImpedance.value] || {};
    return {
      method: selMethod.value,
      measure: selMeasure.value,
      basis: selNetwork.value,
      impedance: selImpedance.value,
      decay: selDecay.value,
      d0: g.d0,
      beta: g.beta,
      includeClosed: chkClosed.checked,
      types: checkedTypes(),
    };
  }

  // Container does not use distance basis or impedance, so they are left out of its key.
  function settingsKey(s) {
    var core;
    if (s.method === "container") core = [s.method, s.measure];
    else if (usesDecay(s.method)) core = [s.method, s.basis, s.impedance, s.decay, s.d0, s.decay === "negexp" ? s.beta : null];
    else core = [s.method, s.basis, s.impedance];
    return JSON.stringify(core.concat([s.includeClosed, s.types.slice().sort()]));
  }

  function describe(s) {
    if (s.method === "container") return "Container · " + (s.measure === "count" ? "number of hospitals" : "number of beds");
    if (usesDecay(s.method)) return METHOD_LABELS[s.method] + " · " + DECAY_LABELS[s.decay] + " · " + BASIS_LABELS[s.basis] + " · " + IMPEDANCE_LABELS[s.impedance];
    return METHOD_LABELS[s.method] + " · " + BASIS_LABELS[s.basis] + " · " + IMPEDANCE_LABELS[s.impedance];
  }

  // What is still unchosen before Apply can run, or null when the form is complete.
  function missingChoice(s) {
    if (!s.method) return "Select a method";
    if (s.method === "container") return s.measure ? null : "Select a container measure";
    var gaps = [];
    if (!s.basis) gaps.push("distance basis");
    if (!s.impedance) gaps.push("travel impedance");
    if (usesDecay(s.method) && !s.decay) gaps.push("distance decay function");
    if (!gaps.length) return null;
    return "Select " + (gaps.length === 1 ? gaps[0] : gaps.slice(0, -1).join(", ") + " and " + gaps[gaps.length - 1]);
  }

  function updateHint() {
    var s = readSettings();
    var gap = missingChoice(s);
    var changed = appliedKey !== null && !gap && settingsKey(s) !== appliedKey;
    var msg;
    var enabled = true;
    if (gap) { msg = gap + ", then press Apply."; enabled = false; }
    else if (s.types.length === 0) { msg = "Select at least one hospital type."; enabled = false; }
    else if ((s.method !== "container") && !odByTract) { msg = "OD matrix not available."; enabled = false; }
    else if (usesDecay(s.method) && gravitySupplyCount(s) === 0) { msg = "No included hospital has a bed count."; enabled = false; }
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

  // ---- gravity parameters: threshold d0 and beta, each a slider plus a number box ----
  // Ranges depend on the travel impedance. Threshold: 5-120 min or 2-100 km.
  // Beta (negative exponential, in 1 per cost unit): 0.01-0.30 /min or 0.01-0.50 /km. With beta = 0.05 /min the
  // value halves every ln2/beta = 13.9 min, about the median time to the nearest hospital here (12 min);
  // 0.10 /km halves every 6.9 km (median nearest road distance 7.9 km). Both ends stay usable.
  var GP = {
    time: { unit: "min", d0: { min: 5, max: 120, step: 1, def: 30 }, beta: { min: 0.01, max: 0.3, step: 0.005, def: 0.05, unit: "/min" } },
    distance: { unit: "km", d0: { min: 2, max: 100, step: 1, def: 20 }, beta: { min: 0.01, max: 0.5, step: 0.01, def: 0.1, unit: "/km" } },
  };
  // remembered per impedance, so switching time <-> distance and back keeps what was typed
  var gpValue = { time: { d0: GP.time.d0.def, beta: GP.time.beta.def }, distance: { d0: GP.distance.d0.def, beta: GP.distance.beta.def } };
  var gpConfigured = null;
  var d0Range = byId("gp-d0-range"), d0Num = byId("gp-d0-num");
  var betaRange = byId("gp-beta-range"), betaNum = byId("gp-beta-num");

  function trimNum(v) { return String(Math.round(v * 1000) / 1000); }

  function configureParams(imp) {
    var cfg = GP[imp];
    [[d0Range, d0Num, cfg.d0, "d0"], [betaRange, betaNum, cfg.beta, "beta"]].forEach(function (x) {
      x[0].min = x[1].min = x[2].min;
      x[0].max = x[1].max = x[2].max;
      x[0].step = x[2].step;
      x[1].step = x[2].step; // the up/down buttons move one slider step (step "any" would move by 1, outside the range)
      var v = gpValue[imp][x[3]];
      x[0].value = v;
      x[1].value = trimNum(v);
    });
    byId("gp-d0-unit").textContent = cfg.unit + " (" + cfg.d0.min + "–" + cfg.d0.max + ")";
    byId("gp-beta-unit").textContent = cfg.beta.unit + " (" + cfg.beta.min + "–" + cfg.beta.max + ")";
    gpConfigured = imp;
  }

  function setParam(key, v, source) {
    var imp = selImpedance.value;
    gpValue[imp][key] = v;
    var rng = key === "d0" ? d0Range : betaRange;
    var num = key === "d0" ? d0Num : betaNum;
    if (source !== "range") rng.value = v;
    if (source !== "num") num.value = trimNum(v);
    drawPreview();
    updateHint();
  }

  function bindParam(rng, num, key) {
    rng.addEventListener("input", function () { setParam(key, parseFloat(rng.value), "range"); });
    // while typing, accept only values inside the range; clamp when the box is left
    num.addEventListener("input", function () {
      var cfg = GP[selImpedance.value][key];
      var v = parseFloat(num.value);
      if (isFinite(v) && v >= cfg.min && v <= cfg.max) setParam(key, v, "num");
    });
    num.addEventListener("change", function () {
      var cfg = GP[selImpedance.value][key];
      var v = parseFloat(num.value);
      if (!isFinite(v)) v = gpValue[selImpedance.value][key];
      v = Math.min(cfg.max, Math.max(cfg.min, v));
      setParam(key, v, "commit");
      num.value = trimNum(v);
    });
  }

  function svgEl(tag, attrs, text) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Small plot of f(d) from 0 to a little past the threshold, so the cut-off is visible.
  function drawPreview() {
    var svg = byId("decay-preview");
    svg.replaceChildren();
    var s = readSettings();
    if (!s.decay || !GP[s.impedance]) return;
    var cfg = GP[s.impedance];
    var X0 = 30, X1 = 232, Y0 = 70, Y1 = 8; // plot box in viewBox units; y grows downward
    var span = s.d0 * 1.1;
    function x(d) { return X0 + (d / span) * (X1 - X0); }
    function y(f) { return Y0 - f * (Y0 - Y1); }
    var pts = [];
    for (var i = 0; i <= 120; i++) {
      var d = (span * i) / 120;
      pts.push([x(d), y(Access.decay(s.decay, d, s.d0, s.beta))]);
    }
    svg.appendChild(svgEl("line", { class: "axis", x1: X0, y1: Y0, x2: X1, y2: Y0 }));
    svg.appendChild(svgEl("line", { class: "axis", x1: X0, y1: Y1, x2: X0, y2: Y0 }));
    svg.appendChild(svgEl("polygon", { class: "area", points: [[X0, Y0]].concat(pts, [[x(span), Y0]]).map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ") }));
    svg.appendChild(svgEl("polyline", { class: "curve", points: pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ") }));
    svg.appendChild(svgEl("text", { x: X0 - 4, y: Y1 + 3, "text-anchor": "end" }, "1"));
    svg.appendChild(svgEl("text", { x: X0 - 4, y: Y0 + 3, "text-anchor": "end" }, "0"));
    svg.appendChild(svgEl("text", { x: X0, y: Y0 + 13, "text-anchor": "middle" }, "0"));
    svg.appendChild(svgEl("line", { class: "axis", x1: x(s.d0), y1: Y0, x2: x(s.d0), y2: Y0 + 3 }));
    svg.appendChild(svgEl("text", { x: x(s.d0), y: Y0 + 13, "text-anchor": "middle" }, trimNum(s.d0) + " " + cfg.unit));
    svg.appendChild(svgEl("text", { x: X0, y: 97, "text-anchor": "start" }, "f(d): weight of a hospital at cost d"));
    if (s.decay === "negexp") {
      byId("gp-beta-half").textContent = "Weight halves every " + trimNum(Math.LN2 / s.beta) + " " + cfg.unit + " (ln 2 ÷ β).";
    }
  }

  // Show the pieces each method needs.
  function syncMethod() {
    var m = selMethod.value;
    var container = m === "container", gravityOn = usesDecay(m);
    byId("field-measure").hidden = !container;
    byId("method-note").hidden = !container;
    byId("field-decay").hidden = !gravityOn;
    selNetwork.disabled = container;
    selImpedance.disabled = container;
    syncGravity();
  }

  function syncGravity() {
    var m = selMethod.value;
    var imp = selImpedance.value;
    var show = usesDecay(m) && !!imp && !!selDecay.value;
    byId("gravity-params").hidden = !show;
    byId("gp-beta-block").hidden = selDecay.value !== "negexp";
    if (!show) return;
    if (gpConfigured !== imp) configureParams(imp);
    drawPreview();
  }

  function gravitySupplyCount(s) {
    var n = 0;
    hospitals.forEach(function (p) {
      if ((p.status === "OPEN" || s.includeClosed) && s.types.indexOf(p.type) >= 0 && p.beds !== null) n += 1;
    });
    return n;
  }

  function apply() {
    var s = readSettings();
    if (missingChoice(s)) return;
    var included = new Set();
    hospitals.forEach(function (p, hid) {
      if ((p.status === "OPEN" || s.includeClosed) && s.types.indexOf(p.type) >= 0) included.add(hid);
    });
    var counted = included; // hospitals that actually enter the calculation
    if (s.method === "container") {
      accessLayer = makeContainerLayer(s, Access.container(tractFeatures, hospFeatures, included));
    } else if (usesDecay(s.method)) {
      // supply = beds, so a hospital without a bed count cannot be part of it
      var supply = new Map();
      included.forEach(function (hid) { var b = hospitals.get(hid).beds; if (b !== null) supply.set(hid, b); });
      var opts = { kind: s.decay, d0: s.d0, beta: s.beta };
      var results;
      if (s.method === "gravity") {
        results = Access.gravity(odByTract, supply, s.basis, s.impedance, opts);
      } else {
        results = Access.sfca(odByTract, supply, demandPop, s.basis, s.impedance, opts).byTract;
      }
      accessLayer = makeScoreLayer(s, results);
      counted = new Set(supply.keys());
    } else {
      accessLayer = makeClosestLayer(s, Access.closestFacility(odByTract, included, s.basis, s.impedance));
    }

    supplyIncluded = counted;
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
    odByTract = od;
    hospFeatures = hospitalFeatures;
    var types = {};
    hospitalFeatures.forEach(function (f) { types[f.properties.type] = true; });
    var box = byId("type-filters");
    Object.keys(types).sort().forEach(function (t) {
      var label = el("label", "check");
      var input = el("input");
      input.type = "checkbox";
      input.value = t;
      input.checked = t !== "MILITARY"; // specialty hospitals are included by default; military hospitals serve a restricted population
      input.addEventListener("change", updateHint);
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + sentence(t)));
      box.appendChild(label);
    });
    [selMeasure, chkClosed].forEach(function (c) { c.addEventListener("change", updateHint); });
    selMethod.addEventListener("change", function () { syncMethod(); updateHint(); });
    selNetwork.addEventListener("change", function () { syncImpedance(); syncGravity(); updateHint(); });
    selImpedance.addEventListener("change", function () { syncGravity(); updateHint(); });
    selDecay.addEventListener("change", function () { syncGravity(); updateHint(); });
    bindParam(d0Range, d0Num, "d0");
    bindParam(betaRange, betaNum, "beta");
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
  // tracts_all.csv: geoid,county_fips,pop,lon,lat,basis
  function parseDemand(text) {
    text.split(/\r?\n/).slice(1).forEach(function (line) {
      if (!line) return;
      var f = line.split(",");
      demandPop.set(f[0], parseFloat(f[2]));
    });
  }

  var odError = null;
  var odPromise = loadText("data/input/od_matrix.csv")
    .then(Access.parseOD)
    .catch(function (err) { console.error(err); odError = err.message; return null; });

  Promise.all([
    loadJSON("data/input/tracts_mecklenburg.geojson"),
    loadJSON("data/input/hospitals_input.geojson"),
    loadText("data/input/tracts_all.csv"),
    odPromise,
  ])
    .then(function (res) {
      addTracts(res[0]);
      parseDemand(res[2]);
      var hosp = addHospitals(res[1]);
      // Fit to Mecklenburg County; hospitals in the other counties are reached by panning.
      map.fitBounds(tractLayer.getBounds(), { padding: [20, 20] });
      L.control.layers(null, { "Tract boundaries": tractLayer, "Hospitals": hosp }, { collapsed: false }).addTo(map);
      initAccessPanel(res[1].features, res[3]);
      if (odError) setStatus("OD matrix failed to load: " + odError, true);
      else setStatus(res[0].features.length + " Mecklenburg County tracts, " + res[1].features.length + " hospitals, " + demandPop.size + " demand tracts, OD matrix loaded.");
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
