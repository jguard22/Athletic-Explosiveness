// The Combine layer's controller: listens to the page's "bwfun" events, runs the guided Combine, draws the stage, the board, the
// level strip and the settings, and hands every reward to fun.js (which holds them behind the quiet gate).
//
// Boundaries (a test greps for them): app.js and units.js never import this; this file never changes how anything is measured.
// It reads what happened (a height, a time) and what the page says is running (window.BWAE.measuring()).
import { COPY } from "./copy.js";
import * as C from "./config.js";
import { createCombine, storyPicks } from "./combine.js";
import { createBoard } from "./board.js";
import { createStats } from "./stats.js";
import { createFun, setMotion } from "./fun.js";
import { createUi } from "./ui.js";

const U = window.BWUnits, AE = window.BWAE;
const root = document.documentElement;
if (!U || !AE) throw new Error("the Combine layer needs units.js and app.js first");

// The kit's stylesheet is added here, not imported by fun.css, so ?fun=0 never fetches a kit file. Wait for it so nothing draws unstyled.
{
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = new URL("../vendor/fun-kit/ui/fun-kit.css", import.meta.url).href;
  document.head.append(link);
  await new Promise((done) => { link.onload = link.onerror = done; setTimeout(done, 3000); });
}

// ---------------------------------------------------------------- saved choices (all optional; the page works with storage blocked)
const prefs = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: the choice lasts until reload */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nothing to remove */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* memory only */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* none */ } },
};
const VISIT_KEY = "bw-ae-visit";          // the visit is kept on the device (not in a tab), with an idle expiry
const STAFF_KEY = "bw-ae-staff";          // this tab was opened with ?staff=1: it shows the staff controls on a booth device
const hasBle = (() => { try { return !!navigator.bluetooth; } catch { return false; } })();   // Web Bluetooth: Chrome and Edge, not iOS Safari or Firefox
const playFlags = () => { try { return JSON.parse(prefs.get("bw-ae-play", "{}")) || {}; } catch { return {}; } };

// ---------------------------------------------------------------- state
const ui = createUi({ U });
const stats = createStats();
const board = createBoard();
const els = {
  stage: document.getElementById("ae-stage-body"), board: document.getElementById("ae-board-body"), level: document.getElementById("ae-level-body"),
  settings: document.getElementById("ae-settings-body"), live: document.getElementById("ae-live"), labToggle: document.getElementById("ae-lab-toggle"),
};
let mode = root.getAttribute("data-fun");
let booth = root.hasAttribute("data-booth");
let real = null, simCtx = null, ctx = null;       // ctx: { fun, sim, visit, combine }
let view = "idle", run = null, cardHandle = null;  // idle | run | card
/** The screen the stage is on, also written on <html> so the page can hide what is only in the way during a round (the section links). */
function setView(next) { view = next; root.setAttribute("data-ae-view", next); }
let armTimer = null, goWatch = null, fwTicker = null, restTimer = null, stationAt = 0;
let lastSum = null, lastRes = null, lastJumpCm = null, meId = null, lastFirstWinMs = null;
const pending = { armedFor: null };

const fmt = {
  height: (cm) => `${U.fmt("height", cm)} ${U.unit("height")}`,
  ms: (ms) => `${Math.round(ms)} ms`,
  seconds: (s) => `${s.toFixed(2)} s`,
};
const say = (text) => { if (!els.live) return; els.live.textContent = ""; setTimeout(() => { els.live.textContent = text; }, 30); };
const spoken = (cm) => `${U.fmt("height", cm)} ${U.get() === "imperial" ? COPY.words.inches : COPY.words.centimeters}`;

// ---------------------------------------------------------------- the person's visit (one sitting), kept on this device
// Not per tab: a second tab shares the same rest, the same two-Combine cap and the same warm-up count, so opening another tab is not a
// way around them. Three idle hours end a visit, so a returning athlete is never locked out by an old cap. Opening the page writes nothing:
// the visit is saved when something real happens (a jump, a finished Combine, a tap on I'm warm / I'm rested).
function readVisit() { try { const v = JSON.parse(prefs.get(VISIT_KEY)); return v && typeof v.id === "string" ? v : null; } catch { return null; } }
function loadVisit(sim) {
  if (sim) return C.newVisit();
  const v = readVisit();
  return v && !C.visitExpired(v, Date.now()) ? { ...C.newVisit(), ...v } : C.newVisit();
}
function saveVisit(c) {
  if (c.sim) return;
  c.visit.touchedAt = Date.now();
  prefs.set(VISIT_KEY, JSON.stringify(c.visit));
}
/** Take on a newer visit another tab saved, or start a fresh one when this one has gone stale. Never while a round is running. */
function syncVisit() {
  if (!real || view === "run") return false;
  const now = Date.now(), cur = real.visit, stored = readVisit();
  const live = stored && !C.visitExpired(stored, now) ? stored : null;
  let next = cur;
  if (live && (live.id !== cur.id || (live.touchedAt ?? 0) > (cur.touchedAt ?? 0))) next = { ...C.newVisit(), ...live };
  else if (C.visitExpired(cur, now)) next = C.newVisit();
  if (next === cur) return false;
  real.visit = next;
  return true;
}
function refreshVisit() {
  if (view === "run" || !syncVisit()) return;
  if (view === "idle") toIdle(); else if (view === "card") watchRest();
}
// staff controls on a booth device: opened once with ?staff=1, remembered for this tab only
let staff = false;
try {
  const u = new URL(location.href);
  if (u.searchParams.get("staff") === "1") { session.set(STAFF_KEY, "1"); u.searchParams.delete("staff"); history.replaceState(null, "", u); }
  staff = session.get(STAFF_KEY) === "1";
} catch { /* no URL API: no staff controls on a booth device */ }

