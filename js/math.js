/* Render the TeX in the Methods tab ($...$ inline, $$...$$ display) with KaTeX.
 * If the KaTeX scripts fail to load, the TeX source stays visible as plain text. */
(function () {
  "use strict";
  var root = document.getElementById("view-methods");
  if (!root || typeof renderMathInElement !== "function") return;
  renderMathInElement(root, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });
})();
