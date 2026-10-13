// The engagement layer against the real vendored kit (no page): XP and levels through xpToReach, badges, Heat from the previous
// visit's Card, the demo twin that never touches the real profile, Forget my data, the first win clock, ground-truth XP, and the
// quiet gate holding every reward while something is being measured.
import test from "node:test";
import assert from "node:assert/strict";
import { xpToReach, levelFromXp } from "../src/vendor/fun-kit/index.js";
import { createFun } from "../src/fun/fun.js";
import { createCombine } from "../src/fun/combine.js";
import * as C from "../src/fun/config.js";
import { COPY } from "../src/fun/copy.js";

const jump = (foot, cm, n = 1) => ({ type: "jump", rep: { n, foot, flightMs: 500, estCm: cm } });
const step = (ms) => ({ type: "firststep", trial: { n: 1, side: "L", reactionMs: 200, pushMs: 300, stepMs: ms, dir: "FWD" } });
const sprint = (tN = 1920, N = 5) => ({ type: "sprint", trial: { n: 1, N, startSide: "L", t3: 1100, tN, vN: 4.8, accel: 2.5 } });
const rsi = (v, hops) => ({ type: "rsi", rsi: v, hops });

/** effect stand-ins that record what the gate let through */
function fakeFx() {
  const calls = [];
  const rec = (name) => (...a) => { calls.push(name); return Promise.resolve(); };
  return { calls, burst: rec("burst"), confetti: rec("confetti"), ribbons: rec("ribbons"), toast: rec("toast"), unlockToast: rec("unlockToast"), levelUpModal: rec("levelUpModal"), bloom: rec("bloom"), gentleGlow: rec("gentleGlow") };
}
/** a stand-in for window.localStorage: a Storage that is not the kit's memory storage, so the kit treats it as durable */
function recordingStorage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear() };
}
const keysOf = (s) => Array.from({ length: s.length }, (_, i) => s.key(i));

function setup({ sim = false, memory = false, storage = recordingStorage(), measure = { on: false }, start = Date.UTC(2026, 9, 13, 15), warm = true } = {}) {
  let t = start;
  const fx = fakeFx();
  const fun = createFun({ sim, memory, storage, now: () => t, measuring: () => measure.on, fx, pause: 0 });
  const visit = C.newVisit(t, "v1");
  visit.warm = warm; // these tests are about the rewards; the warm-up rule has its own tests in fun-combine
  // a machine for one round; pass { sim: true } to skip the rest and the visit cap when a test plays several rounds
  const combine = (o = {}) => createCombine({
    now: () => t, sim, visit, best: { ...fun.bests }, history: fun.history.firstSteps, ...o,
  });
  return { fun, fx, storage, visit, combine, tick: (ms) => (t += ms), now: () => t, measure };
}
function playFull(c, cm = 33.1) {
  c.start();
  c.feed(jump("BOTH", cm)); c.feed(jump("L", 17.7)); c.feed(jump("R", 19.6));
  [450, 470, 440].forEach((ms) => c.feed(step(ms)));
  c.feed(sprint());
  c.feed(jump("BOTH", 11)); c.feed(rsi(0.6, 2)); c.feed(jump("BOTH", 12)); c.feed(rsi(0.62, 3));
  return c.summary();
}

test("a full Combine pays the table's XP in one session and lands on level 3, asserted through xpToReach", () => {
  const s = setup({ sim: true });
  const c = s.combine();
  const sum = playFull(c);
  const res = s.fun.finishRound(sum, { visitId: s.visit.id });
  const total = C.roundXp(sum.xpInput).total;
  assert.equal(res.xp.total, total);
  assert.equal(res.outcome.xp.gained, total, "badges are recognition: the starter set pays no XP of its own");
  assert.equal(res.outcome.xp.level, 3);
  assert.equal(res.outcome.xp.title, "Starter");
  assert.ok(res.outcome.xp.total >= xpToReach(3, C.CURVE) && res.outcome.xp.total < xpToReach(4, C.CURVE));
  assert.equal(levelFromXp(res.outcome.xp.total, C.CURVE).level, 3);
  assert.equal(res.outcome.xp.levelUp, true);
  assert.equal(res.heat.flames, 3, "a first-time visitor tops out at three flames");
  assert.equal(res.heat.name, "Surge");
  assert.equal(s.fun.kit.xp.info().total, total);
});

