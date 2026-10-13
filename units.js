/* Brilliant Wear — display units (metric / imperial).

   Everything the demo measures, stores and exports stays metric (cm, m, m/s,
   m/s²). Only what people read or type converts, at the edge:
     - read:  an element carries data-kind + data-base (the metric value) and
              BWUnits repaints it in the chosen system
     - type:  a number <input> with data-kind shows the converted value; the
              change handler calls toBase() to get the metric value back
   The choice is a per-browser preference. Until it is made the default follows
   the locale (en-US → imperial), the same rule Steady and Burst use.

   Kinds (base unit → metric / imperial display):
     height     cm   → cm  / in      vertical leap, jump-device height
     dist       m    → m   / ft      stride, course lengths
     speed      m/s  → m/s / mph     sprint, foot swing, arm drive
     walkSpeed  m/s  → m/s / ft/s    gait speed
     accel      m/s² → m/s² / ft/s²  sprint acceleration

   Same file in every Brilliant Wear demo; loads as a plain <script> (window.
   BWUnits) and as a CommonJS module for tests. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BWUnits = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const KEY = "bw-units";
  const FT = 0.3048;      // m per ft
  const MPH = 0.44704;    // m/s per mph
  const IN_CM = 2.54;     // cm per in

  // `per` = base units in one display unit, so display = base / per.
  const KINDS = {
    height:    { base: "cm",   metric: { unit: "cm",   per: 1, digits: 1 }, imperial: { unit: "in",    per: IN_CM, digits: 1 } },
    dist:      { base: "m",    metric: { unit: "m",    per: 1, digits: 2 }, imperial: { unit: "ft",    per: FT,    digits: 2 } },
    speed:     { base: "m/s",  metric: { unit: "m/s",  per: 1, digits: 2 }, imperial: { unit: "mph",   per: MPH,   digits: 1 } },
    walkSpeed: { base: "m/s",  metric: { unit: "m/s",  per: 1, digits: 2 }, imperial: { unit: "ft/s",  per: FT,    digits: 2 } },
    accel:     { base: "m/s²", metric: { unit: "m/s²", per: 1, digits: 2 }, imperial: { unit: "ft/s²", per: FT,    digits: 1 } },
  };

  let mem = null;                       // session fallback when storage is blocked
  const listeners = new Set();

  function localeUnits() {
    try {
      const loc = (navigator.language || "").toUpperCase();
      return /-(US|LR|MM)\b/.test(loc) || loc === "EN" ? "imperial" : "metric";
    } catch { return "imperial"; }
  }
  const valid = (u) => u === "metric" || u === "imperial";
  function get() {
    let v = null;
    try { v = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    if (valid(v)) return v;
    return valid(mem) ? mem : localeUnits();
  }
  function set(u) {
    if (!valid(u)) return;
    mem = u;
    try { localStorage.setItem(KEY, u); } catch { /* keep the in-memory choice */ }
    listeners.forEach((cb) => cb(u));
  }
  const imperial = () => get() === "imperial";
  const onChange = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };

  const spec = (kind) => {
    const k = KINDS[kind];
    if (!k) throw new Error(`BWUnits: unknown kind "${kind}"`);
    return k[get()];
  };
  const unit = (kind) => spec(kind).unit;
  const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));

  /** metric value → number in the display unit (null when empty) */
  function show(kind, v) { return finite(v) ? Number(v) / spec(kind).per : null; }
  /** number typed in the display unit → metric value (null when empty/invalid) */
  function toBase(kind, shown) { return finite(shown) ? Number(shown) * spec(kind).per : null; }
  /** "12.3" — the number only; "—" when empty */
  function fmt(kind, v, digits) {
    const s = show(kind, v);
    return s == null ? "—" : s.toFixed(digits ?? spec(kind).digits);
  }
  /** "12.3 in"; trim drops trailing zeros ("4 m", "13.1 ft") */
  function fmtU(kind, v, digits, trim) {
    const s = show(kind, v);
    if (s == null) return "—";
    const d = digits ?? spec(kind).digits;
    return `${trim ? String(+s.toFixed(d)) : s.toFixed(d)} ${unit(kind)}`;
  }

  // ---------- DOM painting ----------
  /** repaint one element that carries data-kind (+ data-base, data-digits, data-with-unit) */
  function paint(el) {
    const kind = el.dataset && el.dataset.kind;
    if (!kind) return;
    const raw = el.dataset.base;
    const v = finite(raw) ? Number(raw) : null;
    const digits = el.dataset.digits === undefined ? undefined : Number(el.dataset.digits);
    if (el.tagName === "INPUT") el.value = v == null ? "" : String(+show(kind, v).toFixed(2));
    else if (el.dataset.withUnit !== undefined) el.textContent = fmtU(kind, v, digits, true);
    else el.textContent = fmt(kind, v, digits);
  }
  /** set the metric value on an element and repaint it */
  function put(el, kind, v, digits) {
    el.dataset.kind = kind;
    el.dataset.base = finite(v) ? String(v) : "";
    if (digits !== undefined) el.dataset.digits = String(digits);
    paint(el);
  }
  /** relabel every [data-u] unit and repaint every [data-kind] value under root */
  function bind(root) {
    root.querySelectorAll("[data-u]").forEach((el) => { el.textContent = unit(el.dataset.u); });
    root.querySelectorAll("[data-kind]").forEach(paint);
  }
  /** wire a segmented control of button[data-units] */
  function bindSwitch(box) {
    const btns = [...box.querySelectorAll("button[data-units]")];
    const refresh = () => btns.forEach((b) => {
      const on = b.dataset.units === get();
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    btns.forEach((b) => b.addEventListener("click", () => set(b.dataset.units)));
    onChange(refresh);
    refresh();
  }
  /** one call at startup: paint labels/values, wire the switch, repaint on change */
  function init(switchBox, root) {
    const r = root || document;
    bind(r);
    if (switchBox) bindSwitch(switchBox);
    onChange(() => bind(r));
  }

  return { KINDS, localeUnits, get, set, imperial, onChange, unit, show, toBase, fmt, fmtU, paint, put, bind, bindSwitch, init };
});
