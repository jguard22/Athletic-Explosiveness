/* Runs first, in <head>, before anything paints. A classic script (not a module) on purpose: it only reads two query
   parameters and a few saved preferences and sets attributes on <html>, so the page opens in the right mode and theme
   with no flash and no layout jump.

     ?fun=0          the engagement layer is skipped entirely: no attribute is set, no module is loaded, the page is the original
     ?mode=lab       the original dashboard (with the Combine / Lab switch); not remembered
     ?mode=combine   the guided Combine; not remembered
     ?booth=1        booth mode (no profile, each visitor starts fresh); remembered
     otherwise       the saved choice (bw-ae-mode), Combine by default

   Attributes set on <html>: data-fun="combine|lab", data-theme="light|dark", data-motion="reduce|full", data-booth="1" when on.
   Motion: the saved choice (bw-ae-motion: auto, reduce, full) or the system's reduced-motion setting. */
(function () {
  "use strict";
  var root = document.documentElement;
  var q;
  try { q = new URLSearchParams(location.search); } catch (e) { q = { get: function () { return null; } }; }
  function pref(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  if (q.get("fun") === "0") return;

  var asked = q.get("mode");
  var mode = asked === "lab" || asked === "combine" ? asked : (pref("bw-ae-mode") === "lab" ? "lab" : "combine");
  root.setAttribute("data-fun", mode);

  if (q.get("booth") === "1") { try { localStorage.setItem("bw-ae-booth", "1"); } catch (e) { /* private mode */ } }
  if (q.get("booth") === "1" || pref("bw-ae-booth") === "1") root.setAttribute("data-booth", "1");

  // theme: the saved choice wins, otherwise the system one. Resolved to an explicit light / dark so the stylesheet needs one selector.
  var mq = null;
  try { mq = window.matchMedia("(prefers-color-scheme: light)"); } catch (e) { mq = null; }
  function applyTheme() {
    var saved = pref("bw-ae-theme");
    var theme = saved === "light" || saved === "dark" ? saved : (mq && mq.matches ? "light" : "dark");
    if (root.getAttribute("data-theme") !== theme) {
      root.setAttribute("data-theme", theme);
      try { document.dispatchEvent(new Event("bwtheme")); } catch (e) { /* old browser */ }
    }
  }
  var rm = null;
  try { rm = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch (e) { rm = null; }
  function applyMotion() {
    var saved = pref("bw-ae-motion");
    var motion = saved === "reduce" || saved === "full" ? saved : (rm && rm.matches ? "reduce" : "full");
    if (root.getAttribute("data-motion") !== motion) root.setAttribute("data-motion", motion);
  }
  function apply() { applyTheme(); applyMotion(); }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
  if (rm && rm.addEventListener) rm.addEventListener("change", apply);
  window.addEventListener("bwprefs", apply);   // the settings panel saves a choice, then announces it
})();
