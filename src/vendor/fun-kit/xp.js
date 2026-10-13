// XP ledger + level curve.
//
// The curve is deliberately gentle at the start: level 1 -> 2 costs 40 XP,
// which one ordinary first session (base + first-session bonus) clears, so the
// first level-up lands inside the first session. Later levels grow roughly
// quadratically and round to 5s so numbers look tidy.
//
// The ledger also knows three things a plain counter cannot:
//   - one-time awards (`once: true` + a `key`) are exempt from the daily soft cap and do not use up its allowance,
//     so an onboarding bonus is never quartered because the rest of the day was busy;
//   - `revoke(key)` takes a keyed award back (an invalidated measurement, a cancelled string), and
//   - `defer(id, entries)` holds XP unpaid until `commit(id)` or `discard(id)`, so nothing needs revoking.

import { createEmitter } from "./emitter.js";
import { getLabel } from "./labels.js";
import { dayKey } from "./time.js";

export const DEFAULT_CURVE = Object.freeze({ first: 40, linear: 15, quad: 4, round: 5, maxLevel: 99 });

/** XP needed to go from `level` to `level + 1`. */
export function xpForNextLevel(level, curve = DEFAULT_CURVE) {
  const c = { ...DEFAULT_CURVE, ...curve };
  const n = Math.max(0, level - 1);
  const raw = c.first + c.linear * n + c.quad * n * n;
  return Math.max(c.round, Math.round(raw / c.round) * c.round);
}

/** Total XP at which `level` begins (level 1 = 0). */
export function xpToReach(level, curve = DEFAULT_CURVE) {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += xpForNextLevel(l, curve);
  return sum;
}

/** Level, progress into it and distance to the next, from a total. */
export function levelFromXp(total, curve = DEFAULT_CURVE) {
  const c = { ...DEFAULT_CURVE, ...curve };
  total = Math.max(0, Math.floor(total || 0));
  let level = 1, floor = 0;
  while (level < c.maxLevel) {
    const need = xpForNextLevel(level, c);
    if (total < floor + need) break;
    floor += need; level++;
  }
  const need = level >= c.maxLevel ? 0 : xpForNextLevel(level, c);
  const into = total - floor;
  return { level, total, into, need, toNext: Math.max(0, need - into), pct: need ? into / need : 1, maxed: level >= c.maxLevel };
}

/** Level-title sets: pick a theme per app, or pass your own [[fromLevel, title], ...]. */
export const TITLE_SETS = Object.freeze({
  generic: [[1, "Newcomer"], [3, "Regular"], [6, "Dedicated"], [10, "Pro"], [15, "Master"], [25, "Legend"]],
  athlete: [[1, "Rookie"], [3, "Contender"], [6, "Competitor"], [10, "Standout"], [15, "Elite"], [25, "Hall of Fame"]],
  calm: [[1, "Beginner"], [3, "Steady"], [6, "Grounded"], [10, "Balanced"], [15, "Centered"], [25, "Serene"]],
  explorer: [[1, "Wanderer"], [3, "Scout"], [6, "Pathfinder"], [10, "Navigator"], [15, "Trailblazer"], [25, "Cartographer"]],
  maker: [[1, "Tinkerer"], [3, "Builder"], [6, "Crafter"], [10, "Engineer"], [15, "Architect"], [25, "Inventor"]],
  musician: [[1, "Listener"], [3, "Player"], [6, "Groover"], [10, "Performer"], [15, "Headliner"], [25, "Maestro"]],
  golf: [[1, "Range Rookie"], [3, "Weekend Player"], [6, "Scratch Chaser"], [10, "Club Champion"], [15, "Tour Hopeful"], [25, "Major Winner"]],
});

const titleSet = (titles) => (typeof titles === "string" ? TITLE_SETS[titles] ?? TITLE_SETS.generic : titles);

export function titleFor(level, titles = "generic") {
  const set = titleSet(titles);
  let out = set[0]?.[1] ?? "";
  for (const [from, title] of set) if (level >= from) out = title;
  return out;
}

/**
 * Where a level sits on the title ladder: whether the next level brings a new title, which title that is, and whether
 * the last title is already worn (`topTitle`: nothing further to earn by name, though levels go on).
 */
export function titleLadder(level, titles = "generic") {
  const set = [...(titleSet(titles) ?? [])].sort((a, b) => a[0] - b[0]);
  const title = titleFor(level, titles);
  const upcoming = set.find(([from]) => from > level) ?? null;
  return {
    title, nextTitle: titleFor(level + 1, titles), titleChanges: titleFor(level + 1, titles) !== title,
    topTitle: !upcoming, nextNewTitle: upcoming ? upcoming[1] : null, nextNewTitleLevel: upcoming ? upcoming[0] : null,
  };
}

