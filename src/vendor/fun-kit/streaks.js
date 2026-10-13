// Streaks, the kind way.
//
// Two modes:
//   "daily"  - consecutive days, softened by a grace day (one missed day is
//              forgiven, regenerating every `graceCooldownDays`) and by "rest
//              day" tokens that are EARNED (1 per `earnEvery` streak days, hold
//              up to `maxTokens`) and spent automatically on missed days.
//   "weekly" - a weekly goal (default 3 sessions/week). Only a COMPLETED short
//              week can interrupt the chain, rest tokens cover it, and the
//              first week is pro-rated. This is the default for health apps:
//              rest days are part of training, so they can never "break" it.
//
// The weekly goal can change without re-scoring the past: `setGoal(n)` records a goal HISTORY, and every
// completed week is judged against the goal that applied to it. A raise starts next week, a lowering starts now.
//
// A lapse never shames: when a chain ends the next session returns a
// `comeback` result with a welcome-back XP bonus, and `best` is kept forever.
//
// Everything is derived by replaying a compact map of active days
// ({ "2026-10-12": sessions }) so results are deterministic, survive
// time-zone changes (day keys, not timestamps) and are trivial to test.
// History older than `maxHistoryDays` is folded into a small checkpoint
// (`base`: tokens, run, best, ...) instead of being dropped, so trimming the
// map never changes current, best or tokens; replay just resumes from it.

import { createEmitter } from "./emitter.js";
import { getLabel } from "./labels.js";
import { addDays, dayKey, daysLeftInWeek, diffDays, weekStartKey } from "./time.js";

export const STREAK_DEFAULTS = Object.freeze({
  mode: "daily",
  weeklyTarget: 3,
  unit: "days", // weekly counting: "days" = distinct active days, "sessions" = every session
  prorateFirstWeek: true,
  weekStart: 1, // Monday
  graceDays: 1,
  graceCooldownDays: 7,
  startTokens: 1, // a welcome token every run begins with, in both modes (rest tokens after that are earned); 0 makes them purely earned
  earnEvery: 0, // 0 = 7 for daily, 4 for weekly
  maxTokens: 2,
  milestones: [],
  rolloverHour: 0,
  tz: undefined,
  maxHistoryDays: 800, // active days older than this are dropped; `best` is saved separately and kept forever, but the run being counted can only reach back this far
  minComebackStreak: 2,
});

const MILESTONES = { daily: [3, 7, 14, 30, 60, 100, 200, 365], weekly: [1, 2, 4, 8, 12, 26, 52] };

export function resolveRules(cfg = {}) {
  const r = { ...STREAK_DEFAULTS, ...cfg };
  if (!r.earnEvery) r.earnEvery = r.mode === "weekly" ? 4 : 7;
  if (!r.milestones?.length) r.milestones = MILESTONES[r.mode];
  return r;
}

/** The weekly target that applies to the week starting `wk`: the last goal-history entry at or before it, else the configured target. */
export function goalForWeek(rules, wk) {
  let t = rules.weeklyTarget;
  for (const g of rules.goals ?? []) { if (g.from <= wk) t = g.target; else break; }
  return t;
}

const sortedKeys = (days, upTo) => Object.keys(days).filter((k) => k <= upTo).sort();

/** Run the daily rules over sorted active days, from a checkpoint if given. */
function replayDaily(keys, rules, base) {
  const st = base ? { ...base } : { tokens: rules.startTokens, current: 0, best: 0, last: null, lastGrace: null, active: 0 };
  const covered = [], breaks = [], earned = [];
  let lapsedFrom = 0;

  const plan = (missedFirst, need, lg, tk) => {
    const graceOk = rules.graceDays > 0 && (lg == null || diffDays(missedFirst, lg) >= rules.graceCooldownDays);
    const graceUse = graceOk ? Math.min(rules.graceDays, need) : 0;
    const rest = need - graceUse;
    return { ok: rest <= tk, graceUse, rest };
  };

  for (const k of keys) {
    if (st.last != null && k <= st.last) continue; // older than the checkpoint (a very late backfill): already folded in
    st.active++;
    if (st.last == null) st.current = 1;
    else {
      const need = diffDays(k, st.last) - 1;
      if (need === 0) st.current++;
      else {
        const first = addDays(st.last, 1);
        const p = plan(first, need, st.lastGrace, st.tokens);
        if (p.ok) {
          for (let i = 0; i < need; i++) covered.push({ day: addDays(first, i), by: i < p.graceUse ? "grace" : "rest" });
          if (p.graceUse) st.lastGrace = first;
          st.tokens -= p.rest;
          st.current++;
          lapsedFrom = 0;
        } else {
          breaks.push({ at: k, previous: st.current, missedDays: need });
          lapsedFrom = 0;
          st.current = 1;
        }
      }
    }
    if (st.current > st.best) st.best = st.current;
    if (st.current > 0 && st.current % rules.earnEvery === 0 && st.tokens < rules.maxTokens) {
      st.tokens++; earned.push({ day: k, streak: st.current });
    }
    st.last = k;
  }
  return { st, covered, breaks, earned, lapsedFrom, plan };
}

