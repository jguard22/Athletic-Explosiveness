// createFunKit: wires every module together behind one call per session.
//
//   const kit = createFunKit({ app: "steady", mode: "health", badges, challengeTemplates, ... });
//   const outcome = kit.completeSession({ metrics: { balance: 82 }, counters: { reps: 20 }, headline: {...} });
//   playOutcome(outcome, { celebrate, sound, haptics });     // juice/orchestrate.js
//
// You can also use any module on its own (kit.xp, kit.streaks, ...).

import { createMemoryStorage, createStore } from "./store.js";
import { createXp } from "./xp.js";
import { createStreaks } from "./streaks.js";
import { createChallenges } from "./challenges.js";
import { createAchievements } from "./achievements.js";
import { createQuests } from "./quests.js";
import { createPersonalBests } from "./pb.js";
import { createAdaptive } from "./adaptive.js";
import { createRewards } from "./rewards.js";
import { createGuardrails } from "./guardrails.js";
import { buildRecap, renderShareCard } from "./recap.js";
import { createEmitter } from "./emitter.js";
import { dayKey } from "./time.js";
import { labelsFor } from "./labels.js";

/**
 * @param {object} config
 *  app, mode ("playful"|"health"|"calm"|"kids"), guardrails (overrides), storage, store, storeVersion, migrations,
 *  now, tz, rolloverHour, weekStart, titles, curve, xp/streaks/challengeOptions/rewardOptions (module overrides),
 *  badges, challengeTemplates, quests, features, pbMetrics, drops, adaptive, baseSessionXp, firstSessionXp, dedupeMs,
 *  labels (the words on the recap cards; see labels.js), featureLabels (display names for feature ids; a `label` on a feature rule works too)
 *
 *  Streaks can be switched off for an app that has none: `streaks: false` (or `streaks: { enabled: false }`). Nothing then
 *  records a streak day, no streak cue or card appears, and the outcome carries `streak: { mode: "off", off: true }`.
 *  Per session, `countsTowardStreak: false` on completeSession() leaves one session out of the streak (it still earns XP,
 *  personal bests, badges and challenge progress).
 *
 * The guardrail mode wins over module overrides: a kids/health app cannot switch rewards back on, remove the
 * XP soft cap, restore swaps, or drop the template filter through xp / rewardOptions / challengeOptions.
 */