/**
 * "120 XP to Regular" when the next level brings a new title, else "120 XP to level 5"; "Max level" at the cap.
 * At the top of the title ladder it never names the title already worn.
 * @param {object} info from xp.info() (or levelFromXp() plus title / nextTitle)
 * @param {(key: string, vars?: object) => string} [L] label resolver (labels.js); defaults to the global labels
 */
export function toNextText(info, L = (k, v) => getLabel(k, v)) {
  if (info.maxed) return L("maxLevel");
  const changes = info.titleChanges ?? (info.nextTitle != null && info.nextTitle !== info.title);
  if (changes && info.nextTitle) return L("xpToTitle", { xp: info.toNext, title: info.nextTitle });
  return L("xpToLevel", { xp: info.toNext, level: (info.level ?? 0) + 1 });
}

const LEDGER_CAP = 100;
const KEYS_CAP = 300;
const PENDING_CAP = 20;
const PENDING_TTL_MS = 14 * 86400000;

const blank = () => ({ total: 0, ledger: [], keys: [], paid: [], pending: {}, daily: { day: "", amount: 0 } });

/**
 * @param {{store: ReturnType<import('./store.js').createStore>, curve?: object, titles?: string|Array,
 *          dailySoftCap?: number, softFactor?: number, sessionCap?: number, now?: () => number, tz?: string, rolloverHour?: number}} opts
 *   dailySoftCap: past this many (repeatable) XP in a day each award is cut to `softFactor` of its value, minimum 1.
 *   sessionCap:   most (repeatable) XP one `award()` call may pay; the excess is dropped (listed in `result.dropped`). 0 = no cap.
 */
