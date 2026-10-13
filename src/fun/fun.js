// The engagement layer's one kit file: a single createFunKit config, the sound, the quiet gate and every celebration.
//
// Two instances come from this one factory: the real one (localStorage, namespace fk:ae-demo:*) and the demo one (Simulate, or
// booth mode) on createMemoryStorage(), which is never written anywhere. Nothing a simulated athlete earns reaches a real profile.
//
// The line between display and reward: the measured result (the number, its judgment, the stamp) is the page's own feedback and
// shows at once. Everything that rewards it (particles, sound, a haptic cue, a toast, the level-up dialog, the PB ribbon) goes
// through the quiet gate below, which stays shut while a calibration, a GO window, a sprint or a flight is being measured and for
// 300 ms after the last edge. Safety and measurement code (app.js, units.js) never imports this file or the kit.
import {
  createFunKit, createMemoryStorage, createSound, createHaptics, createFirstWin, createQuietGate, playOutcome, dayKey,
} from "../vendor/fun-kit/index.js";
import * as celebrateKit from "../vendor/fun-kit/juice/celebrate.js";
import {
  APP_ID, SIM_ID, CURVE, TITLES, DAILY_XP_SOFT_CAP, XP, CAPS, roundXp, makePbMetrics, makeBadges, heat, countPbs, improved,
  truthXp, plausibleTruth,
} from "./config.js";
import { COPY } from "./copy.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Sounds the kit does not ship: a stamp thud, a short fanfare and a shutter click. Plain voice lists, checked by the kit when registered. */
export const SOUNDS = Object.freeze({
  stamp: [{ f: 150, f2: 62, dur: 0.18, gain: 0.5, type: "triangle" }, { f: 880, dur: 0.04, gain: 0.12, type: "square" }],
  fanfare: [
    { f: 523.25, dur: 0.12, gain: 0.4, type: "triangle" }, { f: 659.25, at: 0.1, dur: 0.12, gain: 0.4, type: "triangle" },
    { f: 783.99, at: 0.2, dur: 0.12, gain: 0.4, type: "triangle" }, { f: 1046.5, at: 0.3, dur: 0.5, gain: 0.45, type: "triangle" },
    { f: 1318.5, at: 0.3, dur: 0.5, gain: 0.14 },
  ],
  shutter: [{ f: 2600, dur: 0.02, gain: 0.3, type: "square" }, { f: 1700, at: 0.05, dur: 0.03, gain: 0.25, type: "square" }],
});

/**
 * Cues that would be felt on the foot or the wrist. They are registered so the vocabulary is ready, but nothing is sent: no
 * device vibration is wired yet (TODO[SDK]) and none would ever fire during an effort, because the gate is shut then.
 */
export const HAPTIC_PATTERNS = Object.freeze({
  goPulse: [{ ms: 120, amp: 1 }],
  pbPulse: [{ ms: 120, amp: 1 }, { ms: 200, amp: 0 }, { ms: 120, amp: 1 }],
  landPop: [{ ms: 60, amp: 0.6 }],
});

const KEYS = { cards: "app.cards", hist: "app.hist", truthDay: "app.truthDay" };

const defaultFmt = {
  height: (cm) => `${cm.toFixed(1)} cm`, ms: (ms) => `${Math.round(ms)} ms`, seconds: (s) => `${s.toFixed(2)} s`,
};

/**
 * @param {{sim?: boolean, memory?: boolean, storage?: Storage, now?: () => number, measuring?: () => boolean,
 *   createContext?: () => AudioContext|null, fmt?: object, fx?: object, send?: Function}} [o]
 *   sim / memory  both use a memory storage; sim also marks everything as simulated
 *   measuring     true while a calibration, GO window, sprint or flight is being measured (the gate's isQuiet)
 *   pause         ms between the staged cues of one celebration (tests pass 0)
 *   fx            the visual effects object (the kit's own by default; tests pass stand-ins because they have no page)
 */
