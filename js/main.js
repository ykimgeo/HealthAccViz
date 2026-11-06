(function () {
  "use strict";

  // ----- map -----
  var map = L.map("map", { zoomControl: true }).setView([35.227, -80.843], 10);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 18,
  }).addTo(map);

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
    if (name === "dashboard") map.invalidateSize();
  }

  tabs.forEach(function (t) {
    t.addEventListener("click", function () { showView(t.dataset.view); });
  });

  window.addEventListener("resize", function () { map.invalidateSize(); });
})();