export function createFunKit(config = {}) {
  const { app, mode = "health", now = Date.now, tz, rolloverHour = 0 } = config;
  if (!app) throw new Error("fun-kit: `app` is required");
  const weekStart = config.weekStart ?? 1;
  const guard = createGuardrails(mode, config.guardrails);
  const d = guard.defaults();
  const store = config.store ?? createStore({ app, version: config.storeVersion ?? 1, migrations: config.migrations, storage: config.storage });
  const events = createEmitter();
  const streaksOn = config.streaks !== false && config.streaks?.enabled !== false;
  const streakCfg = config.streaks && typeof config.streaks === "object" ? (({ enabled, ...rest }) => rest)(config.streaks) : {};
  const W = labelsFor(config.labels);
  const featureLabel = (id) => config.features?.[id]?.label ?? config.featureLabels?.[id] ?? id;

  // Module options: the app's overrides sit on top of the guardrail defaults, then the guardrails re-assert what must hold.
  const xpOpts = { ...d.xp, ...config.xp };
  if (d.xp.dailySoftCap > 0 && !(xpOpts.dailySoftCap > 0 && xpOpts.dailySoftCap <= d.xp.dailySoftCap)) xpOpts.dailySoftCap = d.xp.dailySoftCap;
  const challengeOpts = { ...d.challenges, ...config.challengeOptions };
  if (!guard.allows("rerolls")) challengeOpts.maxRerolls = { daily: 0, weekly: 0 };
  const extraFilter = config.challengeOptions?.filter;
  challengeOpts.filter = (t) => guard.filterTemplate(t) && (typeof extraFilter === "function" ? !!extraFilter(t) : true);
  const rewardOpts = { ...d.rewards, ...config.rewardOptions, enabled: !!d.rewards.enabled && config.rewardOptions?.enabled !== false };

  const xp = createXp({ store, curve: config.curve, titles: config.titles, now, tz, rolloverHour, ...xpOpts });
  const streaks = createStreaks({ store, now, tz, rolloverHour, weekStart, ...d.streaks, ...streakCfg });
  const achievements = createAchievements({ store, badges: config.badges ?? [], now, tz, rolloverHour });
  const pb = createPersonalBests({ store, metrics: config.pbMetrics ?? [], now });
  const challenges = createChallenges({ app, store, templates: config.challengeTemplates ?? [], now, tz, rolloverHour, weekStart, level: () => xp.level, ...challengeOpts });
  const quests = createQuests({ store, quests: config.quests ?? [], features: config.features ?? {}, level: () => xp.level, counter: achievements.counter });
  const rewards = createRewards({ store, drops: config.drops ?? [], now, tz, rolloverHour, weekStart, ...rewardOpts });
  const adaptive = config.adaptive ? createAdaptive({ store, ...config.adaptive, ceiling: guard.capLoad(config.adaptive.ceiling ?? 1, 1) }) : null;

  const baseSessionXp = config.baseSessionXp ?? 30;
  const firstSessionXp = config.firstSessionXp ?? 25; // 30 + 25 = 55 >= the 40 XP first level, so session one levels up
  const pbXp = config.pbXp ?? 15;
  const partialXp = config.partialXp ?? 5;
  const dedupeMs = config.dedupeMs ?? 0;
  const metricLabel = new Map((config.pbMetrics ?? []).map((m) => [m.id, m]));
  const sharingOn = guard.allows("sharing");
  const tx = (fn) => (typeof store.transaction === "function" ? store.transaction(fn) : fn());

  const offState = () => ({ mode: "off", off: true, enabled: false, current: 0, best: 0, tokens: 0, status: "none", doneToday: false, milestones: [], nextMilestone: null });
  /** One-time or app-specific XP lines a session carries (a welcome bonus, a coach's award), checked and given a default source. */
  const extraEntries = (session) => (Array.isArray(session.extraXp) ? session.extraXp : [])
    .filter((e) => e && Number.isFinite(Number(e.amount)) && Number(e.amount) > 0)
    .map((e) => ({ source: "bonus", label: "Bonus", ...e, amount: Math.round(Number(e.amount)) }));
  const sessionCap = xpOpts.sessionCap > 0 ? xpOpts.sessionCap : 0;
  const repeatableSpent = (res) => res.applied.filter((a) => !a.exempt).reduce((n, a) => n + a.amount, 0);
  const finiteEntries = (obj, positiveOnly = false) => Object.entries(obj ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && (!positiveOnly || v > 0));
  const emptyQuests = () => ({ stepsCompleted: [], questsCompleted: [], unlockedFeatures: [] });
  const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const mergeXp = (a, b) => ({ ...b, gained: a.gained + b.gained, applied: [...a.applied, ...b.applied], dropped: [...(a.dropped ?? []), ...(b.dropped ?? [])], fromLevel: a.fromLevel, levelUp: b.toLevel > a.fromLevel, levelsGained: range(a.fromLevel + 1, b.toLevel) });
  const SESSIONS_KEY = "kit.sessions";

  /** Recent session ids (and the time of the last session) so a double-tap on "Done" is counted once. */
  const seenSessions = () => store.get(SESSIONS_KEY, { ids: [], last: null });

  function duplicateOutcome(at, why) {
    const info = xp.info();
    return {
      at, completed: true, duplicate: true, duplicateReason: why, appName: config.appName ?? app, headline: undefined, nextGoal: undefined,
      xp: { gained: 0, applied: [], dropped: [], total: info.total, ...info, fromLevel: info.level, toLevel: info.level, levelUp: false, levelsGained: [] },
      streak: streaksOn ? { ...streaks.state(at), mode: streaks.rules.mode, counted: false } : offState(), pbs: [], badges: [], challenges: [], quests: emptyQuests(), drop: null, celebrations: [], recap: [], nudge: null,
    };
  }

  /**
   * Record a finished session and get everything the UI needs to celebrate it.
   * All-or-nothing: if anything throws, every write it made is rolled back.
   * Pass a stable `id` (or set `dedupeMs`) so a double-tap on "Done" counts once; a repeat returns `{ duplicate: true }` with nothing to celebrate.
   * @param {{id?: string, at?: number, completed?: boolean, durationMs?: number, metrics?: Record<string, number>, counters?: Record<string, number>,
   *   tags?: string[], first?: string[], events?: string[], ghosts?: Record<string, Array<[number, number]>>, baseXp?: number,
   *   overTarget?: boolean, headline?: object, nextGoal?: object, countsTowardStreak?: boolean,
   *   extraXp?: Array<{amount: number, source?: string, label?: string, key?: string, once?: boolean}>}} session
   *  countsTowardStreak: false leaves this session out of the streak (no streak day, milestone, goal or comeback); it still
   *    earns XP, personal bests, badges and challenge progress. Default true.
   *  extraXp: app-specific XP lines (a welcome bonus, a coach's award) paid in the SAME award as the session, so one
   *    level-up result and cue covers everything. Give a one-time line a `key` and `once: true` (paid in full past the
   *    soft cap, never twice).
   *  counters and metrics both feed challenges; a name that appears in both is fed once, as the counter.
   */
  function completeSession(session = {}) {
    return tx(() => runSession(session));
  }

  function runSession(session) {
    const at = session.at ?? now();
    const completed = session.completed !== false;

    // 0. duplicate taps
    const seen = seenSessions();
    const sid = session.id == null ? null : String(session.id);
    if (sid && seen.ids.includes(sid)) return duplicateOutcome(at, "id");
    if (dedupeMs > 0 && seen.last != null && Math.abs(Number(at) - seen.last) < dedupeMs) return duplicateOutcome(at, "too-soon");
    store.set(SESSIONS_KEY, { ids: sid ? [...seen.ids, sid].slice(-50) : seen.ids, last: Number(at) });

    const day = dayKey(at, { tz, rolloverHour });
    const out = { at, completed, headline: session.headline, nextGoal: session.nextGoal, appName: config.appName ?? app, duplicate: false };
    const entries = [];
    out.nudge = guard.sessionNudge(session.durationMs);
    const recapOpts = { sharing: sharingOn, labels: config.labels, featureLabel };

    if (!completed) {
      // Once per day: abandoned sessions cannot be farmed for XP.
      entries.push({ amount: partialXp, source: "effort", label: W("xpPartial"), key: `partial:${day}` });
      entries.push(...extraEntries(session));
      out.xp = xp.award(entries, { at });
      out.streak = streaksOn ? { ...streaks.state(at), mode: streaks.rules.mode, counted: false } : offState();
      out.pbs = []; out.badges = []; out.challenges = []; out.quests = emptyQuests(); out.drop = null; out.celebrations = [];
      out.recap = buildRecap(out, recapOpts);
      return out;
    }

    // Over a medical/load target: the session still counts, but nothing measured in it is rewarded.
    // Withheld metrics never reach personal bests, "best ever" badge rules, threshold badges or challenges.
    const withhold = !!session.overTarget && guard.withholdOverTarget();
    out.overTarget = withhold;
    const metricList = finiteEntries(session.metrics);
    const counterList = finiteEntries(session.counters, true);
    const scored = withhold ? {} : Object.fromEntries(metricList);

    const firstEver = achievements.counter("sessions") === 0;
    const firstFlags = [...(session.first ?? []), ...(firstEver ? ["first_session"] : [])];

    // 1. streak (skipped when streaks are off, or this session opts out)
    const countStreak = streaksOn && session.countsTowardStreak !== false;
    const sr = countStreak ? streaks.record(at)
      : { newDay: false, milestone: null, comeback: null, goalReached: false, tokenEarned: false, coveredNow: false, after: streaksOn ? streaks.state(at) : offState() };
    const streakInfo = {
      ...sr.after, mode: streaksOn ? streaks.rules.mode : "off", ...(streaksOn ? {} : { off: true }), counted: countStreak,
      milestone: sr.milestone, comeback: sr.comeback, goalReached: sr.goalReached, tokenEarned: sr.tokenEarned, coveredNow: sr.coveredNow, newDay: sr.newDay,
    };

    // 2. counters + personal bests
    achievements.bump("sessions");
    if (sr.newDay) achievements.bump("activeDays");
    for (const [k, v] of counterList) achievements.bump(k, v);
    const pbs = [];
    const pbIds = [];
    for (const [id, value] of metricList) {
      const m = metricLabel.get(id);
      if (!m) { if (!withhold) achievements.observe(id, value); continue; }
      const valueText = m.format ? m.format(value) : String(value) + (m.unit ? ` ${m.unit}` : "");
      if (withhold) {
        const best = pb.best(id);
        pbs.push({ id, value, previous: best, best, status: "withheld", withheld: true, isPB: false, isFirst: false, nearMiss: false, tie: false, delta: 0, deltaPct: 0, text: "", label: m.label ?? id, valueText });
        continue;
      }
      const r = pb.submit(id, value, { at, ghost: session.ghosts?.[id] });
      pbs.push({ ...r, label: m.label ?? id, valueText, withheld: false });
      if (r.isPB) pbIds.push(id);
      achievements.observe(id, value);
    }

    // 3. challenges
    const done = [];
    let sweep = null;
    const feed = (metric, amount) => { const r = challenges.report(metric, amount, { at }); done.push(...r.completed); if (r.sweep) sweep = r.sweep; };
    feed("sessions", 1);
    if (Number.isFinite(session.durationMs) && session.durationMs > 0) feed("minutes", Math.max(1, Math.round(session.durationMs / 60000)));
    const counterNames = new Set(counterList.map(([k]) => k));
    for (const [k, v] of counterList) feed(k, v);
    for (const [k, v] of Object.entries(scored)) if (!counterNames.has(k)) feed(k, v); // a name given as both is fed once, as the counter

    // 4. badges (after streak, pbs and counters)
    const badges = achievements.evaluate({ at, metrics: scored, tags: session.tags ?? [], pbs: pbIds, first: firstFlags }, { current: streakInfo.current, mode: streakInfo.mode });

    // 5. quests
    const qres = emptyQuests();
    const qEvents = ["session", ...(session.events ?? []), ...(session.tags ?? [])];
    for (const e of qEvents) {
      const r = quests.report(e, 1);
      qres.stepsCompleted.push(...r.stepsCompleted); qres.questsCompleted.push(...r.questsCompleted); qres.unlockedFeatures.push(...r.unlockedFeatures);
    }

    // 6. XP (atomic: one level-up result however many sources)
    entries.push({ amount: session.baseXp ?? baseSessionXp, source: "session", label: W("xpSession"), ...(sid ? { key: `session:${sid}` } : {}) }); // keyed when the session has an id, so xp.revoke() can take it back
    if (firstEver) entries.push({ amount: firstSessionXp, source: "first", label: W("xpFirst"), key: "first-session", once: true });
    if (pbIds.length) entries.push({ amount: pbXp, source: "pb", label: W("xpPb"), key: `pb:${at}` });
    if (sr.milestone) entries.push({ amount: Math.min(60, sr.milestone * 2 + 10), source: "streak", label: W("xpMilestone", { n: sr.milestone }) });
    if (sr.goalReached) entries.push({ amount: 20, source: "goal", label: W("xpGoal") });
    if (sr.comeback) entries.push({ amount: sr.comeback.bonusXp, source: "comeback", label: W("xpComeback") });
    for (const c of done) entries.push({ amount: c.xp, source: "challenge", label: c.title });
    if (sweep) entries.push({ amount: sweep.xp, source: "sweep", label: W("xpSweep") });
    for (const b of badges) entries.push({ amount: b.xp, source: "badge", label: b.badge.title, key: `badge:${b.id}`, once: true });
    for (const s of qres.stepsCompleted) if (s.xp) entries.push({ amount: s.xp, source: "quest", label: s.step.title });
    for (const q of qres.questsCompleted) if (q.xp) entries.push({ amount: q.xp, source: "quest", label: q.quest.title });
    entries.push(...extraEntries(session));

    // 7. surprise drop (never reads performance)
    const drop = guard.allows("variableRewards") ? rewards.roll({ at }) : null;
    if (drop?.xp) entries.push({ amount: drop.xp, source: "drop", label: drop.drop.title });

    let xpRes = xp.award(entries, { at });
    // A level-up can open a level-gated quest; pay out whatever that completes (and merge it into one result).
    for (let pass = 0; pass < 3; pass++) {
      const refresh = quests.refresh();
      qres.unlockedFeatures.push(...refresh.unlockedFeatures);
      qres.stepsCompleted.push(...refresh.stepsCompleted); qres.questsCompleted.push(...refresh.questsCompleted);
      const more = [];
      for (const s of refresh.stepsCompleted) if (s.xp) more.push({ amount: s.xp, source: "quest", label: s.step.title });
      for (const q of refresh.questsCompleted) if (q.xp) more.push({ amount: q.xp, source: "quest", label: q.quest.title });
      if (!more.length) break;
      xpRes = mergeXp(xpRes, xp.award(more, { at, ...(sessionCap ? { cap: Math.max(0, sessionCap - repeatableSpent(xpRes)) } : {}) }));
    }
    out.xp = xpRes;

    out.streak = streakInfo;
    out.pbs = pbs;
    out.challenges = done;
    out.badges = badges;
    out.quests = qres;
    out.drop = drop;

    // 8. ordered celebration cues for juice/orchestrate.js
    const cues = [];
    if (out.xp.levelUp) cues.push({ type: "levelup", level: out.xp.toLevel, title: out.xp.title });
    for (const p of pbs) if (p.isPB && !p.withheld) cues.push({ type: "pb", pb: p });
    if (sr.goalReached) cues.push({ type: "goal" });
    if (sr.milestone) cues.push({ type: "milestone", value: sr.milestone });
    if (sr.comeback) cues.push({ type: "comeback", comeback: sr.comeback });
    for (const b of badges) cues.push({ type: "badge", badge: b.badge, tier: b.badge.tier ?? "common" });
    for (const c of done) cues.push({ type: "challenge", challenge: c });
    for (const f of qres.unlockedFeatures) cues.push({ type: "unlock", feature: f, label: featureLabel(f) });
    if (drop) cues.push({ type: "drop", drop: drop.drop });
    if (!cues.length) cues.push({ type: "complete" });
    out.celebrations = cues;
    out.recap = buildRecap({ ...out, quests: qres }, recapOpts);

    events.emit("session", out);
    return out;
  }

  /** Everything a home screen needs in one call. `includeHidden: false` leaves secret badge tiles out of `badges`. */
  function summary(at = now(), { includeHidden = true } = {}) {
    return {
      xp: xp.info(), streak: streaksOn ? { ...streaks.state(at), mode: streaks.rules.mode } : offState(), week: streaksOn ? streaks.recent(7, at) : [],
      today: challenges.today(at), weekly: challenges.week(at), nextQuest: quests.next(),
      badges: achievements.collection({ includeHidden }), features: quests.unlockedFeatures(), pending: quests.pendingAnnouncements(),
    };
  }

  /**
   * A second kit from the same configuration on its own storage (memory by default), so nothing it earns is saved: the
   * "demo twin" for a demo wearer, a tutorial or a what-if. It shares the content, guardrails, clock and options but
   * none of the state. `fork.parent` is this kit; `fork.awardToParent(entries)` pays something to the real kit (a
   * one-time welcome bonus, keyed so it is never paid twice) and returns that award's result.
   *   kit.fork()                          memory storage, same app name, nothing persists (`fork.store.durable` is false)
   *   kit.fork({ storage })               another Storage; the app name becomes `<app>-fork` unless you pass `app`
   *   kit.fork({ mode: "playful", ... })  any other createFunKit option, overriding this kit's
   * Call `fork.dispose()` when the twin is dropped.
   */
  function fork(o = {}) {
    const { storage, app: forkApp, store: forkStore, ...overrides } = o;
    const child = createFunKit({
      ...config, ...overrides,
      store: forkStore, app: forkApp ?? (storage ? `${app}-fork` : app), storage: forkStore ? undefined : storage ?? createMemoryStorage(),
    });
    child.parent = api;
    child.isFork = true;
    child.awardToParent = (entries, opts) => api.xp.award(entries, opts);
    return child;
  }

  const api = {
    app, mode, store, guard, guardrails: guard, xp, streaks, challenges, achievements, quests, pb, adaptive, rewards, events,
    completeSession, summary, buildRecap, fork, streaksEnabled: streaksOn, featureLabel,
    /** Share-card renderer bound to this kit's guardrails (refuses in kids mode, ignores the health opt-in where it is not allowed). */
    renderShareCard: (recap, opts = {}) => renderShareCard(recap, { guardrails: guard, appName: config.appName ?? app, labels: config.labels, ...opts }),
    /** Backup / restore the whole saved state as JSON (see store.exportData). */
    exportData: () => store.exportData?.(),
    importData: (payload, opts) => store.importData?.(payload, opts),
    requestPersistence: () => store.requestPersistence?.() ?? Promise.resolve(false),
    on: events.on,
    /** Forget everything: every key in the namespace, including the schema marker (it is written again with the next real save). */
    reset() { if (typeof store.wipe === "function") store.wipe(); else store.clear(); },
    /** Stop listening for other tabs and drop event handlers (a forked demo twin, a hot reload). */
    dispose() { try { store.dispose?.(); } catch {} },
  };
  return api;
}