// ---------------------------------------------------------------- the two kit instances (real, and the demo twin on memory storage)
// A kit on a fresh namespace writes its schema marker the moment it is created. So a visitor who has no saved profile gets a "preview"
// (memory storage: it only draws the empty level strip) and the real kit is created when something real happens: a Combine on a
// body, a typed ground-truth value. Opening the page, or simulating, never writes the kit's profile (simulating only adds local event counts, flagged sim).
function hasStoredProfile() { try { return Object.keys(localStorage).some((k) => k.startsWith(`fk:${C.APP_ID}:`)); } catch { return false; } }
function makeCtx(sim, { preview = false } = {}) {
  const fun = createFun({
    sim, memory: (booth && !sim) || preview, storage: sim ? undefined : safeLocal(), measuring: () => AE.measuring(), fmt,
  });
  fun.syncOutputs({ sound: prefs.get("bw-ae-sound", "on") !== "off" });
  fun.sound.armOnGesture();
  return { fun, sim, preview, visit: loadVisit(sim), combine: null };
}
function ensureReal() {
  if (!real.preview) return;
  const visit = real.visit;
  real.fun.dispose();
  real = makeCtx(false);
  real.visit = visit;
  if (!ctx.sim) ctx = real;
}
function safeLocal() { try { return localStorage; } catch { return undefined; } }
const newCombine = () => createCombine({
  now: Date.now, sim: ctx.sim, visit: ctx.visit, sprintN: () => AE.sprintSteps(), best: ctx.fun.bests, history: ctx.fun.history.firstSteps, onVisit: () => saveVisit(ctx),
});

// ---------------------------------------------------------------- stage: idle
function can() { return C.canStart(ctx.visit, Date.now(), ctx.sim); }
function lastCardInfo() {
  const c = ctx.fun.cards.all().pop();
  return c && c.flames ? { flames: c.flames, name: C.HEAT.names[c.flames - 1] } : null;
}
/** Your bests so far, in storage units: what the kit's personal bests hold (the demo twin's, while simulating). */
function bestsNow() {
  const b = ctx.fun.bests, n = AE.sprintSteps();
  return { jump: b.jump(), singleL: b.single("L"), singleR: b.single("R"), firstStep: b.firstStep(), sprint: b.sprint(n), sprintN: n, rsi: b.rsi() };
}
const viewNow = () => C.idleView(bestsNow());
let shownConnected = null;
function drawIdle() {
  shownConnected = AE.hasDevice();
  const top = board.top()[0] ?? null;
  ui.renderIdle(els.stage, {
    sim: ctx.sim, booth, ble: hasBle, connected: shownConnected, safety: prefs.get("bw-ae-safety") !== "1", last: ctx.sim ? null : lastCardInfo(), can: can(),
    view: viewNow(), top: top ? { who: top.who, cm: top.cm } : null, sprintN: AE.sprintSteps(), act: stageActs,
  });
  watchRest();
}
function toIdle() {
  clearRoundTimers();
  syncVisit();
  setView("idle"); run = null; cardHandle = null;
  drawIdle();
}
// insoles may be connected (or drop out) while the first screen is up: say so, and put the right button first
setInterval(() => { if (view === "idle" && mode === "combine" && AE.hasDevice() !== shownConnected) drawIdle(); }, 1000);
const stageActs = {
  start: () => startCombine(),
  sim: () => document.getElementById("btn-sim").click(),   // the page's own Simulate switch; it reports back with a "sim" event
  connect: () => document.getElementById("btn-insoles").click(),
  ackSafety: () => { prefs.set("bw-ae-safety", "1"); if (view === "idle") toIdle(); },
  rested: () => tapRested(),
  skip: () => skipStation(),
  stop: () => stopCombine(),
  lab: () => openLab(C.STATIONS.find((s) => s.id === ctx.combine?.stationId)?.lab),
  rematch: () => startCombine(),
  nextVisitor: () => nextVisitor(),
  addToBoard: (raw) => addToBoard(raw),
  pulse: (answer) => recordPulse(answer),
};