/** Pure daily evaluation. `days` = { dayKey: sessionCount }; `base` = optional checkpoint of older, folded-away history. */
export function evaluateDaily(days, today, rulesIn, base = null) {
  const rules = resolveRules({ ...rulesIn, mode: "daily" });
  const keys = sortedKeys(days, today);
  const run = replayDaily(keys, rules, base?.mode === "daily" ? base : null);
  const { st, covered, breaks, earned, plan } = run;
  let lapsedFrom = run.lapsedFrom;
  const { tokens, best, last, lastGrace } = st;
  let current = st.current;

  let status = "none", doneToday = false, comebackReady = false, pendingCover = 0;
  if (last != null) {
    const gap = diffDays(today, last);
    if (gap === 0) { status = "done"; doneToday = true; }
    else if (gap === 1) status = "ready";
    else {
      const need = gap - 1;
      const p = plan(addDays(last, 1), need, lastGrace, tokens);
      if (p.ok) { status = "resting"; pendingCover = need; }
      else { status = "lapsed"; lapsedFrom = current; current = 0; comebackReady = lapsedFrom >= rules.minComebackStreak; }
    }
  }
  const toToken = current > 0 ? rules.earnEvery - (current % rules.earnEvery) : rules.earnEvery;
  return {
    mode: "daily", current, best, tokens, maxTokens: rules.maxTokens, status, doneToday, lastActive: last, today,
    covered, breaks, earned, pendingCover, lapsedFrom, comebackReady,
    graceReady: rules.graceDays > 0 && (lastGrace == null || diffDays(today, lastGrace) >= rules.graceCooldownDays),
    toNextToken: toToken,
    milestones: rules.milestones.filter((m) => m <= current),
    nextMilestone: rules.milestones.find((m) => m > current) ?? null,
    activeDays: st.active,
  };
}

/** Checkpoint of everything before `cutoff` (a day key), so those days can be deleted without changing any result. */
export function foldDaily(days, cutoff, rulesIn, base = null) {
  const rules = resolveRules({ ...rulesIn, mode: "daily" });
  const old = Object.keys(days).filter((k) => k < cutoff && days[k] > 0).sort();
  const prior = base?.mode === "daily" ? base : null;
  if (!old.length) return prior;
  const { st } = replayDaily(old, rules, prior);
  return { mode: "daily", ...st };
}

/**
 * Run the weekly rules for every COMPLETED week in [fromWeek, toWeek), from a checkpoint if given.
 * A checkpoint already includes all weeks before its `nextWeek`, and its weeks are never "first" (no pro-rating).
 */
