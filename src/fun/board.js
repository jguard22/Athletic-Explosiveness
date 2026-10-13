// Today's booth board: three letters and a two-foot leap, kept on this device only (its own key, outside the kit, outside the CSV).
// Opt-in per visitor. Simulated results and warm-up jumps never get on it. Nothing here leaves the browser.
import { CAPS, cleanInitials, ordinal } from "./config.js";
import { dayKey } from "../vendor/fun-kit/time.js";

export const BOARD_KEY = "bw-ae-board";
const DAY_OPTS = { rolloverHour: 4 };

function safeStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** @param {{storage?: Storage, now?: () => number, key?: string}} [o] */
export function createBoard({ storage, now = Date.now, key = BOARD_KEY } = {}) {
  const st = safeStorage(storage);
  let mem = [];
  const load = () => {
    if (!st) return mem;
    try {
      const raw = st.getItem(key);
      const v = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter((e) => e && typeof e.who === "string" && Number.isFinite(e.cm)) : [];
    } catch { return mem; }
  };
  const save = (list) => {
    mem = list;
    if (!st) return;
    try { list.length ? st.setItem(key, JSON.stringify(list)) : st.removeItem(key); } catch { /* quota or private mode: memory keeps it */ }
  };
  const today = () => { const d = dayKey(now(), DAY_OPTS); return load().filter((e) => e.day === d).sort((a, b) => b.cm - a.cm || a.at - b.at); };

  const api = {
    /** Add a visitor. Refuses a simulated result, a warm-up result and anything that is not three-letters-and-a-height. */
    add({ who, cm, sim = false, warmup = false } = {}) {
      if (sim) return { ok: false, reason: "sim" };
      if (warmup) return { ok: false, reason: "warmup" };
      const initials = cleanInitials(who);
      if (!initials) return { ok: false, reason: "initials" };
      if (!(Number.isFinite(cm) && cm > 0)) return { ok: false, reason: "invalid" };
      const at = now(), day = dayKey(at, DAY_OPTS);
      const entry = { id: `b${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, who: initials, cm, at, day };
      // keep today and yesterday only, newest last, at most boardKeep
      const keep = load().filter((e) => e.day >= dayKey(at - 86400000, DAY_OPTS)).concat(entry).slice(-CAPS.boardKeep);
      save(keep);
      return { ok: true, entry, ...api.rankOf(entry.id) };
    },
    top(n = CAPS.boardShown) { return today().slice(0, n); },
    all: today,
    count: () => today().length,
    /** "3rd of 14 today", shown only when at least five people are on today's board. */
    rankOf(id) {
      const list = today();
      const i = list.findIndex((e) => e.id === id);
      if (i < 0) return { rank: null, total: list.length, text: null };
      return { rank: i + 1, total: list.length, nth: ordinal(i + 1), text: list.length >= CAPS.boardMin ? { nth: ordinal(i + 1), total: list.length } : null };
    },
    clear() { save([]); },
    key,
  };
  return api;
}
