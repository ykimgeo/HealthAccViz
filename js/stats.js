/* Descriptive statistics for the correlation chart (no DOM, no Leaflet).
 * Loaded in the browser as window.Stats and in Node via require() for testing.
 */
(function (root) {
  "use strict";

  function mean(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  // sample standard deviation (n - 1)
  function sd(a) {
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  // z-scores; null when the values do not vary
  function zscores(a) {
    var m = mean(a), s = sd(a);
    if (!(s > 0)) return null;
    return a.map(function (v) { return (v - m) / s; });
  }

  function pearson(x, y) {
    var mx = mean(x), my = mean(y), sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < x.length; i++) {
      var dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  }

  // ranks 1..n, tied values share the average of their ranks
  function ranks(a) {
    var idx = a.map(function (_, i) { return i; }).sort(function (p, q) { return a[p] - a[q]; });
    var r = new Array(a.length);
    var i = 0;
    while (i < idx.length) {
      var j = i;
      while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
      var avg = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
    }
    return r;
  }

  // Spearman rank correlation = Pearson correlation of the average ranks
  function spearman(x, y) {
    return pearson(ranks(x), ranks(y));
  }

  // number of values in `bins` equal-width bins over [lo, hi]; the upper end belongs to the last bin
  function histogram(values, lo, hi, bins) {
    var counts = [];
    for (var b = 0; b < bins; b++) counts.push(0);
    var w = (hi - lo) / bins;
    values.forEach(function (v) {
      var b = Math.floor((v - lo) / w);
      if (b < 0) b = 0;
      if (b > bins - 1) b = bins - 1;
      counts[b] += 1;
    });
    return counts;
  }

  // share of the values that equal the most frequent value (1 = all identical)
  function topShare(a) {
    var c = new Map(), best = 0;
    a.forEach(function (v) {
      var n = (c.get(v) || 0) + 1;
      c.set(v, n);
      if (n > best) best = n;
    });
    return a.length ? best / a.length : 0;
  }

  var api = { mean: mean, sd: sd, zscores: zscores, pearson: pearson, ranks: ranks, spearman: spearman, histogram: histogram, topShare: topShare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof window !== "undefined" ? window : this);
