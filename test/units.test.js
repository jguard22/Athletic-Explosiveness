// Run: npm test  (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
const lang = (l) => Object.defineProperty(globalThis, "navigator", { value: { language: l }, configurable: true });
const U = require("../units.js");
const reset = () => { store.clear(); lang("en-US"); };

test("default follows the locale; a choice persists and wins", () => {
  reset();
  assert.equal(U.get(), "imperial");
  lang("de-DE"); assert.equal(U.get(), "metric");
  lang("en-GB"); assert.equal(U.get(), "metric");
  lang("en-US"); U.set("metric");
  assert.equal(U.get(), "metric");
  assert.equal(store.get("bw-units"), "metric");
  U.set("bogus");
  assert.equal(U.get(), "metric");
});

test("display converts, base stays metric", () => {
  reset(); U.set("metric");
  assert.equal(U.fmt("height", 71.12), "71.1");
  assert.equal(U.fmtU("speed", 8.5), "8.50 m/s");
  assert.equal(U.fmtU("accel", 4.2), "4.20 m/s²");
  assert.equal(U.fmtU("dist", 4, 1, true), "4 m");
  U.set("imperial");
  assert.equal(U.fmt("height", 71.12), "28.0");
  assert.equal(U.fmtU("height", 71.12), "28.0 in");
  assert.equal(U.fmtU("speed", 8.9408), "20.0 mph");
  assert.equal(U.fmtU("walkSpeed", 1.2), "3.94 ft/s");
  assert.equal(U.fmtU("accel", 3.048), "10.0 ft/s²");
  assert.equal(U.fmtU("dist", 4, 1, true), "13.1 ft");
  assert.equal(U.fmtU("dist", 3, 1, true), "9.8 ft");
  assert.equal(U.fmt("height", null), "—");
  assert.equal(U.fmt("speed", ""), "—");
});

test("typed values convert back to metric (round trip)", () => {
  reset(); U.set("imperial");
  const cm = U.toBase("height", "28.5");
  assert.ok(Math.abs(cm - 72.39) < 1e-9);
  assert.equal(U.fmt("height", cm), "28.5");
  U.set("metric");
  assert.equal(U.fmt("height", cm), "72.4");
  assert.equal(U.toBase("height", "72.39"), 72.39);
  assert.equal(U.toBase("height", ""), null);
  assert.equal(U.toBase("height", "abc"), null);
});

test("unknown kinds throw", () => {
  reset();
  assert.throws(() => U.unit("nope"), /unknown kind/);
});

test("paint / put / bind repaint elements in the active system", () => {
  reset(); U.set("metric");
  const el = { dataset: {}, tagName: "SPAN", textContent: "" };
  U.put(el, "speed", 4.47);
  assert.equal(el.textContent, "4.47");
  const input = { dataset: {}, tagName: "INPUT", value: "" };
  U.put(input, "height", 72.39);
  assert.equal(input.value, "72.39");
  const label = { dataset: { u: "speed" }, textContent: "" };
  const course = { dataset: { kind: "dist", base: "4", digits: "1", withUnit: "" }, tagName: "SPAN", textContent: "" };
  const root = { querySelectorAll: (sel) => (sel === "[data-u]" ? [label] : [el, input, course]) };
  U.bind(root);
  assert.equal(label.textContent, "m/s");
  assert.equal(course.textContent, "4 m");
  U.set("imperial");
  U.bind(root);
  assert.equal(label.textContent, "mph");
  assert.equal(el.textContent, "10.0");
  assert.equal(input.value, "28.5");
  assert.equal(course.textContent, "13.1 ft");
  U.put(el, "speed", null);
  assert.equal(el.textContent, "—");
  U.put(input, "height", null);
  assert.equal(input.value, "");
});

test("onChange fires on set", () => {
  reset();
  const seen = [];
  const off = U.onChange((u) => seen.push(u));
  U.set("metric"); U.set("imperial");
  off(); U.set("metric");
  assert.deepEqual(seen, ["metric", "imperial"]);
});