test("the eight starter badges open from the round's flags, and pb_leap waits for a real PB", () => {
  const s = setup({ sim: true });
  const sum = playFull(s.combine());
  const res = s.fun.finishRound(sum, { visitId: s.visit.id });
  const ids = res.outcome.badges.map((b) => b.id).sort();
  assert.deepEqual(ids, ["combine_done", "first_leap", "first_step", "one_foot", "springy", "sprinter"]);
  assert.equal(res.outcome.pbs.find((p) => p.id === "jumpCm").isFirst, true);
  assert.equal(s.fun.kit.achievements.isUnlocked("pb_leap"), false);
  assert.equal(s.fun.kit.achievements.collection().total, 8);

  // a rematch that beats the leap earns New High and Rematch
  s.tick(C.CAPS.restMs + 1);
  const sum2 = playFull(s.combine({ sim: true }), 36.0);
  const res2 = s.fun.finishRound({ ...sum2, id: "v1:2", n: 2 }, { visitId: s.visit.id });
  assert.ok(res2.outcome.badges.some((b) => b.id === "pb_leap"));
  assert.ok(res2.outcome.badges.some((b) => b.id === "rematch"));
  assert.equal(res2.heat.flames, 3, "a same-visit rematch cannot add flames, whatever it beats");
});

test("Heat compares with the PREVIOUS VISIT's Card only", () => {
  const s = setup({});
  const sum1 = playFull(s.combine({ sim: true }), 30);
  const r1 = s.fun.finishRound({ ...sum1, id: "visit1:1" }, { visitId: "visit1" });
  assert.equal(r1.heat.flames, 3);
  // a new visit with better marks everywhere
  s.tick(24 * 3600000);
  const better = createCombine({ now: s.now, sim: true, visit: C.newVisit(s.now(), "visit2"), best: { ...s.fun.bests } });
  better.start();
  better.feed(jump("BOTH", 36)); better.feed(jump("L", 20)); better.feed(jump("R", 22));
  [430, 440, 420].forEach((ms) => better.feed(step(ms)));
  better.feed(sprint(1800)); better.feed(jump("BOTH", 11)); better.feed(rsi(0.7, 2)); better.feed(jump("BOTH", 11)); better.feed(rsi(0.7, 3));
  const sum2 = better.summary();
  const r2 = s.fun.finishRound({ ...sum2, id: "visit2:1" }, { visitId: "visit2" });
  assert.equal(r2.pbs, 5);
  assert.equal(r2.heat.flames, 5, "five marks past the last visit, full circuit: Nova");
  assert.equal(r2.heat.name, "Nova");
  // the same visit again does not count itself as a previous visit
  const sum3 = better.summary();
  const r3 = s.fun.finishRound({ ...sum3, id: "visit2:2", n: 2 }, { visitId: "visit2" });
  assert.equal(r3.prev.visit, "visit1");
  assert.equal(r3.heat.flames, r2.heat.flames);
});

test("a stopped Combine with no finished station records nothing", () => {
  const s = setup({ sim: true });
  const c = s.combine(); c.start();
  const sum = c.stop();
  assert.equal(s.fun.finishRound(sum, { visitId: s.visit.id }), null);
  assert.equal(s.fun.kit.xp.info().total, 0);
});

test("the demo twin: a simulated athlete never reaches the real profile", () => {
  const real = recordingStorage();
  const sim = setup({ sim: true, storage: real });
  assert.equal(sim.fun.kit.store.kind, "memory");
  assert.equal(sim.fun.kit.store.durable, false);
  assert.equal(sim.fun.kit.app, C.SIM_ID);
  const sum = playFull(sim.combine());
  sim.fun.finishRound(sum, { visitId: "v1" });
  sim.fun.beginFirstWin(); sim.fun.feedFirstWin("leap");
  assert.deepEqual(keysOf(real), [], "nothing from the simulated athlete touched the real storage");

  const booth = setup({ memory: true, storage: real });
  assert.equal(booth.fun.kit.store.kind, "memory", "booth mode keeps no profile either");
  booth.fun.finishRound(playFull(booth.combine()), { visitId: "v1" });
  assert.deepEqual(keysOf(real), []);

  const mine = setup({ storage: real });
  assert.equal(mine.fun.kit.store.kind, "local");
  assert.equal(mine.fun.kit.app, C.APP_ID);
  mine.fun.finishRound(playFull(mine.combine()), { visitId: "v1" });
  assert.ok(keysOf(real).length > 3);
  assert.ok(keysOf(real).every((k) => k.startsWith(`fk:${C.APP_ID}:`)), "only the kit namespace of the real app");
  assert.ok(mine.fun.kit.store.durable);
});

test("Forget my data is kit.reset(): nothing is left in storage", () => {
  const s = setup({});
  const sum = playFull(s.combine());
  s.fun.finishRound(sum, { visitId: "v1" });
  s.fun.beginFirstWin(); s.fun.feedFirstWin("leap");
  s.fun.truth({ kind: "jump", n: 1, device: 30, visitId: "v1" });
  s.fun.sound.setMuted(true);
  assert.ok(keysOf(s.storage).length > 4);
  s.fun.forget();
  assert.deepEqual(keysOf(s.storage), []);
  assert.equal(s.fun.kit.xp.info().total, 0, "XP is gone");
  assert.equal(s.fun.kit.pb.best("jumpCm"), null, "bests are gone");
  assert.equal(s.fun.cards.all().length, 0, "Cards are gone");
  assert.equal(s.fun.history.firstSteps().length, 0);
  // reading the empty profile again leaves nothing behind either
  s.fun.kit.xp.info(); s.fun.kit.achievements.collection(); s.fun.kit.pb.all();
  assert.deepEqual(keysOf(s.storage), []);
});