// ---------------------------------------------------------------- the Combine
function clearRoundTimers() {
  clearTimeout(armTimer); clearTimeout(goWatch); clearInterval(fwTicker);
  armTimer = goWatch = fwTicker = null;
}
function startCombine() {
  if (mode !== "combine" || view === "run") return;
  if (!ctx.sim) { syncVisit(); ensureReal(); }
  ctx.fun.cancel();
  ctx.combine = newCombine();
  const r = ctx.combine.start();
  if (!r.ok) { toIdle(); return; }
  ctx.fun.unlockAudio();
  ctx.fun.beginFirstWin();
  stats.record("combine_start"); if (r.n >= 2) stats.record("rematch");
  restTimerStop();
  setView("run");
  run = ui.renderRun(els.stage, { act: stageActs, sim: ctx.sim });
  if (ctx.sim) { if (r.n >= 2) AE.simReplay(); AE.simHold(false); }
  enterStation();
  run.focus();
  startFirstWinTicker();
  say(COPY.stage.stationOf(1, C.STATIONS.length));
}

/** `dwell`: a result has just landed, so it stays on screen a few seconds before the next station's "to beat" replaces it. */
function enterStation({ dwell = false } = {}) {
  const c = ctx.combine, id = c.stationId;
  if (!id) return;
  const sum = c.summary();
  run.setRail(sum?.status ?? {}, id, C.railValues(sum));
  run.setStation(id, { sprintN: AE.sprintSteps(), target: viewNow().stations[id], dwellMs: dwell ? C.CAPS.resultDwellMs : 0 });
  ctx.fun.tick();
  const sim = ctx.sim;
  stationAt = Date.now();
  if (ctx.sim) AE.simHold(!["leap", "onefoot", "bounce"].includes(id));
  // the line under the prompt
  if (id === "leap" || id === "onefoot") {
    if (!sim && !AE.hasDevice()) { run.setStatus(hasBle ? COPY.stage.waitDevice : COPY.stage.noBle); if (id === "leap") run.setDevicePrompt(true, devicePrompt()); }
    else run.setStatus(COPY.stage.standStill);
  } else if (id === "bounce") run.setStatus(COPY.stage.hopsStart);
  else run.setStatus(COPY.stage.getSet);
  // the warm-up hint stays on both jump stations for as long as warm-up jumps remain, so "I'm warm" is there for the one-foot jumps too
  if ((id === "leap" || id === "onefoot") && C.isWarmup(ctx.visit, sim)) run.setWarm(true, tapWarm);
  refreshSub();
  run.setSkipLabel(COPY.stage.skip);
  if (id === "firststep" || id === "sprint") scheduleArm(sim ? 700 : 1600);
}

/** the two ways forward when there is nothing to measure with: Connect only where the browser can */
const devicePrompt = () => ({ connect: hasBle ? () => document.getElementById("btn-insoles").click() : null, sim: () => document.getElementById("btn-sim").click() });

function refreshSub() {
  const sum = ctx.combine.summary(); if (!sum || !run) return;
  const id = ctx.combine.stationId;
  if (id === "onefoot") run.setSub([{ label: COPY.words.left, on: !!sum.onefoot.L }, { label: COPY.words.right, on: !!sum.onefoot.R }]);
  else if (id === "firststep") run.setSub([0, 1, 2].map((i) => ({ label: String(i + 1), on: i < sum.firststep.trials.length })));
  else if (id === "bounce") run.setSub([0, 1, 2].map((i) => ({ label: String(i + 1), on: i < sum.bounce.hops })));
  else run.setSub([]);
}

/**
 * The drills arm themselves one beat after the station opens (and again after each trial), unless the person skipped away.
 * `keepStatus`: a line like "Not enough steps. Let's go again." stays on screen until the drill is armed again.
 */
function scheduleArm(delay, { keepStatus = false } = {}) {
  clearTimeout(armTimer);
  const id = ctx.combine?.stationId;
  if (id !== "firststep" && id !== "sprint") return;
  if (!keepStatus) run.setStatus(COPY.stage.getSet);
  armTimer = setTimeout(() => {
    if (!ctx.combine || ctx.combine.stationId !== id || view !== "run") return;
    if (AE.measuring()) { scheduleArm(500); return; }
    // Simulate has no reaction to protect, so its delay is short; a real GO keeps the page's random 1.5 to 3.5 s
    const opts = ctx.sim ? { delayMs: 600 + Math.random() * 300 } : undefined;
    if (id === "firststep") AE.armGo(opts); else AE.armSprint(opts);
    run.setStatus(COPY.stage.holdStill);
  }, delay);
}