export function createXp({ store, curve, titles = "generic", dailySoftCap = 0, softFactor = 0.25, sessionCap = 0, now = Date.now, tz, rolloverHour = 0 } = {}) {
  const KEY = "xp";
  const emitter = createEmitter();
  const load = () => ({ ...blank(), ...store.get(KEY, blank()) });

  const info = (total = load().total) => {
    const lv = levelFromXp(total, curve);
    return { ...lv, ...titleLadder(lv.level, titles), nextLevel: lv.maxed ? lv.level : lv.level + 1 };
  };

  const trimPending = (st, at) => {
    for (const [id, p] of Object.entries(st.pending)) if (at - p.at > PENDING_TTL_MS) delete st.pending[id];
    const ids = Object.keys(st.pending);
    if (ids.length > PENDING_CAP) for (const id of ids.slice(0, ids.length - PENDING_CAP)) delete st.pending[id];
  };

  /**
   * Award XP. `entries` may be one entry or a list; a list is applied atomically
   * so a session produces ONE level-up result however many sources contributed.
   * Entry: { amount, source, label, key?(dedupe), once?(one-time: needs a key; exempt from the caps) }.
   * `opts.cap` overrides `sessionCap` for this call (0 = no room left for repeatable XP; one-time awards still pay).
   */
  function award(entries, { at = now(), cap } = {}) {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    const st = load();
    const day = dayKey(at, { tz, rolloverHour });
    if (st.daily.day !== day) st.daily = { day, amount: 0 };
    const before = levelFromXp(st.total, curve);
    const limit = cap ?? (sessionCap > 0 ? sessionCap : null); // null = uncapped; an explicit 0 leaves no room for repeatable XP
    const applied = [], dropped = [];
    let gained = 0, spent = 0;
    for (const e of list) {
      let amount = Math.round(Number(e.amount) || 0);
      if (amount <= 0) continue;
      if (e.key && st.keys.includes(e.key)) continue;
      const exempt = e.once === true && !!e.key;
      let softened = false, capped = false;
      if (!exempt) {
        if (dailySoftCap > 0 && st.daily.amount >= dailySoftCap) { amount = Math.max(1, Math.round(amount * softFactor)); softened = true; }
        if (limit != null) {
          const room = limit - spent;
          if (room <= 0) { dropped.push({ source: e.source ?? "misc", label: e.label ?? "", amount, reason: "session-cap" }); continue; }
          if (amount > room) { amount = room; capped = true; }
        }
        spent += amount;
        st.daily.amount += amount;
      }
      gained += amount;
      if (e.key) {
        st.keys.push(e.key); if (st.keys.length > KEYS_CAP) st.keys.shift();
        st.paid.push({ key: e.key, amount, day, counted: !exempt }); if (st.paid.length > KEYS_CAP) st.paid.shift();
      }
      const row = { at, amount, source: e.source ?? "misc", label: e.label ?? "", ...(e.key ? { key: e.key } : {}) };
      applied.push({ ...row, softened, capped, exempt });
      st.ledger.push(row);
    }
    if (st.ledger.length > LEDGER_CAP) st.ledger.splice(0, st.ledger.length - LEDGER_CAP);
    st.total += gained;
    store.set(KEY, st);
    const after = info(st.total);
    const levelUp = after.level > before.level;
    const result = {
      gained, applied, dropped, total: st.total, ...after, fromLevel: before.level, toLevel: after.level, levelUp,
      levelsGained: levelUp ? Array.from({ length: after.level - before.level }, (_, i) => before.level + 1 + i) : [],
    };
    if (gained > 0) emitter.emit("xp", result);
    if (levelUp) emitter.emit("levelup", result);
    return result;
  }

  /**
   * Take a keyed award back (the key is freed, so a corrected award can be paid once). The level can fall; if that must
   * never be shown, `defer()` the XP instead. Unknown keys, or awards too old to remember, return `{ revoked: false }`.
   * @returns {{revoked: boolean, reason?: string, amount?: number, total?: number, level?: number, levelDown?: boolean, fromLevel?: number, toLevel?: number}}
   */
  function revoke(key, { at = now(), reason = "" } = {}) {
    const st = load();
    let idx = -1;
    for (let i = st.paid.length - 1; i >= 0; i--) if (st.paid[i].key === key) { idx = i; break; }
    if (idx < 0) return { revoked: false, reason: st.keys.includes(key) ? "unknown-amount" : "not-found" };
    const p = st.paid.splice(idx, 1)[0];
    st.keys = st.keys.filter((k) => k !== key);
    const before = levelFromXp(st.total, curve);
    const amount = Math.min(p.amount, st.total);
    st.total -= amount;
    if (p.counted && st.daily.day === p.day) st.daily.amount = Math.max(0, st.daily.amount - amount); // the day's allowance comes back too
    st.ledger.push({ at, amount: -amount, source: "revoked", label: reason || `Revoked ${key}`, key });
    if (st.ledger.length > LEDGER_CAP) st.ledger.splice(0, st.ledger.length - LEDGER_CAP);
    store.set(KEY, st);
    const after = info(st.total);
    const result = { revoked: true, key, amount, total: st.total, ...after, fromLevel: before.level, toLevel: after.level, levelDown: after.level < before.level };
    emitter.emit("revoke", result);
    return result;
  }

  /**
   * Hold XP unpaid under `id` (a string close, a validation step). Calling it again with the same id adds to the hold;
   * an entry whose key is already held is skipped. Held XP touches neither the total nor the daily allowance.
   * Holds older than 14 days are dropped; at most 20 are kept.
   */
  function defer(id, entries, { at = now() } = {}) {
    if (id == null || id === "") throw new Error("fun-kit xp: defer() needs an id");
    const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && Math.round(Number(e.amount) || 0) > 0);
    const st = load();
    const hold = st.pending[id] ?? { at, entries: [] };
    for (const e of list) {
      if (e.key && hold.entries.some((x) => x.key === e.key)) continue;
      hold.entries.push({ amount: Math.round(Number(e.amount)), source: e.source ?? "misc", label: e.label ?? "", ...(e.key ? { key: e.key } : {}), ...(e.once ? { once: true } : {}) });
    }
    st.pending[id] = hold;
    trimPending(st, at);
    store.set(KEY, st);
    return { id: String(id), count: hold.entries.length, amount: hold.entries.reduce((a, e) => a + e.amount, 0) };
  }

  /** Pay a hold (caps and dedupe apply now, as of `at`). Returns the usual award result plus `committed: id`. */
  function commit(id, { at = now(), cap } = {}) {
    const st = load();
    const hold = st.pending[id];
    if (!hold) return { committed: false, reason: "not-found", gained: 0, applied: [], dropped: [], ...info(st.total) };
    delete st.pending[id];
    store.set(KEY, st);
    try {
      const r = award(hold.entries, { at, cap });
      return { committed: id, ...r };
    } catch (err) {
      const again = load(); again.pending[id] = hold; store.set(KEY, again);
      throw err;
    }
  }

  /** Throw a hold away unpaid. Returns whether there was one. */
  function discard(id) {
    const st = load();
    if (!st.pending[id]) return false;
    delete st.pending[id];
    store.set(KEY, st);
    return true;
  }

  /** The holds: one by id, or all of them. */
  function pending(id) {
    const st = load();
    const view = (k, p) => ({ id: k, at: p.at, count: p.entries.length, amount: p.entries.reduce((a, e) => a + e.amount, 0), entries: p.entries.map((e) => ({ ...e })) });
    if (id != null) return st.pending[id] ? view(id, st.pending[id]) : null;
    return Object.entries(st.pending).map(([k, p]) => view(k, p));
  }

  return {
    award, revoke, defer, commit, discard, pending,
    info,
    get total() { return load().total; },
    get level() { return info().level; },
    ledger: (n = 20) => load().ledger.slice(-n).reverse(),
    on: emitter.on, off: emitter.off,
    reset: () => store.remove(KEY),
  };
}
