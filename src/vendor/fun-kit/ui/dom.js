// Minimal DOM helpers shared by the juice and ui modules. No framework.

export const SVG_NS = "http://www.w3.org/2000/svg";

/** hyperscript: h("div", { class: "x", onclick: fn, "aria-label": "y", style: { "--fk-w": "40%" } }, child, "text") */
export function h(tag, attrs = {}, ...children) {
  const doc = globalThis.document;
  const el = doc.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function applyAttrs(el, attrs = {}) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") { for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val)); }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof globalThis.Node ? c : globalThis.document.createTextNode(String(c)));
  }
  return el;
}

/** Parse an SVG string into an element. */
export function svgFromString(str) {
  const t = globalThis.document.createElement("template");
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const clampPct = (v) => Math.max(0, Math.min(100, v * 100));