function onGo(kind) {
  if (view !== "run") return;
  run.setGo(true, COPY.stage.go);
  run.ringGo();
  say(COPY.stage.go);
  clearTimeout(goWatch);
  // a real person who never steps would leave the window open: look again after eight seconds
  goWatch = setTimeout(() => {
    if (view !== "run" || !AE.measuring()) return;
    AE.cancelDrills(); run.setGo(false); run.setStation(ctx.combine.stationId, { sprintN: AE.sprintSteps(), target: viewNow().stations[ctx.combine.stationId] });
    run.setStatus(COPY.stage.noResponse); refreshSub(); scheduleArm(1200, { keepStatus: true });
  }, 8000);
}

function onFeed(d) {
  if (view !== "run") {
    if (d.type === "jump" && mode === "combine" && !ctx.sim) { ctx.visit.jumps++; saveVisit(ctx); }
    return;
  }
  clearTimeout(goWatch);
  const c = ctx.combine;
  const r = c.feed(d.type === "rsi" ? { type: "rsi", rsi: d.rsi, hops: d.hops } : d);
  if (!r.accepted) {
    if (r.reason === "wrong-foot") run.setHint(r.hint === "leap" ? COPY.stage.wrongFootLeap : COPY.stage.wrongFootOne);
    // a sprint cut short by the timeout is not the station's result: say so and go again
    else if (r.reason === "short-sprint") { run.setGo(false); run.setStatus(COPY.stage.notEnough); scheduleArm(1200, { keepStatus: true }); }
    return;
  }
  ctx.fun.edge();   // an effort just ended: rewards wait 300 ms more
  run.setHint("");
  if (r.hop) return;
  const rep = r.rep;
  if (d.type === "firststep" || d.type === "sprint") run.setGo(false);
  // the first leap ever is the first win. While it is still a warm-up it is celebrated as a first, not as a best (the Warm-up tag stays)
  const firstLeap = rep.kind === "leap" && rep.warmup && !ctx.fun.firstWin.isDone();
  const vm = repView(rep, firstLeap);
  const shown = run.showRep(vm);
  if (rep.kind === "leap" || rep.kind === "onefoot") { lastJumpCm = rep.cm; refreshFun(); barsGhost(ctx.fun.bests.jump()); }
  say(announcement(rep));
  // the first win: the first stamp, timed from the press
  if (rep.kind === "leap") {
    const before = ctx.fun.firstWin.isDone();
    const st = ctx.fun.feedFirstWin("leap");
    if (!before && st.done) onFirstWin(st);
  }
  const pb = rep.judgment.id === "pb" && !rep.warmup;
  ctx.fun.rep({ kind: rep.kind, judgment: rep.warmup ? (firstLeap ? C.JUDGMENTS.firstleap : C.JUDGMENTS.warmup) : rep.judgment, cm: rep.cm, visual: pb ? shown.markPb : undefined });
  if (rep.kind === "bounce" && !r.stationDone) run.setStatus(COPY.stage.hops(rep.hops));
  if (r.stationDone) {
    ctx.fun.stamp(); stats.record("station_done");
    say(COPY.stage.live.stamp(COPY.stations[r.stationDone].name));
  }
  if (r.finished) { finishRound(); return; }
  if (r.stationDone) { clearTimeout(armTimer); enterStation({ dwell: true }); return; }
  refreshSub();
  if (rep.kind === "firststep") scheduleArm(ctx.sim ? 500 : 1300);
}

/** The lab's jump bars get a dashed line at your best (the ghost), so the original chart shows what to beat too. */
function barsGhost(best) {
  const bars = document.getElementById("jump-bars");
  if (!bars) return;
  if (best == null) { bars.removeAttribute("data-ghost"); return; }
  const vals = [...bars.querySelectorAll("[data-base]")].map((e) => Number(e.dataset.base)).filter(Number.isFinite);
  const max = Math.max(...vals, 1);
  bars.style.setProperty("--ae-ghost-y", `${Math.min(100, (best / max) * 78)}%`);   // the page draws a bar at (cm / max) * 78 percent
  bars.dataset.ghost = "on"; bars.dataset.ghostLabel = COPY.near.best;
}