function replayWeekly(days, rules, fromWeek, toWeek, base, firstDay) {
  const st = base ? { ...base } : { tokens: rules.startTokens, current: 0, best: 0, run: 0, lapsedFrom: 0, active: 0, lastOutcome: null };
  const weeks = [], breaks = [], earned = [];
  const weekCount = (wk) => {
    let distinct = 0, sessions = 0;
    for (let i = 0; i < 7; i++) { const n = days[addDays(wk, i)] ?? 0; if (n > 0) distinct++; sessions += n; }
    return rules.unit === "days" ? distinct : sessions;
  };
  const targetFor = (wk, isFirst) => {
    let t = goalForWeek(rules, wk);
    if (isFirst && rules.prorateFirstWeek && firstDay) t = Math.max(1, Math.min(t, 7 - diffDays(firstDay, wk)));
    return t;
  };
  if (fromWeek) {
    for (let wk = fromWeek; wk < toWeek; wk = addDays(wk, 7)) {
      const target = targetFor(wk, !base && wk === fromWeek);
      const count = weekCount(wk);
      let outcome;
      if (count >= target) {
        st.current++; st.run++; outcome = "qualified"; st.lapsedFrom = 0;
        if (st.run % rules.earnEvery === 0 && st.tokens < rules.maxTokens) { st.tokens++; earned.push({ week: wk, streak: st.current }); }
      } else if (st.current > 0 && st.tokens > 0) {
        st.tokens--; outcome = "rested";
      } else {
        if (st.current > 0) { breaks.push({ week: wk, previous: st.current }); st.lapsedFrom = st.current; }
        st.current = 0; st.run = 0; outcome = "missed";
      }
      if (st.current > st.best) st.best = st.current;
      st.lastOutcome = outcome;
      weeks.push({ week: wk, count, target, outcome });
    }
  }
  return { st, weeks, breaks, earned, weekCount, targetFor };
}

/** Pure weekly-goal evaluation. `base` = optional checkpoint of older, folded-away weeks. */
export function evaluateWeekly(days, today, rulesIn, baseIn = null) {
  const rules = resolveRules({ ...rulesIn, mode: "weekly" });
  const keys = sortedKeys(days, today);
  const thisWeek = weekStartKey(today, rules.weekStart);
  const base = baseIn?.mode === "weekly" ? baseIn : null;
  const firstDay = keys[0];
  const firstWeek = base ? base.nextWeek : firstDay ? weekStartKey(firstDay, rules.weekStart) : null;
  const run = replayWeekly(days, rules, firstWeek, thisWeek, base, firstDay);
  const { weeks, breaks, earned, weekCount, targetFor, st } = run;
  let { tokens, current, best } = st;
  const lapsedFrom = st.lapsedFrom;
  const count = weekCount(thisWeek);
  const target = targetFor(thisWeek, !base && thisWeek === firstWeek);
  const reached = count >= target;
  const left = daysLeftInWeek(today, rules.weekStart);
  const doneToday = (days[today] ?? 0) > 0;
  const remaining = Math.max(0, target - count);
  const possible = rules.unit === "days" ? left - (doneToday ? 1 : 0) : Infinity;
  const effective = reached ? current + 1 : current;
  if (effective > best) best = effective;
  const lastOutcome = weeks.length ? weeks[weeks.length - 1].outcome : st.lastOutcome;
  const everActive = keys.length > 0 || !!base;
  let status = "none";
  if (everActive) {
    if (reached) status = "reached";
    else if (lapsedFrom > 0 && current === 0 && count === 0) status = "lapsed"; // a comeback session this week means we are building again
    else if (lastOutcome === "rested") status = "resting";
    else status = "building";
  }
  const nextGoal = (rules.goals ?? []).find((g) => g.from > thisWeek) ?? null;
  return {
    mode: "weekly", unit: rules.unit, current: effective, best, tokens, maxTokens: rules.maxTokens, status, doneToday, today, weeks, breaks, earned,
    goal: { target: goalForWeek(rules, thisWeek), next: nextGoal ? { from: nextGoal.from, target: nextGoal.target } : null },
    covered: weeks.filter((w) => w.outcome === "rested").map((w) => ({ week: w.week, by: "rest" })),
    lapsedFrom: reached ? 0 : lapsedFrom,
    comebackReady: !reached && lapsedFrom >= rules.minComebackStreak && current === 0 && count === 0,
    thisWeek: { week: thisWeek, count, target, remaining, reached, daysLeft: left, onTrack: remaining <= possible, over: Math.max(0, count - target), unit: rules.unit },
    toNextToken: rules.earnEvery - (st.run % rules.earnEvery),
    milestones: rules.milestones.filter((m) => m <= effective),
    nextMilestone: rules.milestones.find((m) => m > effective) ?? null,
    activeDays: (base?.active ?? 0) + keys.length,
  };
}

