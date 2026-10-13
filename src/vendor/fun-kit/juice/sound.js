// UI sounds synthesized with WebAudio (no audio files).
//
// - The AudioContext is only created after a user gesture (armOnGesture() wires
//   a one-time pointerdown/keydown, or call unlock() inside a tap handler), so
//   browsers never block it and nothing plays before the person has interacted.
// - Master volume + mute persist in the store when one is given, but only once they differ from where they started:
//   creating a sound object, or setting a value it already has, writes nothing (so "Forget my data" leaves no default
//   behind). Start quieter than 70% with `createSound({ volume: 0.35 })` instead of calling setVolume at start-up.
// - Each sound is a pure "plan" (list of voices), so it can be unit tested
//   without audio hardware.
// - Apps register their own plans (`register(name, voices)`, `registerAll(pack)`) and play any plan shifted in pitch
//   (`play(name, { detune })`, in cents) or softer (`gain`), which is how a rising coin ladder or a tap tone family
//   is built without new plans. `ladder(name)` does the rising-pitch run for you.

import { clamp } from "../rng.js";

const NOTE = { G4: 392, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1567.98 };

/** Voice: { f, f2?, type?, at?, dur, gain?, pan? } (frequency Hz, optional glide target, start offset s). */
export const SOUND_PLANS = Object.freeze({
  tick: [{ f: 1200, dur: 0.02, gain: 0.35, type: "square" }],
  tickAccent: [{ f: 1700, dur: 0.03, gain: 0.5, type: "square" }],
  chime: [{ f: NOTE.E6, dur: 0.5, gain: 0.35 }, { f: NOTE.E6 * 2, dur: 0.3, gain: 0.08 }],
  coin: [{ f: NOTE.E5 * 1.5, dur: 0.07, gain: 0.4, type: "square" }, { f: NOTE.E6, at: 0.07, dur: 0.32, gain: 0.35, type: "square" }],
  success: [{ f: NOTE.C5, dur: 0.12, gain: 0.4 }, { f: NOTE.E5, at: 0.09, dur: 0.12, gain: 0.4 }, { f: NOTE.G5, at: 0.18, dur: 0.3, gain: 0.45 }],
  unlock: [{ f: NOTE.G5, dur: 0.1, gain: 0.35 }, { f: NOTE.C6, at: 0.09, dur: 0.1, gain: 0.35 }, { f: NOTE.E6, at: 0.18, dur: 0.4, gain: 0.4 }, { f: NOTE.G6, at: 0.18, dur: 0.4, gain: 0.12 }],
  whoosh: [{ f: 220, f2: 1400, dur: 0.35, gain: 0.18, type: "sawtooth" }, { f: 1400, f2: 300, at: 0.2, dur: 0.3, gain: 0.1, type: "triangle" }],
  levelUp: [
    { f: NOTE.C5, dur: 0.16, gain: 0.45, type: "triangle" }, { f: NOTE.E5, at: 0.14, dur: 0.16, gain: 0.45, type: "triangle" },
    { f: NOTE.G5, at: 0.28, dur: 0.16, gain: 0.45, type: "triangle" }, { f: NOTE.C6, at: 0.42, dur: 0.7, gain: 0.5, type: "triangle" },
    { f: NOTE.E6, at: 0.42, dur: 0.7, gain: 0.2 }, { f: NOTE.G6, at: 0.42, dur: 0.7, gain: 0.12 },
  ],
  soft: [{ f: NOTE.G4, dur: 0.35, gain: 0.25 }, { f: NOTE.D5, at: 0.12, dur: 0.45, gain: 0.2 }],
});

export const SOUND_NAMES = Object.keys(SOUND_PLANS);

const WAVES = new Set(["sine", "square", "sawtooth", "triangle"]);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const MAX_VOICES = 16;
export const MAX_SOUND_S = 4;

/**
 * Check and normalise a sound plan (a list of voices). Throws a clear error for anything that would be harsh or
 * endless: frequencies outside 20 Hz to 20 kHz, voices longer than 2 s, a plan longer than 4 s, more than 16 voices.
 * Returns frozen copies with defaults filled in.
 */
