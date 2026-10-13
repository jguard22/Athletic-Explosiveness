// Quest chains / skill tree with unlock gating = progressive feature reveal.
//
// Features are things the host app can show or hide ("history", "glove",
// "challenges"...). Core features are always on; the rest are revealed as the
// player completes quests, reaches levels or finishes sessions, so a newcomer
// sees a calm app and discovers more as they go.
//
// Quest:  { id, title, desc, requires?: Gate, steps: Step[], unlocks?: string[], xp?: number, parallel?: boolean }
// Step:   { id, title, goal: { event: "session", count: 3 } | { counter: "sessions", gte: 5 }, xp? }
// Gate:   { quests?: string[], level?: number, counters?: {name: n}, features?: string[] }
// Feature rules (optional, besides quest.unlocks):
//   features: { history: { default: true }, glove: { level: 3 }, challenges: { quest: "first-steps" }, ... }

import { createEmitter } from "./emitter.js";

function gateOk(gate, ctx) {
  if (!gate) return true;
  if (gate.level != null && ctx.level < gate.level) return false;
  if (gate.quests?.some((q) => !ctx.completed.has(q))) return false;
  if (gate.counters && Object.entries(gate.counters).some(([k, v]) => (ctx.counter(k) ?? 0) < v)) return false;
  if (gate.features?.some((f) => !ctx.isFeatureOn(f))) return false;
  return true;
}

/** Throws a clear error for quest content that would break mid-session (no id, no steps, duplicate ids). */
export function validateQuests(quests) {
  const seen = new Set();
  for (const q of quests) {
    if (!q || !q.id) throw new Error("fun-kit quests: every quest needs an id");
    if (seen.has(q.id)) throw new Error(`fun-kit quests: duplicate quest id "${q.id}"`);
    seen.add(q.id);
    if (!Array.isArray(q.steps) || !q.steps.length) throw new Error(`fun-kit quests: quest "${q.id}" needs at least one step`);
    const steps = new Set();
    for (const s of q.steps) {
      if (!s || !s.id) throw new Error(`fun-kit quests: every step of "${q.id}" needs an id`);
      if (steps.has(s.id)) throw new Error(`fun-kit quests: quest "${q.id}" has two steps called "${s.id}"`);
      steps.add(s.id);
    }
  }
}

/**
 * @param {{store: any, quests: object[], features?: Record<string, object>, level?: () => number, counter?: (name: string) => number}} opts
 */
