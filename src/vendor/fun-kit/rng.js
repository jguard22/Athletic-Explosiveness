// Seeded randomness. Everything "random but repeatable" (daily challenges)
// goes through here so the same date + app always yields the same result.

/** FNV-style 32-bit string hash. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for gameplay randomness. Returns () => [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded rng from any list of parts. */
export const seeded = (...parts) => mulberry32(hashString(parts.join("|")));

export function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }

/** Weighted pick; weightFn returns >= 0. Returns undefined when nothing has weight. */
export function pickWeighted(items, weightFn, rng) {
  let total = 0;
  const w = items.map((it) => { const x = Math.max(0, Number(weightFn(it)) || 0); total += x; return x; });
  if (total <= 0) return undefined;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}

export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
