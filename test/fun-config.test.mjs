// The Combine's rules: judgment edges, Heat, XP and its caps, the level curve (through the kit's xpToReach, never as literals),
// the rest and visit rules, ground-truth plausibility, the Moon maths and the copy lint. Pure functions, no page needed.
import test from "node:test";
import assert from "node:assert/strict";
import { xpToReach, xpForNextLevel, levelFromXp, titleFor, createGuardrails, createMemoryStorage, createStore, createXp } from "../src/vendor/fun-kit/index.js";
import * as C from "../src/fun/config.js";
import { COPY, allStrings } from "../src/fun/copy.js";

test("jump judgments: PB! beats the best, Photo finish is within 1 cm, Close within 5 percent, Solid within 15, Warm-up only below 85 percent", () => {
  assert.equal(C.judgeJump(35, 33.1).id, "pb");
  assert.equal(C.judgeJump(33.2, 33.1).id, "pb");
  assert.equal(C.judgeJump(33.1, 33.1).id, "photo");          // level with the best is a photo finish, not a PB
  assert.equal(C.judgeJump(32.1, 33.1).id, "photo");          // exactly 1 cm off
  assert.equal(C.judgeJump(32.09, 33.1).id, "close");         // just over 1 cm but within 5 percent (1.655 cm)
  assert.equal(C.judgeJump(31.5, 33.1).id, "close");          // 4.8 percent off
  assert.equal(C.judgeJump(31.4, 33.1).id, "solid");          // 5.1 percent off: not a warm-up, the word is reserved for far below
  assert.equal(C.judgeJump(28.2, 33.1).id, "solid");          // 14.8 percent off
  assert.equal(C.judgeJump(28.1, 33.1).id, "warmup");         // 15.1 percent off: below 85 percent of the best
  assert.equal(C.judgeJump(20, 33.1).id, "warmup");           // far below: neutral, never shame
  assert.equal(C.judgeJump(14.2, 15).id, "photo");            // small best: 1 cm window is wider than 5 percent
  assert.equal(C.judgeJump(30, null).id, "first");
  assert.equal(C.judgeJump(99, 33.1, { warmup: true }).id, "warmup"); // a warm-up jump never earns a PB
  assert.equal(C.judgeJump(30, null, { warmup: true }).id, "warmup");
});

test("first-step judgments use your own median and calibrate for three trials", () => {
  assert.equal(C.judgeFirstStep(450, []).id, "calibrating");
  assert.equal(C.judgeFirstStep(450, [500, 480]).id, "calibrating");
  const prior = [500, 480, 520]; // median 500
  assert.equal(C.median(prior), 500);
  assert.equal(C.judgeFirstStep(475, prior).id, "lightning");   // at or under 95 percent
  assert.equal(C.judgeFirstStep(476, prior).id, "quick");
  assert.equal(C.judgeFirstStep(500, prior).id, "quick");       // at or under 100 percent
  assert.equal(C.judgeFirstStep(501, prior).id, "ready");
  assert.equal(C.judgeFirstStep(550, prior).id, "ready");       // at or under 110 percent
  assert.equal(C.judgeFirstStep(551, prior).id, "warmup");
  assert.equal(C.median([4, 1, 3, 2]), 2.5);
  assert.equal(C.median([]), null);
});

test("sprint and bounce judgments", () => {
  assert.equal(C.judgeSprint(1.9, 2.0).id, "pb");
  assert.equal(C.judgeSprint(2.03, 2.0).id, "photo");
  assert.equal(C.judgeSprint(2.08, 2.0).id, "close");
  assert.equal(C.judgeSprint(2.2, 2.0).id, "solid", "10 percent slower than your best is solid, not a warm-up");
  assert.equal(C.judgeSprint(2.31, 2.0).id, "warmup");
  assert.equal(C.judgeSprint(2.2, null).id, "first");
  assert.equal(C.judgeBounce(0.7, 0.6).id, "springy");
  assert.equal(C.judgeBounce(0.55, 0.6).id, "steady");
  assert.equal(C.judgeBounce(0.4, 0.6).id, "warmup");
});

