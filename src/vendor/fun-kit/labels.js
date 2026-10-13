// Words the kit writes itself, in one place, so an app can replace every one of them (its own voice, another language,
// a copy lint that has to see all of it).
//
//   setLabels({ swap: "Reroll", complete: "Finished" });           // once, at start-up: applies to every component and cue
//   renderChallengeCard(c, { labels: { swap: "Swap it" } });        // or per call: wins over setLabels
//   playOutcome(outcome, { labels: { pbTitle: "New best" } });
//
// A label is a string with {name} slots, or a function that receives the same values and returns a string. Keys that a
// call site does not fill stay as written. `labelKeys()` lists every key; `getLabel(key)` reads one.
//
// The text of a personal-best line (pb.js) and the recap cards (recap.js) are labels too.

const plural = (n, one, other = `${one}s`) => (Number(n) === 1 ? one : other);

export const DEFAULT_LABELS = Object.freeze({
  // ---- celebration cues (juice/orchestrate.js, juice/celebrate.js)
  pbTitle: "Personal best",
  goalTitle: "Goal hit",
  goalText: "Weekly goal reached. Rest days are part of the plan.",
  milestoneTitle: "Milestone",
  milestoneText: "{value} in a row. That's a real habit.",
  comebackTitle: "Welcome back (+{xp} XP)",
  challengeXp: "+{xp} XP",
  unlockTitle: "New feature",
  unlockText: "{feature} is now available.",
  dropTitle: "Surprise",
  badgeUnlocked: "Badge unlocked: {title}",
  moreBadgesTitle: "More badges",
  moreBadgesText: "+{count} more unlocked. They are waiting in your collection.",
  toastRegion: "Notifications",
  levelUpEyebrow: "Level up",
  levelReached: "You reached level {level}",
  xpThisSession: "+{xp} XP this session",
  keepGoing: "Keep going",

  // ---- xp bar
  level: "Level",
  maxLevel: "Max level",
  xpToTitle: "{xp} XP to {title}",
  xpToLevel: "{xp} XP to level {level}",
  xpBarAria: "{into} of {need} XP to next level",
  nextLevel: "the next level",

  // ---- streak flame
  flameNone: "Start whenever you like.",
  flameDone: "Done for today.",
  flameReady: "Ready when you are.",
  flameResting: "Resting. Your streak is safe.",
  flameLapsed: "Fresh start waiting.",
  flameBuilding: "Building this week.",
  flameReached: "Weekly goal reached.",
  flameFreshRun: "A fresh run is underway.",
  unitDay: (v) => plural(v.n, "day"),
  unitWeek: (v) => plural(v.n, "week"),
  unitSession: (v) => plural(v.n, "session"),
  best: "{unit} best",
  restBankedDay: (v) => `${v.n} rest ${plural(v.n, "day")} banked`,
  restBankedWeek: (v) => `${v.n} rest ${plural(v.n, "week")} banked`,
  weekPipsAria: "{count} of {target} {unit} this week",
  recentPipsAria: "Last 7 days",

  // ---- challenge card
  thisWeek: "This week",
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  complete: "Complete",
  swap: "Swap",
  swapAria: "Swap challenge: {title}",
  challengeProgressAria: "{title}: {progress} of {target}",

  // ---- badge grid
  badgesWord: "badges",
  secretsLeft: (v) => `${v.n} ${plural(v.n, "secret")} left to find`,
  badgeUnlockedState: "Unlocked",
  badgeLockedState: "Locked",
  badgeSecretState: "Secret",

  // ---- recap carousel
  recapRegion: "Session recap",
  slide: "{n} of {total}",
  back: "Back",
  next: "Next",
  done: "Done",
  share: "Share",
  prevCard: "Previous card",
  nextCard: "Next card",

  // ---- recap cards (recap.js)
  recapSessionComplete: "Session complete",
  recapNiceWork: "Nice work.",
  recapNiceWorkXp: "Nice work. That counts.",
  recapPb: "Personal best",
  recapFirstMark: "Your first mark",
  recapNearMiss: "So close",
  recapWelcomeBack: "Welcome back",
  recapThisWeek: "This week",
  recapWeeklyGoal: "Weekly goal reached",
  recapGoalHit: "Goal hit. Rest days are part of the plan.",
  recapWeeksRunning: " {n} {unit} running.",
  recapToGo: "{remaining} {unit} to go with {daysLeft} {daysUnit} left. You've got time.",
  recapStreak: "Streak",
  recapMilestone: "{n}-day milestone",
  recapRestCovered: "A rest day covered a gap. Your streak lives on.",
  recapHabit: "That's a real habit forming.",
  recapKeepRolling: "Keep it rolling tomorrow, or take a rest day when you need one.",
  recapLevel: "Level {level}: {title}",
  recapBadge: "Badge: {title}",
  recapSurprise: "Surprise: {title}",
  recapChallenge: "Challenge done: {title}",
  recapUnlocked: "Unlocked: {feature}",
  recapLevelUpEyebrow: "Level up",
  recapUnlockedEyebrow: "Unlocked",
  recapLevelEyebrow: "Level {level}",
  recapToNext: "{xp} XP to {what}.",
  recapRestWell: "Rest well",
  recapUpNext: "Up next",
  recapComeBack: "Come back whenever you're ready. Your progress is saved.",

  // ---- messages the engine writes (streaks.js, guardrails.js, onboarding.js, share card)
  comebackLong: "Welcome back. Your best run is safe, and you built {previous} {unit} of momentum before. Let's pick it up.",
  comebackShort: "Welcome back. Glad you're here.",
  nudgeLong: "That was a long one, {minutes} minutes. Rest is part of the plan, and your progress is saved.",
  announceTitle: "New unlocked",
  shareLevel: "LEVEL {level}",
  shareLevelTitle: "LEVEL {level} · {title}",
  shareFooterHealth: "Shared with health details by choice",
  shareFooterPlain: "Progress only. No health data shared.",

  // ---- XP ledger lines (kit.js): the labels on xp.applied rows
  xpSession: "Session complete",
  xpFirst: "First session",
  xpPb: "Personal best",
  xpMilestone: "{n} milestone",
  xpGoal: "Weekly goal reached",
  xpComeback: "Welcome back",
  xpSweep: "All challenges done",
  xpPartial: "Showed up",

  // ---- personal-best lines (pb.js)
  pbFirst: "{label}: {value}. That's your first mark, and the one to beat.",
  pbNew: "New personal best: {value} ({gap} {direction}).",
  pbFaster: "faster",
  pbBetter: "better",
  pbTie: "Matched your best: {value}.",
  pbNearLower: "{gap} off your best. So close.",
  pbNearHigher: "{gap} short of your best. So close.",
  pbOff: "Best is {best}. Every rep builds toward it.",
  ghostLevel: "Level with your ghost",
  ghostAhead: "{gap} ahead of your ghost",
  ghostBehind: "{gap} behind your ghost",
});

let overrides = {};

/** Replace some labels everywhere (call once at start-up). Later calls add to earlier ones; `null` clears them all. */
export function setLabels(map) {
  overrides = map == null ? {} : { ...overrides, ...map };
  return { ...overrides };
}
export const resetLabels = () => setLabels(null);
export const labelKeys = () => Object.keys(DEFAULT_LABELS);

const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));

/** One label, resolved: per-call `local` map first, then setLabels(), then the defaults. */
export function getLabel(key, vars = {}, local) {
  const raw = local?.[key] ?? overrides[key] ?? DEFAULT_LABELS[key];
  if (raw == null) return String(key);
  return typeof raw === "function" ? String(raw(vars)) : fill(raw, vars);
}

/** A resolver bound to a per-call `labels` map: `const L = labelsFor(opts.labels); L("swap")`. */
export const labelsFor = (local) => (key, vars) => getLabel(key, vars, local);
