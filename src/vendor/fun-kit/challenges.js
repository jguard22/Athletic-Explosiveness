// Daily / weekly challenges: deterministic by date.
//
// The same app + date (+ reroll count) always yields the same challenges on
// every device, with no server: picks are seeded from "<app>|<period>|<key>".
// Apps supply TEMPLATES; the engine picks, scales to the player's level,
// tracks progress and handles rerolls. Picks walk a seeded shuffle bag per slot,
// so within one slot consecutive days do not repeat a template (when the slot's pool
// holds 2+ templates and stays the same) and variety is maximal. Two slots of the same
// difficulty draw from their own bags, so a template can show up on consecutive days in
// different slots.
//
// The player's level is pinned into each period's saved state the first time that period
// is generated, so a level-up mid-day never reshuffles today's cards or changes a target.
//
// Template:
//   { id, title: "Complete {target} reps", metric: "reps", agg: "sum"|"max"|"count",
//     target: 20 | {min,max,step} | [easy,mid,hard], difficulty: "easy"|"medium"|"hard",
//     xp: 20, period: "daily"|"weekly" (default daily), weight: 1, minLevel: 1,
//     when: { weekdays: [0..6] }, tags: [], description,
//     shareSafe: false,  // true = the title may appear on a share image (default: never; titles can reveal measurements)
//     chip: "Quick win", // optional text for the card's chip (default: the weekly / difficulty label from labels.js)
//     applies: (ctx) => boolean  // optional: only offered when true. ctx = { ...context(), level, period, key, at, app }. }
//
// Which templates are eligible (the `filter` option and every template's `applies`) is decided ONCE per day / week,
// when that period first generates, and saved with it, like the player's level. So a filter that depends on state
// (a connected glove, a feature switched on, a mode) can change mid-day without reshuffling today's cards.

import { createEmitter } from "./emitter.js";
import { pickWeighted, randInt, seeded } from "./rng.js";
import { addDays, dayIndex, dayKey, weekStartKey, weekday } from "./time.js";

export const DEFAULT_SLOTS = Object.freeze({ daily: ["easy", "medium", "hard"], weekly: ["medium"] });
const DIFF_INDEX = { easy: 0, medium: 1, hard: 2 };

function resolveTarget(t, difficulty, rng, level, scale) {
  let target;
  if (typeof t.target === "number") target = t.target;
  else if (Array.isArray(t.target)) target = t.target[Math.min(DIFF_INDEX[difficulty] ?? 1, t.target.length - 1)];
  else if (t.target && typeof t.target === "object") {
    const { min, max, step = 1 } = t.target;
    target = min + step * randInt(rng, 0, Math.max(0, Math.floor((max - min) / step)));
  } else target = 1;
  if (scale?.perLevel) target *= Math.min(scale.max ?? 2, 1 + scale.perLevel * Math.max(0, level - 1));
  const step = typeof t.target === "object" && !Array.isArray(t.target) ? t.target.step ?? 1 : 1;
  return Math.max(1, Math.round(target / step) * step);
}