export function createFun(o = {}) {
  const { sim = false, memory = false, storage, now = Date.now, measuring = () => false, createContext, fmt = defaultFmt, fx, send, pause = 700 } = o;
  const demo = sim || memory;

  const kit = createFunKit({
    app: sim ? SIM_ID : APP_ID, appName: "Combine", mode: "playful", now, rolloverHour: 4,
    storage: demo ? createMemoryStorage() : storage,
    guardrails: { dailyXpSoftCap: DAILY_XP_SOFT_CAP },
    titles: TITLES, curve: CURVE,
    baseSessionXp: 0, firstSessionXp: 0, partialXp: 0, pbXp: 0,
    streaks: false, rewardOptions: { enabled: false },
    pbMetrics: makePbMetrics(fmt), badges: makeBadges(),
  });

  // ---------------------------------------------------------------- sound, haptics, the gate
  const gate = createQuietGate({ isQuiet: () => !!measuring(), pollMs: 250 });
  const sound = createSound({ store: kit.store, createContext, volume: 0.5, plans: SOUNDS });
  const haptics = createHaptics({ store: kit.store, send, patterns: HAPTIC_PATTERNS, splitAtGaps: true, gapMinMs: 20, maxSegments: 4 });

  let edgeTimer = null;
  /** An effort just ended (a landing, a contact, a finish): keep the gate shut for 300 ms more, so a reward never lands inside the read. */
  function edge(ms = 300) {
    gate.hold("edge");
    clearTimeout(edgeTimer);
    edgeTimer = setTimeout(() => gate.release("edge"), ms);
  }

  // ---------------------------------------------------------------- one celebration at a time, and it can be stopped
  const base = fx ?? celebrateKit;
  let epoch = 0;
  class Cancelled extends Error {}
  const EFFECTS = ["confetti", "burst", "ribbons", "toast", "unlockToast", "levelUpModal", "bloom", "gentleGlow"];
  /** The effects for one celebration; each is checked against the gate again just before it fires. */
  function stage() {
    const mine = epoch, live = () => mine === epoch && !gate.quiet;
    const guard = (fn) => (...a) => { if (!live()) throw new Cancelled("celebration stopped"); return fn(...a); };
    const out = {};
    for (const k of EFFECTS) if (typeof base[k] === "function") out[k] = guard(base[k]);
    const play = (obj) => ({ play: (...a) => { if (!live()) throw new Cancelled("celebration stopped"); return obj.play(...a); } });
    return { celebrate: out, sound: play(sound), haptics: play(haptics), live };
  }
  function clearOverlays() {
    const doc = globalThis.document;
    if (!doc?.body) return;
    try { celebrateKit.dismissCelebrations({ doc, gate }); } catch { /* nothing on screen */ }
  }

  // ---------------------------------------------------------------- first win (the first stamp, measured)
  const firstWin = createFirstWin({
    store: kit.store, now, nudgeAfterMs: 10000, assistAfterMs: 25000, winEvent: "leap",
    beats: [{ id: "leap", on: "leap", text: COPY.stations.leap.how, hint: COPY.stage.nudge }],
  });

  // ---------------------------------------------------------------- the person's own history (kit store, so Forget wipes it)
  const cards = {
    all: () => kit.store.get(KEYS.cards, []),
    /** The latest Card from an earlier visit: the one flames compare with. */
    prevVisit: (visitId) => cards.all().filter((c) => c.visit !== visitId).pop() ?? null,
    /** The latest Card from this visit (the round 2 improvement bonus compares with it). */
    inVisit: (visitId) => cards.all().filter((c) => c.visit === visitId).pop() ?? null,
    save: (c) => kit.store.update(KEYS.cards, (l) => [...l, c].slice(-12), []),
  };
  const history = {
    firstSteps: () => kit.store.get(KEYS.hist, []),
    add: (list) => kit.store.update(KEYS.hist, (l) => [...l, ...list.filter(Number.isFinite)].slice(-30), []),
  };
  const bests = {
    jump: () => kit.pb.best("jumpCm"),
    single: () => kit.pb.best("singleCm"),
    sprint: (n) => kit.pb.best(`sprint${n}`),
    rsi: () => kit.pb.best("rsi"),
    firstStep: () => kit.pb.best("firstStepMs"),
  };

  // ---------------------------------------------------------------- finishing a round
  /**
   * Record a finished (or stopped) Combine: Heat from the previous visit's Card, XP with the caps, the kit session. Returns null when no
   * station was finished (there is nothing to record). Never reads how hard anything was done: only the marks the round produced.
   */
  function finishRound(sum, { visitId }) {
    if (!sum || sum.stationsDone < 1) return null;
    const prev = demo ? null : cards.prevVisit(visitId);
    const pbs = countPbs(sum.marks, prev?.marks);
    const h = heat({ status: sum.status, pbs, hasPrevVisit: !!prev });
    const xp = roundXp(sum.xpInput);
    const earlier = cards.inVisit(visitId);
    const extraXp = sum.n >= 2 && earlier && improved(sum.marks, earlier.marks)
      ? [{ amount: XP.round2, key: `round2:${visitId}`, once: true, source: "improve", label: COPY.xpLabels.improve }] : [];
    const outcome = kit.completeSession({
      id: sum.id, completed: true, durationMs: sum.durationMs, baseXp: xp.total, extraXp,
      metrics: sum.metrics,
      counters: { jumps: sum.counts.leap + sum.counts.onefoot, firstSteps: sum.counts.firstSteps, sprints: sum.counts.sprints, circuits: sum.fullCircuit ? 1 : 0, rematches: sum.n >= 2 ? 1 : 0 },
      first: sum.first, tags: sum.fullCircuit ? ["circuit"] : [],
      headline: { label: COPY.card.heat, value: h.flames, unit: "flames", caption: h.name, health: false },
      nextGoal: { text: COPY.card.first },
    });
    history.add(sum.firststep.trials.map((t) => t.stepMs));
    cards.save({ id: sum.id, visit: visitId, at: now(), n: sum.n, marks: sum.marks, flames: h.flames });
    return { outcome, heat: h, xp, pbs, prev, extraXp: extraXp.length ? XP.round2 : 0 };
  }

  // ---------------------------------------------------------------- ground truth (a flat, capped, plausibility-only award)
  /**
   * A typed device height or gate time. Pays XP.truth once per entry (the key makes a corrected entry replace, never add), only inside
   * physical plausibility, at most CAPS.truthPerDay XP a day. Agreement with the estimate is never looked at.
   */
  function truth({ kind, n, device, visitId }) {
    const key = `truth:${kind}:${visitId}:${n}`;
    const day = dayKey(now(), { rolloverHour: 4 });
    const rec = kit.store.get(KEYS.truthDay, { day, xp: 0 });
    const state = rec.day === day ? rec : { day, xp: 0 };
    if (!plausibleTruth(kind, device)) {
      const r = kit.xp.revoke(key, { reason: "Implausible entry" });
      if (r.revoked) { state.xp = Math.max(0, state.xp - r.amount); kit.store.set(KEYS.truthDay, state); }
      return { ok: false, reason: "implausible", revoked: !!r.revoked };
    }
    const amount = truthXp(state.xp);
    if (amount <= 0) return { ok: false, reason: "day-cap" };
    const res = kit.xp.award({ amount, key, source: "truth", label: COPY.xpLabels.truth });
    if (res.gained > 0) { state.xp += res.gained; kit.store.set(KEYS.truthDay, state); }
    return { ok: true, gained: res.gained, paidToday: state.xp };
  }

  const api = {
    kit, sound, haptics, gate, firstWin, cards, history, bests, demo, sim,
    edge,
    /** Keep outputs in line with the person's choices (sound on / off). */
    syncOutputs({ sound: on = true } = {}) { if (sound.muted === on) sound.setMuted(!on, { persist: false }); },
    unlockAudio() { try { sound.unlock(); } catch { /* no audio */ } },
    finishRound, truth,
    beginFirstWin() { if (!firstWin.isDone()) { firstWin.reset(); firstWin.start(); } return firstWin.state(); },
    feedFirstWin(name) { return firstWin.event(name); },

    /**
     * A reward for one rep or one stamp. The caller passes what happened; WHEN it plays is the gate's decision. `visual` is an optional
     * function (the PB ribbon on the result card) that runs inside the same gated moment as the sound and the particles.
     */
    rep({ kind, judgment, cm, visual } = {}) {
      return gate.run(() => {
        const s = stage();
        if (!s.live()) return [];
        const id = judgment?.id;
        const played = [];
        try {
          if (kind === "leap" || kind === "onefoot") { s.sound.play("whoosh", { detune: clamp(((cm ?? 25) - 10) * 14, 0, 700), gain: 0.8 }); played.push("whoosh"); }
          if (id === "pb" || id === "lightning" || id === "springy") { s.sound.play("fanfare"); s.celebrate.burst?.({ x: 0.5, y: 0.35, count: 80 }); played.push("pb"); s.haptics.play("pbPulse"); }
          else if (id === "photo") { s.sound.play("shutter"); s.celebrate.gentleGlow?.(); played.push("photo"); }
          else if (id === "first") { s.celebrate.burst?.({ x: 0.5, y: 0.35, count: 24 }); played.push("first"); }
          else if (kind === "firststep" || kind === "sprint" || kind === "bounce") { s.sound.play("tick"); played.push("tick"); }
          visual?.();
        } catch (e) { if (!(e instanceof Cancelled)) throw e; }
        return played;
      }, { key: `rep:${kind}`, label: `rep ${kind}` });
    },
    /** The stamp thud when a station finishes. */
    stamp() {
      return gate.run(() => { const s = stage(); if (!s.live()) return []; try { s.sound.play("stamp"); } catch (e) { if (!(e instanceof Cancelled)) throw e; } return ["stamp"]; }, { key: "stamp", label: "stamp" });
    },
    /** The station start tick. */
    tick() { return gate.run(() => { try { stage().sound.play("tick", { gain: 0.6 }); } catch { /* cancelled or no audio */ } }, { key: "tick", live: true }); },

    /** The end-of-round celebration: cues, sounds, then the level-up dialog, all held by the gate. */
    async celebrate(outcome) {
      if (!outcome || outcome.duplicate) return [];
      const staged = stage();
      try {
        return await playOutcome(outcome, {
          sound: staged.sound, haptics: staged.haptics, guardrails: kit.guard, gate, pause, maxToasts: 2, maxBadgeToasts: 2,
          celebrate: staged.celebrate, soundMap: { complete: "fanfare", pb: "coin" }, hapticMap: { pb: "pbPulse", complete: null, levelup: null },
          featureLabel: (id) => id,
        });
      } catch { return []; }
    },
    /** Stop a celebration in flight and take down its toasts and dialog; drop what the gate still holds. */
    cancel() { epoch++; gate.clear("cancelled"); try { haptics.cancel(); } catch { /* none scheduled */ } clearOverlays(); },
    hold: (name = "round") => gate.hold(name),
    release: (name = "round") => gate.release(name),
    /** Forget my data: every key of the kit's namespace goes (kit.reset), nothing is left behind in storage. */
    forget() { api.cancel(); kit.reset(); },
    dispose() { api.cancel(); clearTimeout(edgeTimer); gate.dispose(); try { sound.dispose(); } catch { /* none */ } kit.dispose(); },
    CAPS,
  };
  return api;
}
