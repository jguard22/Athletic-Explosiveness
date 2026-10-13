// Celebration effects: canvas confetti / burst / ribbons, toasts, level-up modal.
//
// Reduced motion (OS setting, or setReducedMotion(true)): no particles and no
// movement. Instead a gentle opacity-only glow fades in and out, and toasts /
// modals simply fade. Colours come from CSS custom properties (--fk-confetti-1..5,
// falling back to --fk-accent / --fk-gold), never from literals.
//
// Everything this file puts on screen can be taken down again: dismissToasts(), dismissModals() and
// dismissCelebrations() (which also stops the particles and the glow, and tells any playOutcome() in flight to stop
// firing cues). A single-page app calls dismissCelebrations() when the route changes.

import { h } from "../ui/dom.js";
import { iconSvg } from "../ui/icons.js";
import { labelsFor } from "../labels.js";
import { countUp } from "./counters.js";

let override = null;
/**
 * Force reduced motion on (true) or off (false), or follow the OS again (null).
 * Also sets :root[data-fk-motion] so the stylesheet's animations follow the same switch.
 */
export function setReducedMotion(v) {
  override = v;
  try {
    const root = globalThis.document?.documentElement;
    if (root) { if (v == null) delete root.dataset.fkMotion; else root.dataset.fkMotion = v ? "reduce" : "full"; }
  } catch {}
  if (v) dispose(); // particles already in flight stop at once
}
export function prefersReducedMotion() {
  if (override != null) return override;
  try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

// ---------------------------------------------------------------- physics (pure, testable)

/**
 * @param {{kind?: "confetti"|"burst"|"ribbon", x: number, y: number, count?: number, colors: string[], rng?: () => number}} o
 */
export function spawnParticles({ kind = "confetti", x, y, count = 120, colors, rng = Math.random }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = kind === "burst" ? rng() * Math.PI * 2 : -Math.PI / 2 + (rng() - 0.5) * 1.6;
    const speed = kind === "burst" ? 3 + rng() * 6 : 6 + rng() * 9;
    out.push({
      x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed * (kind === "ribbon" ? 0.3 : 1),
      rot: rng() * Math.PI * 2, vr: (rng() - 0.5) * 0.4, size: kind === "ribbon" ? 4 + rng() * 3 : 6 + rng() * 6,
      color: colors[Math.floor(rng() * colors.length)], life: 0, maxLife: kind === "burst" ? 40 + rng() * 25 : 90 + rng() * 70,
      shape: kind === "burst" ? "circle" : kind === "ribbon" ? "ribbon" : rng() < 0.5 ? "rect" : "circle",
      gravity: kind === "burst" ? 0.12 : 0.22, drag: kind === "burst" ? 0.96 : 0.985, wobble: rng() * 10,
    });
  }
  return out;
}

/** Advance particles one frame (mutates); returns the survivors. */
export function stepParticles(ps) {
  const alive = [];
  for (const p of ps) {
    p.life++;
    p.vx *= p.drag; p.vy = p.vy * p.drag + p.gravity;
    p.x += p.vx + Math.sin((p.life + p.wobble) * 0.15) * (p.shape === "ribbon" ? 1.2 : 0.3); p.y += p.vy; p.rot += p.vr;
    if (p.life < p.maxLife) alive.push(p);
  }
  return alive;
}

// ---------------------------------------------------------------- canvas layer

let layer = null;

function palette(doc) {
  const cs = globalThis.getComputedStyle?.(doc.documentElement);
  const read = (n) => cs?.getPropertyValue(n).trim();
  const list = [1, 2, 3, 4, 5].map((i) => read(`--fk-confetti-${i}`)).filter(Boolean);
  if (list.length) return list;
  return [read("--fk-accent"), read("--fk-gold"), read("--fk-ink")].filter(Boolean).concat(["currentColor"]).slice(0, 4);
}

