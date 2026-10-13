// The Combine's rules, as plain data and pure functions: judgments, Heat, XP and its caps, the rest and visit rules,
// ground-truth plausibility, the kit content (titles, curve, badges, personal-best metrics) and the Moon maths.
// No DOM and no kit import here: the numbers can be tested on their own, and nothing in this file can reach a sensor.
// Everything is stored and compared in metric (cm, ms, s); the UI converts only when it draws.
import { COPY } from "./copy.js";

export const APP_ID = "ae-demo";
export const SIM_ID = "ae-demo-sim";
export const G = 9.80665;

// ---------------------------------------------------------------- kit content
/** Level curve: cumulative XP L2 30, L3 73, L4 137 ... Tests read it through the kit's xpToReach, never as literals. */
export const CURVE = Object.freeze({ first: 30, linear: 8, quad: 4.5, round: 1 });
export const TITLES = Object.freeze(COPY.titles.map((t, i) => [i + 1, t]));
export const DAILY_XP_SOFT_CAP = 120;

export const STATIONS = Object.freeze([
  { id: "leap", n: 1, lab: "card-jump", jump: true },
  { id: "onefoot", n: 2, lab: "card-jump", jump: true },
  { id: "firststep", n: 3, lab: "card-firststep", need: 3 },
  { id: "sprint", n: 4, lab: "card-sprint", need: 1 },
  { id: "bounce", n: 5, lab: "card-rsi", optional: true, need: 3 },
]);
export const STATION_IDS = Object.freeze(STATIONS.map((s) => s.id));
export const stationName = (id) => COPY.stations[id].name;

// ---------------------------------------------------------------- caps and rest (all app-side, all tested)
export const CAPS = Object.freeze({
  jumpsPerStation: 5,     // valid jumps that earn XP, per jump station per round
  firstSteps: 6,          // First Step trials that earn XP per round
  sprints: 3,             // sprints that earn XP per round
  warmupJumps: 3,         // the first jumps of a visit are warm-ups: no best, no board entry
  combinesPerVisit: 2,
  restMs: 120000,         // a visible two-minute rest before a same-visit rematch
  truthPerDay: 20,        // XP from ground-truth pairs per day
  boardMin: 5,            // results needed before a rank is shown
  boardShown: 5,
  boardKeep: 200,
});

export const XP = Object.freeze({ jump: 3, firstStep: 3, sprint: 5, bounceSet: 3, station: 5, combine: 30, round2: 15, truth: 2 });