function repView(rep, firstLeap = false) {
  switch (rep.kind) {
    case "leap": return { kind: "leap", label: COPY.stations.leap.name, value: rep.cm, valueKind: "height", judgment: firstLeap ? C.JUDGMENTS.firstleap : rep.judgment, ghost: rep.prior, better: "higher", warmup: rep.warmup };
    case "onefoot": return { kind: "onefoot", label: rep.side === "L" ? COPY.words.leftFoot : COPY.words.rightFoot, value: rep.cm, valueKind: "height", judgment: rep.judgment, ghost: rep.prior, better: "higher", warmup: rep.warmup };
    case "firststep": return { kind: "firststep", label: `${COPY.stations.firststep.name} ${COPY.words.ofTotal(rep.n, rep.need)}`, value: rep.stepMs, valueKind: "ms", judgment: rep.judgment, ghost: ctx.fun.bests.firstStep(), better: "lower" };
    case "sprint": return { kind: "sprint", label: `${COPY.stations.sprint.name}, ${COPY.words.steps(rep.n)}`, value: rep.s, valueKind: "s", judgment: rep.judgment, ghost: rep.prior, better: "lower" };
    default: return { kind: "bounce", label: COPY.stations.bounce.name, value: rep.rsi, valueKind: "rsi", judgment: rep.judgment, ghost: rep.prior, better: "higher" };
  }
}
function announcement(rep) {
  const j = rep.judgment.word;
  switch (rep.kind) {
    case "leap": return `${COPY.stage.live.leap(spoken(rep.cm))} ${j}.`;
    case "onefoot": return `${COPY.stage.live.onefoot(rep.side === "L" ? COPY.words.left : COPY.words.right, spoken(rep.cm))} ${j}.`;
    case "firststep": return `${COPY.stage.live.firststep(rep.stepMs)} ${j}.`;
    case "sprint": return `${COPY.stage.live.sprint(rep.n, rep.s.toFixed(2))} ${j}.`;
    default: return COPY.stage.live.bounce;
  }
}

function tapWarm() {
  ctx.visit.warm = true; saveVisit(ctx); stats.record("warm_tap");
  run?.setWarm(false);
}
function skipStation() {
  if (view !== "run") return;
  if (Date.now() - stationAt < C.CAPS.skipGuardMs) return;   // a double tap on Skip skips one station, not two
  clearTimeout(armTimer); clearTimeout(goWatch);
  AE.cancelDrills(); run.setGo(false);
  const r = ctx.combine.skip();
  if (!r) return;
  stats.record("station_skip");
  if (r.finished) finishRound(); else enterStation();
}
function stopCombine({ silent = false } = {}) {
  if (view !== "run") return;
  clearRoundTimers(); AE.cancelDrills();
  ctx.combine.stop();
  finishRound({ silent });
}

function onFirstWin(st) {
  lastFirstWinMs = st.timeToWinMs;
  stats.firstWin(st.timeToWinMs, { sim: ctx.sim });
  clearInterval(fwTicker); fwTicker = null;
}
function startFirstWinTicker() {
  clearInterval(fwTicker);
  if (ctx.fun.firstWin.isDone()) return;
  fwTicker = setInterval(() => {
    if (view !== "run" || ctx.combine.stationId !== "leap") return;
    const f = ctx.fun.firstWin.tick();
    if (f?.type === "nudge") run.setHint(COPY.stage.nudge);
    if (f?.type === "assist" && !ctx.sim) run.setDevicePrompt(true, devicePrompt());
  }, 1000);
}

// ---------------------------------------------------------------- finishing: the Card
function finishRound({ silent = false } = {}) {
  clearRoundTimers(); AE.cancelDrills();
  if (ctx.sim) AE.simHold(true);
  const sum = ctx.combine.summary();
  lastSum = sum;
  const res = ctx.fun.finishRound(sum, { visitId: ctx.visit.id });
  lastRes = res;
  if (!res) { stats.record("combine_stop"); toIdle(); say(COPY.card.noStations); return; }
  if (sum.early) stats.record("combine_stop"); else stats.record("combine_done");
  setView("card");
  const level = res.outcome.xp;
  const canBoard = !ctx.sim && sum.marks.leap != null;
  const pulseDue = !ctx.visit.pulsed;
  cardHandle = ui.renderCard(els.stage, {
    sum, heat: res.heat, story: storyPicks(sum), xp: res.outcome.xp, level: { level: level.level, title: level.title },
    sim: ctx.sim, booth: booth && !ctx.sim, canBoard, pulseDue, prevVisit: !!res.prev, act: stageActs,
  });
  cardHandle.el.scrollIntoView?.({ block: "start", behavior: document.documentElement.dataset.motion === "reduce" ? "auto" : "smooth" });
  cardHandle.focus();
  watchRest();
  renderLevel();
  say(COPY.stage.live.card);
  // Simulate and booth mode keep no profile, so nothing about levels and badges is celebrated there
  if (!silent) ctx.fun.celebrate(res.outcome, { progress: !(ctx.sim || booth) });
}