test("the first win is measured by createFirstWin().state().timeToWinMs and lands inside 60 seconds", () => {
  const s = setup({ sim: true });
  const st0 = s.fun.beginFirstWin();
  assert.equal(st0.active, true);
  s.tick(1700); // the simulated first jump lands about 1.7 s after the press
  const st = s.fun.feedFirstWin("leap");
  assert.equal(st.done, true);
  assert.equal(st.timeToWinMs, 1700);
  assert.equal(st.withinTarget, true);
  assert.ok(st.timeToWinMs < 60000);
  // it runs once: beginning again does not restart a finished clock
  assert.equal(s.fun.beginFirstWin().done, true);
  // a slow first jump past 25 s raises the assist so the page can offer Simulate
  const slow = setup({ sim: false });
  slow.fun.beginFirstWin();
  const seen = [];
  slow.fun.firstWin.on("nudge", () => seen.push("nudge")); slow.fun.firstWin.on("assist", () => seen.push("assist"));
  slow.tick(11000); slow.fun.firstWin.tick();
  slow.tick(15000); slow.fun.firstWin.tick();
  assert.deepEqual(seen, ["nudge", "assist"]);
});

test("ground truth pays flat inside plausibility, caps per day, replaces never adds, and ignores agreement", () => {
  const s = setup({});
  const near = s.fun.truth({ kind: "jump", n: 1, device: 33, visitId: "v1" });   // close to a 33 cm estimate
  const far = s.fun.truth({ kind: "jump", n: 2, device: 90, visitId: "v1" });    // wildly different, still plausible
  assert.equal(near.gained, C.XP.truth);
  assert.equal(far.gained, C.XP.truth, "disagreeing with the estimate pays the same as agreeing");
  const again = s.fun.truth({ kind: "jump", n: 1, device: 35, visitId: "v1" });  // a corrected value for the same rep
  assert.equal(again.gained, 0, "a revised entry replaces, it does not add");
  assert.equal(s.fun.kit.xp.info().total, 2 * C.XP.truth);
  const bad = s.fun.truth({ kind: "jump", n: 3, device: 200, visitId: "v1" });
  assert.equal(bad.ok, false); assert.equal(bad.reason, "implausible");
  const gate = s.fun.truth({ kind: "gate", n: 1, device: 0.2, visitId: "v1" });
  assert.equal(gate.ok, false);
  // clearing an entry that was paid takes the award back
  const fix = s.fun.truth({ kind: "jump", n: 2, device: 500, visitId: "v1" });
  assert.equal(fix.revoked, true);
  assert.equal(s.fun.kit.xp.info().total, C.XP.truth);
  // the daily cap is on XP
  for (let n = 10; n < 40; n++) s.fun.truth({ kind: "jump", n, device: 30, visitId: "v1" });
  const day = s.fun.kit.xp.ledger(200).filter((l) => l.source === "truth" && l.amount > 0).reduce((a, l) => a + l.amount, 0);
  assert.ok(day <= C.CAPS.truthPerDay + C.XP.truth, `ground-truth XP today is ${day}`);
  assert.equal(s.fun.truth({ kind: "jump", n: 99, device: 30, visitId: "v1" }).ok, false, "past the daily cap nothing more is paid");
});

test("round 2 improvement pays +15 once per visit, and only when a mark improved on this visit's earlier Card", () => {
  const s = setup({});
  const r1 = s.fun.finishRound({ ...playFull(s.combine({ sim: true }), 30), id: "v1:1" }, { visitId: "v1" });
  assert.equal(r1.extraXp, 0);
  const better = playFull(s.combine({ sim: true }), 31);
  const r2 = s.fun.finishRound({ ...better, id: "v1:2", n: 2 }, { visitId: "v1" });
  assert.equal(r2.extraXp, C.XP.round2);
  assert.ok(r2.outcome.xp.applied.some((a) => a.key === "round2:v1" && a.amount === C.XP.round2));
  const again = playFull(s.combine({ sim: true }), 40);
  const r3 = s.fun.finishRound({ ...again, id: "v1:3", n: 3 }, { visitId: "v1" });
  assert.ok(!r3.outcome.xp.applied.some((a) => a.key === "round2:v1"), "the bonus is once per visit");
});

