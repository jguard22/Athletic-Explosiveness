// The Combine as a state machine: five stations in a row, fed with the page's own events (jump, firststep, sprint, rsi).
// Pure: no DOM, no kit, no clock of its own (now() is passed in), so every rule here is covered by node:test.
// It only ever READS what happened (a height, a time); it never decides how a measurement is taken.
import {
  STATIONS, STATION_IDS, CAPS, isWarmup, canStart, isFullCircuit, balance,
  judgeJump, judgeFirstStep, judgeSprint, judgeBounce,
} from "./config.js";

const idle = () => ({ leap: "todo", onefoot: "todo", firststep: "todo", sprint: "todo", bounce: "todo" });

/**
 * @param {{now?: () => number, sim?: boolean, visit: object, sprintN?: () => number,
 *   best?: {jump?: () => number|null, single?: () => number|null, sprint?: (n: number) => number|null, rsi?: () => number|null},
 *   history?: () => number[], onVisit?: () => void}} o
 *   visit    the person's sitting (config.newVisit): jumps counted for the warm-up rule, Combines counted for the cap and the rest
 *   best     all-time bests from the kit before this round (null when there is none yet)
 *   history  earlier first-step contact times (ms) for the median
 */
export function createCombine({ now = Date.now, sim = false, visit, sprintN = () => 5, best = {}, history = () => [], onVisit = () => {} } = {}) {
  let R = null; // the round in progress or just finished

  const fresh = (n) => ({
    id: `${visit.id}:${n}`, n, sim, startedAt: now(), endedAt: null, early: false, phase: "running", index: 0,
    status: idle(), sprintN: sprintN(), prev: { lastEndAt: visit.lastEndAt, rested: visit.rested },
    leap: null, onefoot: { L: null, R: null }, firststep: { trials: [] }, sprint: null, bounce: { hops: 0, rsi: null, sets: 0 },
    counts: { leap: 0, onefoot: 0, firstSteps: 0, sprints: 0 },
    local: { jump: null, single: { L: null, R: null } }, // best non-warm-up marks inside this round, so a later rep is judged against an earlier one
  });

  const stationId = () => (R && R.phase === "running" ? STATION_IDS[R.index] : null);

  function advance() {
    // the next station that is not already done (a station can finish out of order only by Skip, which also lands here)
    do { R.index++; } while (R.index < STATIONS.length && R.status[STATION_IDS[R.index]] !== "todo");
    if (R.index >= STATIONS.length) finish(false);
  }
  function finish(early) {
    if (!R || R.phase !== "running") return;
    const finished = STATION_IDS.filter((id) => R.status[id] === "done").length;
    R.phase = "done"; R.endedAt = now(); R.early = early;
    for (const id of STATION_IDS) if (R.status[id] === "todo") R.status[id] = early ? "notrun" : "skipped";
    if (finished === 0) {
      // nothing was done: it was no effort, so it neither counts toward the visit's two Combines nor starts a rest
      visit.combines = Math.max(0, visit.combines - 1);
      visit.lastEndAt = R.prev.lastEndAt; visit.rested = R.prev.rested;
    } else { visit.lastEndAt = R.endedAt; visit.rested = false; }
    onVisit();
  }
  const markDone = (id) => { R.status[id] = "done"; };
  const bestJump = () => { const a = best.jump?.() ?? null, b = R.local.jump; return a == null ? b : b == null ? a : Math.max(a, b); };
  // a one-foot leap is judged against the same foot's best: the left against the left, the right against the right
  const bestSingle = (side) => { const a = best.single?.(side) ?? null, b = R.local.single[side]; return a == null ? b : b == null ? a : Math.max(a, b); };

  function feedJump(rep) {
    const warmup = isWarmup(visit, sim);
    visit.jumps++; onVisit();
    const id = stationId();
    if (id === "bounce") return { accepted: true, station: id, hop: true }; // a hop: the rsi event that follows counts the chain
    if (id !== "leap" && id !== "onefoot") return { accepted: false, station: id, reason: "not-a-jump-station" };
    const cm = rep.estCm;
    if (!(cm > 0)) return { accepted: false, station: id, reason: "invalid" };
    if (id === "leap") {
      if (rep.foot !== "BOTH") return { accepted: false, station: id, reason: "wrong-foot", hint: "leap" };
      const prior = bestJump();
      const judgment = judgeJump(cm, prior, { warmup });
      R.counts.leap++;
      R.leap = { cm, foot: "BOTH", warmup, judgment, prior };
      if (!warmup && (R.local.jump == null || cm > R.local.jump)) R.local.jump = cm;
      markDone("leap"); advance();
      return { accepted: true, station: "leap", rep: { kind: "leap", cm, warmup, judgment, prior, n: rep.n }, stationDone: "leap", finished: R.phase === "done" };
    }
    // one foot at a time
    if (rep.foot !== "L" && rep.foot !== "R") return { accepted: false, station: id, reason: "wrong-foot", hint: "onefoot" };
    const side = rep.foot;
    const prior = bestSingle(side);
    const judgment = judgeJump(cm, prior, { warmup });
    R.counts.onefoot++;
    const cur = R.onefoot[side];
    if (!cur || cm > cur.cm) R.onefoot[side] = { cm, warmup, judgment, prior };
    if (!warmup && (R.local.single[side] == null || cm > R.local.single[side])) R.local.single[side] = cm;
    const both = R.onefoot.L && R.onefoot.R;
    const out = { accepted: true, station: "onefoot", rep: { kind: "onefoot", side, cm, warmup, judgment, prior, n: rep.n }, stationDone: both ? "onefoot" : null, finished: false };
    if (both) { markDone("onefoot"); advance(); out.finished = R.phase === "done"; }
    return out;
  }

  function feedFirstStep(trial) {
    if (stationId() !== "firststep") return { accepted: false, station: stationId(), reason: "not-this-station" };
    const earlier = [...history(), ...R.firststep.trials.map((t) => t.stepMs)];
    const judgment = judgeFirstStep(trial.stepMs, earlier);
    const t = { n: R.firststep.trials.length + 1, stepMs: trial.stepMs, reactionMs: trial.reactionMs, pushMs: trial.pushMs, side: trial.side, dir: trial.dir ?? null, judgment };
    R.firststep.trials.push(t);
    R.counts.firstSteps++;
    const need = STATIONS[2].need;
    const done = R.firststep.trials.length >= need;
    const out = { accepted: true, station: "firststep", rep: { kind: "firststep", ...t, need }, stationDone: done ? "firststep" : null, finished: false };
    if (done) { markDone("firststep"); advance(); out.finished = R.phase === "done"; }
    return out;
  }

  function feedSprint(trial) {
    if (stationId() !== "sprint") return { accepted: false, station: stationId(), reason: "not-this-station" };
    const s = trial.tN / 1000, n = trial.N;
    const prior = best.sprint?.(n) ?? null;
    const judgment = judgeSprint(s, prior);
    R.counts.sprints++;
    R.sprint = { n, s, split3: trial.t3 != null ? trial.t3 / 1000 : null, v: trial.vN ?? null, judgment, prior };
    markDone("sprint"); advance();
    return { accepted: true, station: "sprint", rep: { kind: "sprint", ...R.sprint }, stationDone: "sprint", finished: R.phase === "done" };
  }

  function feedRsi(ev) {
    if (stationId() !== "bounce") return { accepted: false, station: stationId(), reason: "not-this-station" };
    const b = R.bounce;
    b.rsi = Math.max(b.rsi ?? 0, ev.rsi);
    b.hops = Math.max(b.hops, ev.hops ?? 2);
    const done = b.hops >= STATIONS[4].need;
    const prior = best.rsi?.() ?? null;
    const judgment = judgeBounce(b.rsi, prior);
    const out = { accepted: true, station: "bounce", rep: { kind: "bounce", rsi: b.rsi, hops: b.hops, judgment, prior, need: STATIONS[4].need }, stationDone: done ? "bounce" : null, finished: false };
    if (done) { b.sets = 1; b.judgment = judgment; b.prior = prior; markDone("bounce"); advance(); out.finished = R.phase === "done"; }
    return out;
  }

  const api = {
    /** Begin a Combine. Refuses (with why) when the visit already had two or the rest is not over. */
    start() {
      const can = canStart(visit, now(), sim);
      if (!can.ok) return { ok: false, ...can };
      visit.combines++; onVisit();
      R = fresh(visit.combines);
      return { ok: true, id: R.id, n: R.n };
    },
    /** Feed a page event ({type, ...}). Returns what the UI needs, or { accepted: false }. */
    feed(ev) {
      if (!R || R.phase !== "running") return { accepted: false, reason: "no-round" };
      if (ev.type === "jump") return feedJump(ev.rep);
      if (ev.type === "firststep") return feedFirstStep(ev.trial);
      if (ev.type === "sprint") return feedSprint(ev.trial);
      if (ev.type === "rsi") return feedRsi(ev);
      return { accepted: false, reason: "ignored" };
    },
    /** Skip the current station. */
    skip() {
      if (!R || R.phase !== "running") return null;
      const id = STATION_IDS[R.index];
      R.status[id] = "skipped"; advance();
      return { skipped: id, finished: R.phase === "done" };
    },
    /** Stop here: the Card shows what was finished. */
    stop() { if (R && R.phase === "running") finish(true); return api.summary(); },
    get phase() { return R ? R.phase : "idle"; },
    get stationId() { return stationId(); },
    get stationIndex() { return R ? R.index : -1; },
    get round() { return R; },
    reset() { R = null; },
    /** Everything the Card, the XP and the kit need, in storage units (cm, ms, s). */
    summary() {
      if (!R) return null;
      const st = { ...R.status };
      const L = R.onefoot.L, Rr = R.onefoot.R;
      const eligible = (x) => (x && !x.warmup ? x.cm : null);
      const singleBest = Math.max(eligible(L) ?? 0, eligible(Rr) ?? 0) || null;
      const anySingle = Math.max(L?.cm ?? 0, Rr?.cm ?? 0) || null;
      const trials = R.firststep.trials;
      const bestMs = trials.length ? Math.min(...trials.map((t) => t.stepMs)) : null;
      const stationsDone = Object.values(st).filter((s) => s === "done").length;
      const full = isFullCircuit(st);
      const metrics = {};
      if (R.leap && !R.leap.warmup) metrics.jumpCm = R.leap.cm;
      if (eligible(L)) metrics.singleL = L.cm;
      if (eligible(Rr)) metrics.singleR = Rr.cm;
      if (bestMs != null) metrics.firstStepMs = bestMs;
      if (R.sprint) metrics[`sprint${R.sprint.n}`] = R.sprint.s;
      if (R.bounce.rsi != null && R.bounce.sets) metrics.rsi = R.bounce.rsi;
      const first = [];
      if (R.leap) first.push("leap");
      if (L && Rr) first.push("onefoot");
      if (trials.length) first.push("firststep");
      if (R.sprint) first.push("sprint");
      if (R.bounce.sets) first.push("bounce");
      return {
        id: R.id, n: R.n, sim, startedAt: R.startedAt, endedAt: R.endedAt, durationMs: (R.endedAt ?? now()) - R.startedAt, early: R.early, phase: R.phase,
        status: st, stationsDone, fullCircuit: full,
        leap: R.leap, onefoot: { L, R: Rr, best: singleBest, anyBest: anySingle, balance: balance(L?.cm, Rr?.cm) },
        firststep: { trials: trials.map((t) => ({ ...t })), bestMs, median: trials.length ? [...trials].map((t) => t.stepMs).sort((a, b) => a - b)[trials.length >> 1] : null },
        sprint: R.sprint, bounce: { ...R.bounce },
        counts: { ...R.counts }, metrics, first,
        xpInput: { jumps: { leap: R.counts.leap, onefoot: R.counts.onefoot }, firstSteps: R.counts.firstSteps, sprints: R.counts.sprints, bounceSets: R.bounce.sets, stationsDone, complete: full },
        // the compact marks a later Card is compared with (storage units)
        marks: {
          leap: R.leap && !R.leap.warmup ? R.leap.cm : null, onefoot: singleBest, firststep: bestMs,
          sprint: R.sprint ? { n: R.sprint.n, s: R.sprint.s } : null, bounce: R.bounce.sets ? R.bounce.rsi : null,
        },
        warmupOnly: !!(R.leap?.warmup && (!L || L.warmup) && (!Rr || Rr.warmup)),
      };
    },
  };
  return api;
}