/** Throws a clear error for template content that would misbehave mid-session (missing metric, bad difficulty / period / target). */
export function validateTemplates(templates) {
  const seen = new Set();
  for (const t of templates) {
    if (!t || !t.id) throw new Error("fun-kit challenges: every template needs an id");
    if (seen.has(t.id)) throw new Error(`fun-kit challenges: duplicate template id "${t.id}"`);
    seen.add(t.id);
    if (!t.metric) throw new Error(`fun-kit challenges: template "${t.id}" needs a metric`);
    if (t.difficulty != null && !Object.hasOwn(DIFF_INDEX, t.difficulty)) throw new Error(`fun-kit challenges: template "${t.id}" has unknown difficulty "${t.difficulty}"`);
    if (t.period != null && t.period !== "daily" && t.period !== "weekly") throw new Error(`fun-kit challenges: template "${t.id}" has unknown period "${t.period}"`);
    if (t.agg != null && !["sum", "max", "count"].includes(t.agg)) throw new Error(`fun-kit challenges: template "${t.id}" has unknown agg "${t.agg}"`);
    if (t.xp != null && !(Number.isFinite(t.xp) && t.xp >= 0)) throw new Error(`fun-kit challenges: template "${t.id}" xp must be a non-negative number`);
    if (t.chip != null && typeof t.chip !== "string") throw new Error(`fun-kit challenges: template "${t.id}" chip must be a string`);
    if (t.applies != null && typeof t.applies !== "function") throw new Error(`fun-kit challenges: template "${t.id}" applies must be a function`);
    const tg = t.target;
    const ok = tg == null || (typeof tg === "number" && Number.isFinite(tg) && tg > 0) || (Array.isArray(tg) && tg.length > 0 && tg.every((x) => Number.isFinite(x) && x > 0))
      || (typeof tg === "object" && !Array.isArray(tg) && Number.isFinite(tg.min) && Number.isFinite(tg.max) && tg.max >= tg.min && tg.min > 0);
    if (!ok) throw new Error(`fun-kit challenges: template "${t.id}" has an invalid target`);
  }
}

