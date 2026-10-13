// Haptic pattern library for the insoles / watch.
//
// The kit never talks to hardware. The host injects ONE adapter:
//
//     createHaptics({ send: (waveform, meta) => insoles.vibrate(waveform, meta.zones) })
//
// waveform = [[durationMs, amplitude 0..1], ...] (the same shape Burst's
// WAVEFORMS use). meta = { name, steps, zones } where zones is the heel->toe
// order for patterns that travel across the foot, so an adapter with per-motor
// control can route each step, and one without can just play the waveform.
// With no adapter every call is a no-op that says so (the gallery logs it).
//
// Beyond the built-in nine patterns an app can register its own (`register(name, steps)`), have the kit split a
// pattern at its silent gaps so the adapter never receives a zero-amplitude step (`splitAtGaps`; the kit times the
// pieces), cap how many pieces that may be, and restrict which side (left / right) a pattern may reach
// (`allowedSides`; a recovering-foot channel must never fire on the wrong foot).

import { clamp } from "../rng.js";

/** Step: { ms, amp, zone? } - amp 0 = silence (a gap). */
export const PATTERNS = Object.freeze({
  successPop: [{ ms: 90, amp: 1 }, { ms: 60, amp: 0 }, { ms: 45, amp: 0.55 }],
  levelUpRoll: [ // travels heel -> arch -> ball -> toe, building
    { ms: 80, amp: 0.45, zone: "heel" }, { ms: 30, amp: 0 }, { ms: 80, amp: 0.65, zone: "arch" }, { ms: 30, amp: 0 },
    { ms: 80, amp: 0.85, zone: "ball" }, { ms: 30, amp: 0 }, { ms: 140, amp: 1, zone: "toe" },
  ],
  warningDoubleTap: [{ ms: 70, amp: 0.9 }, { ms: 90, amp: 0 }, { ms: 70, amp: 0.9 }],
  beatPulse: [{ ms: 35, amp: 0.8 }],
  tick: [{ ms: 20, amp: 0.4 }],
  goal: [{ ms: 70, amp: 0.6 }, { ms: 50, amp: 0 }, { ms: 110, amp: 0.9 }],
  welcomeBack: [{ ms: 220, amp: 0.35 }], // a single soft nudge, not an alarm
  nearMiss: [{ ms: 60, amp: 0.5 }, { ms: 60, amp: 0 }, { ms: 60, amp: 0.5 }, { ms: 60, amp: 0 }, { ms: 140, amp: 0.7 }],
});

export const PATTERN_NAMES = Object.keys(PATTERNS);
export const MAX_PATTERN_MS = 900;
const MAX_STEPS = 40;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function toWaveform(steps, intensity = 1) {
  return steps.map((s) => [s.ms, s.amp === 0 ? 0 : Math.round(clamp(s.amp * intensity, 0.05, 1) * 100) / 100]);
}
export const patternMs = (steps) => steps.reduce((a, s) => a + s.ms, 0);

/**
 * Check and normalise a pattern: steps are `{ ms, amp, zone? }` or `[ms, amp, zone?]`. Amplitude 0 is a silent gap.
 * Throws a clear error for anything the hardware layer should never see. Returns a frozen copy.
 */
export function validatePattern(steps, { maxMs = MAX_PATTERN_MS } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("fun-kit haptics: a pattern needs at least one step");
  if (steps.length > MAX_STEPS) throw new Error(`fun-kit haptics: a pattern has at most ${MAX_STEPS} steps`);
  const out = steps.map((raw, i) => {
    const st = Array.isArray(raw) ? { ms: raw[0], amp: raw[1], zone: raw[2] } : raw;
    const { ms, amp, zone } = st ?? {};
    if (!Number.isFinite(ms) || ms < 5) throw new Error(`fun-kit haptics: step ${i} needs ms of at least 5`);
    if (!Number.isFinite(amp) || amp < 0 || amp > 1) throw new Error(`fun-kit haptics: step ${i} needs an amp from 0 to 1`);
    if (zone != null && !(typeof zone === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(zone))) throw new Error(`fun-kit haptics: step ${i} has an invalid zone`);
    return Object.freeze({ ms: Math.round(ms), amp, ...(zone ? { zone } : {}) });
  });
  if (!out.some((s) => s.amp > 0)) throw new Error("fun-kit haptics: a pattern needs at least one step that vibrates");
  if (patternMs(out) > maxMs) throw new Error(`fun-kit haptics: a pattern may run at most ${maxMs} ms (this one runs ${patternMs(out)})`);
  return Object.freeze(out);
}

