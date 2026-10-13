// Badge engine with a small rule DSL.
//
// Badge:  { id, title, desc, tier, hidden?, xp?, group?, icon?, rule, shareSafe? }
//   shareSafe: true lets the badge title appear on a share image. Default false: a title like
//   "Score 95 or higher" says something about a measurement, so it stays off shared cards unless you opt it in.
//
// Rules are plain objects (serialisable) combined with all/any/not:
//   { counter: "sessions", gte: 10 }            lifetime counter (bump() it)
//   { threshold: "score", gte: 90 }             value in THIS event's metrics
//   { max: "score", gte: 95 }                   best value ever observed
//   { streak: "any"|"daily"|"weekly", gte: 7 }  current streak from the event ctx
//   { personalBest: true } | { personalBest: "score" } | { personalBest: "score", count: 5 }
//   { firstTime: "glove" }                      first event flagged with this feature/tag
//   { combo: ["tagA", "tagB", rule...] }        every tag present in this event (and every rule true)
//   { time: { from: 22, to: 4 } }               hour-of-day window (wraps midnight)
//   { weekday: [0, 6] }
//   { all: [...] } { any: [...] } { not: rule }
//   { fn: (ctx) => boolean }                    escape hatch (not serialisable)
//
// Rarity tiers drive default XP and the colour token a host maps
// (--fk-rarity-common ... --fk-rarity-legendary). Hidden badges stay "???"
// until earned and never count against the total shown.

import { createEmitter } from "./emitter.js";
import { dayKey, wallClock, weekday } from "./time.js";

export const RARITY = Object.freeze({
  common: { rank: 0, label: "Common", xp: 10 },
  uncommon: { rank: 1, label: "Uncommon", xp: 20 },
  rare: { rank: 2, label: "Rare", xp: 40 },
  epic: { rank: 3, label: "Epic", xp: 75 },
  legendary: { rank: 4, label: "Legendary", xp: 150 },
});

const cmp = (v, r) => {
  if (v == null || Number.isNaN(v)) return false;
  if (r.gte != null && !(v >= r.gte)) return false;
  if (r.gt != null && !(v > r.gt)) return false;
  if (r.lte != null && !(v <= r.lte)) return false;
  if (r.lt != null && !(v < r.lt)) return false;
  if (r.eq != null && v !== r.eq) return false;
  return true;
};
const target = (r) => r.gte ?? (r.gt != null ? r.gt + 1 : r.eq ?? null);

/**
 * Evaluate a rule against a context:
 *  ctx = { counters, maxes, event: {metrics, tags, pbs, features, at}, streak: {current, mode}, seen, now, tz }
 */
export function evalRule(rule, ctx) {
  if (!rule) return false;
  if (typeof rule === "function") return !!rule(ctx);
  if ("all" in rule) return rule.all.every((r) => evalRule(r, ctx));
  if ("any" in rule) return rule.any.some((r) => evalRule(r, ctx));
  if ("not" in rule) return !evalRule(rule.not, ctx);
  if ("fn" in rule) return !!rule.fn(ctx);
  if ("counter" in rule) return cmp(ctx.counters[rule.counter] ?? 0, rule);
  if ("threshold" in rule) return cmp(ctx.event?.metrics?.[rule.threshold], rule);
  if ("max" in rule) return cmp(ctx.maxes[rule.max], rule);
  if ("streak" in rule) {
    if (rule.streak !== "any" && ctx.streak?.mode !== rule.streak) return false;
    return cmp(ctx.streak?.current ?? 0, rule);
  }
  if ("personalBest" in rule) {
    const pbs = ctx.event?.pbs ?? [];
    if (rule.count != null) return (ctx.counters[`pb:${rule.personalBest === true ? "*" : rule.personalBest}`] ?? 0) >= rule.count;
    return rule.personalBest === true ? pbs.length > 0 : pbs.includes(rule.personalBest);
  }
  if ("firstTime" in rule) return (ctx.event?.first ?? []).includes(rule.firstTime);
  if ("combo" in rule) {
    const tags = ctx.event?.tags ?? [];
    return rule.combo.every((c) => (typeof c === "string" ? tags.includes(c) : evalRule(c, ctx)));
  }
  if ("time" in rule) {
    const { hour } = wallClock(ctx.event?.at ?? ctx.now, ctx.tz);
    const { from, to } = rule.time;
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  }
  if ("weekday" in rule) return rule.weekday.includes(weekday(dayKey(ctx.event?.at ?? ctx.now, { tz: ctx.tz, rolloverHour: ctx.rolloverHour })));
  return false;
}

