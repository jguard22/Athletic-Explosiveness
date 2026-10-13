// Guardrails: per-app policy flags so engagement never works against wellbeing.
//
// Pick a preset and (optionally) override single flags:
//   playful - games, competitions (Burst-style). Leaderboards, time pressure, daily streaks OK.
//   health  - Steady/Feel/Data Lab-style wellness apps. Weekly goal streaks, NO leaderboards by
//             default, no streak-loss shame, no rewards for exceeding a medical/load target.
//   calm    - breathing / sleep / stress apps: health + no competitive pressure, no countdown pressure.
//   kids    - health + calm + no variable rewards, no sharing, shorter session nudges.
//
// Safety flags only tighten: in health, calm and kids an override can switch a permission OFF
// but never ON, and the XP soft cap / session nudge can only get stricter. Anything an override
// tried to relax is dropped and listed in `guardrails.ignored` (with a console warning). Only the
// playful preset can opt back into competition, leaderboards and the like.
//
// Where the flags bite (createFunKit and the share card read them; host UI can ask with
// guardrails.allows("leaderboards")):
//   leaderboards / competition / timePressure   challenge templates tagged for them are filtered out
//   variableRewards                             no surprise drops; rewards.roll() returns null
//   rewardOverTarget                            session.overTarget values earn no PB, badge, challenge or reward
//   sharing                                     recap cards are not shareable; renderShareCard refuses
//   shareHealthData                             the person may opt in to measured values on a share image (never the default)
//   dailyXpSoftCap                              XP past the cap is cut to a quarter
//   sessionNudgeMinutes                         completeSession() returns `nudge` for long sessions; the recap suggests rest
//   rerolls                                     challenge "swap" allowed (off = none)
//   challengeSweep                              clean-sweep bonus XP

import { getLabel } from "./labels.js";

export const PRESETS = Object.freeze({
  playful: {
    leaderboards: true, competition: true, timePressure: true, variableRewards: true,
    streakMode: "daily", streakShame: false, rewardOverTarget: true, shareHealthData: true,
    sharing: true, dailyXpSoftCap: 0, sessionNudgeMinutes: 0, challengeSweep: true, rerolls: true,
  },
  health: {
    leaderboards: false, competition: false, timePressure: false, variableRewards: true,
    streakMode: "weekly", streakShame: false, rewardOverTarget: false, shareHealthData: true,
    sharing: true, dailyXpSoftCap: 150, sessionNudgeMinutes: 45, challengeSweep: true, rerolls: true,
  },
  calm: {
    leaderboards: false, competition: false, timePressure: false, variableRewards: true,
    streakMode: "weekly", streakShame: false, rewardOverTarget: false, shareHealthData: true,
    sharing: true, dailyXpSoftCap: 100, sessionNudgeMinutes: 30, challengeSweep: false, rerolls: true,
  },
  kids: {
    leaderboards: false, competition: false, timePressure: false, variableRewards: false,
    streakMode: "weekly", streakShame: false, rewardOverTarget: false, shareHealthData: false,
    sharing: false, dailyXpSoftCap: 80, sessionNudgeMinutes: 20, challengeSweep: false, rerolls: true,
  },
});

