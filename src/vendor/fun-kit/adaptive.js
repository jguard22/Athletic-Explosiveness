// Adaptive difficulty: steer the success rate into a flow band (~70-85%).
//
// A weighted up-down staircase (Kaernbach): after a success difficulty rises a
// little, after a miss it falls a lot, in the ratio (1-p)/p, so the long-run
// success rate converges on the target p (default 77.5%, the middle of the
// band). Step size shrinks on direction reversals so it settles instead of
// wobbling, and two safety valves keep it kind: three misses in a row drop
// difficulty immediately, and an app-set `ceiling` caps difficulty (health
// apps pass a safe load limit; the staircase never pushes past it, a saved
// level above a new ceiling is pulled down when it loads, and setCeiling()
// persists across reloads and reset()).
//
// Difficulty is normalised to 0..1 (`level`); `value()` maps it to the app's
// real parameter range, e.g. { min: 8, max: 20 } seconds of hold time.

import { clamp, lerp } from "./rng.js";

export const FLOW_BAND = Object.freeze({ low: 0.7, high: 0.85 });

/**
 * @param {{store?: any, key?: string, start?: number, min?: number, max?: number, target?: number, step?: number,
 *   minStep?: number, shrink?: number, window?: number, integer?: boolean, invert?: boolean, ceiling?: number, floor?: number}} opts
 *   `min`/`max` map level 0..1 onto the app's parameter (invert=true when a SMALLER value is harder, e.g. a time limit).
 */
export function createAdaptive({ store, key = "adaptive", start = 0.35, min = 0, max = 1, target = 0.775, step = 0.08, minStep = 0.015, shrink = 0.85, window = 10, integer = false, invert = false, ceiling = 1, floor = 0 } = {}) {
  // `ceiling` / `floor` are the app's hard limits. setCeiling() can only lower the ceiling further (it is saved, so it
  // survives reloads and reset()), and the level is clamped into [floor, ceiling] whenever state is loaded.
  const hardCeiling = clamp(Number.isFinite(ceiling) ? ceiling : 1, 0, 1);
  const hardFloor = clamp(Number.isFinite(floor) ? floor : 0, 0, 1);
  const limits = (cap) => { const c = Math.min(hardCeiling, cap ?? 1); return { ceiling: c, floor: Math.min(hardFloor, c) }; };
  const fresh = (cap = null) => { const l = limits(cap); return { level: clamp(start, l.floor, l.ceiling), step, last: null, reversals: 0, misses: 0, hits: 0, recent: [], trials: 0, ...l, cap }; };
  function normalize(saved) {
    if (!saved) return fresh();
    const cap = Number.isFinite(saved.cap) ? clamp(saved.cap, 0, 1) : null; // legacy saves have no cap: the constructor limits apply
    const base = fresh(cap);
    const out = { ...base, ...saved, cap, ...limits(cap) };
    out.level = Number.isFinite(out.level) ? clamp(out.level, out.floor, out.ceiling) : base.level;
    if (!Array.isArray(out.recent)) out.recent = [];
    return out;
  }
  let st = normalize(store?.get(key, null));
  const save = () => { try { store?.set(key, st); } catch {} };
  if (store?.has?.(key) && st.level !== store.get(key, {}).level) save();
  const sync = () => { if (store) st = normalize(store.get(key, null)); return st; }; // other tabs may have moved it
  const up = () => st.step * ((1 - target) / target);
  const down = () => st.step;

  function record(success) {
    sync();
    const ok = typeof success === "number" ? success >= 0.5 : !!success;
    const dir = ok ? 1 : -1;
    if (st.last && st.last !== dir) { st.reversals++; st.step = Math.max(minStep, st.step * shrink); }
    st.last = dir;
    st.recent.push(ok ? 1 : 0);
    if (st.recent.length > window) st.recent.shift();
    st.trials++;
    if (ok) { st.hits++; st.misses = 0; st.level += up(); }
    else {
      st.misses++;
      st.level -= down();
      if (st.misses >= 3) { st.level -= down(); st.misses = 0; } // frustration guard
    }
    st.level = clamp(st.level, st.floor, st.ceiling);
    save();
    return snapshot();
  }

  function value() {
    sync();
    const t = invert ? 1 - st.level : st.level;
    const v = lerp(min, max, t);
    return integer ? Math.round(v) : v;
  }

  function rate() { sync(); return st.recent.length ? st.recent.reduce((a, b) => a + b, 0) / st.recent.length : null; }

  function snapshot() {
    sync();
    const r = rate();
    return { level: st.level, value: value(), rate: r, inBand: r != null && r >= FLOW_BAND.low && r <= FLOW_BAND.high, trials: st.trials, step: st.step, ceiling: st.ceiling, atCeiling: st.level >= st.ceiling - 1e-9, atFloor: st.level <= st.floor + 1e-9 };
  }

  return {
    record, value, rate, snapshot,
    get level() { return sync().level; },
    get ceiling() { return sync().ceiling; },
    /** Lower the safety ceiling (0..1). Saved, so it survives reloads and reset(); it can never exceed the constructor `ceiling`. */
    setCeiling(c) {
      sync();
      st.cap = clamp(Number.isFinite(c) ? c : 1, 0, 1);
      Object.assign(st, limits(st.cap));
      st.level = clamp(st.level, st.floor, st.ceiling);
      save();
    },
    setLevel(l) { sync(); if (Number.isFinite(l)) { st.level = clamp(l, st.floor, st.ceiling); save(); } },
    /** Start over at `start`; the safety ceiling stays. */
    reset() { sync(); st = fresh(st.cap); save(); },
  };
}
