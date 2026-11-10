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

  var api = {
    parseOD: parseOD,
    costKey: costKey,
    fixedBreaks: fixedBreaks,
    classifyFixed: classifyFixed,
    closestFacility: closestFacility,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Access = api;
})(typeof window !== "undefined" ? window : this);
