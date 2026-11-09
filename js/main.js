(function () {
  "use strict";

  var mapEl = document.getElementById("map");

  // ----- guard: Leaflet must be loaded -----
  if (typeof L === "undefined") {
    mapEl.innerHTML =
      '<p class="map-notice map-notice--static" role="alert">' +
      "Leaflet failed to load (vendor/leaflet/leaflet.js). Check that the vendor folder is deployed.</p>";
    console.error("Leaflet (L) is not defined; map not initialised.");
    return;
  }

  // ----- map -----
  var map = L.map(mapEl, { zoomControl: true }).setView([35.227, -80.843], 10);

  // ----- basemap with automatic fallback -----
  // Providers are tried in order. A provider is abandoned when its first
  // tiles fail (or hang) before any tile has loaded.
  var PROVIDERS = [
    {
      name: "CARTO Positron",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: {
        subdomains: "abcd",
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      },
    },
    {
      name: "OpenStreetMap",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      },
    },
  ];

  var notice = document.createElement("p");
  notice.className = "map-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  mapEl.parentNode.appendChild(notice);

  function setNotice(text) {
    notice.textContent = text || "";
    notice.hidden = !text;
  }

  var ERRORS_BEFORE_SWITCH = 4;
  var HANG_MS = 8000;
  var current = null;

  function useProvider(i) {
    if (current) map.removeLayer(current.layer);

    if (i >= PROVIDERS.length) {
      current = null;
      setNotice("Basemap tiles could not be loaded. Map layers will still display.");
      console.warn("All basemap providers failed.");
      return;
    }

    var p = PROVIDERS[i];
    var layer = L.tileLayer(p.url, p.options);
    var state = { layer: layer, ok: 0, err: 0, timer: null };
    current = state;

    function fail(reason) {
      if (current !== state || state.ok > 0) return;
      clearTimeout(state.timer);
      console.warn("Basemap '" + p.name + "' failed (" + reason + "); trying next provider.");
      useProvider(i + 1);
    }

    layer.on("tileload", function () {
      state.ok += 1;
      if (state.ok === 1) {
        clearTimeout(state.timer);
        setNotice("");
      }
    });
    layer.on("tileerror", function () {
      state.err += 1;
      if (state.ok === 0 && state.err >= ERRORS_BEFORE_SWITCH) fail("tile errors");
    });
    state.timer = setTimeout(function () { fail("no tile loaded in " + HANG_MS + " ms"); }, HANG_MS);

    layer.addTo(map);
  }

  useProvider(0);

  // ----- keep Leaflet's size in sync with the layout -----
  function refreshSize() { map.invalidateSize(); }
  setTimeout(refreshSize, 0);
  window.addEventListener("load", refreshSize);
  window.addEventListener("resize", refreshSize);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(refreshSize).observe(mapEl);
  }

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