const fill = (s, vars) => String(s ?? "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));

function candidatesFor(templates, { period, key, level, filter }) {
  const wd = period === "daily" ? weekday(key) : null;
  return templates.filter((t) => (t.period ?? "daily") === period
    && (t.minLevel ?? 1) <= level
    && (!t.when?.weekdays || wd == null || t.when.weekdays.includes(wd))
    && (!filter || filter(t)));
}

/**
 * Deterministic "shuffle bag" walk through a pool: every template appears once per
 * cycle, in an order seeded by app + slot + cycle number, and the first pick of a
 * new cycle is never the last pick of the previous one. So within a slot consecutive
 * days never repeat (given 2+ eligible templates and an unchanged pool) and variety is maximal.
 */
function bagPick(pool, { app, period, slot, difficulty, idx }) {
  const stable = [...pool].sort((a, b) => (a.id < b.id ? -1 : 1));
  const n = stable.length;
  if (n === 1) return stable[0];
  const order = (c) => {
    const rng = seeded(app, period, slot, difficulty, c);
    return stable.map((t) => ({ t, k: -Math.log(1 - rng()) / Math.max(1e-6, t.weight ?? 1) })).sort((x, y) => x.k - y.k).map((x) => x.t);
  };
  if (n === 2) { const o = order(0); return o[idx % 2]; } // strict alternation
  const cycle = Math.floor(idx / n), pos = idx % n;
  const bag = order(cycle);
  if (cycle > 0 && bag[0] === order(cycle - 1)[n - 1]) [bag[0], bag[1]] = [bag[1], bag[0]];
  return bag[pos];
}

/**
 * Pure generator. Same input -> same output.
 * @returns {Array<object>} one entry per slot
 */
export function generateChallenges({ app, templates, period = "daily", key, rerolls = {}, level = 1, slots, scale, filter, exclude = [] }) {
  const pool = candidatesFor(templates, { period, key, level, filter });
  const slotDefs = slots ?? DEFAULT_SLOTS[period];
  const idx = period === "daily" ? dayIndex(key) : Math.floor(dayIndex(key) / 7);
  const chosen = [];
  slotDefs.forEach((difficulty, i) => {
    const rng = seeded(app, period, key, i, rerolls[i] ?? 0);
    const used = new Set(chosen.map((c) => c.templateId));
    const fresh = (t) => !used.has(t.id) && !exclude.includes(t.id);
    let cands = pool.filter((t) => fresh(t) && (t.difficulty ?? "medium") === difficulty);
    if (!cands.length) cands = pool.filter(fresh);
    if (!cands.length) cands = pool.filter((t) => !used.has(t.id));
    if (!cands.length) return;
    let t = bagPick(cands, { app, period, slot: i, difficulty, idx });
    const k = rerolls[i] ?? 0;
    if (k > 0) {
      // A reroll walks to a different template, deterministically per reroll count.
      const others = cands.filter((c) => c.id !== t.id);
      const picked = pickWeighted(others.length ? others : cands, (x) => x.weight ?? 1, rng);
      t = picked ?? t;
    }
    const diff = t.difficulty ?? difficulty;
    const target = resolveTarget(t, diff, rng, level, scale);
    chosen.push({
      slot: i, templateId: t.id, period, periodKey: key, rerolled: k,
      title: fill(t.title, { target }), description: fill(t.description, { target }),
      metric: t.metric, agg: t.agg ?? "sum", target, difficulty: diff, xp: t.xp ?? 20, tags: t.tags ?? [], shareSafe: t.shareSafe === true, ...(t.chip ? { chip: t.chip } : {}),
    });
  });
  return chosen;
}

/**
 * @param {{app: string, store: any, templates: object[], now?: () => number, tz?: string, rolloverHour?: number,
 *   level?: () => number, slots?: {daily?: string[], weekly?: string[]}, maxRerolls?: {daily?: number, weekly?: number},
 *   sweepXp?: number, weekStart?: number, scale?: {perLevel: number, max?: number}, filter?: (t: object) => boolean,
 *   context?: () => object}} opts
 *   filter / context: evaluated once per period (see the header): `filter(template)` and each template's `applies(ctx)`,
 *   where ctx merges what `context()` returns with { level, period, key, at, app }.
 */
export function createChallenges({ app, store, templates, now = Date.now, tz, rolloverHour = 0, level = () => 1, slots = {}, maxRerolls = {}, sweepXp = 25, weekStart = 1, scale, filter, context } = {}) {
  validateTemplates(templates ?? []);
  const KEY = "challenges";
  const emitter = createEmitter();
  const rerollCap = { daily: maxRerolls.daily ?? 1, weekly: maxRerolls.weekly ?? 1 };
  const slotDefs = { daily: slots.daily ?? DEFAULT_SLOTS.daily, weekly: slots.weekly ?? DEFAULT_SLOTS.weekly };
  const load = () => store.get(KEY, { periods: {} });
  const blank = () => ({ progress: {}, done: {}, rerolls: {}, sweep: false, level: null, eligible: null });
  const liveLevel = () => { const l = Number(level()); return Number.isFinite(l) && l >= 1 ? l : 1; };

  const keys = (at) => {
    const d = dayKey(at, { tz, rolloverHour });
    return { daily: d, weekly: weekStartKey(d, weekStart), day: d };
  };

  const attempt = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  /** Ids of this period's templates that pass the app filter and their own `applies(ctx)` right now. */
  function eligibleIds(period, key, lvl, at) {
    const base = attempt(() => (typeof context === "function" ? context() : null), null);
    const ctx = { ...(base && typeof base === "object" ? base : {}), level: lvl, period, key, at, app };
    return templates
      .filter((t) => (t.period ?? "daily") === period && (!filter || attempt(() => !!filter(t), false)) && (typeof t.applies !== "function" || attempt(() => !!t.applies(ctx), false)))
      .map((t) => t.id);
  }

  /** Pin the player's level and the eligible template ids into a period's state the first time it is used. */
  function pin(st, period, key, at) {
    if (st.level == null) st.level = liveLevel();
    if (!Array.isArray(st.eligible)) st.eligible = eligibleIds(period, key, st.level, at);
    return st;
  }

  function gen(period, key, rerolls, st) {
    const ok = new Set(st.eligible);
    return generateChallenges({ app, templates, period, key, rerolls, level: st.level, slots: slotDefs[period], scale, filter: (t) => ok.has(t.id) });
  }

  function view(period, at = now()) {
    const key = keys(at)[period];
    const pk = `${period}:${key}`;
    const state = load();
    let st = state.periods[pk];
    if (!st || st.level == null || !Array.isArray(st.eligible)) { st = pin(st ?? blank(), period, key, at); state.periods[pk] = st; store.set(KEY, state); } // pin level + eligible templates on first generation
    return gen(period, key, st.rerolls, st).map((c) => {
      const progress = Math.min(c.target, st.progress[c.slot] ?? 0);
      const done = st.done[c.slot] != null;
      return { ...c, id: `${period}:${key}:${c.slot}:${c.rerolled}`, progress, pct: progress / c.target, done, doneAt: st.done[c.slot] ?? null,
        canReroll: !done && (st.rerolls[c.slot] ?? 0) < rerollCap[period] && Object.values(st.rerolls).reduce((a, b) => a + b, 0) < rerollCap[period] };
    });
  }

  const today = (at) => view("daily", at);
  const week = (at) => view("weekly", at);

  /** Feed a metric. Returns completions and whether the daily set was swept. */
  function report(metric, amount = 1, { at = now() } = {}) {
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount <= 0) return { completed: [], sweep: null, xp: 0 }; // NaN, 0 and negatives never move progress
    const state = load();
    const k = keys(at);
    const completed = [];
    let sweep = null;
    for (const period of ["daily", "weekly"]) {
      const pk = `${period}:${k[period]}`;
      const st = pin(state.periods[pk] ?? blank(), period, k[period], at);
      const list = gen(period, k[period], st.rerolls, st);
      for (const c of list) {
        if (c.metric !== metric || st.done[c.slot] != null) continue;
        const cur = st.progress[c.slot] ?? 0;
        const next = c.agg === "max" ? Math.max(cur, amount) : c.agg === "count" ? cur + 1 : cur + amount;
        if (next === cur) continue;
        st.progress[c.slot] = next;
        if (next >= c.target) { st.done[c.slot] = at; completed.push({ ...c, id: `${pk}:${c.slot}:${c.rerolled}`, progress: c.target, done: true, doneAt: at }); }
      }
      if (period === "daily" && list.length && !st.sweep && list.every((c) => st.done[c.slot] != null) && completed.some((c) => c.period === "daily")) {
        st.sweep = true; sweep = { xp: sweepXp, count: list.length };
      }
      state.periods[pk] = st; // always saved: it carries the pinned level
    }
    // prune old periods
    const nowKeys = keys(now());
    const keep = new Set([k, nowKeys].flatMap((x) => [`daily:${x.daily}`, `weekly:${x.weekly}`, `daily:${addDays(x.daily, -1)}`, `weekly:${addDays(x.weekly, -7)}`]));
    for (const pk of Object.keys(state.periods)) if (!keep.has(pk)) delete state.periods[pk];
    store.set(KEY, state);
    const result = { completed, sweep, xp: completed.reduce((a, c) => a + c.xp, 0) + (sweep?.xp ?? 0) };
    for (const c of completed) emitter.emit("complete", c);
    if (sweep) emitter.emit("sweep", sweep);
    return result;
  }

  /** Swap a not-yet-finished challenge for a new deterministic pick. */
  function reroll(slot, { period = "daily", at = now() } = {}) {
    const state = load();
    const key = keys(at)[period];
    const pk = `${period}:${key}`;
    const st = pin(state.periods[pk] ?? blank(), period, key, at);
    const used = Object.values(st.rerolls).reduce((a, b) => a + b, 0);
    if (st.done[slot] != null) return { ok: false, reason: "done" };
    if (used >= rerollCap[period]) return { ok: false, reason: "limit" };
    st.rerolls[slot] = (st.rerolls[slot] ?? 0) + 1;
    st.progress[slot] = 0;
    state.periods[pk] = st;
    store.set(KEY, state);
    const challenge = view(period, at).find((c) => c.slot === slot);
    emitter.emit("reroll", challenge);
    return { ok: true, challenge };
  }

  return { today, week, report, reroll, view, on: emitter.on, off: emitter.off, reset: () => store.remove(KEY) };
}
