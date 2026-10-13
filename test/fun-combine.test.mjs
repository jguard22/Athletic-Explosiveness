// The Combine state machine, driven with the same events the page sends (jump, firststep, sprint, rsi).
import test from "node:test";
import assert from "node:assert/strict";
import { createCombine, storyPicks } from "../src/fun/combine.js";
import * as C from "../src/fun/config.js";

const jump = (foot, cm, n = 1) => ({ type: "jump", rep: { n, foot, flightMs: Math.round(Math.sqrt((8 * cm) / 100 / C.G) * 1000), estCm: cm } });
const step = (ms, side = "L", n = 1) => ({ type: "firststep", trial: { n, side, reactionMs: 200, pushMs: 300, stepMs: ms, dir: "FWD" } });
const sprint = (tN = 1920, N = 5) => ({ type: "sprint", trial: { n: 1, N, startSide: "L", t3: 1100, tN, vN: 4.8, accel: 2.5 } });
const rsi = (v, hops) => ({ type: "rsi", rsi: v, contactMs: 540, flightMs: 310, hops });

function make({ sim = true, start = 1_000_000, ...o } = {}) {
  let t = start;
  const visit = C.newVisit(t, "v1");
  const combine = createCombine({ now: () => t, sim, visit, ...o });
  return { combine, visit, tick: (ms) => { t += ms; return t; }, now: () => t };
}

function playAll(combine, { cm = 33.1 } = {}) {
  combine.feed(jump("BOTH", cm));
  combine.feed(jump("L", 17.7)); combine.feed(jump("R", 19.6));
  [450, 470, 440].forEach((ms) => combine.feed(step(ms)));
  combine.feed(sprint());
  combine.feed(jump("BOTH", 11)); combine.feed(rsi(0.6, 2)); combine.feed(jump("BOTH", 12)); combine.feed(rsi(0.62, 3));
}

test("a full simulated Combine: five stations in order, the Card's marks and the XP input", () => {
  const { combine } = make();
  assert.equal(combine.start().ok, true);
  assert.equal(combine.stationId, "leap");

  let r = combine.feed(jump("BOTH", 33.1));
  assert.equal(r.accepted, true); assert.equal(r.stationDone, "leap"); assert.equal(r.rep.judgment.id, "first");
  assert.equal(combine.stationId, "onefoot");

  r = combine.feed(jump("L", 17.7));
  assert.equal(r.stationDone, null, "one side is not the station");
  assert.equal(combine.stationId, "onefoot");
  r = combine.feed(jump("R", 19.6));
  assert.equal(r.stationDone, "onefoot");
  assert.equal(combine.stationId, "firststep");

  for (const ms of [450, 470, 440]) r = combine.feed(step(ms));
  assert.equal(r.stationDone, "firststep");
  assert.equal(combine.stationId, "sprint");

  r = combine.feed(sprint(1920, 5));
  assert.equal(r.stationDone, "sprint"); assert.equal(r.rep.judgment.id, "first");
  assert.equal(combine.stationId, "bounce");

  combine.feed(jump("BOTH", 11));
  r = combine.feed(rsi(0.6, 2));
  assert.equal(r.stationDone, null, "two hops are not a set");
  combine.feed(jump("BOTH", 12));
  r = combine.feed(rsi(0.62, 3));
  assert.equal(r.stationDone, "bounce"); assert.equal(r.finished, true);
  assert.equal(combine.phase, "done");

  const s = combine.summary();
  assert.equal(s.fullCircuit, true);
  assert.equal(s.stationsDone, 5);
  assert.deepEqual(s.marks, { leap: 33.1, onefoot: 19.6, firststep: 440, sprint: { n: 5, s: 1.92 }, bounce: 0.62 });
  assert.deepEqual(s.xpInput, { jumps: { leap: 1, onefoot: 2 }, firstSteps: 3, sprints: 1, bounceSets: 1, stationsDone: 5, complete: true });
  assert.equal(C.roundXp(s.xpInput).total, 81);
  assert.deepEqual(s.first.sort(), ["bounce", "firststep", "leap", "onefoot", "sprint"]);
  assert.deepEqual(Object.keys(s.metrics).sort(), ["firstStepMs", "jumpCm", "rsi", "singleCm", "sprint5"]);
  assert.equal(s.metrics.singleCm, 19.6, "the better foot is the one-foot mark");
  assert.equal(s.onefoot.balance.pct, 10, "17.7 against 19.6 is about 10 percent apart");
  assert.equal(s.onefoot.balance.weaker, "Left");
  // the first three first-step trials only calibrate
  assert.deepEqual(s.firststep.trials.map((t) => t.judgment.id), ["calibrating", "calibrating", "calibrating"]);
});