test("every judgment has a word AND a shape, so no cue depends on colour", () => {
  for (const j of Object.values(C.JUDGMENTS)) {
    assert.ok(j.word && j.word.length > 1, j.id);
    assert.ok(Object.values(C.SHAPES).includes(j.shape), j.id);
  }
  // the five jump judgments use five different shapes
  const shapes = ["pb", "photo", "close", "solid", "warmup"].map((id) => C.JUDGMENTS[id].shape);
  assert.equal(new Set(shapes).size, 5);
  assert.equal(C.JUDGMENTS.firstleap.word, "First leap");
});

test("Heat: flames follow the circuit and marks against the PREVIOUS VISIT, never talent", () => {
  const done = { leap: "done", onefoot: "done", firststep: "done", sprint: "done", bounce: "done" };
  const none = { leap: "todo", onefoot: "todo", firststep: "todo", sprint: "todo", bounce: "todo" };
  assert.equal(C.heat({ status: none }).flames, 0);
  assert.equal(C.heat({ status: { ...none, leap: "done" } }).flames, 1);
  assert.equal(C.heat({ status: { ...none, leap: "done", onefoot: "done" } }).flames, 1);
  assert.equal(C.heat({ status: { ...none, leap: "done", onefoot: "done", firststep: "done" } }).flames, 2);
  assert.equal(C.heat({ status: done }).flames, 3);
  assert.equal(C.heat({ status: { ...done, bounce: "skipped" } }).flames, 3);   // Bounce is optional
  assert.equal(C.heat({ status: { ...done, sprint: "skipped" } }).flames, 2);   // any other skip is not a full circuit
  // flames 4 and 5 need a previous visit AND the full circuit
  assert.equal(C.heat({ status: done, pbs: 3, hasPrevVisit: false }).flames, 3, "a first-time visitor tops out at 3");
  assert.equal(C.heat({ status: done, pbs: 2, hasPrevVisit: true }).flames, 4);
  assert.equal(C.heat({ status: done, pbs: 3, hasPrevVisit: true }).flames, 5);
  assert.equal(C.heat({ status: done, pbs: 1, hasPrevVisit: true }).flames, 3);
  assert.equal(C.heat({ status: { ...none, leap: "done", onefoot: "done", firststep: "done" }, pbs: 3, hasPrevVisit: true }).flames, 2, "no full circuit, no 4 or 5");
  assert.deepEqual(COPY.heat, ["Spark", "Charge", "Surge", "Blaze", "Nova"]);
  assert.equal(C.heat({ status: done, pbs: 3, hasPrevVisit: true }).name, "Nova");
});

test("marks that beat the previous visit's Card (lower is better for times, same step count for sprints)", () => {
  const prev = { leap: 30, onefoot: 20, firststep: 480, sprint: { n: 5, s: 2.0 }, bounce: 0.6 };
  assert.equal(C.countPbs({ leap: 31, onefoot: 21, firststep: 470, sprint: { n: 5, s: 1.9 }, bounce: 0.7 }, prev), 5);
  assert.equal(C.countPbs({ leap: 30, onefoot: 20, firststep: 480, sprint: { n: 5, s: 2.0 }, bounce: 0.6 }, prev), 0, "equal is not beating");
  assert.equal(C.countPbs({ sprint: { n: 3, s: 1.0 } }, prev), 0, "a different step count is not comparable");
  assert.equal(C.countPbs({ leap: 40 }, null), 0, "no previous Card, no PBs");
  assert.equal(C.countPbs({ leap: null, onefoot: null }, prev), 0);
});