/** What a round pays, with the caps applied. `r`: { jumps: {leap, onefoot}, firstSteps, sprints, bounceSets, stationsDone, complete } */
export function roundXp(r = {}) {
  const j = r.jumps ?? {};
  const cap = (n, max) => Math.max(0, Math.min(Math.floor(n || 0), max));
  const parts = {
    jump: (cap(j.leap, CAPS.jumpsPerStation) + cap(j.onefoot, CAPS.jumpsPerStation)) * XP.jump,
    firstStep: cap(r.firstSteps, CAPS.firstSteps) * XP.firstStep,
    sprint: cap(r.sprints, CAPS.sprints) * XP.sprint,
    bounce: (r.bounceSets ?? 0) > 0 ? XP.bounceSet : 0,
    station: cap(r.stationsDone, STATIONS.length) * XP.station,
    combine: r.complete ? XP.combine : 0,
  };
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

/** Ground truth pays flat inside physical plausibility; agreement with the estimate is never a condition. */
export const PLAUSIBLE = Object.freeze({ jumpCm: [5, 120], gateS: [0.5, 4] });
export const plausibleJumpCm = (cm) => Number.isFinite(cm) && cm >= PLAUSIBLE.jumpCm[0] && cm <= PLAUSIBLE.jumpCm[1];
export const plausibleGateS = (s) => Number.isFinite(s) && s >= PLAUSIBLE.gateS[0] && s <= PLAUSIBLE.gateS[1];
export const plausibleTruth = (kind, v) => (kind === "jump" ? plausibleJumpCm(v) : kind === "gate" ? plausibleGateS(v) : false);
/** XP for one ground-truth entry given what was already paid today (the daily cap is on XP). */
export function truthXp(paidToday = 0) { return Math.max(0, Math.min(XP.truth, CAPS.truthPerDay - paidToday)); }

// ---------------------------------------------------------------- judgments (relative to yourself, never an invented norm)
export const SHAPES = Object.freeze({ diamond: "diamond", circle: "circle", triangle: "triangle", dash: "dash", ring: "ring" });
const J = (id, shape, tone) => Object.freeze({ id, word: COPY.judge[id], shape, tone });
export const JUDGMENTS = Object.freeze({
  pb: J("pb", SHAPES.diamond, "gold"), first: J("first", SHAPES.diamond, "accent"),
  photo: J("photo", SHAPES.circle, "accent"), close: J("close", SHAPES.triangle, "accent"), warmup: J("warmup", SHAPES.dash, "calm"),
  lightning: J("lightning", SHAPES.diamond, "gold"), quick: J("quick", SHAPES.circle, "accent"), ready: J("ready", SHAPES.triangle, "accent"),
  calibrating: J("calibrating", SHAPES.ring, "calm"), springy: J("springy", SHAPES.diamond, "gold"), steady: J("steady", SHAPES.circle, "accent"),
});

/**
 * A jump: PB! beats your best, Photo finish is within 1 cm, Close within 5 percent, Warm-up otherwise (and always for a warm-up jump).
 * `best` is the best before this result (cm), or null for a first mark.
 */
export function judgeJump(cm, best, { warmup = false } = {}) {
  if (warmup) return JUDGMENTS.warmup;
  if (best == null) return JUDGMENTS.first;
  if (cm > best) return JUDGMENTS.pb;
  const gap = best - cm;
  if (gap <= 1) return JUDGMENTS.photo;
  if (gap <= best * 0.05) return JUDGMENTS.close;
  return JUDGMENTS.warmup;
}

export function median(list) {
  const a = list.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
/**
 * A first step (first-contact ms, lower is faster) against your own median of earlier trials. The first three trials only calibrate.
 * Lightning is at or under 95 percent of your median, Quick at or under 100, Ready at or under 110, Warm-up slower.
 */
export function judgeFirstStep(ms, earlier = []) {
  const prior = earlier.filter(Number.isFinite);
  if (prior.length < 3) return JUDGMENTS.calibrating;
  const m = median(prior);
  if (ms <= m * 0.95) return JUDGMENTS.lightning;
  if (ms <= m) return JUDGMENTS.quick;
  if (ms <= m * 1.1) return JUDGMENTS.ready;
  return JUDGMENTS.warmup;
}

/** A sprint time to step N (seconds, lower is faster) against your best for the same N. Photo finish is within 0.03 s. */
export function judgeSprint(s, best) {
  if (best == null) return JUDGMENTS.first;
  if (s < best) return JUDGMENTS.pb;
  const gap = s - best;
  if (gap <= 0.03) return JUDGMENTS.photo;
  if (gap <= best * 0.05) return JUDGMENTS.close;
  return JUDGMENTS.warmup;
}

/** Bounce (RSI, higher is springier) against your best: Springy at or past it, Steady within 15 percent. */
export function judgeBounce(rsi, best) {
  if (best == null) return JUDGMENTS.first;
  if (rsi >= best) return JUDGMENTS.springy;
  if (rsi >= best * 0.85) return JUDGMENTS.steady;
  return JUDGMENTS.warmup;
}

// ---------------------------------------------------------------- Heat (the overall rating of a Card, 1 to 5 flames)
export const HEAT = Object.freeze({ names: COPY.heat });
/** True when stations 1 to 4 are done and the optional Bounce is done or skipped. */
export function isFullCircuit(status = {}) {
  return ["leap", "onefoot", "firststep", "sprint"].every((id) => status[id] === "done") && ["done", "skipped"].includes(status.bounce);
}
/**
 * Flames reflect finishing the circuit and beating your own marks from your PREVIOUS VISIT's Card, not talent.
 * 1 = at least one station, 2 = three stations, 3 = the full circuit, 4 = full circuit with 2+ PBs, 5 = with 3+ PBs.
 * `pbs` is the number of marks that beat the previous visit's Card; it only counts when `hasPrevVisit` is true, so a first-time
 * visitor tops out at 3 and a same-visit rematch can never add flames.
 */
export function heat({ status = {}, pbs = 0, hasPrevVisit = false } = {}) {
  const done = Object.values(status).filter((s) => s === "done").length;
  const full = isFullCircuit(status);
  let flames = done >= 3 ? 2 : done >= 1 ? 1 : 0;
  if (full) flames = 3;
  if (full && hasPrevVisit && pbs >= 3) flames = 5;
  else if (full && hasPrevVisit && pbs >= 2) flames = 4;
  return { flames, name: flames ? HEAT.names[flames - 1] : "", fullCircuit: full, done, pbs: hasPrevVisit ? pbs : 0 };
}

/** Marks in `now` that beat `prev` (both Card stamp summaries: leap cm, onefoot cm, firststep ms, sprint {n, s}, bounce rsi). */
export function countPbs(now = {}, prev = null) {
  if (!prev) return 0;
  let n = 0;
  if (now.leap != null && prev.leap != null && now.leap > prev.leap) n++;
  if (now.onefoot != null && prev.onefoot != null && now.onefoot > prev.onefoot) n++;
  if (now.firststep != null && prev.firststep != null && now.firststep < prev.firststep) n++;
  if (now.sprint && prev.sprint && now.sprint.n === prev.sprint.n && now.sprint.s < prev.sprint.s) n++;
  if (now.bounce != null && prev.bounce != null && now.bounce > prev.bounce) n++;
  return n;
}
/** Did any mark improve on an earlier Card of the same visit (the round 2 improvement bonus; flames never read this). */
export const improved = (now, earlier) => countPbs(now, earlier) > 0;

// ---------------------------------------------------------------- the visit (one person's sitting) and the rest rule
export function newVisit(now = Date.now(), id = `v${now.toString(36)}`) {
  return { id, startedAt: now, warm: false, jumps: 0, combines: 0, lastEndAt: null, rested: false, restedTaps: 0 };
}
export const isWarmup = (visit, sim = false) => !sim && !visit.warm && visit.jumps < CAPS.warmupJumps;
/** A Combine on a body needs a rest and is capped per visit. Simulate has no body to rest, so neither rule applies there. */
export function restLeftMs(visit, now, sim = false) {
  if (sim || visit.combines < 1 || visit.rested || visit.lastEndAt == null) return 0;
  return Math.max(0, visit.lastEndAt + CAPS.restMs - now);
}
export function canStart(visit, now, sim = false) {
  if (sim) return { ok: true, reason: null, waitMs: 0 };
  if (visit.combines >= CAPS.combinesPerVisit) return { ok: false, reason: "cap", waitMs: 0 };
  const wait = restLeftMs(visit, now, sim);
  return wait > 0 ? { ok: false, reason: "rest", waitMs: wait } : { ok: true, reason: null, waitMs: 0 };
}

// ---------------------------------------------------------------- the board
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
}
/** Three letters, upper case, nothing else. Returns "" when there is nothing usable. */
export function cleanInitials(raw) {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
}

// ---------------------------------------------------------------- Moon and Jupiter (a game, not a measurement)
export const MOON_G = 1.62, JUPITER_G = 24.79;
/** How much higher (or lower) the same flight time would carry you under another gravity. */
export const heightFactor = (g) => G / g;
export const moonCm = (cm) => cm * heightFactor(MOON_G);
export const jupiterCm = (cm) => cm * heightFactor(JUPITER_G);
/** A scaled height in the chosen system: "2.0 m" / "6 ft 7 in", or "13 cm" / "5.1 in" when small. */
export function bigHeightText(cm, system) {
  if (!Number.isFinite(cm)) return "";
  if (system === "imperial") {
    const inches = cm / 2.54;
    if (inches < 12) return `${inches.toFixed(1)} in`;
    let ft = Math.floor(inches / 12), inch = Math.round(inches - ft * 12);
    if (inch === 12) { ft += 1; inch = 0; }
    return `${ft} ft ${inch} in`;
  }
  return cm >= 100 ? `${(cm / 100).toFixed(1)} m` : `${Math.round(cm)} cm`;
}

// ---------------------------------------------------------------- Card helpers
/** The headline for a stamp, in storage units (cm, ms, s, rsi). */
export function stampValue(id, s) {
  if (!s) return null;
  if (id === "leap") return s.cm ?? null;
  if (id === "onefoot") return s.best ?? null;
  if (id === "firststep") return s.bestMs ?? null;
  if (id === "sprint") return s.s != null ? { n: s.n, s: s.s } : null;
  if (id === "bounce") return s.rsi ?? null;
  return null;
}
/** Left and right single-leg leaps and how far apart they are (percent of the larger). */
export function balance(l, r) {
  if (!(l > 0) || !(r > 0)) return null;
  const hi = Math.max(l, r), lo = Math.min(l, r);
  return { l, r, pct: Math.round(((hi - lo) / hi) * 100), weaker: l < r ? "Left" : r < l ? "Right" : null };
}

// ---------------------------------------------------------------- kit content: metrics and badges
/**
 * Personal bests the kit tracks. `fmt` carries the display system, so a line like "New personal best" honours metric / imperial:
 * { height: (cm) => "33.1 cm", seconds: (s) => "1.92 s", ms: (ms) => "412 ms" }.
 */
export function makePbMetrics(fmt) {
  const m = (id, label, better, format, extra = {}) => ({ id, label, better, format, ...extra });
  return [
    m("jumpCm", "Two-foot leap", "higher", fmt.height, { nearMissAbs: 1, nearMissPct: 0.05 }),
    m("singleCm", "One-foot leap", "higher", fmt.height, { nearMissAbs: 1, nearMissPct: 0.05 }),
    m("firstStepMs", "First step", "lower", fmt.ms, { nearMissAbs: 10, nearMissPct: 0.03 }),
    m("sprint3", "Sprint, 3 steps", "lower", fmt.seconds, { nearMissAbs: 0.03, nearMissPct: 0.05 }),
    m("sprint5", "Sprint, 5 steps", "lower", fmt.seconds, { nearMissAbs: 0.03, nearMissPct: 0.05 }),
    m("sprint7", "Sprint, 7 steps", "lower", fmt.seconds, { nearMissAbs: 0.03, nearMissPct: 0.05 }),
    m("rsi", "Bounce", "higher", (v) => v.toFixed(2), { nearMissAbs: 0.05, nearMissPct: 0.1 }),
  ];
}

/** The eight starter badges. Rules read flags and counters that completeSession is given at the end of a round. */
export function makeBadges() {
  // Badges are recognition, not currency: the starter set pays no XP, so the first Combine keeps the pacing the table gives (level 3).
  const b = (id, tier, icon, rule, extra = {}) => ({ id, tier, icon, rule, xp: 0, title: COPY.badges[id].title, desc: COPY.badges[id].desc, shareSafe: true, ...extra });
  return [
    b("first_leap", "common", "bolt", { firstTime: "leap" }),
    b("one_foot", "common", "target", { firstTime: "onefoot" }),
    b("first_step", "common", "sparkle", { firstTime: "firststep" }),
    b("sprinter", "common", "flame", { firstTime: "sprint" }),
    b("springy", "common", "refresh", { firstTime: "bounce" }),
    b("combine_done", "common", "check", { counter: "circuits", gte: 1 }),
    b("rematch", "common", "heart", { counter: "rematches", gte: 1 }),
    b("pb_leap", "common", "trophy", { personalBest: "jumpCm" }),
  ];
}