test("events for a station that is not current are ignored, never miscounted", () => {
  const { combine } = make();
  combine.start();
  assert.equal(combine.feed(step(450)).accepted, false);
  assert.equal(combine.feed(sprint()).accepted, false);
  assert.equal(combine.feed(rsi(0.6, 2)).accepted, false);
  combine.feed(jump("BOTH", 30));
  // now on One foot: a two-foot jump is not progress and earns no XP count
  const r = combine.feed(jump("BOTH", 31));
  assert.equal(r.accepted, false); assert.equal(r.reason, "wrong-foot"); assert.equal(r.hint, "onefoot");
  assert.equal(combine.summary().counts.onefoot, 0);
  // and on Leap a one-foot takeoff is not progress either
  const b = make(); b.combine.start();
  const w = b.combine.feed(jump("L", 18));
  assert.equal(w.accepted, false); assert.equal(w.hint, "leap");
  assert.equal(b.combine.stationId, "leap");
  assert.equal(b.combine.feed({ type: "nonsense" }).accepted, false);
  assert.equal(make().combine.feed(jump("BOTH", 30)).reason, "no-round");
});

test("warm-up: the first three jumps of a real visit are warm-ups (no best, no PB), I'm warm ends it", () => {
  const { combine, visit } = make({ sim: false });
  combine.start();
  const a = combine.feed(jump("BOTH", 40));
  assert.equal(a.rep.warmup, true); assert.equal(a.rep.judgment.id, "warmup");
  combine.feed(jump("L", 20)); combine.feed(jump("R", 22));
  assert.equal(visit.jumps, 3);
  const s = combine.summary();
  assert.equal(s.leap.warmup, true);
  assert.equal(s.metrics.jumpCm, undefined, "a warm-up jump never reaches the kit's personal bests");
  assert.equal(s.metrics.singleCm, undefined);
  assert.equal(s.marks.leap, null);
  assert.equal(s.warmupOnly, true);

  // a person who taps I'm warm first has every jump count
  const w = make({ sim: false });
  w.visit.warm = true;
  w.combine.start();
  const b = w.combine.feed(jump("BOTH", 40));
  assert.equal(b.rep.warmup, false); assert.equal(b.rep.judgment.id, "first");
  assert.equal(w.combine.summary().metrics.jumpCm, 40);
  assert.equal(w.combine.summary().warmupOnly, false);

  // and after three jumps the next one counts
  const x = make({ sim: false });
  x.visit.jumps = 3;
  x.combine.start();
  assert.equal(x.combine.feed(jump("BOTH", 41)).rep.warmup, false);
});

test("jumps are judged against your best: kit best first, an earlier rep of the same round second", () => {
  const { combine } = make({ best: { jump: () => 33.1, single: () => 19.0 } });
  combine.start();
  const leap = combine.feed(jump("BOTH", 34.5));
  assert.equal(leap.rep.judgment.id, "pb"); assert.equal(leap.rep.prior, 33.1);
  const l = combine.feed(jump("L", 18.5));
  assert.equal(l.rep.judgment.id, "photo", "within a centimetre of the best one-foot mark");
  const r = combine.feed(jump("R", 19.5));
  assert.equal(r.rep.judgment.id, "pb");
  assert.equal(combine.summary().marks.onefoot, 19.5);
});

test("skip and stop: skipped stations are named, a stopped Combine marks the rest as not run", () => {
  const a = make();
  a.combine.start();
  a.combine.feed(jump("BOTH", 30));
  const sk = a.combine.skip();
  assert.deepEqual(sk, { skipped: "onefoot", finished: false });
  assert.equal(a.combine.stationId, "firststep");
  const sum = a.combine.stop();
  assert.equal(a.combine.phase, "done");
  assert.equal(sum.early, true);
  assert.deepEqual(sum.status, { leap: "done", onefoot: "skipped", firststep: "notrun", sprint: "notrun", bounce: "notrun" });
  assert.equal(sum.fullCircuit, false);
  assert.equal(C.heat({ status: sum.status }).flames, 1);
  assert.equal(C.roundXp(sum.xpInput).combine, 0, "no +30 for a stopped Combine");

  // skipping Bounce at the end still finishes a full circuit
  const b = make();
  b.combine.start();
  b.combine.feed(jump("BOTH", 30)); b.combine.feed(jump("L", 17)); b.combine.feed(jump("R", 18));
  [450, 460, 470].forEach((ms) => b.combine.feed(step(ms)));
  b.combine.feed(sprint());
  assert.equal(b.combine.stationId, "bounce");
  const last = b.combine.skip();
  assert.equal(last.finished, true);
  const s = b.combine.summary();
  assert.equal(s.status.bounce, "skipped");
  assert.equal(s.fullCircuit, true);
  assert.equal(C.heat({ status: s.status }).flames, 3);
  assert.equal(C.roundXp(s.xpInput).bounce, 0);
});