export function validateSoundPlan(voices) {
  if (!Array.isArray(voices) || !voices.length) throw new Error("fun-kit sound: a plan needs at least one voice");
  if (voices.length > MAX_VOICES) throw new Error(`fun-kit sound: a plan has at most ${MAX_VOICES} voices`);
  const hz = (x) => Number.isFinite(x) && x >= 20 && x <= 20000;
  return Object.freeze(voices.map((v, i) => {
    if (!v || !hz(v.f)) throw new Error(`fun-kit sound: voice ${i} needs f between 20 and 20000 Hz`);
    if (v.f2 != null && !hz(v.f2)) throw new Error(`fun-kit sound: voice ${i} has an invalid f2`);
    if (!Number.isFinite(v.dur) || v.dur < 0.005 || v.dur > 2) throw new Error(`fun-kit sound: voice ${i} needs dur between 0.005 and 2 seconds`);
    const at = v.at ?? 0;
    if (!Number.isFinite(at) || at < 0 || at + v.dur > MAX_SOUND_S) throw new Error(`fun-kit sound: voice ${i} must end within ${MAX_SOUND_S} seconds`);
    const gain = v.gain ?? 0.4;
    if (!Number.isFinite(gain) || gain < 0 || gain > 1) throw new Error(`fun-kit sound: voice ${i} needs gain from 0 to 1`);
    if (v.type != null && !WAVES.has(v.type)) throw new Error(`fun-kit sound: voice ${i} has an unknown wave "${v.type}"`);
    if (v.pan != null && !(Number.isFinite(v.pan) && v.pan >= -1 && v.pan <= 1)) throw new Error(`fun-kit sound: voice ${i} needs pan from -1 to 1`);
    return Object.freeze({ f: v.f, ...(v.f2 != null ? { f2: v.f2 } : {}), type: v.type ?? "sine", at, dur: v.dur, gain, ...(v.pan != null ? { pan: v.pan } : {}) });
  }));
}

/** A plan shifted by `cents` (100 = one semitone, clamped to two octaves either way) and scaled by `gain` (0..1). Pure. */
export function detunePlan(plan, cents = 0, gain = 1) {
  const k = 2 ** (clamp(Number(cents) || 0, -2400, 2400) / 1200);
  const g = clamp(Number(gain) || 0, 0, 1);
  const hz = (x) => clamp(x * k, 20, 20000);
  return plan.map((v) => ({ ...v, f: hz(v.f), ...(v.f2 != null ? { f2: hz(v.f2) } : {}), gain: (v.gain ?? 0.4) * g }));
}

/** Beat times (seconds from `start`) for a metronome run. */
export const beatTimes = (start, bpm, count) => Array.from({ length: count }, (_, i) => start + (i * 60) / bpm);

/**
 * @param {{store?: any, key?: string, createContext?: () => AudioContext, doc?: Document, plans?: Record<string, object[]>, now?: () => number,
 *   volume?: number, muted?: boolean}} [o]
 *   plans   extra sounds registered at creation (a pack).
 *   volume  the starting volume, 0..1 (default 0.7); a value saved in the store wins. Nothing is written until it changes.
 *   muted   start muted (default false); a saved value wins.
 */