/** Which stations still hold a mark worth chasing (for the one line of story): the weakest done station by judgment rank. */
export function storyPicks(summary) {
  const rank = { pb: 5, first: 4, lightning: 5, springy: 5, photo: 4, quick: 3, steady: 3, close: 3, ready: 2, warmup: 1, calibrating: 1 };
  const items = [];
  if (summary.leap) items.push(["leap", rank[summary.leap.judgment.id] ?? 1]);
  const one = [summary.onefoot.L, summary.onefoot.R].filter(Boolean);
  if (one.length) items.push(["onefoot", Math.max(...one.map((x) => rank[x.judgment.id] ?? 1))]);
  const ft = summary.firststep.trials;
  if (ft.length) items.push(["firststep", Math.max(...ft.map((t) => rank[t.judgment.id] ?? 1))]);
  if (summary.sprint) items.push(["sprint", rank[summary.sprint.judgment.id] ?? 1]);
  if (summary.bounce.sets && summary.bounce.judgment) items.push(["bounce", rank[summary.bounce.judgment.id] ?? 1]);
  if (!items.length) return { strongest: null, chase: null };
  const sorted = [...items].sort((a, b) => b[1] - a[1]);
  const bal = summary.onefoot.balance;
  return { strongest: sorted[0][0], chase: bal && bal.pct >= 5 && bal.weaker ? { kind: "foot", side: bal.weaker } : sorted.length > 1 ? { kind: "station", id: sorted[sorted.length - 1][0] } : null };
}
