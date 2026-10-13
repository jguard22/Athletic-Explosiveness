// playOutcome(): turn a completeSession() outcome into a staged celebration
// (visual + sound + haptic) in one call. Everything is optional and degrades:
// no sound object -> silent, no haptics adapter -> no-op, reduced motion -> glow.
//
// Calm by design: comebacks and rest-day cover get a soft toast and a quiet
// chime, never confetti. Health-mode guardrails also mute "competitive" flourishes.
// In a "calm" app (guardrails.mode === "calm", or effects: "soft") every particle effect becomes one slow bloom of
// light, level-ups included.
//
// Pass a quiet gate (quiet.js) to hold the whole celebration while a session, measurement or stance is running: it
// plays when the gate opens, or is dropped if it waits too long. The returned promise resolves with the cues played ([] when dropped).
//
// What reaches the screen is kept to a sensible amount (see planCues): the level-up modal lists the features it opened, so
// those do not also get a toast each; a first set that opens five badges toasts the rarest two and says how many more
// are waiting; and no more than `maxToasts` toasts play for one outcome (the rarest and most personal first). Everything
// stays on the recap card.
//
// dismissCelebrations() (celebrate.js) stops a run in flight, which is what a route change needs; `signal` does the same
// for one call.

import * as fx from "./celebrate.js";
import { labelsFor } from "../labels.js";

