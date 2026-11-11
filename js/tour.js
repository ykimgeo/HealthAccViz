/* Quick Tour dialog: opens on the first visit and from the "?" button in the header. */
(function () {
  "use strict";

  var STORE_KEY = "healthaccviz.tour.seen";
  // Example images: place the screenshots at these paths (relative to healthcare.html).
  var STEPS = [
    {
      title: "Welcome",
      body: "<p>This dashboard compares how easily residents of Mecklenburg County (Charlotte, NC) can reach hospitals. " +
        "The unit of analysis is the Census tract (305 tracts). Different accessibility measures give different pictures, " +
        "so you can switch the measure and see how the result changes.</p>" +
        "<p>This tour takes about one minute. Use the <b>?</b> button in the header to open it again at any time.</p>"
    },
    {
      title: "1. Measure (left panel)",
      img: "img/tour/measure.png",
      body: "<p>Choose how accessibility is calculated, then press <b>Apply</b>.</p><ul>" +
        "<li><b>Method</b>: Closest facility, Container, Gravity, or 2SFCA.</li>" +
        "<li><b>Distance basis</b> (Euclidean or road network) and <b>Travel impedance</b> (distance or time).</li>" +
        "<li><b>Distance decay</b> (Gravity, 2SFCA): Binary, Negative exponential, or Gaussian, with sliders for the threshold d<sub>0</sub> and the coefficient &beta;.</li>" +
        "<li><b>Hospitals included</b>: show or hide closed hospitals and hospital types.</li></ul>"
    },
    {
      title: "2. Map and legend",
      body: "<p>Tracts are colored by the result: <b>darker green = better access</b>. " +
        "Circles are hospitals, and a larger circle means more beds.</p><ul>" +
        "<li>Click a tract to see its values and its nearest or contributing hospitals.</li>" +
        "<li>Click a hospital to highlight the tracts it serves.</li>" +
        "<li>The legend (bottom-left of the map) can be collapsed. Use the <b>Controls</b> panel to show a single indicator instead.</li></ul>"
    },
    {
      title: "3. Summary (right panel)",
      img: "img/tour/summary.png",
      body: "<p>Population-weighted statistics of the Mecklenburg tracts for the applied measure, " +
        "such as the mean, the median, and the share of residents within a cutoff. " +
        "Larger tracts count more because each tract is weighted by its 2024 population.</p>"
    },
    {
      title: "4. Selection",
      img: "img/tour/selection.png",
      body: "<p>Details of the tract or hospital you clicked: its score, population, the hospitals that contribute to it, " +
        "or the tracts that a hospital serves. A tract and a hospital are never selected at the same time.</p>"
    },
    {
      title: "5. Charts",
      img: "img/tour/charts.png",
      body: "<p>Each dot is a tract. The chart relates the accessibility score (y) to a tract indicator (x), " +
        "both as z-scores, with Pearson and Spearman correlations, histograms on both axes, and a 3&times;3 bivariate color legend.</p>" +
        "<p><b>Hover</b> a dot to highlight the tract on the map, or hover a tract on the map to highlight its dot. " +
        "The correlations are descriptive and not significance tests.</p>"
    },
    {
      title: "6. Methods tab",
      body: "<p>The <b>Methods</b> tab describes the data, how to read the results, and the limitations. " +
        "Press <b>Close</b> to start exploring.</p>"
    }
  ];

  var el = document.getElementById("tour");
  if (!el) return;
  var title = document.getElementById("tour-title");
  var body = document.getElementById("tour-body");
  var fig = document.getElementById("tour-fig");
  var img = document.getElementById("tour-img");
  var missing = document.getElementById("tour-missing");
  var prev = document.getElementById("tour-prev");
  var next = document.getElementById("tour-next");
  var skip = document.getElementById("tour-skip");
  var count = document.getElementById("tour-count");
  var opener = document.getElementById("btn-tour");
  var idx = 0;
  var lastFocus = null;

  function show(i) {
    idx = i;
    var s = STEPS[i];
    title.textContent = s.title;
    body.innerHTML = s.body;
    if (s.img) {
      fig.hidden = false;
      missing.hidden = true;
      img.hidden = false;
      img.alt = s.title + " (example)";
      img.onerror = function () {
        img.hidden = true;
        missing.hidden = false;
        missing.textContent = "Example image: " + s.img;
      };
      img.src = s.img;
    } else {
      fig.hidden = true;
    }
    prev.disabled = i === 0;
    next.textContent = i === STEPS.length - 1 ? "Close" : "Next";
    count.textContent = (i + 1) + " / " + STEPS.length;
  }

  function markSeen() {
    try { localStorage.setItem(STORE_KEY, "1"); } catch (e) { /* storage may be blocked */ }
  }

  function open() {
    lastFocus = document.activeElement;
    el.hidden = false;
    show(0);
    next.focus();
  }

  function close() {
    el.hidden = true;
    markSeen();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  next.addEventListener("click", function () {
    if (idx === STEPS.length - 1) close(); else show(idx + 1);
  });
  prev.addEventListener("click", function () { if (idx > 0) show(idx - 1); });
  skip.addEventListener("click", close);
  opener.addEventListener("click", open);
  el.addEventListener("click", function (e) { if (e.target === el) close(); });
  document.addEventListener("keydown", function (e) {
    if (el.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && idx < STEPS.length - 1) show(idx + 1);
    else if (e.key === "ArrowLeft" && idx > 0) show(idx - 1);
    else if (e.key === "Tab") {
      var f = Array.prototype.filter.call(el.querySelectorAll("button"), function (b) { return !b.disabled; });
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  var seen = false;
  try { seen = localStorage.getItem(STORE_KEY) === "1"; } catch (e) { /* treat as first visit */ }
  if (!seen) open();
})();