// ---------------------------------------------------------------- the rest before a rematch
function restTimerStop() { clearInterval(restTimer); restTimer = null; }
function watchRest() {
  restTimerStop();
  const tick = () => {
    // one source for what the screen says: canStart. The cap outranks the rest, so a capped visit never counts down to a rematch
    const can = C.canStart(ctx.visit, Date.now(), ctx.sim);
    const left = can.reason === "rest" ? can.waitMs : 0;
    if (cardHandle) cardHandle.setRest(left, { cap: can.reason === "cap" });
    else if (view === "idle") {
      const line = document.getElementById("ae-rest-line");
      if (can.reason === "rest" && line) line.textContent = `${COPY.card.restLine} ${COPY.card.rematchIn(ui.mmss(left))}`;
      else if (can.reason === "cap" && line) line.textContent = COPY.card.cap;
      else if (can.ok && line) toIdle();
    }
    if (left <= 0) restTimerStop();
  };
  tick();
  if (C.canStart(ctx.visit, Date.now(), ctx.sim).reason === "rest") restTimer = setInterval(tick, 1000);
}
function tapRested() {
  ctx.visit.rested = true; ctx.visit.restedTaps++; saveVisit(ctx); stats.record("rested_tap");
  watchRest(); if (view === "idle") toIdle();
}

function nextVisitor() {
  stats.record("next_visitor");
  ctx.fun.cancel();
  ctx.visit = C.newVisit();
  saveVisit(ctx);
  if (booth && !ctx.sim) { ctx.fun.dispose(); const fresh = makeCtx(false); fresh.visit = ctx.visit; real = ctx = fresh; }
  meId = null; lastSum = null;
  toIdle(); renderBoard(); renderLevel();
  els.stage.scrollIntoView?.({ block: "start" });
}

// ---------------------------------------------------------------- board
function renderBoard() {
  const entries = board.top();
  const me = meId ? board.rankOf(meId) : null;
  ui.renderBoard(els.board, { entries, meId, rankText: me?.text ?? null });
}
function addToBoard(raw) {
  if (!lastSum || view !== "card") return;
  const r = board.add({ who: raw, cm: lastSum.marks.leap, sim: ctx.sim, warmup: lastSum.leap?.warmup });
  if (!r.ok) {
    cardHandle?.boardResult(r.reason === "initials" ? COPY.board.initials : r.reason === "blocked" ? COPY.board.blocked : r.reason === "sim" ? COPY.board.simBlocked : COPY.board.warmBlocked);
    return;
  }
  meId = r.entry.id;
  stats.record("board_add");
  cardHandle?.boardResult(r.text ? COPY.board.rank(r.text.nth, r.text.total) : COPY.board.added);
  renderBoard();
  say(COPY.board.added);
}

function recordPulse(answer) {
  stats.pulse(answer, { firstWinMs: lastFirstWinMs ?? ctx.fun.firstWin.state().timeToWinMs, sim: ctx.sim });
  ctx.visit.pulsed = true; saveVisit(ctx);
  cardHandle?.thanks();
}

// ---------------------------------------------------------------- level, settings
function renderLevel() { ui.renderLevel(els.level, { kit: ctx.fun.kit, sim: ctx.sim, booth }); }

function renderSettings() {
  const play = playFlags();
  ui.renderSettings(els.settings, {
    sound: prefs.get("bw-ae-sound", "on") !== "off", motion: prefs.get("bw-ae-motion", "auto"), theme: prefs.get("bw-ae-theme", "auto"),
    booth, staff: !booth || staff, moon: !!play.moon, jupiter: !!play.jupiter,
    act: {
      sound: (on) => { prefs.set("bw-ae-sound", on ? "on" : "off"); for (const c of [real, simCtx]) c?.fun.syncOutputs({ sound: on }); renderSettings(); },
      motion: (id) => { prefs.set("bw-ae-motion", id); window.dispatchEvent(new Event("bwprefs")); setMotion(id); renderSettings(); },
      theme: (id) => { prefs.set("bw-ae-theme", id); window.dispatchEvent(new Event("bwprefs")); renderSettings(); },
      booth: (on) => setBooth(on),
      play: (which, on) => { const f = playFlags(); f[which] = on; prefs.set("bw-ae-play", JSON.stringify(f)); refreshFun(); },
      stats: downloadStats,
      clearBoard: () => { board.clear(); meId = null; renderBoard(); },
      forget: forgetAll,
    },
  });
}

function setBooth(on) {
  booth = !!on;
  prefs.set("bw-ae-booth", on ? "1" : "0");
  root.toggleAttribute("data-booth", booth);
  try { const u = new URL(location.href); if (u.searchParams.has("booth")) { u.searchParams.delete("booth"); history.replaceState(null, "", u); } } catch { /* no history */ }
  if (view === "run") stopCombine({ silent: true });
  const visit = real.visit;
  real.fun.dispose();
  real = makeCtx(false, { preview: !booth && !hasStoredProfile() }); real.visit = visit;
  if (!ctx.sim) ctx = real;
  toIdle(); renderLevel(); renderSettings();
}