/** Progress (0..1) for rules that are naturally countable; null otherwise. */
export function ruleProgress(rule, ctx) {
  if (!rule || typeof rule !== "object") return null;
  if ("counter" in rule) { const t = target(rule); return t ? { value: Math.min(ctx.counters[rule.counter] ?? 0, t), target: t } : null; }
  if ("max" in rule) { const t = target(rule); return t ? { value: Math.min(ctx.maxes[rule.max] ?? 0, t), target: t } : null; }
  if ("streak" in rule) { const t = target(rule); return t ? { value: Math.min(ctx.streak?.current ?? 0, t), target: t } : null; }
  if ("personalBest" in rule && rule.count != null) { const v = ctx.counters[`pb:${rule.personalBest === true ? "*" : rule.personalBest}`] ?? 0; return { value: Math.min(v, rule.count), target: rule.count }; }
  if ("all" in rule) { const parts = rule.all.map((r) => ruleProgress(r, ctx)).filter(Boolean); if (parts.length) { const v = parts.reduce((a, p) => a + p.value / p.target, 0) / parts.length; return { value: v, target: 1 }; } }
  return null;
}

/** Throws a clear error for badge content that would fail later, mid-session (unknown tier, no rule, duplicate id). */
export function validateBadges(badges) {
  const seen = new Set();
  for (const b of badges) {
    if (!b || !b.id) throw new Error("fun-kit badges: every badge needs an id");
    if (seen.has(b.id)) throw new Error(`fun-kit badges: duplicate badge id "${b.id}"`);
    seen.add(b.id);
    if (b.tier != null && !Object.hasOwn(RARITY, b.tier)) throw new Error(`fun-kit badges: badge "${b.id}" has unknown tier "${b.tier}" (use ${Object.keys(RARITY).join(", ")})`);
    if (b.rule == null) throw new Error(`fun-kit badges: badge "${b.id}" has no rule`);
    if (b.xp != null && !Number.isFinite(b.xp)) throw new Error(`fun-kit badges: badge "${b.id}" xp must be a number`);
  }
}

/**
 * @param {{store: any, badges: object[], now?: () => number, tz?: string, rolloverHour?: number}} opts
 */