/** Words and phrases that read as shame or pressure. Used to lint host copy. */
export const SHAME_PATTERNS = [
  /\byou (lost|broke|failed|missed)\b/i,
  /\bstreak (lost|broken|ended|gone|over)\b/i,
  /\bdon'?t (break|lose|miss)\b/i,
  /\b(falling|fell) behind\b/i,
  /\bdisappoint/i,
  /\blast chance\b/i,
  /\bhurry\b/i,
  /\bor (you'?ll|you will) lose\b/i,
  /\bwe miss you\b/i,
];

/** Flags where `true` grants the app more latitude. Outside the playful preset an override may only turn these off. */
export const PERMISSION_FLAGS = Object.freeze(["leaderboards", "competition", "timePressure", "variableRewards", "rewardOverTarget", "sharing", "shareHealthData"]);
/** Numeric limits that may only get stricter (smaller, and never 0 = unlimited) outside the playful preset. */
export const LIMIT_FLAGS = Object.freeze(["dailyXpSoftCap", "sessionNudgeMinutes"]);

/**
 * @param {"playful"|"health"|"calm"|"kids"} mode
 * @param {Partial<typeof PRESETS.health>} [overrides]
 */
export function createGuardrails(mode = "health", overrides = {}) {
  const base = PRESETS[mode];
  if (!base) throw new Error(`fun-kit guardrails: unknown mode "${mode}"`);
  const flags = { ...base, ...overrides };
  const ignored = [];
  // Rules that no override may relax:
  if (mode !== "playful") {
    for (const f of PERMISSION_FLAGS) if (flags[f] && !base[f]) { ignored.push({ flag: f, requested: flags[f], applied: base[f] }); flags[f] = base[f]; }
    for (const f of LIMIT_FLAGS) {
      const v = flags[f];
      if (v !== base[f] && !(Number.isFinite(v) && v > 0 && v < base[f])) { ignored.push({ flag: f, requested: v, applied: base[f] }); flags[f] = base[f]; }
    }
  }
  flags.streakShame = false;
  if (ignored.length) { try { console.warn(`[fun-kit] guardrails (${mode}) ignored overrides that would relax a safety rule: ${ignored.map((i) => i.flag).join(", ")}`); } catch {} }

  const api = {
    mode, flags, ignored,
    allows: (name) => !!flags[name],
    assertAllowed(name) { if (!flags[name]) throw new Error(`fun-kit guardrails (${mode}): "${name}" is not allowed in this app`); },

    /** Defaults createFunKit merges into its module configs. */
    defaults() {
      return {
        streaks: { mode: flags.streakMode },
        xp: { dailySoftCap: flags.dailyXpSoftCap },
        rewards: { enabled: flags.variableRewards, maxPerDay: mode === "playful" ? 1 : 1, baseChance: mode === "playful" ? 0.14 : 0.1 },
        challenges: { sweepXp: flags.challengeSweep ? 25 : 0, ...(flags.rerolls ? {} : { maxRerolls: { daily: 0, weekly: 0 } }) },
      };
    },

    /** Drop challenge templates that violate the policy (competitive, over-target, countdown). */
    filterTemplate(t) {
      if (!flags.competition && t.tags?.includes("competitive")) return false;
      if (!flags.timePressure && t.tags?.includes("timed")) return false;
      if (!flags.leaderboards && t.tags?.includes("leaderboard")) return false;
      if (!flags.rewardOverTarget && t.tags?.includes("over-target")) return false;
      return true;
    },

    /** Clamp a requested load/intensity to a medical or safety ceiling. Never reward beyond it. */
    capLoad(requested, ceiling) { return ceiling == null ? requested : Math.min(requested, ceiling); },

    /** True if XP for exceeding a target should be withheld (health: yes). */
    withholdOverTarget: () => !flags.rewardOverTarget,

    /** A gentle rest suggestion once a session runs past `sessionNudgeMinutes`; null otherwise (or when the nudge is off). */
    sessionNudge(elapsedMs) {
      const limit = flags.sessionNudgeMinutes;
      if (!(limit > 0) || !(elapsedMs >= limit * 60000)) return null;
      const minutes = Math.round(elapsedMs / 60000);
      return { minutes, limit, text: getLabel("nudgeLong", { minutes, limit }) };
    },

    /** Lint host copy; returns the list of offending patterns (empty = fine). */
    lintCopy(text) { return SHAME_PATTERNS.filter((p) => p.test(String(text))).map((p) => p.source); },

    /** Validate a challenge template; returns human-readable issues. */
    validateTemplate(t) {
      const issues = [];
      if (!api.filterTemplate(t)) issues.push(`template "${t.id}" is tagged for a mechanic this mode disallows`);
      for (const f of ["title", "description"]) { const bad = api.lintCopy(t[f] ?? ""); if (bad.length) issues.push(`template "${t.id}" ${f} reads as pressure`); }
      if (t.maxTarget != null && Number(t.target) > t.maxTarget && !flags.rewardOverTarget) issues.push(`template "${t.id}" target exceeds its safe ceiling`);
      return issues;
    },

    explain: () => Object.entries(flags).map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
  return api;
}