/** Particle effects swapped for a bloom of light: no movement, nothing to startle. */
const softened = (celebrate) => {
  const bloom = (o) => (celebrate.bloom ?? celebrate.gentleGlow ?? (() => Promise.resolve()))(o);
  return { ...celebrate, confetti: bloom, burst: bloom, ribbons: () => Promise.resolve() };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The sound each cue plays unless `soundMap` says otherwise. */
export const DEFAULT_CUE_SOUNDS = Object.freeze({ levelup: "levelUp", pb: "coin", badge: "unlock", goal: "success", milestone: "success", comeback: "soft", challenge: "coin", unlock: "whoosh", drop: "chime", complete: "chime" });
/** The haptic pattern each cue plays unless `hapticMap` says otherwise. */
export const DEFAULT_CUE_HAPTICS = Object.freeze({ levelup: "levelUpRoll", pb: "successPop", goal: "goal", milestone: "successPop", comeback: "welcomeBack" });

const TIER_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
const tierRank = (cue) => TIER_RANK[cue.tier ?? cue.badge?.tier ?? "common"] ?? 0;
/** Cues that put a toast on screen. */
const TOAST_CUES = new Set(["pb", "goal", "milestone", "comeback", "badge", "badges-more", "challenge", "unlock", "drop"]);
/** Which toast survives when there are too many: higher wins, then the earlier cue. */
const TOAST_PRIORITY = { pb: 90, comeback: 86, goal: 80, milestone: 78, drop: 70, challenge: 48, "badges-more": 44, unlock: 40 };
const BADGE_PRIORITY = [50, 56, 66, 82, 88]; // common .. legendary
const priorityOf = (cue) => (cue.type === "badge" ? BADGE_PRIORITY[tierRank(cue)] ?? 50 : TOAST_PRIORITY[cue.type] ?? 0);

/**
 * Decide what a list of celebration cues actually plays. Pure, so an app can inspect it.
 * @param {object[]} cues outcome.celebrations
 * @param {{modal?: boolean, maxBadgeToasts?: number, maxToasts?: number}} [o]
 *   modal           the level-up modal will open (default true): feature unlocks are listed in it instead of getting a toast each
 *   maxBadgeToasts  badges beyond the rarest N become one "+K more" cue (default 2; 0 = every badge gets its own toast)
 *   maxToasts       most toast cues one outcome plays; the rest are dropped, lowest priority first (default 3; 0 = no limit)
 * @returns {{cues: object[], folded: object[], dropped: object[]}} cues to play in order; unlock cues folded into the modal; cues dropped by the cap
 */
export function planCues(cues = [], { modal = true, maxBadgeToasts = 2, maxToasts = 3 } = {}) {
  let list = cues.map((c, i) => ({ c, i }));
  const folded = [], dropped = [];
  if (modal && cues.some((c) => c.type === "levelup")) {
    list = list.filter((x) => (x.c.type === "unlock" ? (folded.push(x.c), false) : true));
  }
  const badges = list.filter((x) => x.c.type === "badge");
  if (maxBadgeToasts > 0 && badges.length > maxBadgeToasts) {
    const keep = new Set([...badges].sort((a, b) => tierRank(b.c) - tierRank(a.c) || a.i - b.i).slice(0, maxBadgeToasts));
    const hidden = badges.filter((x) => !keep.has(x));
    const last = Math.max(...[...keep].map((x) => x.i));
    list = list.filter((x) => x.c.type !== "badge" || keep.has(x));
    list.push({ c: { type: "badges-more", count: hidden.length, badges: hidden.map((x) => x.c.badge) }, i: last + 0.5 });
    list.sort((a, b) => a.i - b.i);
  }
  if (maxToasts > 0) {
    const toasts = list.filter((x) => TOAST_CUES.has(x.c.type));
    if (toasts.length > maxToasts) {
      const keep = new Set([...toasts].sort((a, b) => priorityOf(b.c) - priorityOf(a.c) || a.i - b.i).slice(0, maxToasts));
      for (const x of toasts) if (!keep.has(x)) dropped.push(x.c);
      list = list.filter((x) => !TOAST_CUES.has(x.c.type) || keep.has(x));
    }
  }
  return { cues: list.map((x) => x.c), folded, dropped };
}

/**
 * @param {object} outcome from kit.completeSession()
 * @param {{celebrate?: object, sound?: object, haptics?: object, guardrails?: object, pause?: number, modal?: boolean, doc?: Document,
 *   gate?: ReturnType<import('../quiet.js').createQuietGate>, effects?: "auto"|"full"|"soft",
 *   maxToasts?: number, maxBadgeToasts?: number, hapticMap?: Record<string, string|null>, soundMap?: Record<string, string|null>,
 *   featureLabel?: (id: string) => string, labels?: object, toastPosition?: "top"|"bottom", signal?: AbortSignal}} [o]
 *   effects: "soft" turns confetti, bursts and ribbons into a bloom of light; "auto" (default) does that in calm mode only.
 *   maxToasts / maxBadgeToasts: see planCues (defaults 3 and 2; 0 lifts the limit).
 *   hapticMap / soundMap: the pattern or sound each cue plays, by cue type ("levelup", "pb", "goal", "milestone", "comeback",
 *     "badge", "challenge", "unlock", "drop", "complete"); null or "" silences that cue. Give the personal best and the streak
 *     milestone their own, so the two never feel alike.
 *   featureLabel: the display name of a feature id (a cue's own `label` wins); labels: the words (labels.js).
 *   toastPosition: "top" or "bottom" for this run's toasts.
 *   signal: abort to stop firing cues and skip the modal (dismissCelebrations() does this for every run at once).
 * @returns {Promise<string[]>} the list of cue types played (handy for tests/analytics)
 */
export async function playOutcome(outcome, opts = {}) {
  const { gate, ...rest } = opts;
  if (gate) {
    const h = gate.run(() => playOutcome(outcome, rest), { label: "outcome" });
    const r = await h.done;
    return r.ran && Array.isArray(r.result) ? r.result : [];
  }
  const { sound, haptics, guardrails, pause = 450, modal = true, doc, effects = "auto", maxToasts = 3, maxBadgeToasts = 2, hapticMap, soundMap, featureLabel, labels, toastPosition, signal } = rest;
  const L = labelsFor(labels);
  const celebrate = effects === "soft" || (effects === "auto" && guardrails?.mode === "calm") ? softened(rest.celebrate ?? fx) : rest.celebrate ?? fx;
  const played = [];
  const calm = guardrails && !guardrails.allows("competition");
  const cues = outcome.celebrations ?? [];
  const pick = (map, defaults, type) => (map && Object.hasOwn(map, type) ? map[type] : defaults[type]);
  const sfx = (type) => { const n = pick(soundMap, DEFAULT_CUE_SOUNDS, type); if (n) sound?.play?.(n); };
  const hap = (type) => { const n = pick(hapticMap, DEFAULT_CUE_HAPTICS, type); if (n) haptics?.play?.(n); };
  const opt = { ...(doc ? { doc } : {}), ...(toastPosition ? { position: toastPosition } : {}) };
  const fxOpt = doc ? { doc } : {};
  const nameOf = (id) => (typeof featureLabel === "function" ? featureLabel(id) : id) ?? id;
  const unlockLabel = (cue) => cue.label ?? nameOf(cue.feature);
  const epoch0 = fx.celebrationEpoch();
  const alive = () => fx.celebrationEpoch() === epoch0 && !signal?.aborted;
  let levelCue = null;

  const plan = planCues(cues, { modal, maxBadgeToasts, maxToasts });
  for (const cue of plan.folded) played.push(cue.type); // listed in the level-up modal below

  for (const cue of plan.cues) {
    if (!alive()) return played;
    played.push(cue.type);
    switch (cue.type) {
      case "levelup":
        levelCue = cue;
        celebrate.confetti({ ...fxOpt }); sfx("levelup"); hap("levelup");
        break;
      case "pb":
        celebrate.burst({ x: 0.5, y: 0.4, ...fxOpt }); sfx("pb"); hap("pb");
        celebrate.toast(cue.pb.text, { title: L("pbTitle"), icon: "trophy", tone: "gold", ...opt });
        break;
      case "badge":
        sfx("badge"); hap("badge"); celebrate.unlockToast(cue.badge, { ...opt, ...(labels ? { labels } : {}) });
        if (["epic", "legendary"].includes(cue.tier)) celebrate.ribbons({ ...fxOpt });
        break;
      case "badges-more":
        celebrate.toast(L("moreBadgesText", { count: cue.count }), { title: L("moreBadgesTitle"), icon: "star", tone: "gold", ...opt });
        break;
      case "goal":
        sfx("goal"); hap("goal"); celebrate.burst({ x: 0.5, y: 0.5, ...fxOpt });
        celebrate.toast(L("goalText"), { title: L("goalTitle"), icon: "target", tone: "gold", ...opt });
        break;
      case "milestone":
        sfx("milestone"); hap("milestone");
        celebrate.toast(L("milestoneText", { value: cue.value }), { title: L("milestoneTitle"), icon: "flame", tone: "gold", ...opt });
        if (!calm) celebrate.confetti({ count: 70, ...fxOpt });
        break;
      case "comeback":
        sfx("comeback"); hap("comeback");
        celebrate.toast(cue.comeback.message, { title: L("comebackTitle", { xp: cue.comeback.bonusXp }), icon: "heart", tone: "calm", ...opt });
        break;
      case "challenge":
        sfx("challenge"); hap("challenge"); celebrate.toast(L("challengeXp", { xp: cue.challenge.xp }), { title: cue.challenge.title, icon: "check", tone: "accent", ...opt });
        break;
      case "unlock":
        sfx("unlock"); hap("unlock"); celebrate.toast(L("unlockText", { feature: unlockLabel(cue) }), { title: L("unlockTitle"), icon: "sparkle", tone: "accent", ...opt });
        break;
      case "drop":
        sfx("drop"); hap("drop"); celebrate.toast(cue.drop.title, { title: L("dropTitle"), icon: "gift", tone: "gold", ...opt });
        break;
      default:
        sfx("complete"); hap("complete"); celebrate.burst({ x: 0.5, y: 0.45, count: 24, ...fxOpt });
    }
    await wait(pause);
  }

  if (levelCue && modal && alive()) {
    const named = plan.folded.length ? plan.folded.map(unlockLabel) : (outcome.quests?.unlockedFeatures ?? []).map(nameOf);
    await celebrate.levelUpModal({ level: levelCue.level, title: levelCue.title, fromLevel: outcome.xp?.fromLevel, xpGained: outcome.xp?.gained, unlocks: named, ...(labels ? { labels } : {}), ...fxOpt });
  }
  return played;
}