function downloadStats() {
  const blob = new Blob([stats.csv()], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "ae-fun-stats.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function forgetAll() {
  if (view === "run") stopCombine({ silent: true });
  real.fun.forget();        // kit.reset(): every key of fk:ae-demo:* is removed
  board.clear(); stats.clear(); prefs.del("bw-ae-safety"); prefs.del(VISIT_KEY);
  meId = null; lastSum = null; lastRes = null; lastFirstWinMs = null;
  real.visit = C.newVisit();
  if (!ctx.sim) ctx = real;
  toIdle(); renderBoard(); renderLevel(); renderSettings();
  const note = document.getElementById("ae-forgot"); if (note) note.textContent = COPY.settings.forgotten;
  say(COPY.settings.forgotten);
}

// ---------------------------------------------------------------- lab details, mode
function openLab(cardId) {
  root.classList.add("ae-lab-open");
  syncLabToggle();
  const el = (cardId && document.getElementById(cardId)) || document.getElementById("lab-grid");
  el?.scrollIntoView?.({ block: "start" });
}
function syncLabToggle() {
  const open = root.classList.contains("ae-lab-open");
  els.labToggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (els.labToggle) els.labToggle.textContent = open ? COPY.lab.close : COPY.lab.open;
}
function setMode(next) {
  if (next === mode || (next !== "combine" && next !== "lab")) return;
  if (view === "run") stopCombine({ silent: true });
  ctx.fun.cancel();
  mode = next; root.setAttribute("data-fun", next);
  prefs.set("bw-ae-mode", next);
  stats.record("mode_switch");
  ui.syncMode(next);
  placeTools();
  if (next === "combine") { if (view === "idle") toIdle(); renderBoard(); renderLevel(); }   // a Card on screen stays where it was
}

// ---------------------------------------------------------------- the page tells us things
function onSim(on) {
  if (view === "run") { clearRoundTimers(); AE.cancelDrills(); ctx.combine.stop(); setView("idle"); }
  ctx.fun.cancel();
  if (on) {
    simCtx?.fun.dispose();
    simCtx = makeCtx(true);
    ctx = simCtx;
    stats.record("sim_start");
    simCtx.fun.unlockAudio();   // this runs inside the click that pressed Simulate, a user gesture
  } else {
    simCtx?.fun.dispose(); simCtx = null;
    ctx = real;
  }
  if (mode !== "combine") return;
  renderLevel();
  if (on) startCombine(); else toIdle();
}

window.addEventListener("bwfun", (e) => {
  const d = e.detail;
  switch (d.type) {
    case "sim": onSim(d.on); break;
    case "cal.start": if (view === "run" && !ctx.sim) run.setStatus(COPY.stage.waitCal); break;
    case "cal.done": if (view === "run" && !ctx.sim && ctx.combine.stationId === "leap") run.setStatus(COPY.stage.standStill, { wait: false }); break;
    case "go": onGo(d.kind); break;
    case "jump": case "firststep": case "sprint": case "rsi": onFeed(d); break;
    case "sprint.fail": if (view === "run" && ctx.combine.stationId === "sprint") { clearTimeout(goWatch); run.setGo(false); run.setStatus(COPY.stage.notEnough); scheduleArm(1200, { keepStatus: true }); } break;
    case "truth": {
      if (!ctx.sim) ensureReal();
      truthFeedback(d, ctx.fun.truth({ kind: d.kind, n: d.n, device: d.device, visitId: ctx.visit.id }));
      renderLevel();
      break;
    }
    default: break;
  }
});

/** A typed device height or gate time answers back right where it was typed: what it paid, or why not. Plain text, never a reward effect. */
function truthFeedback(d, r) {
  const input = document.querySelector(d.kind === "jump" ? `#jump-table input[data-rep="${d.n}"]` : `#sp-table input[data-sprint="${d.n}"]`);
  const cell = input?.closest("td");
  const T = COPY.truth;
  const text = d.device == null ? (r.revoked ? T.clearedXp : T.cleared)
    : r.ok ? (r.gained > 0 ? T.paid(r.gained) : T.same)
    : r.reason === "day-cap" ? T.dayCap : T.implausible;
  if (cell) {
    let note = cell.querySelector(".ae-truth-note");
    if (!note) { note = document.createElement("span"); note.className = "ae-truth-note"; note.setAttribute("role", "status"); cell.append(note); }
    note.textContent = text;
  }
  say(text);
}

// Combine keeps the header short: the tools (wrist, calibrate, export) live under "Lab details" there, and go back to the header in Lab
// mode. The same elements move, so the page's own listeners keep working and there are no duplicates.
const controls = document.querySelector("header .controls");
const controlOrder = controls ? [...controls.children] : [];
function placeTools() {
  const tools = document.getElementById("ae-tools");
  if (!controls || !tools) return;
  if (mode === "combine") tools.append(...["btn-wrist", "btn-cal", "btn-export"].map((id) => document.getElementById(id)).filter(Boolean));
  else controls.append(...controlOrder);
}

// header: Combine / Lab switch; nav; lab disclosure; easter eggs
/** The header switch leaves the Combine page. Mid-round that would end the round (and use up one of the visit's two), so it asks first. */
let leaveTimer = null;
function requestMode(next) {
  if (next === mode) return;
  if (view === "run" && mode === "combine" && !leaveTimer) {
    run.setHint(COPY.stage.leaveAsk); say(COPY.stage.leaveAsk);
    leaveTimer = setTimeout(() => { leaveTimer = null; if (view === "run") run.setHint(""); }, 5000);
    return;
  }
  clearTimeout(leaveTimer); leaveTimer = null;
  setMode(next);
}
document.querySelectorAll("#mode-seg button").forEach((b) => b.addEventListener("click", () => requestMode(b.dataset.mode)));
// Space and S are the lab's hotkeys for arming a drill. The Combine arms its own drills, so a stray key must not arm one behind it:
// off during a round, and off in Combine mode while the lab dashboard is hidden. Lab mode, and Lab details when open between rounds, keep them.
window.addEventListener("keydown", (e) => {
  if (mode !== "combine" || (e.code !== "Space" && e.code !== "KeyS") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
  if (view === "run" || !root.classList.contains("ae-lab-open")) e.stopImmediatePropagation();
}, true);
els.labToggle?.addEventListener("click", () => { root.classList.toggle("ae-lab-open"); syncLabToggle(); });
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || mode !== "combine") return;
  if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
  const which = e.code === "KeyM" ? "moon" : e.code === "KeyJ" ? "jupiter" : null;
  if (!which) return;
  const f = playFlags(); f[which] = !f[which]; if (f[which]) f[which === "moon" ? "jupiter" : "moon"] = false;
  prefs.set("bw-ae-play", JSON.stringify(f)); refreshFun(); renderSettings();
});
/** The Moon / Jupiter line under the last jump: the same flight time under another gravity. A game, never scored. */
function refreshFun() {
  if (view !== "run" || lastJumpCm == null) return;
  const f = playFlags();
  run.setFun(f.moon ? COPY.fun.moon(C.bigHeightText(C.moonCm(lastJumpCm), U.get())) : f.jupiter ? COPY.fun.jupiter(C.bigHeightText(C.jupiterCm(lastJumpCm), U.get())) : "");
}
// the spoken line of the last result named a length in the old system: clear it rather than leave it stale
U.onChange(() => { refreshFun(); if (els.live) els.live.textContent = ""; });

