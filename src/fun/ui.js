// Drawing for the Combine layer: the hero, the station rail and result, the Card, the board, the level strip and the settings.
// Plain DOM through the kit's tiny h(). Every length and speed is drawn as a [data-kind][data-base] element (metric underneath)
// that BWUnits repaints when the Metric / Imperial switch flips, so nothing here has to listen for it. Every cue is a picture
// AND a word: judgments are a shape plus text, flames come with "3 of 5", a sound always has something to read next to it.
// This file shows results; the rewards (sound, particles, toasts, dialogs) live in fun.js behind the quiet gate.
import { h } from "../vendor/fun-kit/ui/dom.js";
import { iconSvg } from "../vendor/fun-kit/ui/icons.js";
import { renderXpBar, renderBadgeGrid } from "../vendor/fun-kit/ui/components.js";
import { countUp } from "../vendor/fun-kit/juice/counters.js";
import { COPY } from "./copy.js";
import * as C from "./config.js";

const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** @param {{U: object, doc?: Document}} o  U is BWUnits */
export function createUi({ U, doc = document }) {
  const $ = (id) => doc.getElementById(id);

  // ---------------------------------------------------------------- small pieces
  /** A value that repaints itself in the chosen system: "33.1 cm" / "13.0 in" (metric underneath). */
  function uval(kind, base, { digits, unit = true, trim = false } = {}) {
    const el = h("span");
    el.dataset.kind = kind; el.dataset.base = String(base);
    if (digits != null) el.dataset.digits = String(digits);
    if (unit) el.dataset.withUnit = "";
    if (!trim) el.dataset.trim = "0";
    U.paint(el);
    return el;
  }
  const shape = (j) => h("i", { class: "ae-shape", "data-shape": j.shape, "aria-hidden": "true" });
  const judgeChip = (j) => h("span", { class: "ae-judge", "data-tone": j.tone }, shape(j), j.word);
  const flame = (lit, i) => { const el = h("span", { class: `ae-flame${lit ? " is-lit" : ""}`, style: { "--ae-i": i }, "aria-hidden": "true" }); el.innerHTML = iconSvg("flame", { size: "1em" }); return el; };
  const button = (label, onclick, cls = "", attrs = {}) => h("button", { type: "button", class: cls, onclick, ...attrs }, label);
  const clear = (el) => { el.replaceChildren(); return el; };
/** Replace an element's children, skipping null and false (the native append would print "null"). */
const fill = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

  // ---------------------------------------------------------------- header, nav
  function syncMode(mode) {
    for (const b of doc.querySelectorAll("#mode-seg button")) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // ---------------------------------------------------------------- the stage: idle
  /**
   * @param {{sim: boolean, booth: boolean, safety: boolean, last: object|null, can: {ok: boolean, reason: string|null, waitMs: number},
   *   act: {start: Function, sim: Function, ackSafety: Function, rested: Function}}} o
   */
  function renderIdle(root, o) {
    const hero = h("div", { class: "ae-hero" },
      h("p", { class: "ae-eyebrow" }, COPY.hero.eyebrow),
      h("h3", { class: "ae-title" }, COPY.hero.title),
      h("p", { class: "ae-sub" }, o.sim ? COPY.hero.simOn : COPY.hero.sub),
      o.safety ? h("div", { class: "ae-safety", role: "note" }, h("span", {}, COPY.safety.line), button(COPY.safety.ok, o.act.ackSafety)) : null,
      h("div", { class: "ae-actions" },
        button(COPY.hero.start, o.act.start, "primary ae-big", { id: "ae-start", disabled: !o.can.ok }),
        button(o.sim ? COPY.words.simStop : COPY.hero.sim, o.act.sim, "ae-ghost", { id: "ae-sim" })),
      o.can.ok ? h("p", { class: "ae-hint" }, o.sim ? COPY.hero.simOn : COPY.hero.simHint)
        : h("p", { class: "ae-rest", id: "ae-rest-line" }, o.can.reason === "cap" ? COPY.card.cap : `${COPY.card.restLine} ${COPY.card.rematchIn(mmss(o.can.waitMs))}`),
      o.can.reason === "rest" ? button(COPY.card.rested, o.act.rested, "ae-ghost", { id: "ae-rested" }) : null,
      o.last ? h("p", { class: "ae-last" }, COPY.card.lastCard(o.last.name || "—", o.last.flames)) : null);
    fill(root, hero);
    return hero;
  }

  // ---------------------------------------------------------------- the stage: a Combine in progress
  /** Builds the running view once; the returned handle updates it in place so animations are not restarted by every event. */
  function renderRun(root, o) {
    const rail = h("ol", { class: "ae-rail", "aria-label": COPY.card.stampsAria });
    const items = {};
    for (const s of C.STATIONS) {
      const mark = h("span", { class: "ae-rail-mark", "aria-hidden": "true" });
      const state = h("span", { class: "ae-sr" });
      const li = h("li", { class: "ae-rail-item is-todo" }, h("span", { class: "ae-rail-n" }, String(s.n)), h("span", { class: "ae-rail-name" }, COPY.stations[s.id].short), mark, state);
      items[s.id] = { li, mark, state };
      rail.append(li);
    }
    const kicker = h("p", { class: "ae-kicker" });
    const name = h("h3", { class: "ae-station" });
    const prompt = h("p", { class: "ae-prompt", id: "ae-prompt" });
    const how = h("p", { class: "ae-how" });
    const status = h("p", { class: "ae-status is-wait", id: "ae-status" });
    let promptText = "";
    const sub = h("div", { class: "ae-subprog" });
    const warm = h("div", { class: "ae-warm" });
    const dev = h("div", { class: "ae-warm" });      // connect / simulate, when there is nothing to measure with yet
    const hint = h("p", { class: "ae-hint", id: "ae-hint" });   // a gentle one-liner: a nudge, a wrong-foot note
    const promptCard = h("div", { class: "ae-prompt-card is-fresh", tabindex: "-1" }, kicker, name, prompt, how, status, sub, hint, dev, warm);
    const resultSlot = h("div", { id: "ae-result-slot" });
    const actions = h("div", { class: "ae-run-actions" },
      button(COPY.stage.skip, o.act.skip, "", { id: "ae-skip" }),
      button(COPY.stage.stop, o.act.stop, "ae-ghost", { id: "ae-stop" }),
      button(COPY.stage.labDetails, () => o.act.lab(), "ae-ghost", { id: "ae-lab-link" }));
    fill(root, h("div", { class: "ae-run" }, rail, promptCard, resultSlot, actions));

    const stateWord = { done: COPY.stage.stampDone, skipped: COPY.stage.stampSkipped, notrun: COPY.stage.stampNotRun, todo: "", active: "" };
    const markFor = { done: "✓", skipped: "–", notrun: "–", todo: "", active: "●" };

    return {
      /** status: { leap: "done"|..., ... }, active: station id or null */
      setRail(status_, active) {
        for (const s of C.STATIONS) {
          const st = s.id === active ? "active" : status_[s.id] ?? "todo";
          const it = items[s.id];
          it.li.className = `ae-rail-item is-${st}`;
          if (st === "active") it.li.setAttribute("aria-current", "step"); else it.li.removeAttribute("aria-current");
          it.mark.textContent = markFor[st] ?? "";
          it.state.textContent = stateWord[st] ? ` ${stateWord[st]}` : "";
        }
      },
      setStation(id, { sprintN = 5 } = {}) {
        const st = C.STATIONS.find((x) => x.id === id);
        if (!st) { kicker.textContent = ""; name.textContent = ""; prompt.textContent = ""; how.textContent = ""; return; }
        const c = COPY.stations[id];
        kicker.textContent = COPY.stage.stationOf(st.n, C.STATIONS.length);
        name.textContent = c.name; prompt.textContent = promptText = c.prompt; prompt.classList.remove("is-go");
        how.textContent = typeof c.how === "function" ? c.how(sprintN) : c.how;
        promptCard.classList.remove("is-fresh"); void promptCard.offsetWidth; promptCard.classList.add("is-fresh");
        sub.replaceChildren(); warm.replaceChildren(); dev.replaceChildren(); hint.textContent = "";
      },
      setStatus(text, { wait = true } = {}) { status.textContent = text ?? ""; status.classList.toggle("is-wait", !!wait); },
      /** GO: a steady big caption (never a flash) while the window is open; off puts the station's own prompt back */
      setGo(on, word = COPY.stage.go) {
        prompt.classList.toggle("is-go", !!on);
        if (on) { prompt.textContent = word; status.textContent = ""; }
        else if (promptText) prompt.textContent = promptText;
      },
      setSub(pips) { sub.replaceChildren(...pips.map((p) => h("span", { class: `ae-pip${p.on ? " is-on" : ""}` }, `${p.label}${p.on ? " ✓" : ""}`))); },
      setWarm(show, onWarm) {
        warm.replaceChildren();
        if (show) warm.append(h("span", {}, COPY.stage.warmHint), button(COPY.stage.warm, onWarm, "", { id: "ae-warm" }));
      },
      setHint(text) { hint.textContent = text ?? ""; },
      /** no device yet: offer the two ways forward right where the person is looking */
      setDevicePrompt(show, { connect, sim }) {
        if (!show) return;
        dev.replaceChildren(button(COPY.stage.connect, connect, "", { id: "ae-connect" }), button(COPY.stage.simulate, sim, "ae-ghost", { id: "ae-sim-inline" }));
      },
      setSkipLabel(label) { $("ae-skip").textContent = label; },
      /** Show a result: count-up number, shape + word judgment, ghost bar. `fx` only decorates (the ribbon is added by the gated reward). */
      showRep(rep) {
        const slot = $("ae-result-slot");
        const numEl = h("span", { class: "ae-num" });
        const better = rep.better ?? "higher";
        const meter = C.meterPcts(better, rep.value, rep.ghost);
        const final = (v) => (rep.valueKind === "height" ? U.fmt("height", v) : rep.valueKind === "ms" ? String(Math.round(v)) : v.toFixed(2));
        if (rep.valueKind === "height") { numEl.dataset.kind = "height"; numEl.dataset.base = String(rep.value); }
        const unitEl = rep.valueKind === "height" ? h("span", { class: "ae-unit", "data-u": "height" }, U.unit("height"))
          : h("span", { class: "ae-unit" }, rep.valueKind === "ms" ? COPY.words.ms : rep.valueKind === "s" ? COPY.words.s : COPY.words.rsi);
        const near = nearLine(rep);
        const fill = h("span", { class: "ae-meter-fill", style: { "--ae-fill": `${meter.fill}%` } });
        const ghostMark = meter.ghost != null ? h("span", { class: "ae-meter-ghost", style: { "--ae-ghost": `${meter.ghost}%` } }) : null;
        const res = h("div", { class: "ae-result is-fresh", id: "ae-result", "data-judge": rep.judgment.id },
          h("span", { class: "ae-ribbon", "aria-hidden": "true" }, COPY.judge.pb),
          h("p", { class: "ae-result-label" }, rep.label),
          h("p", { class: "ae-result-line" }, numEl, unitEl),
          h("p", { class: "ae-judge-row" }, judgeChip(rep.judgment), rep.warmup ? h("span", { class: "ae-tag" }, COPY.stage.warmupTag) : null, near),
          h("div", { class: "ae-meter", role: "img", "aria-label": `${rep.label}: ${near ? near.textContent : final(rep.value)}` }, fill, ghostMark),
          rep.ghost != null ? h("div", { class: "ae-meter-legend" }, h("span", { class: "ae-key" }, rep.label), h("span", { class: "ae-key is-ghost" }, COPY.near.best, " ", ghostValue(rep))) : null,
          h("p", { class: "ae-fun", id: "ae-fun" }));
        slot.replaceChildren(res);
        // count the number up from zero (reduced motion: it simply lands on the final value)
        countUp(numEl, rep.value, { duration: 800, format: final });
        return { el: res, markPb: () => res.classList.add("is-pb") };
      },
      /** the Moon / Jupiter line under the last jump (a game, never scored) */
      setFun(text) { const el = $("ae-fun"); if (el) el.textContent = text ?? ""; },
      clearResult() { $("ae-result-slot")?.replaceChildren(); },
      /** keyboard and screen-reader users land on the station after Start, not on a button that is gone */
      focus() { promptCard.focus({ preventScroll: true }); },
      ringGo() { promptCard.classList.add("ae-go-ring"); setTimeout(() => promptCard.classList.remove("ae-go-ring"), 800); },
    };
  }

  function ghostValue(rep) {
    if (rep.valueKind === "height") return uval("height", rep.ghost);
    if (rep.valueKind === "ms") return h("span", {}, `${Math.round(rep.ghost)} ${COPY.words.ms}`);
    if (rep.valueKind === "s") return h("span", {}, `${rep.ghost.toFixed(2)} ${COPY.words.s}`);
    return h("span", {}, rep.ghost.toFixed(2));
  }
  /** "0.8 cm off your best" / "1.2 cm past your best" / "Level with your best" (null for a first mark or a warm-up) */
  function nearLine(rep) {
    if (rep.ghost == null || rep.warmup) return null;
    const diff = rep.value - rep.ghost;
    const lowerBetter = rep.better === "lower";
    if (diff === 0) return h("span", { class: "ae-near" }, COPY.near.tie);
    const past = lowerBetter ? diff < 0 : diff > 0;
    const gap = Math.abs(diff);
    const gapEl = rep.valueKind === "height" ? uval("height", gap, { trim: false })
      : rep.valueKind === "ms" ? h("span", {}, `${Math.round(gap)} ${COPY.words.ms}`) : rep.valueKind === "s" ? h("span", {}, `${gap.toFixed(2)} ${COPY.words.s}`) : h("span", {}, gap.toFixed(2));
    const line = h("span", { class: "ae-near" });
    // build "<gap> past your best" with the gap as a live value
    const [pre, post] = (past ? COPY.near.pb("\u0000") : COPY.near.off("\u0000")).split("\u0000");
    line.replaceChildren(pre, gapEl, post);
    return line;
  }

  // ---------------------------------------------------------------- the stage: the Card
  /**
   * @param {{sum: object, heat: object, story: object, xp: object|null, level: object|null, sim: boolean, canBoard: boolean, boardNote: string,
   *   pulseDue: boolean, can: object, act: object}} o
   */
  function renderCard(root, o) {
    const { sum } = o;
    const stamps = h("ol", { class: "ae-stamps", "aria-label": COPY.card.stampsAria });
    C.STATIONS.forEach((s, i) => stamps.append(stampRow(s, sum, i)));

    const flames = h("span", { class: "ae-flames", "aria-hidden": "true" }, ...[1, 2, 3, 4, 5].map((n, i) => flame(n <= o.heat.flames, i)));
    const heat = h("div", { class: "ae-heat", role: "img", "aria-label": `${COPY.card.heat}: ${o.heat.name || "none"}, ${COPY.card.flamesOf(o.heat.flames)}` },
      flames, h("span", { class: "ae-heat-name" }, o.heat.name || "—"), h("span", { class: "ae-heat-n" }, COPY.card.flamesOf(o.heat.flames)));

    const bal = sum.onefoot.balance;
    const story = [];
    if (o.story.strongest) story.push(COPY.card.strongest(COPY.stations[o.story.strongest].name.toLowerCase()));
    if (o.story.chase) story.push(COPY.card.chase(o.story.chase.kind === "foot" ? COPY.card.chaseFoot(o.story.chase.side.toLowerCase()) : COPY.stations[o.story.chase.id].name.toLowerCase()));

    const restRow = h("div", { class: "ae-actions" });
    const rematch = button(COPY.card.rematch, o.act.rematch, "primary ae-big", { id: "ae-rematch" });
    const nextV = button(COPY.card.nextVisitor, o.act.nextVisitor, "ae-ghost", { id: "ae-next" });
    const restedBtn = button(COPY.card.rested, o.act.rested, "ae-ghost ae-hidden", { id: "ae-rested" });
    const restLine = h("p", { class: "ae-rest ae-hidden", id: "ae-rest-line" });
    restRow.append(rematch, restedBtn, nextV);

    let add = null;
    if (o.canBoard) {
      const input = h("input", { id: "ae-initials", type: "text", maxlength: "3", autocomplete: "off", autocapitalize: "characters", "aria-label": COPY.board.initials, placeholder: "ABC", spellcheck: "false" });
      add = h("form", { class: "ae-add", id: "ae-add", onsubmit: (e) => { e.preventDefault(); o.act.addToBoard(input.value); } },
        h("label", { for: "ae-initials" }, COPY.board.ask), input, h("button", { type: "submit", class: "primary" }, COPY.board.save));
    }

    const pulse = o.pulseDue ? h("div", { class: "ae-pulse", id: "ae-pulse", role: "group", "aria-label": COPY.pulse.ask },
      h("p", { class: "ae-line" }, COPY.pulse.ask),
      h("div", { class: "ae-pulse-row" }, ...COPY.pulse.options.map(([id, label]) => button(label, () => o.act.pulse(id), "", { "data-answer": id })))) : null;

    const card = h("article", { class: "ae-card", "aria-labelledby": "ae-card-h", id: "ae-card" },
      h("div", { class: "ae-card-head" }, h("h3", { class: "ae-card-title", id: "ae-card-h", tabindex: "-1" }, COPY.card.title), o.sim ? h("span", { class: "ae-tag" }, COPY.card.simTag) : null),
      heat, stamps,
      story.length ? h("p", { class: "ae-story" }, story.join(" ")) : null,
      bal ? h("p", { class: "ae-line" }, `${COPY.words.left[0]} `, uval("height", bal.l), ` / ${COPY.words.right[0]} `, uval("height", bal.r), `: ${bal.pct}% ${COPY.words.apart}`) : null,
      o.xp ? h("p", { class: "ae-xp-line" }, COPY.card.xp(o.xp.gained), o.level ? ` · ${COPY.card.level(o.level.level, o.level.title)}` : "") : null,
      o.sim ? h("p", { class: "ae-note" }, COPY.card.simNote) : null,
      sum.warmupOnly && !o.sim ? h("p", { class: "ae-note" }, COPY.card.warmNote) : null,
      !sum.early && !o.sim ? h("p", { class: "ae-note" }, o.prevVisit ? COPY.card.prevNote : COPY.card.first) : null,
      add, o.boardNote ? h("p", { class: "ae-note", id: "ae-board-note" }, o.boardNote) : null,
      restLine, restRow, pulse);
    fill(root, card);

    return {
      el: card,
      focus() { $("ae-card-h")?.focus({ preventScroll: true }); },
      /** called every second while a rest is running; ms 0 opens the rematch */
      setRest(ms, { cap = false } = {}) {
        if (cap) { rematch.disabled = true; rematch.textContent = COPY.card.rematch; restLine.textContent = COPY.card.cap; restLine.classList.remove("ae-hidden"); restedBtn.classList.add("ae-hidden"); return; }
        if (ms > 0) {
          rematch.disabled = true; rematch.textContent = COPY.card.rematchIn(mmss(ms));
          restLine.textContent = COPY.card.restLine; restLine.classList.remove("ae-hidden"); restedBtn.classList.remove("ae-hidden");
        } else {
          rematch.disabled = false; rematch.textContent = COPY.card.rematch; restLine.classList.add("ae-hidden"); restedBtn.classList.add("ae-hidden");
        }
      },
      boardResult(text) { add?.remove(); const n = $("ae-board-note"); if (n) n.textContent = text; else card.insertBefore(h("p", { class: "ae-note", id: "ae-board-note" }, text), restLine); },
      thanks() { const p = $("ae-pulse"); if (p) p.replaceChildren(h("p", { class: "ae-flash-note" }, COPY.pulse.thanks)); },
    };
  }

  function stampRow(s, sum, i) {
    const c = COPY.stations[s.id];
    const status = sum.status[s.id];
    const li = h("li", { class: `ae-stamp is-${status}`, style: { "--ae-i": i } });
    li.append(h("span", { class: "ae-stamp-n", "aria-hidden": "true" }, String(s.n)), h("span", { class: "ae-stamp-name" }, c.name));
    const val = h("span", { class: "ae-stamp-val" });
    const subs = h("div", { class: "ae-stamp-sub" });
    if (status !== "done") {
      val.textContent = status === "skipped" ? COPY.stage.stampSkipped : COPY.stage.stampNotRun;
    } else if (s.id === "leap") {
      val.append(uval("height", sum.leap.cm)); subs.append(judgeChip(sum.leap.judgment));
      if (sum.leap.warmup) subs.append(h("span", { class: "ae-tag" }, COPY.stage.warmupTag));
    } else if (s.id === "onefoot") {
      val.append(uval("height", sum.onefoot.anyBest));
      subs.append(h("span", {}, `${COPY.words.left[0]} `, uval("height", sum.onefoot.L.cm), ` / ${COPY.words.right[0]} `, uval("height", sum.onefoot.R.cm)));
      const j = [sum.onefoot.L, sum.onefoot.R].sort((a, b) => b.cm - a.cm)[0].judgment;
      subs.append(judgeChip(j));
    } else if (s.id === "firststep") {
      const best = sum.firststep.trials.reduce((a, t) => (t.stepMs < a.stepMs ? t : a));
      val.textContent = `${best.stepMs} ${COPY.words.ms}`; subs.append(judgeChip(best.judgment), h("span", {}, COPY.words.steps(sum.firststep.trials.length)));
    } else if (s.id === "sprint") {
      val.textContent = `${sum.sprint.s.toFixed(2)} ${COPY.words.s}`; subs.append(judgeChip(sum.sprint.judgment), h("span", {}, COPY.words.steps(sum.sprint.n)));
      if (sum.sprint.split3 != null) subs.append(h("span", {}, COPY.words.split3(sum.sprint.split3.toFixed(2))));
    } else if (s.id === "bounce") {
      val.textContent = sum.bounce.rsi.toFixed(2); subs.append(sum.bounce.judgment ? judgeChip(sum.bounce.judgment) : "", h("span", {}, COPY.words.hops(sum.bounce.hops)));
    }
    li.append(val);
    if (subs.childNodes.length) li.append(subs);
    return li;
  }

  // ---------------------------------------------------------------- the board
  function renderBoard(root, o) {
    const items = o.entries.map((e, i) => h("li", { class: e.id === o.meId ? "is-me" : "", "aria-label": COPY.board.rowAria(C.ordinal(i + 1), e.who) },
      h("span", { class: "ae-rank" }, String(i + 1)), h("span", { class: "ae-who" }, e.who), h("span", { class: "ae-board-val" }, uval("height", e.cm))));
    fill(root,
      h("p", { class: "ae-sub" }, COPY.board.sub),
      items.length ? h("ol", { class: "ae-board" }, ...items) : h("p", { class: "ae-note" }, COPY.board.empty),
      o.rankText ? h("p", { class: "ae-flash-note" }, COPY.board.rank(o.rankText.nth, o.rankText.total)) : (o.meId ? h("p", { class: "ae-note" }, COPY.board.needFive) : null));
  }

  // ---------------------------------------------------------------- level and badges
  function renderLevel(root, o) {
    if (o.booth) { fill(root, h("p", { class: "ae-note" }, COPY.level.boothHidden)); return; }
    const badges = o.kit.achievements.collection({ includeHidden: false });
    fill(root, h("div", { class: "ae-level" },
      h("p", { class: "ae-sub" }, o.sim ? COPY.level.simSub : COPY.level.sub),
      renderXpBar(o.kit.xp.info()),
      h("details", { class: "ae-badges" }, h("summary", {}, `${COPY.level.badges} (${badges.unlockedCount} of ${badges.total})`), renderBadgeGrid(badges))));
  }

  // ---------------------------------------------------------------- settings
  function renderSettings(root, o) {
    const seg = (name, opts, cur, onPick) => h("div", { class: "seg", role: "group", "aria-label": name },
      ...opts.map(([id, label]) => h("button", { type: "button", class: id === cur ? "on" : "", "aria-pressed": id === cur ? "true" : "false", onclick: () => onPick(id) }, label)));
    const check = (id, label, on, onChange) => h("label", { class: "ae-check", for: id }, h("input", { type: "checkbox", id, checked: on || null, onchange: (e) => onChange(e.target.checked) }), label);
    const armed = new Set();
    const sure = (label, sureLabel, run, cls = "ae-danger") => {
      const b = h("button", { type: "button", class: cls }, label);
      let t = null;
      b.addEventListener("click", () => {
        if (!armed.has(b)) { armed.add(b); b.textContent = sureLabel; b.classList.add("is-armed"); t = setTimeout(() => { armed.delete(b); b.textContent = label; b.classList.remove("is-armed"); }, 4000); return; }
        clearTimeout(t); armed.delete(b); b.textContent = label; b.classList.remove("is-armed"); run();
      });
      return b;
    };
    fill(root,
      h("div", { class: "ae-field" }, h("span", { class: "ae-label" }, COPY.settings.sound), seg(COPY.settings.sound, [["on", COPY.stage.soundOn], ["off", COPY.stage.soundOff]], o.sound ? "on" : "off", (id) => o.act.sound(id === "on"))),
      h("div", { class: "ae-field" }, h("span", { class: "ae-label" }, COPY.settings.motion), seg(COPY.settings.motion, COPY.settings.motionOpts, o.motion, o.act.motion)),
      h("div", { class: "ae-field" }, h("span", { class: "ae-label" }, COPY.settings.theme), seg(COPY.settings.theme, COPY.settings.themeOpts, o.theme, o.act.theme)),
      check("ae-booth", COPY.settings.booth, o.booth, o.act.booth),
      check("ae-moon", COPY.settings.moon, o.moon, (v) => o.act.play("moon", v)),
      check("ae-jupiter", COPY.settings.jupiter, o.jupiter, (v) => o.act.play("jupiter", v)),
      h("div", { class: "ae-actions" },
        button(COPY.settings.stats, o.act.stats),
        sure(COPY.settings.clearBoard, COPY.settings.clearBoardSure, o.act.clearBoard),
        sure(COPY.settings.forget, COPY.settings.forgetSure, o.act.forget)),
      h("p", { class: "ae-note", id: "ae-forgot" }),
      h("p", { class: "ae-note" }, COPY.settings.privacy),
      h("p", { class: "ae-note" }, COPY.settings.haptics));
  }

  return { uval, judgeChip, syncMode, renderIdle, renderRun, renderCard, renderBoard, renderLevel, renderSettings, mmss };
}
