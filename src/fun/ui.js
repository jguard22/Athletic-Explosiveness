// Drawing for the Combine layer: the hero, the station rail and result, the Card, the board, the level strip and the settings.
// Plain DOM through the kit's tiny h(). Every length and speed is drawn as a [data-kind][data-base] element (metric underneath)
// that BWUnits repaints when the Metric / Imperial switch flips, so nothing here has to listen for it. Every cue is a picture
// AND a word: judgments are a shape plus text, flames come with "3 of 5", a sound always has something to read next to it.
// This file shows results; the rewards (sound, particles, toasts, dialogs) live in fun.js behind the quiet gate.
import { h, svgFromString } from "../vendor/fun-kit/ui/dom.js";
import { iconSvg } from "../vendor/fun-kit/ui/icons.js";
import { renderXpBar, renderBadgeGrid } from "../vendor/fun-kit/ui/components.js";
import { countUp } from "../vendor/fun-kit/juice/counters.js";
import { COPY } from "./copy.js";
import * as C from "./config.js";

const ICON_PATHS = Object.freeze({
  leap: "M12 16V4 M7.5 8.5L12 4l4.5 4.5 M6 20h4 M14 20h4",
  onefoot: "M12 16V4 M7.5 8.5L12 4l4.5 4.5 M9 20h6",
  firststep: "M4.5 14a7.5 7.5 0 1015 0 7.5 7.5 0 10-15 0z M12 14V9.5 M10 2.5h4 M12 2.5V6",
  sprint: "M4 6l6 6-6 6 M11 6l6 6-6 6 M20 7v10",
  bounce: "M2.5 17c1.2-7 3.3-7 4.5 0 1.2-7 3.3-7 4.5 0 1.2-7 3.3-7 4.5 0 1.2-7 3.3-7 4.5 0 M2.5 21h19",
  arrow: "M5 12h13 M13 6l6 6-6 6",
});

