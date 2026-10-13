// Count-up numbers. Reduced motion: the final value appears at once.

import { prefersReducedMotion } from "./celebrate.js";

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Value of a count-up at progress t (0..1). */
export function valueAt(from, to, t, easing = easeOutCubic) {
  const k = Math.max(0, Math.min(1, t));
  return from + (to - from) * easing(k);
}

/**
 * Animate a number inside an element.
 * @returns {{cancel: () => void, done: Promise<void>}}
 */
export function countUp(el, to, { from = 0, duration = 900, format = (v) => Math.round(v).toLocaleString(), easing = easeOutCubic, raf = globalThis.requestAnimationFrame, now = () => performance.now() } = {}) {
  let cancelled = false;
  const finish = () => { el.textContent = format(to); };
  if (prefersReducedMotion() || !raf || duration <= 0 || from === to) {
    finish();
    return { cancel() {}, done: Promise.resolve() };
  }
  const done = new Promise((resolve) => {
    const t0 = now();
    const tick = () => {
      if (cancelled) return resolve();
      const t = (now() - t0) / duration;
      if (t >= 1) { finish(); return resolve(); }
      el.textContent = format(valueAt(from, to, t, easing));
      raf(tick);
    };
    raf(tick);
  });
  return { cancel() { cancelled = true; finish(); }, done };
}