function ensureLayer(doc) {
  if (layer) return layer;
  const canvas = h("canvas", { class: "fk-fx-canvas", "aria-hidden": "true" });
  doc.body.appendChild(canvas);
  const L = { canvas, ctx: canvas.getContext("2d"), particles: [], raf: 0, dpr: 1 };
  const size = () => {
    L.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.floor(globalThis.innerWidth * L.dpr); canvas.height = Math.floor(globalThis.innerHeight * L.dpr);
  };
  size();
  L.onResize = size;
  globalThis.addEventListener("resize", size);
  layer = L;
  return L;
}

function frame() {
  const L = layer;
  if (!L) return;
  const { ctx, canvas, dpr } = L;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  L.particles = stepParticles(L.particles);
  for (const p of L.particles) {
    const fade = Math.min(1, (p.maxLife - p.life) / 20);
    ctx.save();
    ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
    if (p.shape === "circle") { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
    else if (p.shape === "ribbon") ctx.fillRect(-p.size * 3, -p.size / 6, p.size * 6, p.size / 3);
    else ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
    ctx.restore();
  }
  if (L.particles.length) L.raf = requestAnimationFrame(frame);
  else dispose();
}

function dispose() {
  if (!layer) return;
  cancelAnimationFrame(layer.raf);
  globalThis.removeEventListener("resize", layer.onResize);
  layer.canvas.remove();
  layer = null;
}

/** Soft, motionless acknowledgement used instead of particles. */
export function gentleGlow({ doc = globalThis.document, duration = 900 } = {}) {
  const el = h("div", { class: "fk-glow", "aria-hidden": "true" });
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), duration + 100);
  return Promise.resolve();
}

/**
 * One slow breath of light: the calm-app stand-in for confetti and bursts. Transform and opacity only; with
 * reduced motion it is the plain opacity-only glow.
 */
export function bloom({ doc = globalThis.document, duration = 1700 } = {}) {
  if (!doc?.body) return Promise.resolve();
  if (prefersReducedMotion()) return gentleGlow({ doc, duration: 1200 });
  const el = h("div", { class: "fk-bloom", "aria-hidden": "true" });
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), duration + 100);
  return new Promise((r) => setTimeout(r, duration));
}

/**
 * Where a point is: with `units: "fraction"` x and y are 0..1 of the viewport, with `units: "px"` they are pixels; the
 * default "auto" reads a value of 1 or less as a fraction and anything larger as pixels (so a pixel position at the very
 * top-left edge needs `units: "px"`).
 */
export function resolvePoint(x, y, units = "auto", vw = globalThis.innerWidth, vh = globalThis.innerHeight) {
  const frac = (v) => (units === "fraction" ? true : units === "px" ? false : v <= 1);
  return { x: frac(x) ? x * vw : x, y: frac(y) ? y * vh : y };
}

function emit(kind, { x = 0.5, y = 0.35, count, colors, units = "auto", doc = globalThis.document } = {}) {
  if (prefersReducedMotion() || !doc || !globalThis.requestAnimationFrame) return gentleGlow({ doc });
  const L = ensureLayer(doc);
  const { x: px, y: py } = resolvePoint(x, y, units);
  L.particles.push(...spawnParticles({ kind, x: px, y: py, count: count ?? (kind === "burst" ? 50 : 140), colors: colors ?? palette(doc) }));
  if (!L.raf) L.raf = requestAnimationFrame(frame);
  return new Promise((r) => setTimeout(r, 1800));
}

/** Confetti shower from a point (fractions of the viewport, or px; see `resolvePoint` for the `units` option). */
export const confetti = (opts) => emit("confetti", opts);
/** Radial pop at a point or element. */
export function burst(target = {}, opts = {}) {
  if (target?.getBoundingClientRect) { const r = target.getBoundingClientRect(); return emit("burst", { x: r.left + r.width / 2, y: r.top + r.height / 2, ...opts }); }
  return emit("burst", { ...target, ...opts });
}
/** Streamers from both top corners. */
export function ribbons(opts = {}) {
  const a = emit("ribbon", { x: 0.1, y: 0.05, count: 40, ...opts });
  emit("ribbon", { x: 0.9, y: 0.05, count: 40, ...opts });
  return a;
}
/** Stop every particle immediately (e.g. on route change). Toasts and modals are not touched: see dismissCelebrations(). */
export const stopEffects = () => dispose();