// cards that only mean something once their data arrives
for (const card of document.querySelectorAll("#lab-grid .card[data-needs]")) {
  const source = document.getElementById(card.dataset.needs);
  if (!source) continue;
  const check = () => { const t = source.textContent.trim(); card.classList.toggle("has-data", t !== "" && t !== "—"); };
  new MutationObserver(check).observe(source, { childList: true, characterData: true, subtree: true });
  check();
}

// ---------------------------------------------------------------- start
setMotion(prefs.get("bw-ae-motion", "auto"));
real = ctx = makeCtx(false, { preview: !booth && !hasStoredProfile() });
// the page may already be simulating (the module loads after app.js)
if (AE.isSim()) { simCtx = makeCtx(true); ctx = simCtx; }
ui.syncMode(mode);
placeTools();
syncLabToggle();
toIdle(); renderBoard(); renderLevel(); renderSettings();
// another tab may have moved the visit on (a Combine finished there), and a visit goes stale while the page just sits open
window.addEventListener("storage", (e) => { if (e.key === VISIT_KEY || e.key === null) refreshVisit(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshVisit(); });
setInterval(refreshVisit, 30000);

// a small read-only window for the smoke test and the screenshots; it can read state, never change a measurement
window.BWFun = Object.freeze({
  mode: () => mode, view: () => view, sim: () => ctx.sim, booth: () => booth,
  firstWin: () => ctx.fun.firstWin.state(),
  card: () => (lastSum ? { flames: lastRes?.heat.flames ?? null, stations: lastSum.stationsDone, status: lastSum.status } : null),
  xp: () => ctx.fun.kit.xp.info(),
  gate: () => ({ quiet: ctx.fun.gate.quiet, pending: ctx.fun.gate.pending, holds: ctx.fun.gate.holds, busy: ctx.fun.busy() }),
});