/** Checkpoint of every completed week before `cutoffWeek` (a week-start key), so older days can be deleted without changing any result. */
export function foldWeekly(days, cutoffWeek, rulesIn, baseIn = null) {
  const rules = resolveRules({ ...rulesIn, mode: "weekly" });
  const base = baseIn?.mode === "weekly" ? baseIn : null;
  const old = Object.keys(days).filter((k) => k < cutoffWeek && days[k] > 0).sort();
  const firstDay = old[0];
  const from = base ? base.nextWeek : firstDay ? weekStartKey(firstDay, rules.weekStart) : null;
  if (!from || from >= cutoffWeek) return base ?? null;
  const run = replayWeekly(days, rules, from, cutoffWeek, base, firstDay);
  return { mode: "weekly", ...run.st, active: (base?.active ?? 0) + old.length, nextWeek: cutoffWeek };
}

export const comebackBonusXp = (previous) => Math.max(10, Math.min(60, 10 + 3 * Math.min(previous, 20)));

export function comebackMessage(previous, mode = "daily") {
  const unit = getLabel(mode === "weekly" ? "unitWeek" : "unitDay", { n: 2 });
  return previous >= 2 ? getLabel("comebackLong", { previous, unit }) : getLabel("comebackShort");
}

const GOAL_ANCHOR = "0000-01-01"; // goal-history entry that pins the target in force before the first setGoal()
const MAX_WEEKLY_GOAL = { days: 7, sessions: 50 };

/**
 * @param {{store: any, now?: () => number} & Partial<typeof STREAK_DEFAULTS>} opts
 */