test("XP table and caps", () => {
  const full = C.roundXp({ jumps: { leap: 1, onefoot: 2 }, firstSteps: 3, sprints: 1, bounceSets: 1, stationsDone: 5, complete: true });
  assert.deepEqual(full, { jump: 9, firstStep: 9, sprint: 5, bounce: 3, station: 25, combine: 30, total: 81 });
  // the design's pacing check: a maxed circuit is 15 + 18 + 15 + 3 + 25 + 30 = 106 when each jump station is not counted twice;
  // with both jump stations at their cap of 5 it is 30 for jumps
  const maxed = C.roundXp({ jumps: { leap: 99, onefoot: 99 }, firstSteps: 99, sprints: 99, bounceSets: 9, stationsDone: 9, complete: true });
  assert.equal(maxed.jump, 2 * C.CAPS.jumpsPerStation * C.XP.jump);
  assert.equal(maxed.firstStep, C.CAPS.firstSteps * C.XP.firstStep);
  assert.equal(maxed.sprint, C.CAPS.sprints * C.XP.sprint);
  assert.equal(maxed.bounce, C.XP.bounceSet, "one bounce set per round");
  assert.equal(maxed.station, 5 * C.XP.station);
  assert.equal(maxed.combine, C.XP.combine, "the full Combine pays once");
  assert.equal(C.roundXp({}).total, 0);
  assert.equal(C.roundXp({ jumps: { leap: -4 }, stationsDone: 1 }).total, C.XP.station, "negative counts pay nothing");
  assert.equal(C.roundXp({ stationsDone: 2, complete: false }).combine, 0, "a stopped Combine does not pay the +30");
});

test("the level curve is the kit's: assert through xpToReach, never literals", () => {
  assert.equal(xpToReach(1, C.CURVE), 0);
  assert.equal(xpToReach(2, C.CURVE), xpForNextLevel(1, C.CURVE));
  for (let l = 2; l <= 12; l++) assert.ok(xpToReach(l, C.CURVE) > xpToReach(l - 1, C.CURVE), `level ${l} costs more than ${l - 1}`);
  // a first full Combine (81 XP in Simulate) lands on level 3; the maxed 106 lands on level 3 too
  const first = C.roundXp({ jumps: { leap: 1, onefoot: 2 }, firstSteps: 3, sprints: 1, bounceSets: 1, stationsDone: 5, complete: true }).total;
  assert.equal(levelFromXp(first, C.CURVE).level, 3);
  assert.ok(first >= xpToReach(3, C.CURVE) && first < xpToReach(4, C.CURVE));
  assert.equal(levelFromXp(xpToReach(3, C.CURVE) - 1, C.CURVE).level, 2);
  assert.equal(levelFromXp(xpToReach(3, C.CURVE), C.CURVE).level, 3);
  // the doc's figures, derived rather than hard-coded: each is within a point of the old hand-made formula's neighbours
  assert.ok(xpToReach(2, C.CURVE) <= 40 && xpToReach(2, C.CURVE) >= 25, "level 2 comes early");
  // titles
  assert.equal(titleFor(1, C.TITLES), "Walk-On");
  assert.equal(titleFor(3, C.TITLES), "Starter");
  assert.equal(titleFor(8, C.TITLES), "Hall of Flame");
  assert.equal(titleFor(20, C.TITLES), "Hall of Flame");
});

test("the visit: three warm-up jumps, a two-minute rest, two Combines per visit; Simulate has none of it", () => {
  const t0 = 1_000_000;
  const v = C.newVisit(t0, "v1");
  assert.equal(C.isWarmup(v), true);
  v.jumps = 2; assert.equal(C.isWarmup(v), true);
  v.jumps = 3; assert.equal(C.isWarmup(v), false);
  v.jumps = 0; v.warm = true; assert.equal(C.isWarmup(v), false, "I'm warm ends the warm-up");
  v.warm = false; assert.equal(C.isWarmup(v, true), false, "a simulated athlete has no body to warm up");

  assert.deepEqual(C.canStart(v, t0), { ok: true, reason: null, waitMs: 0 });
  v.combines = 1; v.lastEndAt = t0;
  assert.equal(C.canStart(v, t0 + 1).reason, "rest");
  assert.equal(C.restLeftMs(v, t0 + 30000), C.CAPS.restMs - 30000);
  assert.equal(C.canStart(v, t0 + C.CAPS.restMs).ok, true, "two minutes later the rematch opens");
  v.rested = true;
  assert.equal(C.canStart(v, t0 + 1).ok, true, "an explicit I'm rested tap ends the rest early");
  v.combines = 2; v.rested = false;
  assert.equal(C.canStart(v, t0 + 10 * C.CAPS.restMs).reason, "cap", "a visit is capped at two Combines, however long you wait");
  assert.equal(C.canStart(v, t0, true).ok, true, "Simulate is never capped or rested");
  assert.equal(C.restLeftMs(v, t0 + 1, true), 0);
});