test("the rest and the visit cap are enforced by start() on a real body, and ignored in Simulate", () => {
  const r = make({ sim: false });
  assert.equal(r.combine.start().ok, true);
  playAll(r.combine); // not a valid real-body sequence for warm-up, but the round still finishes
  assert.equal(r.combine.phase, "done");
  const soon = r.combine.start();
  assert.equal(soon.ok, false); assert.equal(soon.reason, "rest"); assert.ok(soon.waitMs > 0 && soon.waitMs <= C.CAPS.restMs);
  r.tick(C.CAPS.restMs);
  assert.equal(r.combine.start().ok, true, "after two minutes the rematch opens");
  r.combine.stop();
  r.tick(10 * C.CAPS.restMs);
  const third = r.combine.start();
  assert.equal(third.ok, false); assert.equal(third.reason, "cap", "a visit is capped at two Combines");
  assert.equal(r.visit.combines, 2);
  // I'm rested ends the rest early
  const q = make({ sim: false });
  q.combine.start(); q.combine.stop();
  assert.equal(q.combine.start().reason, "rest");
  q.visit.rested = true;
  assert.equal(q.combine.start().ok, true);
  // Simulate has no rest and no cap
  const s = make({ sim: true });
  for (let i = 0; i < 5; i++) { assert.equal(s.combine.start().ok, true); s.combine.stop(); }
});

test("a Combine id is unique per visit and round, so a double tap on Done counts once in the kit", () => {
  const a = make(), b = make();
  a.combine.start(); const id1 = a.combine.round.id; a.combine.stop();
  a.combine.start(); const id2 = a.combine.round.id;
  assert.notEqual(id1, id2);
  b.combine.start();
  assert.equal(b.combine.round.id, id1, "same visit and round number, same id: the kit dedupes it");
});

test("sprint judgments compare only the same step count; shorter sprints are their own marks", () => {
  const { combine } = make({ best: { sprint: (n) => (n === 5 ? 2.0 : null) } });
  combine.start();
  combine.feed(jump("BOTH", 30)); combine.feed(jump("L", 17)); combine.feed(jump("R", 18));
  [450, 460, 470].forEach((ms) => combine.feed(step(ms)));
  const r = combine.feed(sprint(1900, 5));
  assert.equal(r.rep.judgment.id, "pb");
  assert.equal(combine.summary().metrics.sprint5, 1.9);
  const t = make({ best: { sprint: (n) => (n === 5 ? 2.0 : null) } });
  t.combine.start();
  t.combine.feed(jump("BOTH", 30)); t.combine.feed(jump("L", 17)); t.combine.feed(jump("R", 18));
  [450, 460, 470].forEach((ms) => t.combine.feed(step(ms)));
  const three = t.combine.feed(sprint(1100, 3));
  assert.equal(three.rep.judgment.id, "first", "no 3-step best yet, so it is a first mark, not a PB over a 5-step time");
  assert.equal(t.combine.summary().metrics.sprint3, 1.1);
  assert.equal(t.combine.summary().metrics.sprint5, undefined);
});

test("first-step tiers use earlier trials from history, not only this round", () => {
  const { combine } = make({ history: () => [500, 480, 520] });
  combine.start();
  combine.feed(jump("BOTH", 30)); combine.feed(jump("L", 17)); combine.feed(jump("R", 18));
  const r = combine.feed(step(470));
  assert.equal(r.rep.judgment.id, "lightning", "470 ms against a median of 500 is under 95 percent");
});

test("the one line of story names a strongest station and a foot to chase", () => {
  const { combine } = make();
  combine.start(); playAll(combine);
  const s = combine.summary();
  const story = storyPicks(s);
  assert.ok(story.strongest);
  assert.deepEqual(story.chase, { kind: "foot", side: "Left" });
  assert.deepEqual(storyPicks({ leap: null, onefoot: { L: null, R: null, balance: null }, firststep: { trials: [] }, sprint: null, bounce: { sets: 0 } }), { strongest: null, chase: null });
});