const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** @param {{U: object, doc?: Document}} o  U is BWUnits */
export function createUi({ U, doc = document }) {
  const $ = (id) => doc.getElementById(id);
  // a result's spoken label carries a height and a gap: say them in the system the switch is on now, not the one it was drawn in
  U.onChange?.(() => doc.querySelectorAll(".ae-meter").forEach((m) => m.relabel?.()));

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

  /** Custom pictograms on a 24 grid, one per station: stroke only, so the colour comes from the surrounding text. */
  const stationIcon = (id, extra = "") => {
    const d = ICON_PATHS[id] ?? ICON_PATHS.leap;
    return svgFromString(`<svg class="ae-ico ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`);
  };
  const arrow = () => svgFromString(`<svg class="ae-ico ae-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICON_PATHS.arrow}"/></svg>`);

  /** A stored value as live text: heights repaint with the Metric / Imperial switch, times and scores are the same in both. */
  function valueNode(v) {
    if (!v) return h("span", { class: "ae-none" }, COPY.program.noMark);
    if (v.kind === "height") return uval("height", v.value);
    if (v.kind === "ms") return h("span", {}, `${Math.round(v.value)} ${COPY.words.ms}`);
    if (v.kind === "s") return h("span", {}, `${v.value.toFixed(2)} ${COPY.words.s}`);
    return h("span", {}, v.value.toFixed(2));
  }
  /** A big number and its unit, as two nodes (the height number repaints with the switch). */
  function numUnit(kind, value, { cls = "" } = {}) {
    const num = h("span", { class: `ae-num ${cls}`.trim() });
    if (kind === "height") {
      num.dataset.kind = "height"; num.dataset.base = String(value); U.paint(num);
      return [num, h("span", { class: "ae-unit", "data-u": "height" }, U.unit("height"))];
    }
    num.textContent = kind === "ms" ? String(Math.round(value)) : value.toFixed(2);
    return [num, h("span", { class: "ae-unit" }, kind === "ms" ? COPY.words.ms : kind === "s" ? COPY.words.s : COPY.words.score)];
  }
  const spokenHeight = (cm) => `${U.fmt("height", cm)} ${U.get() === "imperial" ? COPY.words.inches : COPY.words.centimeters}`;

  /**
   * The height tower (the signature): a ruler in the chosen system, a shaft that fills to a leap, and flags on the marks (your best, the top
   * of today's board). Drawn in storage cm; only the ruler's labels convert, and it redraws when the switch flips.
   * @param {{fill?: number|null, marks?: {cm: number, tone: "best"|"top", label: string}[], animate?: boolean}} o
   */
  function tower({ fill = null, marks = [], animate = true, empty = false } = {}) {
    const el = h("div", { class: "ae-tower", role: "img" });
    const draw = (anim) => {
      const sc = C.towerScale({ system: U.get(), values: [fill, ...marks.map((m) => m.cm)] });
      const offs = C.flagOffsets(marks.map((m) => sc.pct(m.cm)));
      const ruler = h("div", { class: "ae-ruler", "aria-hidden": "true" },
        ...sc.ticks.map((t) => h("span", { class: `ae-tick${t.label != null ? " is-major" : ""}`, style: { "--p": `${sc.pct(t.cm)}%` } }, t.label != null ? h("i", {}, String(t.label)) : null)));
      const shaft = h("div", { class: "ae-shaft", "aria-hidden": "true" },
        fill != null ? h("span", { class: `ae-tower-fill${anim ? "" : " is-set"}`, style: { "--ae-fill": `${sc.pct(fill)}%` } }) : null,
        ...marks.map((m) => h("span", { class: `ae-mark is-${m.tone}`, style: { "--p": `${sc.pct(m.cm)}%` } })),
        empty && fill == null && !marks.length ? h("span", { class: "ae-mark is-empty", style: { "--p": "42%" } }) : null);
      const flags = h("div", { class: "ae-flags", "aria-hidden": "true" },
        ...marks.map((m, i) => h("span", { class: `ae-flag is-${m.tone}`, style: { "--q": `${offs[i]}%` } }, h("b", {}, m.label), uval("height", m.cm))),
        empty && fill == null && !marks.length ? h("span", { class: "ae-flag is-empty", style: { "--q": "42%" } }, COPY.next.towerEmpty) : null);
      el.replaceChildren(ruler, shaft, flags);
      const said = [fill != null ? spokenHeight(fill) : null, ...marks.map((m) => `${m.label} ${spokenHeight(m.cm)}`)].filter(Boolean);
      el.setAttribute("aria-label", `${COPY.next.towerAria}${said.length ? `: ${said.join(", ")}` : `. ${COPY.next.towerEmpty}`}`);
    };
    el.redraw = () => draw(false);
    draw(animate);
    return el;
  }
  // a ruler and a spoken label name the system, so they redraw when the switch flips
  U.onChange?.(() => doc.querySelectorAll(".ae-tower").forEach((t) => t.redraw?.()));

  // ---------------------------------------------------------------- header, nav
  function syncMode(mode) {
    for (const b of doc.querySelectorAll("#mode-seg button")) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // ---------------------------------------------------------------- the stage: idle
  /**
   * The first screen: a headline and the one big button, the next drill, the tower with your best on it, and the five stations with
   * your best at each. A first-time athlete sees the same layout with empty marks ("No mark yet"), so nothing is hidden or moved later.
   * @param {{sim: boolean, booth: boolean, ble: boolean, connected: boolean, safety: boolean, last: object|null, can: {ok: boolean, reason: string|null, waitMs: number},
   *   view: object, top: {who: string, cm: number}|null, sprintN: number,
   *   act: {start: Function, sim: Function, connect: Function, ackSafety: Function, rested: Function, nextVisitor: Function}}} o
   *   ble        false when this browser has no Web Bluetooth (iOS Safari, Firefox): Simulate becomes the main button, because Start cannot lead anywhere
   *   connected  insoles are connected now; with none, Simulate is the main button too, since it is the way to see the whole thing
   *   view       C.idleView(...): the athlete's bests per station, the next drill, the foot to chase
   *   top        today's best two-foot leap on the board (initials and cm), or null
   */
  function renderIdle(root, o) {
    const view = o.view ?? C.idleView({});
    const returning = view.returning && !o.sim;
    const noBle = o.ble === false && !o.sim;
    const noDevice = !o.connected && !o.sim;
    const simMain = noBle || noDevice;
    const startBtn = button(COPY.hero.start, o.act.start, simMain ? "ae-big ae-start" : "primary ae-big ae-start", { id: "ae-start", disabled: !o.can.ok });
    startBtn.append(arrow());
    const simBtn = button(o.sim ? COPY.words.simStop : COPY.hero.sim, o.act.sim, simMain ? "primary ae-big" : "ae-ghost", { id: "ae-sim" });
    if (simMain) simBtn.append(arrow());

    // the next drill: the Combine opens on the two-foot leap; say what it is, what to beat, and the foot to chase
    const st = C.STATIONS[0], c0 = COPY.stations[st.id], leapBest = view.stations.leap;
    const nextDrill = h("div", { class: "ae-next" },
      h("p", { class: "ae-kicker" }, `${COPY.next.kicker} · ${COPY.next.stationOf(st.n, C.STATIONS.length)}`),
      h("div", { class: "ae-next-row" }, stationIcon(st.id, "ae-ico-lg"),
        h("div", { class: "ae-next-text" }, h("h4", { class: "ae-next-name" }, c0.name),
          h("p", { class: "ae-how" }, typeof c0.how === "function" ? c0.how(o.sprintN ?? 5) : c0.how))),
      h("p", { class: "ae-target" }, leapBest ? [h("span", { class: "ae-k" }, COPY.next.beat), valueNode(leapBest)] : h("span", { class: "ae-k" }, COPY.next.first)),
      view.chase && !o.sim ? h("p", { class: "ae-chase" }, COPY.next.chase(view.chase.side, view.chase.pct)) : null);

    // insoles: connected or not, and the way to connect right here (Chrome and Edge only)
    const deviceRow = (connected) => {
      const dot = h("i", { class: "ae-dot", "aria-hidden": "true" });
      if (o.sim) return h("p", { class: "ae-device is-sim", id: "ae-device" }, dot, COPY.device.sim);
      if (o.ble === false) return h("p", { class: "ae-device is-off", id: "ae-device" }, dot, COPY.device.noBle);
      return connected ? h("p", { class: "ae-device is-on", id: "ae-device" }, dot, COPY.device.on)
        : h("p", { class: "ae-device is-off", id: "ae-device" }, dot, COPY.device.off, button(COPY.device.connect, o.act.connect, "ae-link", { id: "ae-connect-idle" }));
    };
    const deviceSlot = h("div", { class: "ae-device-slot" }, deviceRow(o.connected));

    const side = h("div", { class: "ae-hero-side" },
      h("p", { class: "ae-kicker" }, COPY.stations.leap.name),
      tower({ marks: [
        ...(leapBest && !o.sim ? [{ cm: leapBest.value, tone: "best", label: COPY.next.yourBest }] : []),
        ...(o.top ? [{ cm: o.top.cm, tone: "top", label: `${COPY.next.topToday} ${o.top.who}` }] : []),
      ], animate: false, empty: true }));

    const hero = h("div", { class: "ae-hero" },
      h("div", { class: "ae-hero-main" },
        o.sim ? h("p", { class: "ae-simbar", role: "note" }, h("b", {}, COPY.sim.flag), " ", COPY.sim.line) : null,
        h("p", { class: "ae-eyebrow" }, COPY.hero.eyebrow),
        h("h3", { class: "ae-title" }, returning ? COPY.hero.backTitle : COPY.hero.title),
        h("p", { class: "ae-sub ae-lede" }, o.sim ? COPY.hero.simOn : returning ? COPY.hero.backSub : COPY.hero.sub),
        o.safety ? h("div", { class: "ae-safety", role: "note" }, h("span", {}, COPY.safety.line), button(COPY.safety.ok, o.act.ackSafety)) : null,
        h("div", { class: "ae-actions" }, ...(simMain ? [simBtn, startBtn] : [startBtn, simBtn])),
        nextDrill,
        deviceSlot,
        o.can.ok ? h("p", { class: "ae-hint" }, o.sim ? COPY.hero.simOn : noBle ? COPY.hero.noBle : COPY.hero.simHint)
          : h("p", { class: "ae-rest", id: "ae-rest-line" }, o.can.reason === "cap" ? COPY.card.cap : `${COPY.card.restLine} ${COPY.card.rematchIn(mmss(o.can.waitMs))}`),
        o.can.reason === "rest" ? button(COPY.card.rested, o.act.rested, "ae-ghost", { id: "ae-rested" }) : null,
        // capped: the way forward is the next person, so it is right here and not only on a Card that may be long gone
        o.can.reason === "cap" ? button(COPY.card.nextVisitor, o.act.nextVisitor, "ae-ghost", { id: "ae-next" }) : null,
        o.last ? h("p", { class: "ae-last" }, COPY.card.lastCard(o.last.name || "—", o.last.flames)) : null),
      side);

    // the five stations, each with your best (or "No mark yet"), so the first screen is the whole program at a glance
    const program = h("ol", { class: "ae-program", "aria-label": COPY.program.label },
      ...C.STATIONS.map((s, i) => {
        const c = COPY.stations[s.id], b = o.sim ? null : view.stations[s.id];
        const one = s.id === "onefoot" && b ? h("span", { class: "ae-prog-sub" }, `${COPY.words.left[0]} `, b.l ? uval("height", b.l) : "—", ` · ${COPY.words.right[0]} `, b.r ? uval("height", b.r) : "—") : null;
        const sp = s.id === "sprint" && b ? h("span", { class: "ae-prog-sub" }, COPY.words.steps(b.n)) : null;
        return h("li", { class: `ae-prog${i === 0 ? " is-next" : ""}`, "data-station": s.id },
          h("span", { class: "ae-prog-head" }, stationIcon(s.id), h("span", { class: "ae-prog-n" }, String(s.n)), i === 0 ? h("span", { class: "ae-chip" }, COPY.program.up) : null),
          h("span", { class: "ae-prog-name" }, c.name),
          h("span", { class: "ae-prog-best" }, h("span", { class: "ae-k" }, COPY.program.best), h("span", { class: "ae-prog-val" }, ...(b ? (([n, u]) => [n, " ", u])(numUnit(b.kind, b.value, { cls: "is-stamp" })) : [valueNode(null)])), one, sp));
      }));
    fill(root, h("div", { class: "ae-idle" }, hero, program));
    return { el: hero };
  }

  // ---------------------------------------------------------------- the stage: a Combine in progress
  /**
   * Builds the running view once; the returned handle updates it in place so animations are not restarted by every event.
   * @param {{sim: boolean, act: object}} o
   */
  function renderRun(root, o) {
    const rail = h("ol", { class: "ae-rail", "aria-label": COPY.card.stampsAria });
    const items = {};
    for (const s of C.STATIONS) {
      const val = h("span", { class: "ae-rail-val", "aria-hidden": "true" });
      const state = h("span", { class: "ae-sr" });
      const li = h("li", { class: "ae-rail-item is-todo" }, stationIcon(s.id), h("span", { class: "ae-rail-n" }, String(s.n)), h("span", { class: "ae-rail-name" }, COPY.stations[s.id].short), val, state);
      items[s.id] = { li, val, state };
      rail.append(li);
    }
    const kicker = h("p", { class: "ae-kicker" });
    const name = h("h3", { class: "ae-station" });
    const prompt = h("p", { class: "ae-prompt", id: "ae-prompt" });
    const how = h("p", { class: "ae-how" });
    const status = h("p", { class: "ae-status is-wait", id: "ae-status" });
    let promptText = "", dwellTimer = null;
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
    fill(root, h("div", { class: "ae-run" },
      o.sim ? h("p", { class: "ae-simbar", role: "note" }, h("b", {}, COPY.sim.flag), " ", COPY.sim.line) : null,
      rail, h("div", { class: "ae-run-main" }, promptCard, resultSlot), actions));

    const stateWord = { done: COPY.stage.stampDone, skipped: COPY.stage.stampSkipped, notrun: COPY.stage.stampNotRun, todo: "", active: "" };
    const markFor = { done: "✓", skipped: "–", notrun: "–", todo: "", active: "" };

    /** Before a result: what to beat (your best, with the tower for a height) or the invitation to set a first mark. */
    function showWait(id, target, sprintN) {
      const c = COPY.stations[id];
      const kind = target?.kind ?? (id === "firststep" ? "ms" : id === "sprint" ? "s" : id === "bounce" ? "score" : "height");
      const [num, unit] = target ? numUnit(kind, target.value, { cls: "is-target" }) : [kind === "height" ? null : stationIcon(id, "ae-ico-xl"), null];
      const marks = [];
      if (kind === "height" && target) {
        if (id === "leap") marks.push({ cm: target.value, tone: "best", label: COPY.next.yourBest });
        else { if (target.l) marks.push({ cm: target.l, tone: "best", label: COPY.words.left }); if (target.r) marks.push({ cm: target.r, tone: "best", label: COPY.words.right }); }
      }
      const withTower = kind === "height";
      const res = h("div", { class: `ae-result is-wait${withTower ? " has-tower" : ""}`, id: "ae-result" },
        h("div", { class: "ae-result-body" },
          h("p", { class: "ae-result-label" }, target ? COPY.next.beat : COPY.next.first),
          num ? h("p", { class: `ae-result-line${target ? "" : " is-icon"}` }, num, unit) : null,
          h("p", { class: "ae-near" }, target ? (id === "sprint" && target.n ? COPY.words.steps(target.n) : COPY.next.yourBest) : c.name)),
        withTower ? tower({ marks, animate: false, empty: true }) : null);
      resultSlot.replaceChildren(res);
    }

    return {
      /** status: { leap: "done"|..., ... }, active: station id or null, values: what each finished station shows (C.railValues) */
      setRail(status_, active, values = {}) {
        for (const s of C.STATIONS) {
          const st = s.id === active ? "active" : status_[s.id] ?? "todo";
          const it = items[s.id];
          it.li.className = `ae-rail-item is-${st}`;
          if (st === "active") it.li.setAttribute("aria-current", "step"); else it.li.removeAttribute("aria-current");
          it.val.replaceChildren(st === "done" && values[s.id] ? valueNode(values[s.id]) : (markFor[st] ?? ""));
          it.state.textContent = stateWord[st] ? ` ${stateWord[st]}` : "";
        }
      },
      /** `target`: C.idleView().stations[id], your best at this station before this round (null for none) */
      setStation(id, { sprintN = 5, target = null, dwellMs = 0 } = {}) {
        const st = C.STATIONS.find((x) => x.id === id);
        if (!st) { kicker.textContent = ""; name.textContent = ""; prompt.textContent = ""; how.textContent = ""; return; }
        const c = COPY.stations[id];
        kicker.textContent = COPY.stage.stationOf(st.n, C.STATIONS.length);
        name.textContent = c.name; prompt.textContent = promptText = c.prompt; prompt.classList.remove("is-go"); promptCard.classList.remove("is-go");
        how.textContent = typeof c.how === "function" ? c.how(sprintN) : c.how;
        promptCard.classList.remove("is-fresh"); void promptCard.offsetWidth; promptCard.classList.add("is-fresh");
        sub.replaceChildren(); warm.replaceChildren(); dev.replaceChildren(); hint.textContent = "";
        // a result that has just landed stays up for a few seconds (the reveal), then the next station's "to beat" takes its place
        clearTimeout(dwellTimer);
        const cur = resultSlot.firstElementChild;
        if (dwellMs > 0 && cur && !cur.classList.contains("is-wait")) dwellTimer = setTimeout(() => { if (resultSlot.firstElementChild === cur) showWait(id, target, sprintN); }, dwellMs);
        else showWait(id, target, sprintN);
      },
      setStatus(text, { wait = true } = {}) { status.textContent = text ?? ""; status.classList.toggle("is-wait", !!wait); },
      /** GO: a steady big caption (never a flash) while the window is open; off puts the station's own prompt back */
      setGo(on, word = COPY.stage.go) {
        prompt.classList.toggle("is-go", !!on); promptCard.classList.toggle("is-go", !!on);
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
        fill(dev,
          connect ? button(COPY.stage.connect, connect, "", { id: "ae-connect" }) : null,
          button(COPY.stage.simulate, sim, connect ? "ae-ghost" : "primary", { id: "ae-sim-inline" }));
      },
      setSkipLabel(label) { $("ae-skip").textContent = label; },
      /** Show a result: count-up number, shape + word judgment, ghost bar (the tower for a height). `fx` only decorates (the ribbon is added by the gated reward). */
      showRep(rep) {
        clearTimeout(dwellTimer);
        const slot = $("ae-result-slot");
        const better = rep.better ?? "higher";
        const meter = C.meterPcts(better, rep.value, rep.ghost);
        const final = (v) => (rep.valueKind === "height" ? U.fmt("height", v) : rep.valueKind === "ms" ? String(Math.round(v)) : v.toFixed(2));
        const unitText = () => (rep.valueKind === "height" ? U.unit("height") : rep.valueKind === "ms" ? COPY.words.ms : rep.valueKind === "s" ? COPY.words.s : COPY.words.score);
        const [numEl, unitEl] = numUnit(rep.valueKind, rep.value);
        const near = nearLine(rep);
        const isHeight = rep.valueKind === "height";
        let visual;
        if (isHeight) {
          // the tower: your leap rises to its height; the amber flag is the best you are chasing (the best from before this result)
          visual = tower({ fill: rep.value, marks: rep.ghost != null && !rep.warmup ? [{ cm: rep.ghost, tone: "best", label: COPY.near.best }] : [] });
        } else {
          const fillEl = h("span", { class: "ae-meter-fill", style: { "--ae-fill": `${meter.fill}%` } });
          const ghostMark = meter.ghost != null ? h("span", { class: "ae-meter-ghost", style: { "--ae-ghost": `${meter.ghost}%` } }) : null;
          visual = h("div", { class: "ae-meter", role: "img" }, fillEl, ghostMark);
          // the meter's spoken label is built from the live number and gap, and rebuilt when Metric / Imperial flips (see relabelMeters)
          visual.relabel = () => visual.setAttribute("aria-label", `${rep.label}: ${final(rep.value)} ${unitText()}${near ? `, ${near.textContent}` : ""}`);
          visual.relabel();
        }
        const res = h("div", { class: `ae-result is-fresh${isHeight ? " has-tower" : ""}`, id: "ae-result", "data-judge": rep.judgment.id },
          h("span", { class: "ae-ribbon", "aria-hidden": "true" }, COPY.judge.pb),
          h("div", { class: "ae-result-body" },
            h("p", { class: "ae-result-label" }, rep.label),
            h("p", { class: "ae-result-line" }, numEl, unitEl),
            h("p", { class: "ae-judge-row" }, judgeChip(rep.judgment), rep.warmup && rep.judgment.id !== "warmup" ? h("span", { class: "ae-tag" }, COPY.stage.warmupTag) : null, near),
            isHeight ? null : visual,
            !isHeight && rep.ghost != null ? h("div", { class: "ae-meter-legend" }, h("span", { class: "ae-key" }, rep.label), h("span", { class: "ae-key is-ghost" }, COPY.near.best, " ", ghostValue(rep))) : null,
            h("p", { class: "ae-fun", id: "ae-fun" })),
          isHeight ? visual : null);
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
   * @param {{sum: object, heat: object, story: object, xp: object|null, level: object|null, sim: boolean, booth: boolean, canBoard: boolean,
   *   pulseDue: boolean, prevVisit: boolean, act: object}} o
   *   booth  booth mode keeps no profile, so the Card shows no XP or level and makes no "come back" promise
   */
  function renderCard(root, o) {
    const { sum } = o;
    const stamps = h("ol", { class: "ae-stamps", "aria-label": COPY.card.stampsAria });
    C.STATIONS.forEach((s, i) => stamps.append(stampRow(s, sum, i)));

    const flames = h("span", { class: "ae-flames", "aria-hidden": "true" }, ...[1, 2, 3, 4, 5].map((n, i) => flame(n <= o.heat.flames, i)));
    const heat = h("div", { class: "ae-heat", role: "img", "aria-label": `${COPY.card.heat}: ${o.heat.name || "none"}, ${COPY.card.flamesOf(o.heat.flames)}` },
      flames, h("span", { class: "ae-heat-name" }, o.heat.name || "—"), h("span", { class: "ae-heat-n" }, COPY.card.flamesOf(o.heat.flames)));

    const bal = sum.onefoot.balance;
    const progression = !(o.booth && !o.sim);
    // at most one note under the Card's numbers: what matters most for this Card, said once
    const note = o.sim ? COPY.card.simNote
      : sum.warmupOnly ? COPY.card.warmNote
      : sum.early ? null
      : o.booth ? COPY.card.boothNote
      : o.prevVisit ? COPY.card.prevNote : COPY.card.first;
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
      h("div", { class: "ae-card-head" }, h("h3", { class: "ae-card-title", id: "ae-card-h", tabindex: "-1" }, COPY.card.title), o.sim ? h("span", { class: "ae-tag is-sim" }, COPY.card.simTag) : null),
      heat, stamps,
      story.length ? h("p", { class: "ae-story" }, story.join(" ")) : null,
      bal ? h("p", { class: "ae-line" }, `${COPY.words.left[0]} `, uval("height", bal.l), ` / ${COPY.words.right[0]} `, uval("height", bal.r), `: ${bal.pct}% ${COPY.words.apart}`) : null,
      o.xp && progression ? h("p", { class: "ae-xp-line" }, COPY.card.xp(o.xp.gained), o.level ? ` · ${COPY.card.level(o.level.level, o.level.title)}` : "") : null,
      note ? h("p", { class: "ae-note" }, note) : null,
      add,
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
    li.append(h("span", { class: "ae-stamp-head" }, stationIcon(s.id), h("span", { class: "ae-stamp-n", "aria-hidden": "true" }, String(s.n)), h("span", { class: "ae-stamp-name" }, c.name)));
    const val = h("span", { class: "ae-stamp-val" });
    const subs = h("div", { class: "ae-stamp-sub" });
    const sv = (kind, v) => { const [n, u] = numUnit(kind, v, { cls: "is-stamp" }); val.append(n, " ", u); };
    if (status !== "done") {
      val.textContent = status === "skipped" ? COPY.stage.stampSkipped : COPY.stage.stampNotRun;
    } else if (s.id === "leap") {
      sv("height", sum.leap.cm); subs.append(judgeChip(sum.leap.judgment));
      if (sum.leap.warmup && sum.leap.judgment.id !== "warmup") subs.append(h("span", { class: "ae-tag" }, COPY.stage.warmupTag));
    } else if (s.id === "onefoot") {
      sv("height", sum.onefoot.anyBest);
      subs.append(h("span", {}, `${COPY.words.left[0]} `, uval("height", sum.onefoot.L.cm), ` / ${COPY.words.right[0]} `, uval("height", sum.onefoot.R.cm)));
      const j = [sum.onefoot.L, sum.onefoot.R].sort((a, b) => b.cm - a.cm)[0].judgment;
      subs.append(judgeChip(j));
    } else if (s.id === "firststep") {
      const best = sum.firststep.trials.reduce((a, t) => (t.stepMs < a.stepMs ? t : a));
      sv("ms", best.stepMs); subs.append(judgeChip(best.judgment), h("span", {}, COPY.words.steps(sum.firststep.trials.length)));
    } else if (s.id === "sprint") {
      sv("s", sum.sprint.s); subs.append(judgeChip(sum.sprint.judgment), h("span", {}, COPY.words.steps(sum.sprint.n)));
      if (sum.sprint.split3 != null) subs.append(h("span", {}, COPY.words.split3(sum.sprint.split3.toFixed(2))));
    } else if (s.id === "bounce") {
      sv("score", sum.bounce.rsi); subs.append(sum.bounce.judgment ? judgeChip(sum.bounce.judgment) : "", h("span", {}, COPY.words.hops(sum.bounce.hops)));
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
    const staff = o.staff !== false;   // false: a visitor on a booth device
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
      // staff controls: on a booth tablet a visitor sees sound, motion and theme only; the booth switch, the board and the data are staff's
      staff ? check("ae-booth", COPY.settings.booth, o.booth, o.act.booth) : null,
      check("ae-moon", COPY.settings.moon, o.moon, (v) => o.act.play("moon", v)),
      check("ae-jupiter", COPY.settings.jupiter, o.jupiter, (v) => o.act.play("jupiter", v)),
      staff ? h("div", { class: "ae-actions" },
        button(COPY.settings.stats, o.act.stats),
        sure(COPY.settings.clearBoard, COPY.settings.clearBoardSure, o.act.clearBoard),
        sure(COPY.settings.forget, COPY.settings.forgetSure, o.act.forget)) : null,
      h("p", { class: "ae-note", id: "ae-forgot" }),
      h("p", { class: "ae-note" }, COPY.settings.privacy),
      h("p", { class: "ae-note" }, COPY.settings.haptics));
  }

  return { uval, judgeChip, syncMode, renderIdle, renderRun, renderCard, renderBoard, renderLevel, renderSettings, mmss };
}
