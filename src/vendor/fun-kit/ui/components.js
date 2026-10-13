// Render helpers + tiny custom elements. Light DOM, no framework, styled only
// through the --fk-* CSS custom properties the host defines (see tokens.css).
//
//   renderXpBar(xp.info())              renderStreakFlame(streaks.state(), { recent })
//   renderChallengeCard(challenge)       renderBadgeGrid(achievements.collection())
//   renderRecapCarousel(recap)           registerElements() -> <fk-xp-bar> etc. with a .data setter

import { h, clampPct } from "./dom.js";
import { iconSvg } from "./icons.js";
import { ringSvg } from "../juice/ring.js";
import { prefersReducedMotion } from "../juice/celebrate.js";
import { labelsFor } from "../labels.js";
import { toNextText } from "../xp.js";

// Every word these helpers print comes from labels.js: pass `labels` to any of them, or call setLabels() once.

const svgEl = (html) => { const t = globalThis.document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const withIcon = (name, opts) => svgEl(`<span class="fk-icon">${iconSvg(name, opts)}</span>`);

// ---------------------------------------------------------------- XP bar

export function renderXpBar(info, { label, labels } = {}) {
  const L = labelsFor(labels);
  const pct = clampPct(info.pct);
  return h("div", { class: "fk-xp" },
    h("div", { class: "fk-xp-head" },
      h("span", { class: "fk-xp-level" }, `${label ?? L("level")} ${info.level}`),
      h("span", { class: "fk-xp-title" }, info.title ?? "")),
    h("div", { class: "fk-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(info.need || 1), "aria-valuenow": String(info.into), "aria-label": L("xpBarAria", { into: info.into, need: info.need }) },
      h("div", { class: "fk-bar-fill", style: { "--fk-pct": `${pct}%` } })),
    h("div", { class: "fk-xp-foot" }, toNextText(info, L)));
}

// ---------------------------------------------------------------- streak flame

const FLAME_KEY = { none: "flameNone", done: "flameDone", ready: "flameReady", resting: "flameResting", lapsed: "flameLapsed", building: "flameBuilding", reached: "flameReached" };

/** @param {object} state from streaks.state() */
export function renderStreakFlame(state, { recent, unit, labels } = {}) {
  const L = labelsFor(labels);
  if (state.mode === "off") return h("div", { class: "fk-flame is-off", hidden: true });
  const weekly = state.mode === "weekly";
  const cls = state.status === "lapsed" ? "is-ember" : state.status === "resting" ? "is-rest" : state.status === "none" ? "is-ember" : state.doneToday || state.status === "reached" ? "is-lit" : "is-warm";
  // Between runs (a lapse, or the first sessions of a fresh run) show the best run instead of a discouraging 0.
  const showBest = state.current === 0 && state.best > 0 && (state.status === "lapsed" || state.status === "building");
  const big = showBest ? state.best : state.current;
  const u = unit ?? L(weekly ? "unitWeek" : "unitDay", { n: big });
  const flame = withIcon(state.status === "resting" ? "moon" : "flame", { size: "2.4em" });
  const banked = state.tokens != null ? L(weekly ? "restBankedWeek" : "restBankedDay", { n: state.tokens }) : "";
  const root = h("div", { class: `fk-flame ${cls}${state.current >= 7 ? " is-blazing" : ""}` },
    h("div", { class: "fk-flame-icon" }, flame),
    h("div", { class: "fk-flame-body" },
      h("div", { class: "fk-flame-num" }, h("strong", {}, String(big)), h("span", {}, showBest ? L("best", { unit: u }) : u)),
      h("div", { class: "fk-flame-copy" }, showBest && state.status === "building" ? L("flameFreshRun") : FLAME_KEY[state.status] ? L(FLAME_KEY[state.status]) : ""),
      state.tokens != null ? h("div", { class: "fk-flame-tokens", "aria-label": banked }, withIcon("moon", { size: "1em" }), ` ${banked}`) : null));
  if (weekly && state.thisWeek) {
    const w = state.thisWeek;
    const counting = w.unit ?? state.unit ?? "sessions";
    root.append(h("div", { class: "fk-flame-week", role: "img", "aria-label": L("weekPipsAria", { count: Math.min(w.count, w.target), target: w.target, unit: L(counting === "days" ? "unitDay" : "unitSession", { n: 2 }) }) },
      ...Array.from({ length: w.target }, (_, i) => h("span", { class: `fk-pip${i < w.count ? " is-on" : ""}` }))));
  } else if (recent?.length) {
    root.append(h("div", { class: "fk-flame-week", role: "img", "aria-label": L("recentPipsAria") },
      ...recent.map((d) => h("span", { class: `fk-pip${d.active ? " is-on" : d.covered ? " is-rest" : ""}${d.today ? " is-today" : ""}`, title: d.day }))));
  }
  return root;
}

// ---------------------------------------------------------------- challenge card

/**
 * @param {object} c a challenge from challenges.today() / week()
 * @param {{onReroll?: (c: object) => void, labels?: object}} [o] labels: easy / medium / hard (the chip), thisWeek, complete, swap ... (labels.js).
 *   A challenge with a `chip` string (copied from its template) shows that on the chip instead.
 */
export function renderChallengeCard(c, { onReroll, labels } = {}) {
  const L = labelsFor(labels);
  const pct = clampPct(c.pct ?? 0);
  const chip = c.chip ?? (c.period === "weekly" ? L("thisWeek") : L(c.difficulty));
  const card = h("article", { class: `fk-challenge${c.done ? " is-done" : ""} fk-diff-${c.difficulty}` },
    h("div", { class: "fk-challenge-top" },
      h("span", { class: "fk-chip" }, chip),
      // The tick sits in the top row beside the XP, so it never covers a title that wraps onto a second line.
      h("span", { class: "fk-challenge-reward" },
        c.done ? h("span", { class: "fk-challenge-check", "aria-hidden": "true" }, withIcon("check", { size: "1.2em" })) : null,
        h("span", { class: "fk-challenge-xp" }, `+${c.xp} XP`))),
    h("h3", { class: "fk-challenge-title" }, c.title),
    c.description ? h("p", { class: "fk-challenge-desc" }, c.description) : null,
    h("div", { class: "fk-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(c.target), "aria-valuenow": String(Math.round(c.progress)), "aria-label": L("challengeProgressAria", { title: c.title, progress: Math.round(c.progress), target: c.target }) },
      h("div", { class: "fk-bar-fill", style: { "--fk-pct": `${pct}%` } })),
    h("div", { class: "fk-challenge-foot" },
      h("span", {}, c.done ? L("complete") : `${Math.round(c.progress)} / ${c.target}`),
      c.canReroll && onReroll ? h("button", { type: "button", class: "fk-btn fk-btn-quiet fk-btn-sm", onclick: () => onReroll(c), "aria-label": L("swapAria", { title: c.title }) }, withIcon("refresh", { size: "1em" }), ` ${L("swap")}`) : null));
  return card;
}

// ---------------------------------------------------------------- badge grid

export function renderBadgeGrid(collection, { onSelect, labels } = {}) {
  const L = labelsFor(labels);
  const head = h("div", { class: "fk-badges-head" },
    h("strong", {}, `${collection.unlockedCount} of ${collection.total}`),
    h("span", {}, collection.secretsRemaining ? ` ${L("badgesWord")} · ${L("secretsLeft", { n: collection.secretsRemaining })}` : ` ${L("badgesWord")}`));
  const grid = h("ul", { class: "fk-badges", role: "list" });
  for (const b of collection.items) {
    const pct = b.progress && !b.unlocked ? clampPct(b.progress.pct) : 0;
    const tile = h("button", {
      type: "button", class: `fk-badge fk-tier-${b.tier}${b.unlocked ? " is-on" : " is-off"}${b.secret ? " is-secret" : ""}`,
      "aria-label": `${b.title}. ${b.unlocked ? L("badgeUnlockedState") : b.secret ? L("badgeSecretState") : L("badgeLockedState")}. ${b.desc}`,
      onclick: () => onSelect?.(b),
    },
      h("span", { class: "fk-badge-icon" }, withIcon(b.secret ? "lock" : b.unlocked ? b.icon : "lock", { size: "1.6em" })),
      h("span", { class: "fk-badge-name" }, b.title),
      b.progress && !b.unlocked ? h("span", { class: "fk-bar fk-bar-sm", "aria-hidden": "true" }, h("span", { class: "fk-bar-fill", style: { "--fk-pct": `${pct}%` } })) : null,
      h("span", { class: "fk-badge-tier" }, b.tier));
    grid.append(h("li", {}, tile));
  }
  return h("section", { class: "fk-badges-wrap" }, head, grid);
}

// ---------------------------------------------------------------- recap carousel

export function renderRecapCarousel(cards, { onShare, onDone, doneLabel, shareLabel, labels } = {}) {
  const L = labelsFor(labels);
  doneLabel ??= L("done"); shareLabel ??= L("share");
  let index = 0;
  const track = h("div", { class: "fk-recap-track", tabindex: "0" },
    ...cards.map((c, i) => h("div", { class: `fk-recap-card fk-tone-${c.tone ?? "accent"}`, role: "group", "aria-roledescription": "slide", "aria-label": L("slide", { n: i + 1, total: cards.length }) },
      h("div", { class: "fk-recap-eyebrow" }, c.eyebrow),
      h("div", { class: "fk-recap-big" }, c.big, c.unit ? h("small", {}, ` ${c.unit}`) : null),
      h("p", { class: "fk-recap-text" }, c.title),
      c.list?.length > 1 ? h("ul", { class: "fk-recap-list" }, ...c.list.map((x) => h("li", {}, x))) : null)));
  const dots = h("div", { class: "fk-dots", "aria-hidden": "true" }, ...cards.map((_, i) => h("span", { class: `fk-dot${i === 0 ? " is-on" : ""}` })));
  const go = (i) => {
    index = Math.max(0, Math.min(cards.length - 1, i));
    track.children[index]?.scrollIntoView?.({ inline: "center", block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    [...dots.children].forEach((d, k) => d.classList.toggle("is-on", k === index));
    prev.disabled = index === 0; next.disabled = index === cards.length - 1;
  };
  const prev = h("button", { type: "button", class: "fk-btn fk-btn-quiet", onclick: () => go(index - 1), "aria-label": L("prevCard") }, L("back"));
  const next = h("button", { type: "button", class: "fk-btn", onclick: () => go(index + 1), "aria-label": L("nextCard") }, L("next"));
  const root = h("section", { class: "fk-recap", role: "region", "aria-roledescription": "carousel", "aria-label": L("recapRegion") },
    track, dots,
    h("div", { class: "fk-recap-actions" }, prev, onShare ? h("button", { type: "button", class: "fk-btn fk-btn-quiet", onclick: onShare }, withIcon("share", { size: "1em" }), ` ${shareLabel}`) : null, next, onDone ? h("button", { type: "button", class: "fk-btn", onclick: onDone }, doneLabel) : null));
  root.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") go(index + 1); if (e.key === "ArrowLeft") go(index - 1); });
  track.addEventListener("scroll", () => {
    const w = track.clientWidth || 1;
    const i = Math.round(track.scrollLeft / (track.children[0]?.offsetWidth || w));
    if (i !== index && i >= 0 && i < cards.length) { index = i; [...dots.children].forEach((d, k) => d.classList.toggle("is-on", k === i)); prev.disabled = i === 0; next.disabled = i === cards.length - 1; }
  }, { passive: true });
  prev.disabled = true; next.disabled = cards.length < 2;
  return root;
}

// ---------------------------------------------------------------- ring wrapper

export function renderRing(opts) { const w = h("div", { class: "fk-ring-wrap" }); w.innerHTML = ringSvg(opts); return w; }

// ---------------------------------------------------------------- custom elements

const ELEMENTS = {
  "fk-xp-bar": (d, el) => renderXpBar(d, el._opts),
  "fk-streak-flame": (d, el) => renderStreakFlame(d, el._opts),
  "fk-challenge-card": (d, el) => renderChallengeCard(d, el._opts),
  "fk-badge-grid": (d, el) => renderBadgeGrid(d, el._opts),
  "fk-recap-carousel": (d, el) => renderRecapCarousel(d, el._opts),
  "fk-ring": (d) => renderRing(d),
};

/** Define <fk-xp-bar>, <fk-streak-flame>, <fk-challenge-card>, <fk-badge-grid>, <fk-recap-carousel>, <fk-ring>. Safe to call twice. */
export function registerElements() {
  if (!globalThis.customElements) return;
  for (const [tag, render] of Object.entries(ELEMENTS)) {
    if (customElements.get(tag)) continue;
    customElements.define(tag, class extends HTMLElement {
      set data(v) { this._data = v; this.refresh(); }
      get data() { return this._data; }
      set options(v) { this._opts = v; this.refresh(); }
      refresh() { if (this._data != null) this.replaceChildren(render(this._data, this)); }
      connectedCallback() { this.refresh(); }
    });
  }
}
