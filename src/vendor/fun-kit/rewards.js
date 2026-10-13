// Variable reward scheduler.
//
// An occasional surprise (cosmetic, title, theme, sticker, small bonus XP, a
// kind note) after a COMPLETED session. Hard rules baked into the code:
//   - Never pay-to-win: only whitelisted kinds exist; there is no "boost" kind.
//   - Never tied to health measurements: roll() takes no metric input, so the
//     outcome depends only on how many sessions have passed, pity and caps.
//   - Bounded: at most `maxPerDay` / `maxPerWeek` drops; bonus XP is capped.
//   - Never a streak of nothing: a pity timer guarantees a drop every
//     `pityAfter` sessions, and chance ramps toward it.
//   - Variable per person: the draw is seeded from a random salt saved on first use,
//     so two installs (or a reset) do not share a drop schedule. Pass `seed` for a
//     reproducible schedule in tests.

import { createEmitter } from "./emitter.js";
import { pickWeighted, seeded, clamp } from "./rng.js";
import { dayKey, weekStartKey } from "./time.js";

const freshSalt = () => {
  try { const a = new Uint32Array(1); globalThis.crypto.getRandomValues(a); return a[0]; } catch { return Math.floor(Math.random() * 2 ** 32); }
};

export const ALLOWED_KINDS = Object.freeze(["cosmetic", "title", "theme", "sticker", "bonus_xp", "message"]);
export const MAX_BONUS_XP = 25;

export function validateDrops(drops) {
  for (const d of drops) {
    if (!ALLOWED_KINDS.includes(d.kind)) throw new Error(`fun-kit rewards: kind "${d.kind}" is not allowed (allowed: ${ALLOWED_KINDS.join(", ")})`);
    if (d.kind === "bonus_xp" && (d.xp ?? 0) > MAX_BONUS_XP) throw new Error(`fun-kit rewards: bonus_xp is capped at ${MAX_BONUS_XP}`);
  }
}

/**
 * @param {{store: any, drops: object[], baseChance?: number, pityStep?: number, maxChance?: number, pityAfter?: number,
 *   minGapSessions?: number, maxPerDay?: number, maxPerWeek?: number, rng?: () => number, seed?: string|number, now?: () => number, tz?: string,
 *   rolloverHour?: number, weekStart?: number, enabled?: boolean}} opts
 * drop: { id, kind, title, rarity?, weight?, xp?, slot? }
 */
export function createRewards({ store, drops = [], baseChance = 0.12, pityStep = 0.03, maxChance = 0.5, pityAfter = 12, minGapSessions = 2, maxPerDay = 1, maxPerWeek = 3, rng, seed, now = Date.now, tz, rolloverHour = 0, weekStart = 1, enabled = true } = {}) {
  validateDrops(drops);
  const KEY = "rewards";
  const emitter = createEmitter();
  const load = () => store.get(KEY, { since: 0, day: "", dayCount: 0, week: "", weekCount: 0, owned: {}, equipped: {}, rolls: 0, salt: null });

  const chanceFor = (since) => clamp(baseChance + pityStep * since, 0, maxChance);

  /**
   * Call once per completed session. Takes NO performance data on purpose.
   * @returns {null | {drop: object, duplicate: boolean, xp: number}}
   */
  function roll({ at = now() } = {}) {
    if (!enabled || !drops.length) return null;
    const st = load();
    const day = dayKey(at, { tz, rolloverHour });
    const week = weekStartKey(day, weekStart);
    if (st.salt == null) st.salt = seed ?? freshSalt();
    if (st.day !== day) { st.day = day; st.dayCount = 0; }
    if (st.week !== week) { st.week = week; st.weekCount = 0; }
    st.rolls++;
    st.since++;
    const capped = st.dayCount >= maxPerDay || st.weekCount >= maxPerWeek;
    const tooSoon = st.since <= minGapSessions && st.rolls > 1 && st.since < pityAfter;
    const r = (rng ?? seeded("rewards", store.app ?? "", st.salt, st.rolls))();
    const hit = !capped && !tooSoon && (st.since >= pityAfter || r < chanceFor(st.since));
    if (!hit) { store.set(KEY, st); return null; }
    // Prefer something not owned yet; fall back to a small XP gift when the shelf is full.
    const pool = drops.filter((d) => !(st.owned[d.id] && d.kind !== "bonus_xp" && d.kind !== "message"));
    const pick = pickWeighted(pool.length ? pool : drops.filter((d) => d.kind === "bonus_xp" || d.kind === "message"), (d) => d.weight ?? 1, seeded("rewards-pick", store.app ?? "", st.salt, st.rolls));
    if (!pick) { store.set(KEY, st); return null; }
    const duplicate = !!st.owned[pick.id];
    const item = st.owned[pick.id] ?? { count: 0, at };
    item.count++; item.at = at;
    st.owned[pick.id] = item;
    st.since = 0; st.dayCount++; st.weekCount++;
    store.set(KEY, st);
    const result = { drop: pick, duplicate, xp: pick.kind === "bonus_xp" ? Math.min(pick.xp ?? 10, MAX_BONUS_XP) : 0 };
    emitter.emit("drop", result);
    return result;
  }

  function equip(id) {
    const st = load();
    const d = drops.find((x) => x.id === id);
    if (!d || !st.owned[id]) return false;
    st.equipped[d.slot ?? d.kind] = id;
    store.set(KEY, st);
    return true;
  }

  return {
    roll, equip, chanceFor,
    inventory: () => { const st = load(); return drops.filter((d) => st.owned[d.id]).map((d) => ({ ...d, count: st.owned[d.id].count, at: st.owned[d.id].at, equipped: st.equipped[d.slot ?? d.kind] === d.id })); },
    sessionsSinceDrop: () => load().since,
    on: emitter.on, off: emitter.off,
    reset: () => store.remove(KEY),
  };
}
