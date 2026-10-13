// Onboarding helpers:
//   createFirstWin   - script the first 60 seconds so every newcomer gets a win fast
//                      (beats, a gentle nudge when stuck, an "assist" signal that tells the
//                      app to make the first win easier). Persists so it runs once.
//   createTour       - coach-mark tour with spotlight, Next / Back / Skip, remembered per tour.
//   createAnnouncer  - queue feature-unlock announcements so they never stack.

import { createEmitter } from "./emitter.js";
import { getLabel } from "./labels.js";

export const FIRST_WIN_TARGET_MS = 60000;

/**
 * @param {{store: any, beats: Array<{id: string, text: string, hint?: string, on?: string}>, winEvent?: string | string[],
 *   nudgeAfterMs?: number, assistAfterMs?: number, now?: () => number}} opts
 * A beat completes when `event(beat.on ?? beat.id)` fires. The last beat's completion is the win, and so is any event
 * named in `winEvent` (one name or a list: "smash", or ["smash", "lap"] when a lap that ends without the smash should
 * still stop the clock). `win()` ends it directly for any other success.
 */
export function createFirstWin({ store, beats, winEvent, nudgeAfterMs = 10000, assistAfterMs = 25000, now = Date.now } = {}) {
  const KEY = "firstwin";
  const emitter = createEmitter();
  const winNames = new Set([].concat(winEvent ?? []).filter((x) => typeof x === "string" && x));
  const load = () => store.get(KEY, { startedAt: null, index: 0, beatAt: null, doneAt: null, nudged: [], assisted: false, timeToWinMs: null });

  function start() {
    const st = load();
    if (st.doneAt != null || st.startedAt != null) return state();
    st.startedAt = st.beatAt = now();
    store.set(KEY, st);
    emitter.emit("beat", { beat: beats[0], index: 0 });
    return state();
  }

  /** End the first win now, whatever beat it is on (a generic success: a lap finished, any graded set). A no-op once done or before start(). */
  function win(reason = "win") { return event(null, reason); }

  function event(name, reason) {
    const st = load();
    if (st.doneAt != null || st.startedAt == null) return state();
    const beat = beats[st.index];
    const isWin = name == null ? reason != null : winNames.has(name);
    if (beat && name != null && name === (beat.on ?? beat.id) || isWin) {
      st.index = isWin ? beats.length : st.index + 1;
      st.beatAt = now();
      if (st.index >= beats.length) {
        st.doneAt = now();
        st.timeToWinMs = st.doneAt - st.startedAt;
        store.set(KEY, st);
        emitter.emit("win", { timeToWinMs: st.timeToWinMs, withinTarget: st.timeToWinMs <= FIRST_WIN_TARGET_MS, by: isWin ? (name ?? reason) : (beat?.id ?? null) });
        return state();
      }
      store.set(KEY, st);
      emitter.emit("beat", { beat: beats[st.index], index: st.index });
    }
    return state();
  }

  /** Call from a timer (e.g. every second). Fires "nudge" once per beat and "assist" once. */
  function tick() {
    const st = load();
    if (st.doneAt != null || st.startedAt == null) return null;
    const beat = beats[st.index];
    const stuck = now() - st.beatAt;
    const sinceStart = now() - st.startedAt;
    let fired = null;
    if (stuck >= nudgeAfterMs && !st.nudged.includes(beat.id)) {
      st.nudged.push(beat.id);
      fired = { type: "nudge", text: beat.hint ?? beat.text, beat };
      emitter.emit("nudge", fired);
    }
    if (sinceStart >= assistAfterMs && !st.assisted) {
      st.assisted = true;
      fired = { type: "assist", beat };
      emitter.emit("assist", fired);
    }
    if (fired) store.set(KEY, st);
    return fired;
  }

  function state() {
    const st = load();
    return {
      active: st.startedAt != null && st.doneAt == null, done: st.doneAt != null, index: st.index, beat: st.doneAt != null ? null : beats[st.index] ?? null,
      total: beats.length, elapsedMs: st.startedAt != null ? (st.doneAt ?? now()) - st.startedAt : 0, timeToWinMs: st.timeToWinMs,
      withinTarget: st.timeToWinMs != null ? st.timeToWinMs <= FIRST_WIN_TARGET_MS : null, assisted: st.assisted,
    };
  }

  return { start, event: (name) => event(name), win, tick, state, isDone: () => load().doneAt != null, on: emitter.on, off: emitter.off, reset: () => store.remove(KEY) };
}