export function createQuests({ store, quests = [], features = {}, level = () => 1, counter = () => 0 } = {}) {
  validateQuests(quests);
  const KEY = "quests";
  const emitter = createEmitter();
  const byId = new Map(quests.map((q) => [q.id, q]));
  const load = () => store.get(KEY, { events: {}, stepDone: {}, done: {}, started: [], revealed: [], announced: [] });

  const gatedByQuest = new Set(quests.flatMap((q) => q.unlocks ?? []));
  function featureOn(id, st = load()) {
    const rule = features[id];
    if (rule?.default) return true;
    if (st.revealed.includes(id)) return true;
    // Anything a rule or quest gates stays hidden until revealed; unknown ids are ungated.
    return !(rule || gatedByQuest.has(id));
  }

  const ctxOf = (st) => ({
    level: level(), completed: new Set(Object.keys(st.done)), counter,
    isFeatureOn: (f) => featureOn(f, st),
  });

  function stepProgress(q, step, st) {
    const g = step.goal ?? {};
    if (g.counter) {
      const v = counter(g.counter) ?? 0; const t = g.gte ?? 1;
      return { value: Math.min(v, t), target: t, done: v >= t };
    }
    const t = g.count ?? 1;
    const v = st.events[`${q.id}:${step.id}`] ?? 0;
    return { value: Math.min(v, t), target: t, done: !!st.stepDone[`${q.id}:${step.id}`] || v >= t };
  }

  function statusOf(q, st) {
    if (st.done[q.id]) return "complete";
    if (!gateOk(q.requires, ctxOf(st))) return "locked";
    return "active";
  }

  /** Reveal features whose standalone rules are now met (level / quest / counters). */
  function revealByRules(st, newlyRevealed) {
    const ctx = ctxOf(st);
    for (const [id, rule] of Object.entries(features)) {
      if (rule.default || st.revealed.includes(id)) continue;
      const ok = (rule.level != null || rule.quest || rule.counters) && gateOk({ level: rule.level, quests: rule.quest ? [rule.quest] : undefined, counters: rule.counters }, ctx);
      if (ok) { st.revealed.push(id); newlyRevealed.push(id); }
    }
  }

  /** Report a gameplay event; advances every available quest's current step. */
  function report(event, n = 1) {
    const st = load();
    const stepsCompleted = [], questsCompleted = [], unlockedFeatures = [];
    let progressed = true;
    // Loop so a completed quest can unlock another whose counter goals are already met.
    for (let pass = 0; progressed && pass < 6; pass++) {
      progressed = false;
      for (const q of quests) {
        if (statusOf(q, st) !== "active") continue;
        if (!st.started.includes(q.id)) st.started.push(q.id);
        const open = q.parallel ? q.steps : [q.steps.find((s) => !st.stepDone[`${q.id}:${s.id}`])].filter(Boolean);
        for (const s of open) {
          const key = `${q.id}:${s.id}`;
          if (pass === 0 && s.goal?.event === event && !st.stepDone[key]) st.events[key] = (st.events[key] ?? 0) + n;
          const p = stepProgress(q, s, st);
          if (p.done && !st.stepDone[key]) {
            st.stepDone[key] = Date.now();
            stepsCompleted.push({ quest: q, step: s, xp: s.xp ?? 0 });
            progressed = true;
          }
        }
        if (q.steps.every((s) => st.stepDone[`${q.id}:${s.id}`])) {
          st.done[q.id] = Date.now();
          questsCompleted.push({ quest: q, xp: q.xp ?? 0 });
          for (const f of q.unlocks ?? []) if (!st.revealed.includes(f) && !features[f]?.default) { st.revealed.push(f); unlockedFeatures.push(f); }
          progressed = true;
        }
      }
    }
    revealByRules(st, unlockedFeatures);
    store.set(KEY, st);
    for (const s of stepsCompleted) emitter.emit("step", s);
    for (const q of questsCompleted) emitter.emit("quest", q);
    for (const f of unlockedFeatures) emitter.emit("unlock", { feature: f });
    return { stepsCompleted, questsCompleted, unlockedFeatures, xp: stepsCompleted.reduce((a, s) => a + s.xp, 0) + questsCompleted.reduce((a, q) => a + q.xp, 0) };
  }

  /** Re-check gates after something outside quests changed (level-up, counters). */
  const refresh = () => report("__refresh__", 0);

  function list() {
    const st = load();
    return quests.map((q) => {
      const status = statusOf(q, st);
      const steps = q.steps.map((s) => ({ id: s.id, title: s.title, ...stepProgress(q, s, st) }));
      const doneSteps = steps.filter((s) => s.done).length;
      const lockedBy = status === "locked" ? lockReason(q.requires, st) : null;
      return { id: q.id, title: q.title, desc: q.desc, status, steps, doneSteps, pct: steps.length ? doneSteps / steps.length : 0, unlocks: q.unlocks ?? [], requires: q.requires ?? null, lockedBy };
    });
  }

  function lockReason(gate, st) {
    const ctx = ctxOf(st);
    if (gate.level != null && ctx.level < gate.level) return `Reach level ${gate.level}`;
    const q = gate.quests?.find((id) => !ctx.completed.has(id));
    if (q) return `Finish "${byId.get(q)?.title ?? q}"`;
    return "Keep going";
  }

  /** Nodes + edges for a tree/graph view. */
  function tree() {
    const l = list();
    return { nodes: l, edges: quests.flatMap((q) => (q.requires?.quests ?? []).map((from) => ({ from, to: q.id }))) };
  }

  /** Features revealed but not yet announced to the player. */
  const pendingAnnouncements = () => { const st = load(); return st.revealed.filter((f) => !st.announced.includes(f)); };
  function markAnnounced(id) { const st = load(); if (!st.announced.includes(id)) { st.announced.push(id); store.set(KEY, st); } }

  return {
    report, refresh, list, tree, pendingAnnouncements, markAnnounced,
    isUnlocked: (id) => featureOn(id),
    unlockedFeatures: () => Object.keys(features).filter((f) => featureOn(f)),
    next: () => list().find((q) => q.status === "active") ?? null,
    on: emitter.on, off: emitter.off,
    reset: () => store.remove(KEY),
  };
}