export function createStreaks({ store, now = Date.now, ...cfg } = {}) {
  const rules = resolveRules(cfg);
  const KEY = "streak";
  const emitter = createEmitter();
  const loadState = () => store.get(KEY, { days: {} });
  const loadDays = () => loadState().days ?? {};
  /** Rules with the saved weekly-goal history applied. */
  const rulesWith = (goals) => (goals?.length ? { ...rules, goals } : rules);
  const evaluate = (at = now(), days, base, goals) => {
    if (days === undefined) { const st = loadState(); days = st.days ?? {}; base = st.base ?? null; goals = st.goals; }
    const today = dayKey(at, rules);
    const r = rulesWith(goals);
    return rules.mode === "weekly" ? evaluateWeekly(days, today, r, base) : evaluateDaily(days, today, r, base);
  };
  const persist = (days, base, goals) => store.set(KEY, { days, ...(base ? { base } : {}), ...(goals?.length ? { goals } : {}) });

  function record(at = now(), { sessions = 1 } = {}) {
    const saved = loadState();
    const days = saved.days ?? {};
    let base = saved.base ?? null;
    let goals = saved.goals ?? [];
    const key = dayKey(at, rules);
    const before = evaluate(at, days, base, goals);
    const newDay = !(days[key] > 0);
    days[key] = (days[key] ?? 0) + sessions;
    const after = evaluate(at, days, base, goals); // computed on the full history, so earned / covered diffs are exact
    // Fold history older than maxHistoryDays into the checkpoint (results are identical; the map just stays small).
    const cutoffDay = addDays(key, -rules.maxHistoryDays);
    const cutoff = rules.mode === "weekly" ? weekStartKey(cutoffDay, rules.weekStart) : cutoffDay;
    if (Object.keys(days).some((k) => k < cutoff)) {
      base = (rules.mode === "weekly" ? foldWeekly : foldDaily)(days, cutoff, rulesWith(goals), base);
      for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
      if (base?.nextWeek) goals = compactGoals(goals, base.nextWeek); // weeks before the checkpoint are never replayed again
    }
    persist(days, base, goals);
    const prevCur = before.status === "lapsed" || before.current === 0 ? 0 : before.current;
    const milestone = after.current > prevCur ? (rules.milestones.includes(after.current) ? after.current : null) : null;
    const comebackFrom = before.comebackReady ? before.lapsedFrom : 0;
    const result = {
      day: key, newDay, before, after, state: after,
      milestone,
      tokenEarned: after.earned.length > before.earned.length,
      goalReached: rules.mode === "weekly" && !before.thisWeek.reached && after.thisWeek.reached,
      coveredNow: after.covered.length > before.covered.length,
      comeback: comebackFrom ? { previous: comebackFrom, bonusXp: comebackBonusXp(comebackFrom), message: comebackMessage(comebackFrom, rules.mode) } : null,
    };
    emitter.emit("record", result);
    if (result.milestone) emitter.emit("milestone", result);
    if (result.goalReached) emitter.emit("goal", result);
    if (result.comeback) emitter.emit("comeback", result);
    return result;
  }

  /**
   * Change the weekly goal WITHOUT re-scoring history: every completed week keeps the goal it was played under.
   * A lower goal applies from this week (it can only help); a higher one from next week, so a week already won
   * is never un-won. `fromWeek` (any day in the week) can push the change later, never earlier than this week.
   * Weekly mode only. Setting the goal back to what is in force cancels a pending change.
   * @returns {{ok: true, target: number, previous: number, from: string, applies: "now"|"next-week"|"later", changed: boolean, clamped: boolean, state: object}
   *   | {ok: false, reason: "not-weekly"|"invalid"}}
   */
  function setGoal(n, { fromWeek, at = now() } = {}) {
    if (rules.mode !== "weekly") return { ok: false, reason: "not-weekly" };
    const target = Number(n);
    if (!Number.isInteger(target) || target < 1 || target > MAX_WEEKLY_GOAL[rules.unit === "sessions" ? "sessions" : "days"]) return { ok: false, reason: "invalid" };
    const saved = loadState();
    const thisWeek = weekStartKey(dayKey(at, rules), rules.weekStart);
    let goals = (saved.goals ?? []).filter((g) => g.from <= thisWeek); // a pending (future) change is replaced by this call
    if (!goals.length) goals = [{ from: GOAL_ANCHOR, target: rules.weeklyTarget }]; // pins the target in force now, even if the app's config changes later
    const previous = goalForWeek({ ...rules, goals }, thisWeek);
    let from, clamped = false;
    if (fromWeek != null) {
      from = weekStartKey(String(fromWeek), rules.weekStart);
      if (from < thisWeek) { from = thisWeek; clamped = true; } // history is never rewritten
    } else from = target < previous ? thisWeek : addDays(thisWeek, 7);
    const inForceAtFrom = goalForWeek({ ...rules, goals }, from);
    const changed = target !== inForceAtFrom;
    if (changed) {
      goals = goals.filter((g) => g.from !== from);
      goals.push({ from, target });
      goals.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    }
    // Drop entries that no longer change anything (a goal equal to the one before it), keeping the anchor.
    goals = goals.filter((g, i) => i === 0 || g.target !== goals[i - 1].target);
    persist(saved.days ?? {}, saved.base ?? null, goals);
    const result = {
      ok: true, target, previous, from, changed, clamped,
      applies: from <= thisWeek ? "now" : from === addDays(thisWeek, 7) ? "next-week" : "later",
      state: evaluate(at),
    };
    if (changed) emitter.emit("goalchange", result);
    return result;
  }

  /** Last `n` days ending today: [{day, active, covered, today}] for week-dot strips. */
  function recent(n = 7, at = now()) {
    const days = loadDays();
    const today = dayKey(at, rules);
    const ev = evaluate(at);
    const cov = new Set(ev.covered?.map((c) => c.day));
    return Array.from({ length: n }, (_, i) => {
      const day = addDays(today, i - (n - 1));
      return { day, active: (days[day] ?? 0) > 0, covered: cov.has(day), today: day === today };
    });
  }

  return {
    rules,
    record,
    setGoal,
    /** The weekly goal in force this week, the pending change (if any) and the full history (oldest first). Weekly mode only. */
    goal(at = now()) {
      if (rules.mode !== "weekly") return null;
      const goals = loadState().goals ?? [];
      const thisWeek = weekStartKey(dayKey(at, rules), rules.weekStart);
      const next = goals.find((g) => g.from > thisWeek) ?? null;
      return { target: goalForWeek(rulesWith(goals), thisWeek), next: next ? { ...next } : null, history: goals.filter((g) => g.from !== GOAL_ANCHOR).map((g) => ({ ...g })) };
    },
    state: (at) => evaluate(at),
    recent,
    on: emitter.on, off: emitter.off,
    reset: () => store.remove(KEY),
    /** Test / import helper: replace the active-day map (the goal history is kept). */
    _setDays: (days) => { const g = loadState().goals; persist(days, null, g); },
  };
}

/** Goal entries that predate the checkpoint week collapse to the one still in force there. */
function compactGoals(goals, nextWeek) {
  const old = goals.filter((g) => g.from < nextWeek);
  if (old.length <= 1) return goals;
  return [{ ...old[old.length - 1], from: GOAL_ANCHOR }, ...goals.filter((g) => g.from >= nextWeek)];
}