export function createSound({ store, key = "sound", createContext, doc = globalThis.document, plans, now = Date.now, volume = 0.7, muted = false } = {}) {
  const registry = new Map(Object.entries(SOUND_PLANS));
  const builtIn = new Set(registry.keys());
  let prefs = { muted: !!muted, volume: clamp(Number(volume) || 0, 0, 1), ...(store?.get(key, null) ?? {}) };
  const save = () => { try { store?.set(key, prefs); } catch {} };
  let ac = null, master = null, armed = false, disarm = null;
  const make = createContext ?? (() => { const AC = globalThis.AudioContext || globalThis.webkitAudioContext; return AC ? new AC({ latencyHint: "interactive" }) : null; });

  /** Create/resume the audio graph. Call inside a user gesture. */
  function unlock() {
    if (armed && ac) { ac.resume?.(); return true; }
    try {
      ac = make();
      if (!ac) return false;
      master = ac.createGain();
      master.gain.value = prefs.muted ? 0 : prefs.volume;
      master.connect(ac.destination);
      ac.resume?.();
      armed = true;
      return true;
    } catch { ac = null; return false; }
  }

  /** Arm on the first pointer/keyboard gesture; returns a function that removes the listeners. */
  function armOnGesture(target = doc) {
    if (!target) return () => {};
    const go = () => { unlock(); off(); };
    const off = () => { ["pointerdown", "keydown", "touchstart"].forEach((e) => target.removeEventListener(e, go, true)); };
    ["pointerdown", "keydown", "touchstart"].forEach((e) => target.addEventListener(e, go, { capture: true, passive: true }));
    disarm = off;
    return off;
  }

  function voice(v, t0) {
    const o = ac.createOscillator(), g = ac.createGain();
    let out = g;
    if (v.pan && ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = v.pan; g.connect(p); out = p; }
    const start = t0 + (v.at ?? 0);
    o.type = v.type ?? "sine";
    o.frequency.setValueAtTime(v.f, start);
    if (v.f2) o.frequency.exponentialRampToValueAtTime(v.f2, start + v.dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v.gain ?? 0.4), start + Math.min(0.008, v.dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, start + v.dur);
    o.connect(g); out.connect(master);
    o.start(start); o.stop(start + v.dur + 0.03);
  }

  /**
   * Add a sound. Names are letters, digits, `_` and `-`. An existing name (built-in or yours) needs `override: true`.
   * @returns {{name: string, voices: number, seconds: number}}
   */
  function register(name, voices, { override = false } = {}) {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error(`fun-kit sound: "${name}" is not a valid sound name`);
    if (registry.has(name) && !override) throw new Error(`fun-kit sound: sound "${name}" already exists (pass { override: true } to replace it)`);
    const plan = validateSoundPlan(voices);
    registry.set(name, plan);
    return { name, voices: plan.length, seconds: Math.max(...plan.map((v) => v.at + v.dur)) };
  }
  const registerAll = (pack, opts) => Object.fromEntries(Object.entries(pack).map(([n, v]) => [n, register(n, v, opts)]));
  if (plans) registerAll(plans);

  /**
   * Play a named sound. Returns false when muted, not yet unlocked, or unsupported.
   * `detune` shifts the pitch in cents (100 = a semitone); `gain` (0..1) scales it down.
   */
  function play(name, { detune = 0, gain = 1 } = {}) {
    const base = registry.get(name);
    if (!base || prefs.muted || prefs.volume <= 0 || !armed || !ac) return false;
    const plan = detune || gain !== 1 ? detunePlan(base, detune, gain) : base;
    try {
      const t0 = ac.currentTime + 0.005;
      for (const v of plan) voice(v, t0);
      return true;
    } catch { return false; }
  }

  /**
   * A rising run for repeated rewards: each call is `semitones` higher than the last, for `steps` calls, then it
   * stays at the top; it starts over after `resetAfterMs` of quiet. e.g. `const coin = sound.ladder("coin")`.
   */
  function ladder(name, { semitones = 1, steps = 8, resetAfterMs = 1500, gain = 1 } = {}) {
    let n = 0, last = -Infinity;
    return {
      play() {
        const t = now();
        if (t - last > resetAfterMs) n = 0;
        last = t;
        const ok = play(name, { detune: Math.min(n, steps - 1) * semitones * 100, gain });
        n++;
        return ok;
      },
      reset() { n = 0; last = -Infinity; },
      get step() { return n; },
    };
  }

  let timer = null;
  const metronome = {
    /** Start a click track. accent: every Nth beat is louder. */
    start({ bpm = 100, accent = 4 } = {}) {
      if (!armed || !ac || prefs.muted) return false;
      metronome.stop();
      let beat = 0, next = ac.currentTime + 0.05;
      const schedule = () => {
        while (next < ac.currentTime + 0.2) {
          const plan = registry.get(accent && beat % accent === 0 ? "tickAccent" : "tick");
          for (const v of plan) voice(v, next);
          next += 60 / bpm; beat++;
        }
      };
      schedule();
      timer = setInterval(schedule, 25);
      return true;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    get running() { return timer != null; },
  };

  return {
    unlock, armOnGesture, play, metronome, register, registerAll, ladder,
    /** Remove a sound you registered (built-ins stay). */
    unregister(name) { return !builtIn.has(name) && registry.delete(name); },
    has: (name) => registry.has(name),
    names: () => [...registry.keys()],
    /** The voices a sound would play, optionally shifted: for tests and previews. */
    plan: (name, { detune = 0, gain = 1 } = {}) => (registry.has(name) ? detunePlan(registry.get(name), detune, gain) : null),
    get armed() { return armed; },
    get muted() { return prefs.muted; },
    get volume() { return prefs.volume; },
    /** Mute or unmute. Saved only when it changes, or always with `{ persist: true }`; `{ persist: false }` never saves (an app-level preference kept elsewhere). */
    setMuted(m, { persist } = {}) { const next = !!m, changed = next !== prefs.muted; prefs.muted = next; if (master) master.gain.value = prefs.muted ? 0 : prefs.volume; if (next) metronome.stop(); if (persist ?? changed) save(); },
    setVolume(v, { persist } = {}) { const next = clamp(Number(v) || 0, 0, 1), changed = next !== prefs.volume; prefs.volume = next; if (master && !prefs.muted) master.gain.value = prefs.volume; if (persist ?? changed) save(); },
    dispose() { metronome.stop(); disarm?.(); try { ac?.close?.(); } catch {} ac = null; armed = false; },
  };
}
