// Personal bests, near-miss detection and "beat your ghost".
//
// Metric: { id, label, better: "higher"|"lower", unit?, decimals?, nearMissPct?, nearMissAbs?, format?, messages? }
//   messages (optional): this metric's own words per result, each a string with {label} {value} {best} {gap} slots or a
//   function of those: { first, pb, tie, near, off }. Anything left out uses the shared labels (labels.js).
//
// submit() classifies a result as first / pb / tie / near (within the near-miss
// window of the best, e.g. "0.3 s off your best") / off. Near misses are framed
// as "so close", never as failure. A "ghost" is the trace of your best run: a
// list of [t, value] samples you can compare a live run against.

import { createEmitter } from "./emitter.js";
import { getLabel } from "./labels.js";

const HISTORY_CAP = 30;
const GHOST_POINTS = 120;

export function defaultFormat(m, v) {
  const d = m.decimals ?? (Math.abs(v) < 10 ? 1 : 0);
  const n = Number(v).toFixed(d);
  return m.unit ? `${n} ${m.unit}` : n;
}

/** Evenly thin a trace to at most `max` points (keeps first and last). */
export function downsample(points, max = GHOST_POINTS) {
  if (!Array.isArray(points) || points.length <= max) return points ?? [];
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

/** Linear interpolation of a [t, v] trace at time t (clamped). */
export function traceAt(trace, t) {
  if (!trace?.length) return null;
  if (t <= trace[0][0]) return trace[0][1];
  const last = trace[trace.length - 1];
  if (t >= last[0]) return last[1];
  let lo = 0, hi = trace.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (trace[mid][0] <= t) lo = mid; else hi = mid; }
  const [t0, v0] = trace[lo], [t1, v1] = trace[hi];
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/**
 * @param {{store: any, metrics: object[], now?: () => number}} opts
 */
export function createPersonalBests({ store, metrics = [], now = Date.now } = {}) {
  const KEY = "pb";
  const emitter = createEmitter();
  const defs = new Map(metrics.map((m) => [m.id, m]));
  const load = () => store.get(KEY, {});
  const def = (id) => defs.get(id) ?? { id, label: id, better: "higher" };
  const fmt = (m, v) => (m.format ? m.format(v) : defaultFormat(m, v));
  const isBetter = (m, a, b) => (m.better === "lower" ? a < b : a > b);

  function describe(m, r) {
    const f = (v) => fmt(m, v);
    // lazy: a custom format() only ever sees the numbers the line actually uses
    const vars = { label: m.label ?? m.id, get value() { return f(r.value); }, get best() { return f(r.best); }, get gap() { return f(Math.abs(r.delta)); } };
    const own = m.messages?.[r.status];
    if (own != null) return typeof own === "function" ? String(own(vars)) : String(own).replace(/\{(\w+)\}/g, (x, k) => (vars[k] != null ? vars[k] : x));
    const L = (key, extra) => getLabel(key, Object.assign(Object.create(vars), extra));
    if (r.status === "first") return L("pbFirst");
    if (r.status === "pb") return L("pbNew", { direction: L(m.better === "lower" ? "pbFaster" : "pbBetter") });
    if (r.status === "tie") return L("pbTie");
    if (r.status === "near") return L(m.better === "lower" ? "pbNearLower" : "pbNearHigher");
    return L("pbOff");
  }

  /**
   * @param {string} id metric id
   * @param {number} value
   * @param {{at?: number, ghost?: Array<[number, number]>, meta?: object}} [opts]
   */
  function submit(id, value, { at = now(), ghost, meta } = {}) {
    const m = def(id);
    const st = load();
    const rec = st[id] ?? { best: null, bestAt: null, history: [], ghost: null, last: null };
    const previous = rec.best;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // A NaN / missing reading is not a result: never store it, never call it a "first mark".
      return { id, value, previous, best: previous, status: "invalid", invalid: true, isPB: false, isFirst: false, nearMiss: false, tie: false, delta: 0, deltaPct: 0, text: "" };
    }
    let status;
    if (previous == null) status = "first";
    else if (value === previous) status = "tie";
    else if (isBetter(m, value, previous)) status = "pb";
    else {
      const gap = Math.abs(previous - value);
      const window = Math.max(m.nearMissAbs ?? 0, Math.abs(previous) * (m.nearMissPct ?? 0.05));
      status = gap <= window ? "near" : "off";
    }
    const delta = previous == null ? 0 : value - previous;
    const result = {
      id, value, previous, best: status === "pb" || status === "first" ? value : previous, status,
      isPB: status === "pb", isFirst: status === "first", nearMiss: status === "near", tie: status === "tie",
      delta, deltaPct: previous ? delta / Math.abs(previous) : 0,
    };
    result.text = describe(m, result);
    rec.history.push({ v: value, at });
    if (rec.history.length > HISTORY_CAP) rec.history.shift();
    rec.last = { v: value, at, ghost: ghost ? downsample(ghost) : rec.last?.ghost ?? null };
    if (status === "pb" || status === "first") {
      rec.best = value; rec.bestAt = at;
      if (ghost) rec.ghost = downsample(ghost);
    }
    st[id] = rec;
    store.set(KEY, st);
    emitter.emit("result", { ...result, meta });
    if (result.isPB) emitter.emit("pb", result);
    if (result.nearMiss) emitter.emit("near", result);
    return result;
  }

  /**
   * Live comparison against a ghost at time t.
   * which: "best" (default) | "last". Returns null without a ghost.
   */
  function compareToGhost(id, t, live, which = "best") {
    const m = def(id);
    const st = load()[id];
    const trace = which === "last" ? st?.last?.ghost : st?.ghost;
    const g = traceAt(trace, t);
    if (g == null) return null;
    const diff = live - g;
    const ahead = m.better === "lower" ? diff < 0 : diff > 0;
    const gap = fmt(m, Math.abs(diff));
    return { ghost: g, diff, ahead, tied: diff === 0, text: getLabel(diff === 0 ? "ghostLevel" : ahead ? "ghostAhead" : "ghostBehind", { gap }) };
  }

  function trend(id, n = 5) {
    const h = (load()[id]?.history ?? []).slice(-n * 2);
    if (h.length < 4) return { direction: "flat", n: h.length };
    const half = Math.floor(h.length / 2);
    const avg = (a) => a.reduce((s, x) => s + x.v, 0) / a.length;
    const d = avg(h.slice(half)) - avg(h.slice(0, half));
    const m = def(id);
    const improving = m.better === "lower" ? d < 0 : d > 0;
    const rel = Math.abs(d) / (Math.abs(avg(h.slice(0, half))) || 1);
    return { direction: rel < 0.01 ? "flat" : improving ? "up" : "down", change: d, n: h.length };
  }

  return {
    submit, compareToGhost, trend, describe: (id, r) => describe(def(id), r),
    best: (id) => load()[id]?.best ?? null,
    get: (id) => load()[id] ?? null,
    ghost: (id) => load()[id]?.ghost ?? null,
    all: () => Object.entries(load()).map(([id, r]) => ({ id, label: def(id).label, best: r.best, bestText: r.best == null ? "" : fmt(def(id), r.best), at: r.bestAt })),
    on: emitter.on, off: emitter.off,
    reset: () => store.remove(KEY),
  };
}