/** Pure tour state machine (testable without DOM). */
export function createTourState(steps) {
  let i = 0, status = "idle";
  return {
    start() { status = steps.length ? "running" : "done"; i = 0; return this.get(); },
    next() { if (status !== "running") return this.get(); if (i >= steps.length - 1) status = "done"; else i++; return this.get(); },
    back() { if (status === "running" && i > 0) i--; return this.get(); },
    skip() { status = "skipped"; return this.get(); },
    get: () => ({ status, index: i, step: status === "running" ? steps[i] : null, total: steps.length, last: i === steps.length - 1 }),
  };
}

/**
 * Coach-mark tour. Skippable at every step; remembered so it only runs once.
 * steps: [{ id, target?: selector|Element|()=>Element, title, body }]
 *
 * The target is scrolled into view BEFORE it is measured, the cut-out is clamped to the viewport, and the card is placed
 * (below, above, or over the bottom of the screen for a very tall target) so Back / Next / Skip are always on screen.
 * Focus is trapped inside while it is open, and the layout follows scroll and resize.
 */
export function createTour({ store, id = "intro", steps, doc = globalThis.document, labels = {}, onDone } = {}) {
  const KEY = `tour.${id}`;
  const L = { next: "Next", back: "Back", done: "Got it", skip: "Skip tour", of: "of", ...labels };
  const machine = createTourState(steps);
  const emitter = createEmitter();
  let root = null, prevFocus = null, spotEl = null, cardEl = null, targetNode = null, raf = 0;
  const win = () => doc.defaultView ?? globalThis;

  const seen = () => !!store.get(KEY, null);
  const remember = (outcome) => store.set(KEY, { outcome, at: Date.now() });

  function targetEl(step) {
    const t = step.target;
    if (!t) return null;
    try { return typeof t === "function" ? t() : typeof t === "string" ? doc.querySelector(t) : t; } catch { return null; }
  }

  const tokenPx = (name, fallback) => {
    try { const v = parseFloat(win().getComputedStyle(root).getPropertyValue(name)); return Number.isFinite(v) && v > 0 ? v : fallback; } catch { return fallback; }
  };

  /** Position the cut-out and the card from the target's CURRENT rect. Safe to call on scroll / resize. */
  function place() {
    if (!root || !cardEl || !spotEl) return;
    const w = win();
    const vw = w.innerWidth || doc.documentElement.clientWidth || 0, vh = w.innerHeight || doc.documentElement.clientHeight || 0;
    const r = targetNode?.isConnected ? targetNode.getBoundingClientRect() : null;
    cardEl.classList.remove("is-below", "is-above", "is-over", "is-center");
    if (!r || (r.width === 0 && r.height === 0) || !vh) {
      spotEl.classList.add("is-none"); cardEl.classList.add("is-center"); cardEl.style.removeProperty("--fk-card-y");
      return;
    }
    const margin = tokenPx("--fk-space-4", 16), pad = tokenPx("--fk-space-2", 8);
    const top = Math.max(0, r.top - pad), left = Math.max(0, r.left - pad);
    const bottom = Math.min(vh, r.bottom + pad), right = Math.min(vw || r.right + pad, r.right + pad);
    spotEl.classList.remove("is-none");
    spotEl.style.setProperty("--fk-spot-x", `${left}px`); spotEl.style.setProperty("--fk-spot-y", `${top}px`);
    spotEl.style.setProperty("--fk-spot-w", `${Math.max(0, right - left)}px`); spotEl.style.setProperty("--fk-spot-h", `${Math.max(0, bottom - top)}px`);
    const cardH = cardEl.offsetHeight, gap = pad * 2;
    let y, where;
    if (cardH + gap <= vh - bottom - margin) { y = bottom + gap; where = "is-below"; }
    else if (cardH + gap <= top - margin) { y = top - gap - cardH; where = "is-above"; }
    else { y = vh - cardH - margin; where = "is-over"; } // tall target: the card rides over the bottom of the screen
    y = Math.min(Math.max(y, margin), Math.max(margin, vh - cardH - margin));
    cardEl.classList.add(where);
    cardEl.style.setProperty("--fk-card-y", `${y}px`);
  }

  const onMove = () => {
    const w = win();
    if (!w.requestAnimationFrame) return place();
    if (raf) return;
    raf = w.requestAnimationFrame(() => { raf = 0; place(); });
  };

  const trapKeys = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); skip(); return; }
    if (e.key !== "Tab" || !root) return;
    const focusable = [...root.querySelectorAll("button:not([disabled])")];
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1], active = doc.activeElement;
    const outside = !root.contains(active);
    if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
  };
  const pullFocusBack = (e) => { if (root && !root.contains(e.target)) root.querySelector(".fk-tour-next")?.focus(); };

  function open() {
    root = doc.createElement("div");
    root.className = "fk-tour";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.tabIndex = -1;
    root.addEventListener("keydown", trapKeys);
    doc.body.appendChild(root);
    prevFocus = doc.activeElement;
    doc.addEventListener("focusin", pullFocusBack);
    const w = win();
    w.addEventListener?.("resize", onMove);
    w.addEventListener?.("scroll", onMove, true);
  }

  function render() {
    const s = machine.get();
    if (s.status !== "running") return close(s.status);
    if (!root) open();
    const step = s.step;
    targetNode = targetEl(step);
    if (targetNode) {
      // Scroll first, measure after (place() reads the rect again): a rect taken before the scroll points at the wrong place.
      const vh = win().innerHeight || 800;
      const tall = (targetNode.getBoundingClientRect?.().height ?? 0) > vh * 0.6;
      try { targetNode.scrollIntoView?.({ block: tall ? "start" : "center", inline: "nearest", behavior: "instant" }); } catch { try { targetNode.scrollIntoView?.(); } catch {} }
    }
    root.replaceChildren();
    spotEl = doc.createElement("div");
    spotEl.className = "fk-tour-spot is-none";
    cardEl = doc.createElement("div");
    cardEl.className = "fk-tour-card is-center";
    const count = doc.createElement("div"); count.className = "fk-tour-count"; count.textContent = `${s.index + 1} ${L.of} ${s.total}`;
    const title = doc.createElement("h2"); title.id = `fk-tour-${id}-t`; title.textContent = step.title;
    const body = doc.createElement("p"); body.textContent = step.body;
    root.setAttribute("aria-labelledby", title.id);
    const row = doc.createElement("div"); row.className = "fk-tour-row";
    const skipB = doc.createElement("button"); skipB.type = "button"; skipB.className = "fk-btn fk-btn-quiet fk-tour-skip"; skipB.textContent = L.skip; skipB.addEventListener("click", skip);
    const backB = doc.createElement("button"); backB.type = "button"; backB.className = "fk-btn fk-btn-quiet"; backB.textContent = L.back; backB.disabled = s.index === 0; backB.addEventListener("click", back);
    const nextB = doc.createElement("button"); nextB.type = "button"; nextB.className = "fk-btn fk-tour-next"; nextB.textContent = s.last ? L.done : L.next; nextB.addEventListener("click", next);
    row.append(skipB, backB, nextB);
    cardEl.append(count, title, body, row);
    root.append(spotEl, cardEl);
    place();
    nextB.focus({ preventScroll: true });
  }

  function close(outcome) {
    if (root) {
      const w = win();
      w.removeEventListener?.("resize", onMove); w.removeEventListener?.("scroll", onMove, true);
      doc.removeEventListener("focusin", pullFocusBack);
      if (raf && w.cancelAnimationFrame) w.cancelAnimationFrame(raf);
      raf = 0;
      root.remove(); root = null; spotEl = cardEl = targetNode = null;
      prevFocus?.focus?.();
    }
    if (outcome === "done" || outcome === "skipped") {
      remember(outcome);
      emitter.emit(outcome, {});
      try { onDone?.(outcome); } catch {}
    }
  }

  function start({ force = false } = {}) {
    if (seen() && !force) return false;
    machine.start(); render(); emitter.emit("start", {});
    return true;
  }
  function next() { machine.next(); render(); }
  function back() { machine.back(); render(); }
  function skip() { machine.skip(); close("skipped"); }

  return { start, next, back, skip, seen, state: machine.get, on: emitter.on, off: emitter.off, reset: () => store.remove(KEY) };
}

/**
 * Feature-unlock announcements: queue, then show one at a time.
 * show(announcement) may return a Promise that resolves when the player dismisses it.
 */
export function createAnnouncer({ store, show, gapMs = 600 } = {}) {
  const KEY = "announced";
  const queue = [];
  let busy = false;
  const done = () => store.get(KEY, []);

  function announce(feature, copy = {}) {
    if (done().includes(feature) || queue.some((q) => q.feature === feature)) return false;
    queue.push({ feature, title: copy.title ?? getLabel("announceTitle"), body: copy.body ?? "", ...copy });
    return true;
  }

  async function flush() {
    if (busy) return 0;
    busy = true;
    let shown = 0;
    try {
      while (queue.length) {
        const a = queue.shift();
        store.update(KEY, (list) => (list.includes(a.feature) ? list : [...list, a.feature]), []);
        try { await show?.(a); } catch {}
        shown++;
        if (queue.length && gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
    } finally { busy = false; }
    return shown;
  }

  return { announce, flush, pending: () => queue.length, hasAnnounced: (f) => done().includes(f), reset: () => { queue.length = 0; store.remove(KEY); } };
}