test("a repeated Done tap counts once (the kit dedupes the session id)", () => {
  const s = setup({ sim: true });
  const sum = playFull(s.combine());
  const first = s.fun.finishRound(sum, { visitId: "v1" });
  const second = s.fun.finishRound(sum, { visitId: "v1" });
  assert.equal(second.outcome.duplicate, true);
  assert.equal(s.fun.kit.xp.info().total, first.outcome.xp.gained);
});

test("every reward waits for the quiet gate: nothing plays while a calibration, GO window, sprint or flight is measured", async () => {
  const measure = { on: true };
  const s = setup({ sim: true, measure });
  const res = s.fun.finishRound(playFull(s.combine()), { visitId: "v1" });
  const done = s.fun.celebrate(res.outcome);
  const rep = s.fun.rep({ kind: "leap", judgment: C.JUDGMENTS.pb, cm: 40, visual: () => s.fx.calls.push("ribbon") });
  const stamp = s.fun.stamp();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(s.fx.calls, [], "the page is measuring: no particle, toast, dialog or ribbon");
  assert.ok(s.fun.gate.pending >= 2);
  measure.on = false;
  await s.fun.gate.flush();
  await Promise.all([done, rep.done, stamp.done]);
  assert.ok(s.fx.calls.includes("burst"), "the PB burst played after the read");
  assert.ok(s.fx.calls.includes("ribbon"), "the ribbon is part of the gated moment");
  assert.ok(s.fx.calls.includes("levelUpModal"), "the level-up dialog waited too");
  assert.equal(s.fun.gate.pending, 0);
});

test("an edge keeps the gate shut for 300 ms more, so a reward never lands inside the read", async () => {
  const s = setup({ sim: true });
  s.fun.edge(60);
  assert.equal(s.fun.gate.quiet, true);
  const rep = s.fun.rep({ kind: "leap", judgment: C.JUDGMENTS.pb, cm: 40 });
  assert.equal(rep.ran, false);
  await new Promise((r) => setTimeout(r, 120));
  const out = await rep.done;
  assert.equal(out.ran, true);
  assert.ok(s.fx.calls.includes("burst"));
});

test("cancelling a celebration drops what the gate still holds and takes the dialog down", async () => {
  const measure = { on: true };
  const s = setup({ sim: true, measure });
  const res = s.fun.finishRound(playFull(s.combine()), { visitId: "v1" });
  const p = s.fun.celebrate(res.outcome);
  s.fun.cancel();
  measure.on = false;
  await s.fun.gate.flush();
  assert.deepEqual(await p, []);
  assert.deepEqual(s.fx.calls, []);
});

test("one fun-kit session per round keeps the daily soft cap at 120 XP (repeatable XP quartered past it)", () => {
  const s = setup({ sim: true });
  let total = 0;
  for (let i = 1; i <= 4; i++) {
    const sum = playFull(s.combine()); sum.id = `v1:${i}`; sum.n = i;
    total += s.fun.finishRound(sum, { visitId: "v1" }).outcome.xp.gained;
  }
  const full = C.roundXp({ jumps: { leap: 1, onefoot: 2 }, firstSteps: 3, sprints: 1, bounceSets: 1, stationsDone: 5, complete: true }).total;
  assert.ok(total < 4 * full, "later rounds the same day pay less once the soft cap is passed");
  assert.equal(C.DAILY_XP_SOFT_CAP, 120);
});

test("the haptic vocabulary is registered but no device send is wired: nothing can buzz during an effort", () => {
  const s = setup({ sim: true });
  for (const name of ["goPulse", "pbPulse", "landPop"]) assert.ok(s.fun.haptics.has(name), name);
  assert.equal(s.fun.haptics.supported, false);
  assert.equal(s.fun.haptics.play("pbPulse").played, false);
  assert.equal(s.fun.haptics.play("pbPulse").reason, "no-device");
  // the pattern for a personal best is two 120 ms pulses 200 ms apart
  assert.deepEqual(s.fun.haptics.pattern("pbPulse").map((x) => [x.ms, x.amp]), [[120, 1], [200, 0], [120, 1]]);
});

test("the labels the kit writes itself pass the copy lint too", async () => {
  const { labelKeys, getLabel, createGuardrails } = await import("../src/vendor/fun-kit/index.js");
  const guard = createGuardrails("playful");
  for (const k of labelKeys()) {
    const v = getLabel(k, { n: 2, xp: 5, level: 2, count: 2, title: "T", feature: "F", gap: "1", value: "2", best: "3", label: "L", direction: "better", remaining: 2, unit: "weeks", daysLeft: 2, daysUnit: "days", previous: 2, minutes: 40, limit: 45, into: 1, need: 5, progress: 1, target: 2, total: 5, what: "x", streak: 3, xpAmount: 1 });
    assert.deepEqual(guard.lintCopy(v), [], `${k}: ${v}`);
  }
  assert.ok(COPY.pulse.options.length === 3);
});