// ---------------------------------------------------------------- dismissing what is on screen

let epoch = 0;
/** Bumps every time dismissCelebrations() runs; playOutcome() compares it to know it must stop. */
export const celebrationEpoch = () => epoch;
const liveModals = new Set();
const dismissers = new WeakMap(); // toast element -> its dismiss function

/** Remove the toasts on screen at once (all of them, or only those in `doc`). */
export function dismissToasts({ doc = globalThis.document } = {}) {
  let n = 0;
  for (const el of [...(doc?.querySelectorAll?.(".fk-toast") ?? [])]) { const d = dismissers.get(el); if (d) d({ immediate: true }); else el.remove(); n++; }
  return n;
}

/** Close every open level-up modal at once; the promise each one returned resolves. */
export function dismissModals({ doc = globalThis.document } = {}) {
  let n = 0;
  for (const m of [...liveModals]) if (!doc || m.doc === doc) { m.close({ immediate: true }); n++; }
  return n;
}

/**
 * Take everything down: particles, the glow, toasts and modals, and tell every playOutcome() still in flight to stop
 * (it fires no further cue and opens no modal). Call it when a single-page app changes route. Pass the quiet `gate` to
 * drop the celebrations still waiting in it too.
 * @returns {{toasts: number, modals: number}}
 */
export function dismissCelebrations({ doc = globalThis.document, gate } = {}) {
  epoch++;
  dispose();
  for (const el of doc?.querySelectorAll?.(".fk-glow, .fk-bloom") ?? []) el.remove();
  try { gate?.clear?.("dismissed"); } catch {}
  return { toasts: dismissToasts({ doc }), modals: dismissModals({ doc }) };
}

// ---------------------------------------------------------------- toast

let toastPosition = "top";
/**
 * Where toasts appear by default: "top" or "bottom". For a screen with a sticky HUD or a tab bar, set the
 * --fkx-toast-top / --fkx-toast-bottom tokens as well (the edge offset), or pass `position` to one toast.
 */
export function setToastPosition(pos, { doc = globalThis.document } = {}) {
  toastPosition = pos === "bottom" ? "bottom" : "top";
  const host = doc?.querySelector?.(".fk-toasts");
  if (host) host.dataset.fkPosition = toastPosition;
  return toastPosition;
}

function toastHost(doc, position, L) {
  let host = doc.querySelector(".fk-toasts");
  if (!host) { host = h("div", { class: "fk-toasts", role: "region", "aria-label": L("toastRegion") }); doc.body.appendChild(host); }
  host.dataset.fkPosition = position ?? toastPosition;
  return host;
}

/**
 * Show a toast. tone: "accent" | "gold" | "calm". Returns dismiss().
 * @param {string} message
 * @param {{title?: string, icon?: string, tone?: string, duration?: number, tier?: string, maxVisible?: number,
 *   position?: "top"|"bottom", labels?: object, doc?: Document}} [opts]
 *   maxVisible  at most this many toasts stay on screen: a new one sends the oldest away first (0 = no limit).
 *   position    "top" (default) or "bottom" for this toast (and the stack it joins); see setToastPosition().
 */
