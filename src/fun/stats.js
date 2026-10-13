// Local fun stats: counts of named events per day, one-tap "Loved it / Fine / Not for me" answers and first-win times.
// Count events, not people: no ids, no names, and nothing about the body, the sensors or a score ever goes in.
// Only the names below are accepted; anything else is refused. The numbers stay in this browser and can be downloaded as a CSV.
import { dayKey } from "../vendor/fun-kit/time.js";

export const STATS_KEY = "bw-ae-stats";
export const EVENTS = Object.freeze([
  "combine_start", "station_done", "station_skip", "combine_done", "combine_stop", "rematch", "board_add", "sim_start",
  "mode_switch", "rested_tap", "warm_tap", "next_visitor", "first_win", "pulse", "forget",
]);
export const PULSE_ANSWERS = Object.freeze(["loved", "fine", "not-for-me"]);
const KEEP_DAYS = 60;
const DAY_OPTS = { rolloverHour: 4 };

function safeStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** @param {{storage?: Storage, now?: () => number, key?: string}} [o] */
export function createStats({ storage, now = Date.now, key = STATS_KEY } = {}) {
  const st = safeStorage(storage);
  let mem = { days: {}, pulses: [], firstWins: [] };
  const load = () => {
    if (!st) return mem;
    try {
      const v = JSON.parse(st.getItem(key) ?? "null");
      return v && typeof v === "object" ? { days: v.days ?? {}, pulses: v.pulses ?? [], firstWins: v.firstWins ?? [] } : { days: {}, pulses: [], firstWins: [] };
    } catch { return mem; }
  };
  const save = (v) => {
    const days = Object.keys(v.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete v.days[d];
    v.pulses = v.pulses.slice(-200); v.firstWins = v.firstWins.slice(-200);
    mem = v;
    if (!st) return;
    try { st.setItem(key, JSON.stringify(v)); } catch { /* memory keeps it */ }
  };
  const today = () => dayKey(now(), DAY_OPTS);

  const api = {
    /** Count one named event. Unknown names are refused (returns false); there is no payload. */
    record(name) {
      if (!EVENTS.includes(name)) return false;
      const v = load(); const d = today();
      v.days[d] = v.days[d] ?? {};
      v.days[d][name] = (v.days[d][name] ?? 0) + 1;
      save(v);
      return true;
    },
    /** The one-tap fun pulse. `firstWinMs` is how long the first win took (a time on the page, not a body reading). */
    pulse(answer, { firstWinMs = null, sim = false } = {}) {
      if (!PULSE_ANSWERS.includes(answer)) return null;
      const v = load();
      const rec = { day: today(), answer, firstWinMs: Number.isFinite(firstWinMs) ? Math.round(firstWinMs) : null, sim: !!sim };
      v.pulses.push(rec); save(v); api.record("pulse");
      return rec;
    },
    /** Remember how long a first win took. */
    firstWin(ms, { sim = false } = {}) {
      if (!Number.isFinite(ms)) return false;
      const v = load(); v.firstWins.push({ day: today(), ms: Math.round(ms), sim: !!sim }); save(v); api.record("first_win");
      return true;
    },
    snapshot: () => JSON.parse(JSON.stringify(load())),
    /** day,event,count rows; pulse answers; first-win times. Counts only. */
    csv() {
      const v = load();
      const rows = ["kind,day,name,value"];
      for (const d of Object.keys(v.days).sort()) for (const e of Object.keys(v.days[d]).sort()) rows.push(`count,${d},${e},${v.days[d][e]}`);
      const tally = {};
      for (const p of v.pulses) tally[`${p.day},${p.answer}`] = (tally[`${p.day},${p.answer}`] ?? 0) + 1;
      for (const k of Object.keys(tally).sort()) { const [d, a] = k.split(","); rows.push(`pulse,${d},${a},${tally[k]}`); }
      for (const f of v.firstWins) rows.push(`first_win_ms,${f.day},${f.sim ? "sim" : "real"},${f.ms}`);
      return rows.join("\n");
    },
    clear() { mem = { days: {}, pulses: [], firstWins: [] }; if (st) { try { st.removeItem(key); } catch { /* nothing to remove */ } } },
    key,
  };
  return api;
}
