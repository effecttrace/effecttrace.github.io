// Runs synchronously in <head> to apply the saved theme before first paint.
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  var saved = null;
  try { saved = window.localStorage.getItem("effecttrace-theme"); } catch (e) { saved = null; }
  if (saved === "light" || saved === "dark") {
    root.setAttribute("data-theme", saved);
  } else {
    var light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    root.setAttribute("data-theme", light ? "light" : "dark");
  }
})();