test("a visit is a sitting kept on the device with an idle expiry; a Card is a PREVIOUS visit's only once it is hours old or from another day", () => {
  const t0 = Date.UTC(2026, 9, 13, 15);
  const v = C.newVisit(t0, "v1");
  assert.equal(C.visitExpired(v, t0), false);
  assert.equal(C.visitExpired(v, t0 + C.CAPS.visitGapMs), false, "exactly the gap is still the same sitting");
  assert.equal(C.visitExpired(v, t0 + C.CAPS.visitGapMs + 1), true);
  v.combines = 2; v.touchedAt = t0 + 3600000;
  assert.equal(C.visitExpired(v, t0 + 3600000 + C.CAPS.visitGapMs), false, "activity moves the expiry on");
  assert.equal(C.canStart(v, t0 + 26 * 3600000).reason, "cap", "a capped visit stays capped while it is the same sitting...");
  assert.equal(C.visitExpired(v, t0 + 26 * 3600000), true, "...and 26 hours later it is a new sitting, so the athlete is not locked out");
  assert.equal(C.visitExpired(null, t0), true);
  assert.ok(C.CAPS.visitGapMs >= 2 * 3600000, "a few hours at least");
  assert.equal(C.isPriorVisitCard(t0, t0 + 60000, true), false, "a Card from a minute ago is not 'last visit'");
  assert.equal(C.isPriorVisitCard(t0, t0 + C.CAPS.visitGapMs, true), true);
  assert.equal(C.isPriorVisitCard(t0, t0 + 60000, false), true, "a Card from another day counts");
});

test("ground truth: flat XP inside physical plausibility, capped per day, agreement never looked at", () => {
  assert.equal(C.plausibleJumpCm(5), true);
  assert.equal(C.plausibleJumpCm(120), true);
  assert.equal(C.plausibleJumpCm(4.9), false);
  assert.equal(C.plausibleJumpCm(120.1), false);
  assert.equal(C.plausibleGateS(0.5), true);
  assert.equal(C.plausibleGateS(4), true);
  assert.equal(C.plausibleGateS(0.49), false);
  assert.equal(C.plausibleGateS(4.01), false);
  assert.equal(C.plausibleTruth("jump", NaN), false);
  assert.equal(C.plausibleTruth("nope", 30), false);
  assert.equal(C.truthXp(0), C.XP.truth);
  assert.equal(C.truthXp(C.CAPS.truthPerDay - 1), 1);
  assert.equal(C.truthXp(C.CAPS.truthPerDay), 0);
});

test("Moon and Jupiter maths (a game, never scored)", () => {
  assert.ok(Math.abs(C.heightFactor(C.MOON_G) - 6.05) < 0.01);
  assert.ok(Math.abs(C.heightFactor(C.JUPITER_G) - 0.40) < 0.01);
  assert.equal(C.bigHeightText(C.moonCm(33.1), "metric"), "2.0 m");
  assert.equal(C.bigHeightText(C.moonCm(33.1), "imperial"), "6 ft 7 in");
  assert.equal(C.bigHeightText(C.jupiterCm(33.1), "metric"), "13 cm");
  assert.equal(C.bigHeightText(C.jupiterCm(33.1), "imperial"), "5.2 in");
  assert.equal(C.bigHeightText(NaN, "metric"), "");
  assert.equal(C.bigHeightText(C.moonCm(10), "imperial"), "2 ft 0 in");
  assert.ok(COPY.fun.moon("2.0 m").includes("not scored"));
});