export function toast(message, { title, icon = "sparkle", tone = "accent", duration = 3400, tier, maxVisible = 0, position, labels, doc = globalThis.document } = {}) {
  const L = labelsFor(labels);
  const el = h("div", { class: `fk-toast fk-tone-${tone}${tier ? ` fk-tier-${tier}` : ""}`, role: "status", "aria-live": "polite" });
  el.innerHTML = `<span class="fk-toast-icon">${iconSvg(icon, { size: "1.4em" })}</span>`;
  const body = h("div", { class: "fk-toast-body" }, title ? h("strong", {}, title) : null, h("span", {}, message));
  el.append(body);
  const host = toastHost(doc, position, L);
  if (maxVisible > 0) {
    const live = [...host.querySelectorAll(".fk-toast:not(.is-leaving)")];
    while (live.length >= maxVisible) dismissers.get(live.shift())?.({ immediate: false });
  }
  host.appendChild(el);
  let timer, gone = false;
  const dismiss = (o) => {
    if (gone) return;
    clearTimeout(timer);
    if (o?.immediate === true) { gone = true; el.remove(); return; }
    el.classList.add("is-leaving");
    gone = true;
    setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 260);
  };
  dismissers.set(el, dismiss);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  el.addEventListener("click", dismiss);
  return dismiss;
}

/** Toast for an unlocked badge, tinted by rarity tier. */
export const unlockToast = (badge, opts = {}) => toast(badge.desc ?? "", { title: labelsFor(opts.labels)("badgeUnlocked", { title: badge.title }), icon: badge.icon ?? "star", tone: "gold", tier: badge.tier ?? "common", ...opts });

// ---------------------------------------------------------------- level-up modal

/**
 * Accessible level-up dialog. Resolves when dismissed. Esc / button / backdrop all close it; dismissModals() and
 * dismissCelebrations() close it from outside (the promise still resolves).
 * @param {{level: number, title?: string, fromLevel?: number, unlocks?: Array<string | {label?: string, feature?: string}>, xpGained?: number,
 *   doc?: Document, buttonLabel?: string, labels?: object}} o
 *   unlocks: lines under the level, as text or as `{ label }` (a feature's display name; its id is the fallback)
 */
export function levelUpModal({ level, title = "", fromLevel, unlocks = [], xpGained, doc = globalThis.document, buttonLabel, labels } = {}) {
  const L = labelsFor(labels);
  return new Promise((resolve) => {
    const prev = doc.activeElement;
    const num = h("div", { class: "fk-modal-level", "aria-hidden": "true" }, String(fromLevel ?? Math.max(1, level - 1)));
    const btn = h("button", { type: "button", class: "fk-btn", onclick: () => close() }, buttonLabel ?? L("keepGoing"));
    const lines = unlocks.map((u) => (typeof u === "string" ? u : u?.label ?? u?.feature ?? "")).filter(Boolean);
    const card = h("div", { class: "fk-modal-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "fk-lv-title", tabindex: "-1" },
      h("div", { class: "fk-modal-badge" }, h("span", { class: "fk-modal-eyebrow" }, L("levelUpEyebrow"))),
      num,
      h("h2", { id: "fk-lv-title", class: "fk-modal-title" }, L("levelReached", { level })),
      title ? h("p", { class: "fk-modal-sub" }, title) : null,
      xpGained ? h("p", { class: "fk-modal-xp" }, L("xpThisSession", { xp: xpGained })) : null,
      lines.length ? h("ul", { class: "fk-modal-list" }, ...lines.map((u) => h("li", {}, u))) : null,
      btn);
    const scrim = h("div", { class: "fk-modal", onclick: (e) => { if (e.target === scrim) close(); }, onkeydown: trap }, card);
    const entry = { doc, close };
    let closed = false;
    function trap(e) {
      if (e.key === "Escape") return close();
      if (e.key === "Tab") { e.preventDefault(); btn.focus(); } // single focusable control: keep focus inside
    }
    function close(o) {
      if (closed) return;
      closed = true;
      liveModals.delete(entry);
      const finish = () => { scrim.remove(); prev?.focus?.(); resolve(); };
      if (o?.immediate === true) return finish();
      scrim.classList.add("is-leaving");
      setTimeout(finish, prefersReducedMotion() ? 0 : 220);
    }
    liveModals.add(entry);
    doc.body.appendChild(scrim);
    countUp(num, level, { from: fromLevel ?? Math.max(1, level - 1), duration: 700, format: (v) => String(Math.round(v)) });
    btn.focus();
  });
}