export function createAchievements({ store, badges = [], now = Date.now, tz, rolloverHour = 0 } = {}) {
  validateBadges(badges);
  const KEY = "achievements";
  const emitter = createEmitter();
  const byId = new Map(badges.map((b) => [b.id, b]));
  const load = () => store.get(KEY, { counters: {}, maxes: {}, seen: [], unlocked: {} });

  const ctxFor = (st, event, streak) => ({ counters: st.counters, maxes: st.maxes, event, streak, seen: st.seen, now: now(), tz, rolloverHour });

  /** Lifetime counters (sessions, reps, activeDays...). */
  function bump(name, n = 1) {
    if (!Number.isFinite(n) || n <= 0) return counter(name); // NaN / negative amounts never change a counter
    const st = load();
    st.counters[name] = (st.counters[name] ?? 0) + n;
    store.set(KEY, st);
    return st.counters[name];
  }
  const counter = (name) => load().counters[name] ?? 0;

  /** Track best-ever values. */
  function observe(metric, value) {
    if (!Number.isFinite(value)) return;
    const st = load();
    if (st.maxes[metric] == null || value > st.maxes[metric]) { st.maxes[metric] = value; store.set(KEY, st); }
  }

  /**
   * Evaluate every locked badge for an event. Idempotent: a badge unlocks once.
   * event = { at?, metrics?, tags?, pbs?: string[], first?: string[] }
   * Returns the list of newly unlocked { id, badge, at, xp }.
   */
  function evaluate(event = {}, streak = null) {
    const st = load();
    const at = event.at ?? now();
    const ev = { ...event, at };
    for (const f of ev.first ?? []) if (!st.seen.includes(f)) st.seen.push(f);
    // automatic PB counters
    for (const m of ev.pbs ?? []) {
      st.counters[`pb:${m}`] = (st.counters[`pb:${m}`] ?? 0) + 1;
      st.counters["pb:*"] = (st.counters["pb:*"] ?? 0) + 1;
    }
    // `firstTime` should only fire the first time: filter flags already seen before this event
    const prevSeen = new Set(load().seen);
    ev.first = (event.first ?? []).filter((f) => !prevSeen.has(f));
    const ctx = ctxFor(st, ev, streak);
    const out = [];
    for (const b of badges) {
      if (st.unlocked[b.id]) continue;
      let ok = false;
      try { ok = evalRule(b.rule, ctx); } catch { ok = false; }
      if (ok) {
        const xp = b.xp ?? RARITY[b.tier ?? "common"].xp;
        st.unlocked[b.id] = { at };
        out.push({ id: b.id, badge: b, at, xp });
      }
    }
    store.set(KEY, st);
    for (const u of out) emitter.emit("unlock", u);
    return out;
  }

  /** Mark a feature/tag as seen without evaluating (e.g. first connect). */
  function markSeen(name) { const st = load(); if (!st.seen.includes(name)) { st.seen.push(name); store.set(KEY, st); } }
  const hasSeen = (name) => load().seen.includes(name);

  function progressOf(b, st = load()) {
    if (st.unlocked[b.id]) return { value: 1, target: 1, pct: 1 };
    const p = ruleProgress(b.rule, ctxFor(st, {}, null));
    return p ? { ...p, pct: p.target ? p.value / p.target : 0 } : null;
  }

  /**
   * Data for a collection screen. Locked hidden badges come back as "Secret badge" tiles (the screen can show how many
   * are left to find). `includeHidden: false` leaves those tiles out altogether, with no hint that any exist; a hidden
   * badge that is already unlocked still shows.
   */
  function collection({ includeHidden = true } = {}) {
    const st = load();
    const all = badges.map((b) => {
      const unlocked = st.unlocked[b.id];
      const hiddenLocked = !!b.hidden && !unlocked;
      return {
        id: b.id, tier: b.tier ?? "common", group: b.group ?? null, icon: b.icon ?? "star",
        title: hiddenLocked ? "Secret badge" : b.title, desc: hiddenLocked ? "Keep playing to discover this one." : b.desc,
        unlocked: !!unlocked, at: unlocked?.at ?? null, hidden: !!b.hidden, secret: hiddenLocked,
        progress: hiddenLocked ? null : progressOf(b, st),
      };
    });
    const items = includeHidden ? all : all.filter((i) => !i.secret);
    const visible = items.filter((i) => !i.secret);
    const byTier = {};
    for (const t of Object.keys(RARITY)) {
      const inTier = items.filter((i) => i.tier === t);
      byTier[t] = { total: inTier.filter((i) => !i.secret).length, unlocked: inTier.filter((i) => i.unlocked).length };
    }
    const unlockedCount = items.filter((i) => i.unlocked).length;
    return {
      items: items.sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || RARITY[b.tier].rank - RARITY[a.tier].rank),
      total: visible.length + items.filter((i) => i.secret).length,
      unlockedCount, pct: items.length ? unlockedCount / items.length : 0,
      secretsRemaining: items.filter((i) => i.secret).length, byTier,
    };
  }

  return {
    bump, counter, observe, evaluate, markSeen, hasSeen, collection,
    isUnlocked: (id) => !!load().unlocked[id],
    get: (id) => byId.get(id),
    counters: () => load().counters,
    on: emitter.on, off: emitter.off,
    reset: () => store.remove(KEY),
  };
}