test("board helpers", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(C.ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  assert.equal(C.cleanInitials("jeff"), "JEF");
  assert.equal(C.cleanInitials("a-b c"), "ABC");
  assert.equal(C.cleanInitials("12"), "");
  assert.equal(C.cleanInitials(null), "");
  assert.equal(C.isBlockedInitials("fuk"), true);
  assert.equal(C.isBlockedInitials("JEF"), false);
  assert.ok(C.BLOCKED_INITIALS.every((x) => /^[A-Z]{3}$/.test(x)));
});

test("personal-best metrics honour the display system through the format function", () => {
  const metric = C.makePbMetrics({ height: (v) => `${v.toFixed(1)} cm`, ms: (v) => `${v} ms`, seconds: (v) => `${v.toFixed(2)} s` });
  const imperial = C.makePbMetrics({ height: (v) => `${(v / 2.54).toFixed(1)} in`, ms: (v) => `${v} ms`, seconds: (v) => `${v.toFixed(2)} s` });
  assert.equal(metric.find((m) => m.id === "jumpCm").format(33.1), "33.1 cm");
  assert.equal(imperial.find((m) => m.id === "jumpCm").format(33.1), "13.0 in");
  assert.equal(metric.find((m) => m.id === "firstStepMs").better, "lower");
  assert.deepEqual(metric.map((m) => m.id), ["jumpCm", "singleL", "singleR", "firstStepMs", "sprint3", "sprint5", "sprint7", "rsi"]);
});

test("every string the layer writes passes the kit's copy lint, and the wellness wording rules", () => {
  const guard = createGuardrails("playful");
  const strings = allStrings();
  assert.ok(strings.length > 120, `a real copy table (${strings.length} strings)`);
  for (const s of strings) assert.deepEqual(guard.lintCopy(s), [], `pressure language in "${s}"`);
  const word = (...p) => p.join("");
  const banned = new RegExp(`\\b(rehab\\w*|heal(s|ed|ing)?|therap\\w*|cure[sd]?|treat(s|ed|ing|ment)?|diagnos\\w*|${word("gh", "aps")})\\b|injury risk|prevents? injur|clinically|medical device|fall risk`, "i");
  for (const s of strings) assert.doesNotMatch(s, banned, `wellness wording: "${s}"`);
  // no raw measurement numbers in copy: lengths and speeds come from BWUnits at draw time
  for (const s of strings) assert.doesNotMatch(s, /\d+(\.\d+)?\s?(cm|in|m\/s|mph|ft)\b/i, `a hard-coded unit in "${s}"`);
});

test("the XP ledger really pays the round's total in one award (ties the table to the kit)", () => {
  const store = createStore({ app: "ae-test", storage: createMemoryStorage() });
  const xp = createXp({ store, curve: C.CURVE, titles: C.TITLES });
  const total = C.roundXp({ jumps: { leap: 1, onefoot: 2 }, firstSteps: 3, sprints: 1, bounceSets: 1, stationsDone: 5, complete: true }).total;
  const res = xp.award({ amount: total, source: "session" });
  assert.equal(res.gained, total);
  assert.equal(res.level, 3);
  assert.equal(res.title, "Starter");
  assert.equal(res.levelUp, true);
});

test("the ghost bar: a PB always reaches past the ghost mark, for a height and for a time", () => {
  const hi = C.meterPcts("higher", 35, 33);
  assert.ok(hi.fill > hi.ghost && hi.fill < 100, "the new bar is longer than the ghost mark, with headroom");
  const lo = C.meterPcts("lower", 1.8, 2.0);          // a faster time is a longer bar
  assert.ok(lo.fill > lo.ghost);
  const behind = C.meterPcts("lower", 2.2, 2.0);
  assert.ok(behind.fill < behind.ghost);
  assert.deepEqual(C.meterPcts("higher", 30, null), { fill: 100, ghost: null }, "a first mark has no ghost");
  assert.deepEqual(C.meterPcts("higher", 0, 30), { fill: 0, ghost: null });
  assert.equal(C.meterPcts("higher", 33, 33).fill, C.meterPcts("higher", 33, 33).ghost);
});
