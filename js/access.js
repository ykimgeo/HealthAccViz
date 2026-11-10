/* Accessibility calculations (no DOM, no Leaflet).
 * Loaded in the browser as window.Access and in Node via require() for testing.
 */
(function (root) {
  "use strict";

  // OD matrix columns: npa_id, hid, euclid_km, network_km, network_min
  // ids stay strings so the leading zeros of hid survive.
  function parseOD(text) {
    var lines = text.split(/\r?\n/);
    var head = lines[0].split(",");
    var ix = {};
    head.forEach(function (h, i) { ix[h] = i; });
    ["npa_id", "hid", "euclid_km", "network_km", "network_min"].forEach(function (c) {
      if (!(c in ix)) throw new Error("OD matrix is missing column: " + c);
    });
    var byNpa = new Map();
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      var f = lines[i].split(",");
      var row = {
        hid: f[ix.hid],
        e: parseFloat(f[ix.euclid_km]),
        nk: parseFloat(f[ix.network_km]),
        nm: parseFloat(f[ix.network_min]),
      };
      var id = f[ix.npa_id];
      if (!byNpa.has(id)) byNpa.set(id, []);
      byNpa.get(id).push(row);
    }
    return byNpa;
  }

  // Which OD column a (distance basis, impedance) pair uses.
  // Travel time exists only for the road network; there is no Euclidean travel time.
  function costKey(basis, impedance) {
    if (basis === "euclid" && impedance === "distance") return "e";
    if (basis === "network" && impedance === "distance") return "nk";
    if (basis === "network" && impedance === "time") return "nm";
    throw new Error("Travel time is not available for Euclidean distance");
  }

  // Fixed class bounds (upper bounds of the first four classes; the fifth is open-ended).
  function fixedBreaks(impedance) {
    return impedance === "time"
      ? { breaks: [5, 10, 15, 20], unit: "min", decimals: 0 }
      : { breaks: [3, 6, 9, 12], unit: "km", decimals: 0 };
  }

  // Class index 0..4; upper bound inclusive. Class 0 = shortest.
  function classifyFixed(v, breaks) {
    for (var i = 0; i < breaks.length; i++) if (v <= breaks[i]) return i;
    return breaks.length;
  }

  // Closest facility: for every NPA, the included hospital with the lowest cost.
  // Ties are broken by road km, then Euclidean km, then hid, so results are deterministic.
  // Returns Map npa_id -> { hid, cost, e, nk, nm }. NPAs with no included hospital get no entry.
  function closestFacility(byNpa, includedHids, basis, impedance) {
    var key = costKey(basis, impedance);
    var out = new Map();
    byNpa.forEach(function (rows, npaId) {
      var best = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!includedHids.has(r.hid)) continue;
        if (best === null || better(r, best, key)) best = r;
      }
      if (best) out.set(npaId, { hid: best.hid, cost: best[key], e: best.e, nk: best.nk, nm: best.nm });
    });
    return out;
  }

  function better(a, b, key) {
    if (a[key] !== b[key]) return a[key] < b[key];
    if (a.nk !== b.nk) return a.nk < b.nk;
    if (a.e !== b.e) return a.e < b.e;
    return a.hid < b.hid;
  }

  // ---------------------------------------------------------------------
  // Container: count the hospitals (and beds) that lie inside each NPA.
  // No distance is involved. A hospital outside every NPA is not counted anywhere.
  // ---------------------------------------------------------------------
  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // GeoJSON polygon coordinates: [outer ring, ...hole rings]
  function inPolygon(x, y, rings) {
    if (!inRing(x, y, rings[0])) return false;
    for (var h = 1; h < rings.length; h++) if (inRing(x, y, rings[h])) return false;
    return true;
  }

  function inGeometry(x, y, geom) {
    if (geom.type === "Polygon") return inPolygon(x, y, geom.coordinates);
    if (geom.type === "MultiPolygon") return geom.coordinates.some(function (poly) { return inPolygon(x, y, poly); });
    return false;
  }

  function bboxOf(geom) {
    var polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    polys.forEach(function (rings) {
      rings[0].forEach(function (c) {
        if (c[0] < b[0]) b[0] = c[0];
        if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0];
        if (c[1] > b[3]) b[3] = c[1];
      });
    });
    return b;
  }

  // npaFeatures: GeoJSON features with properties.id; hospitalFeatures: point features with
  // properties.hid and properties.beds (null = unknown). includedHids: Set of hids to count.
  // Returns Map npa_id -> { n, beds, bedsMissing, hids }. Every NPA has an entry (n = 0 if empty).
  // beds sums only hospitals with a bed count; bedsMissing says how many were left out of that sum.
  function container(npaFeatures, hospitalFeatures, includedHids) {
    var boxes = npaFeatures.map(function (f) { return bboxOf(f.geometry); });
    var out = new Map();
    npaFeatures.forEach(function (f) { out.set(f.properties.id, { n: 0, beds: 0, bedsMissing: 0, hids: [] }); });
    hospitalFeatures.forEach(function (h) {
      var hid = h.properties.hid;
      if (!includedHids.has(hid)) return;
      var x = h.geometry.coordinates[0], y = h.geometry.coordinates[1];
      for (var i = 0; i < npaFeatures.length; i++) {
        var b = boxes[i];
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (inGeometry(x, y, npaFeatures[i].geometry)) {
          var r = out.get(npaFeatures[i].properties.id);
          r.n += 1;
          r.hids.push(hid);
          if (h.properties.beds === null || h.properties.beds === undefined) r.bedsMissing += 1;
          else r.beds += h.properties.beds;
          return; // a hospital belongs to one NPA only
        }
      }
    });
    return out;
  }

  // Fixed classes for the container measures. Upper bounds of every class but the last (open-ended).
  // Hospital counts per NPA are 0..3 in this data, so counts use four classes; beds use five.
  function containerClasses(measure) {
    if (measure === "count") return { breaks: [0, 1, 2], labels: ["0", "1", "2", "3+"], unit: "hospitals" };
    if (measure === "beds") return { breaks: [0, 100, 300, 600], labels: ["0", "1 – 100", "101 – 300", "301 – 600", "> 600"], unit: "beds" };
    throw new Error("Unknown container measure: " + measure);
  }

  // ---------------------------------------------------------------------
  // Gravity: A_i = sum_j S_j * f(d_ij), S_j = beds of hospital j.
  // The score is the plain Hansen sum A_i, in decay-weighted beds (no normalisation).
  // ---------------------------------------------------------------------
  // Distance decay f(d). d0 is the threshold: f is 0 beyond it.
  //   binary:      1 up to d0
  //   negexp:      exp(-beta * d)                       (beta in 1 / cost unit)
  //   gaussian:    [exp(-1/2 (d/d0)^2) - exp(-1/2)] / [1 - exp(-1/2)]   (equals 1 at 0 and 0 at d0)
  var E_HALF = Math.exp(-0.5);
  function decay(kind, d, d0, beta) {
    if (d > d0) return 0;
    if (kind === "binary") return 1;
    if (kind === "negexp") return Math.exp(-beta * d);
    if (kind === "gaussian") {
      var u = d / d0;
      return (Math.exp(-0.5 * u * u) - E_HALF) / (1 - E_HALF);
    }
    throw new Error("Unknown decay function: " + kind);
  }

  // supply: Map hid -> beds (only hospitals that count, all with a bed count).
  // Returns Map npa_id -> { score, n, top } where score = sum S_j f(d_ij) (weighted beds), n = hospitals within d0,
  // top = the three largest contributions [{ hid, cost, f, w }].
  function gravity(byNpa, supply, basis, impedance, opts) {
    var key = costKey(basis, impedance);
    var total = 0;
    supply.forEach(function (beds) { total += beds; });
    if (!(total > 0)) throw new Error("No included hospital has a bed count");
    var out = new Map();
    byNpa.forEach(function (rows, npaId) {
      var w = 0, n = 0, contrib = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!supply.has(r.hid)) continue;
        var d = r[key];
        if (d <= opts.d0) n += 1;
        var f = decay(opts.kind, d, opts.d0, opts.beta);
        if (f > 0) {
          var c = supply.get(r.hid) * f;
          w += c;
          contrib.push({ hid: r.hid, cost: d, f: f, w: c });
        }
      }
      contrib.sort(function (a, b) { return b.w - a.w || (a.hid < b.hid ? -1 : 1); });
      out.set(npaId, { score: w, n: n, top: contrib.slice(0, 3) });
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // 2SFCA (two-step floating catchment area), with the distance decay f(d) of the Gravity method.
  //   step 1:  R_j = S_j / sum_k P_k f(d_kj)       beds per person around hospital j
  //   step 2:  A_i = sum_j R_j f(d_ij)             beds per person for NPA i
  // With the binary decay this is the original 2SFCA; a continuous f gives the enhanced version.
  // The score is A_i * 1000 (beds per 1,000 people).
  // demand: Map npa_id -> population. supply: Map hid -> beds.
  // A hospital with no demand inside its catchment has no defined R_j and contributes nothing.
  // Returns { byNpa: Map npa_id -> { score, n, top }, ratio: Map hid -> R_j * 1000 }
  // where top = the three largest contributions [{ hid, cost, f, w, r }], w = R_j f * 1000, r = R_j * 1000.
  // ---------------------------------------------------------------------
  function sfca(byNpa, supply, demand, basis, impedance, opts) {
    var key = costKey(basis, impedance);
    var pop = new Map(); // hid -> sum_k P_k f(d_kj)
    byNpa.forEach(function (rows, npaId) {
      var p = demand.get(npaId) || 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!supply.has(r.hid)) continue;
        var f = decay(opts.kind, r[key], opts.d0, opts.beta);
        if (f > 0) pop.set(r.hid, (pop.get(r.hid) || 0) + p * f);
      }
    });
    var ratio = new Map(); // hid -> R_j (beds per person)
    supply.forEach(function (beds, hid) {
      var d = pop.get(hid) || 0;
      if (d > 0) ratio.set(hid, beds / d);
    });
    var out = new Map();
    byNpa.forEach(function (rows, npaId) {
      var a = 0, n = 0, contrib = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!supply.has(r.hid)) continue;
        var c = r[key];
        if (c <= opts.d0) n += 1;
        var f = decay(opts.kind, c, opts.d0, opts.beta);
        if (f > 0 && ratio.has(r.hid)) {
          var w = ratio.get(r.hid) * f;
          a += w;
          contrib.push({ hid: r.hid, cost: c, f: f, w: w * 1000, r: ratio.get(r.hid) * 1000 });
        }
      }
      contrib.sort(function (x, y) { return y.w - x.w || (x.hid < y.hid ? -1 : 1); });
      out.set(npaId, { score: a * 1000, n: n, top: contrib.slice(0, 3) });
    });
    var ratio1000 = new Map();
    ratio.forEach(function (v, hid) { ratio1000.set(hid, v * 1000); });
    return { byNpa: out, ratio: ratio1000 };
  }

  // Linear-interpolation percentile of an ascending array (numpy.percentile default).
  function percentile(sorted, p) {
    var k = (sorted.length - 1) * p / 100;
    var f = Math.floor(k);
    var c = Math.min(f + 1, sorted.length - 1);
    return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
  }

  // Quantile classes over the values of a result: k classes, upper bounds of the first k-1 in `breaks`
  // (class i holds values in (breaks[i-1], breaks[i]], upper bound inclusive).
  // `decimals` is the fewest decimals (0-3) that keep every distinct pair of bounds distinct when printed.
  function quantiles(values, k) {
    var v = [];
    values.forEach(function (x) { v.push(x); });
    v.sort(function (a, b) { return a - b; });
    var min = v[0], max = v[v.length - 1], breaks = [];
    for (var i = 1; i < k; i++) breaks.push(percentile(v, (100 * i) / k));
    var edges = [min].concat(breaks, [max]);
    var decimals = 3;
    for (var d = 0; d <= 3; d++) {
      var ok = true;
      for (var j = 1; j < edges.length; j++) {
        if (edges[j] > edges[j - 1] && edges[j].toFixed(d) === edges[j - 1].toFixed(d)) { ok = false; break; }
      }
      if (ok) { decimals = d; break; }
    }
    return { min: min, max: max, breaks: breaks, flat: max - min < 1e-9, decimals: decimals };
  }

  var api = {
    decay: decay,
    gravity: gravity,
    sfca: sfca,
    quantiles: quantiles,
    container: container,
    containerClasses: containerClasses,
    parseOD: parseOD,
    costKey: costKey,
    fixedBreaks: fixedBreaks,
    classifyFixed: classifyFixed,
    closestFacility: closestFacility,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Access = api;
})(typeof window !== "undefined" ? window : this);