/**
 * Split a pattern at its silent steps. Returns the pieces that vibrate, each with the delay (ms from the start of the
 * pattern) at which it should begin. No piece contains a zero-amplitude step. Gaps shorter than `gapMinMs` stay inside
 * their piece, because a timer cannot place a message that finely.
 * @returns {Array<{delayMs: number, steps: object[]}>}
 */
export function splitSegments(steps, { gapMinMs = 0 } = {}) {
  const out = [];
  let t = 0, cur = null, pendingGap = [];
  for (const st of steps) {
    if (st.amp === 0) {
      if (cur) pendingGap.push(st);
      t += st.ms;
      continue;
    }
    if (cur && pendingGap.length) {
      const gap = pendingGap.reduce((a, g) => a + g.ms, 0);
      if (gap < gapMinMs) cur.steps.push(...pendingGap); // too short to place separately: keep it in the piece
      else { out.push(cur); cur = null; }
    }
    pendingGap = [];
    if (!cur) cur = { delayMs: t, steps: [] };
    cur.steps.push(st);
    t += st.ms;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * @param {{send?: (waveform: Array<[number, number]>, meta: object) => any, enabled?: boolean, intensity?: number,
 *   maxPerMinute?: number, minGapMs?: number, now?: () => number, store?: any, key?: string,
 *   patterns?: Record<string, object[]>, splitAtGaps?: boolean, gapMinMs?: number, maxSegments?: number, maxPatternMs?: number,
 *   allowedSides?: string[] | null, schedule?: (fn: () => void, ms: number) => any, unschedule?: (handle: any) => void}} [o]
 *   patterns      extra patterns registered at creation.
 *   splitAtGaps   send each vibrating piece as its own `send(waveform, meta)` call (meta.segment, meta.segments, meta.delayMs), timed by the kit.
 *   gapMinMs      with splitAtGaps: gaps shorter than this stay inside a piece (default 0 = split at every gap).
 *   maxSegments   with splitAtGaps: a pattern needing more pieces is refused (default 8).
 *   allowedSides  e.g. ["left"]: patterns only ever reach these sides; a request for any other side is dropped (null = no filter).
 */
export function createHaptics({
  send, enabled = true, intensity = 1, maxPerMinute = 40, minGapMs = 80, now = Date.now, store, key = "haptics",
  patterns, splitAtGaps = false, gapMinMs = 0, maxSegments = 8, maxPatternMs = MAX_PATTERN_MS, allowedSides = null,
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = (h) => clearTimeout(h),
} = {}) {
  let prefs = { enabled, intensity, ...(store?.get(key, null) ?? {}) };
  const save = () => { try { store?.set(key, prefs); } catch {} };
  const recent = [];
  let lastAt = -Infinity;
  let beatTimer = null;
  let sides = Array.isArray(allowedSides) ? [...allowedSides] : null;
  const registry = new Map(Object.entries(PATTERNS));
  const builtIn = new Set(registry.keys());
  const timers = new Set();

  const pieces = (steps, split = splitAtGaps) => (split ? splitSegments(steps, { gapMinMs }) : null);

  /**
   * Add a pattern. Names are letters, digits, `_` and `-`. An existing name (built-in or yours) needs `override: true`.
   * @returns {{name: string, ms: number, steps: number, segments: number}}
   */
  function register(name, steps, { override = false } = {}) {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`fun-kit haptics: "${name}" is not a valid pattern name`);
    if (registry.has(name) && !override) throw new Error(`fun-kit haptics: pattern "${name}" already exists (pass { override: true } to replace it)`);
    const clean = validatePattern(steps, { maxMs: maxPatternMs });
    const n = splitAtGaps ? splitSegments(clean, { gapMinMs }).length : 1;
    if (splitAtGaps && n > maxSegments) throw new Error(`fun-kit haptics: pattern "${name}" needs ${n} pieces but at most ${maxSegments} are allowed`);
    registry.set(name, clean);
    return { name, ms: patternMs(clean), steps: clean.length, segments: n };
  }
  const registerAll = (map, opts) => Object.fromEntries(Object.entries(map).map(([n, st]) => [n, register(n, st, opts)]));
  if (patterns) registerAll(patterns);

  const cancel = () => { for (const h of timers) unschedule(h); timers.clear(); };

  /** @returns {{played: boolean, reason?: string, waveform?: any, segments?: Array<{delayMs: number, waveform: any}>}} */
  function play(name, { sides: want } = {}) {
    const steps = registry.get(name);
    if (!steps) return { played: false, reason: "unknown-pattern" };
    if (!send) return { played: false, reason: "no-device" };
    if (!prefs.enabled) return { played: false, reason: "disabled" };
    let reach = want;
    if (sides) {
      reach = (want == null ? sides : [].concat(want)).filter((x) => sides.includes(x));
      if (!reach.length) return { played: false, reason: "side-blocked" };
    }
    const t = now();
    if (name !== "beatPulse" && t - lastAt < minGapMs) return { played: false, reason: "rate-limited" };
    while (recent.length && t - recent[0] > 60000) recent.shift();
    if (name !== "beatPulse" && recent.length >= maxPerMinute) return { played: false, reason: "budget" };
    if (patternMs(steps) > maxPatternMs) return { played: false, reason: "too-long" };
    const parts = pieces(steps);
    if (parts && parts.length > maxSegments) return { played: false, reason: "too-many-segments" };
    const waveform = toWaveform(steps, prefs.intensity);
    const zonesOf = (list) => list.filter((s) => s.zone).map((s) => s.zone);
    try {
      if (!parts) send(waveform, { name, steps, zones: zonesOf(steps), sides: reach });
      else {
        const segs = parts.map((p, i) => ({ delayMs: p.delayMs, steps: p.steps, waveform: toWaveform(p.steps, prefs.intensity), i }));
        const fire = (g) => send(g.waveform, { name, steps: g.steps, zones: zonesOf(g.steps), sides: reach, segment: g.i, segments: segs.length, delayMs: g.delayMs });
        for (const g of segs) {
          if (g.delayMs <= 0) fire(g);
          else {
            const h = schedule(() => { timers.delete(h); try { fire(g); } catch {} }, g.delayMs);
            timers.add(h);
          }
        }
        lastAt = t; recent.push(t);
        return { played: true, waveform, segments: segs.map((g) => ({ delayMs: g.delayMs, waveform: g.waveform })) };
      }
    } catch { cancel(); return { played: false, reason: "adapter-error" }; }
    lastAt = t; recent.push(t);
    return { played: true, waveform };
  }

  const beat = {
    /** A short pulse on every beat (metronome / pacing). */
    start(bpm = 100) {
      beat.stop();
      if (!send || !prefs.enabled) return false;
      beatTimer = setInterval(() => play("beatPulse"), 60000 / bpm);
      return true;
    },
    stop() { if (beatTimer) clearInterval(beatTimer); beatTimer = null; },
    get running() { return beatTimer != null; },
  };

  return {
    play, beat, register, registerAll, cancel,
    /** Remove a pattern you registered (built-ins stay). */
    unregister(name) { return !builtIn.has(name) && registry.delete(name); },
    has: (name) => registry.has(name),
    names: () => [...registry.keys()],
    /** A copy of a pattern's steps, or null. */
    pattern: (name) => (registry.has(name) ? registry.get(name).map((s) => ({ ...s })) : null),
    /** The pieces a pattern is sent as (a single piece when splitting is off). */
    segments: (name) => { const st = registry.get(name); return st ? (pieces(st, true)).map((p) => ({ delayMs: p.delayMs, ms: patternMs(p.steps) })) : null; },
    get supported() { return typeof send === "function"; },
    get enabled() { return prefs.enabled; },
    get intensity() { return prefs.intensity; },
    get sides() { return sides ? [...sides] : null; },
    /** Restrict (or, with null, stop restricting) which sides patterns may reach. */
    setSides(list) { sides = Array.isArray(list) ? [...list] : null; },
    /** Saved only when the value changes (`{ persist: false }` never saves), so setting what is already set leaves nothing behind after "Forget my data". */
    setEnabled(v, { persist } = {}) { const next = !!v, changed = next !== prefs.enabled; prefs.enabled = next; if (!next) { beat.stop(); cancel(); } if (persist ?? changed) save(); },
    setIntensity(v, { persist } = {}) { const next = clamp(Number(v) || 0, 0, 1), changed = next !== prefs.intensity; prefs.intensity = next; if (persist ?? changed) save(); },
  };
}
