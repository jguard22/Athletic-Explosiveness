// Timezone-safe calendar math.
//
// A "day key" is a plain "YYYY-MM-DD" string for the wall-clock day in a zone.
// All arithmetic runs on those strings via UTC day indexes, so DST shifts
// (23 h / 25 h days) and midnight edges never miscount. Pass `tz` (an IANA
// name) to pin a zone; omit it to use the device zone. `rolloverHour` lets
// late-night sessions (before e.g. 4 am) count for the previous day.

export const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fmtCache = new Map();

/** True when `tz` is an IANA zone name this runtime knows. */
export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function formatterFor(tz) {
  if (fmtCache.has(tz)) return fmtCache.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    // A bad zone name must not take a finished session down with it: use the device zone instead.
    try { console.warn(`[fun-kit] unknown time zone "${tz}"; using the device time zone`); } catch {}
  }
  fmtCache.set(tz, f);
  return f;
}

function wallParts(ms, tz) {
  const f = tz ? formatterFor(tz) : null;
  if (!f) {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }
  const o = {};
  for (const p of f.formatToParts(ms)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
}

const toMs = (input) => {
  let n;
  if (input instanceof Date) n = input.getTime();
  else if (typeof input === "string" && input.trim() && Number.isNaN(Number(input))) n = Date.parse(input); // ISO date-time
  else n = Number(input);
  if (!Number.isFinite(n)) throw new TypeError("fun-kit: invalid time");
  return n;
};

export const isDayKey = (s) => typeof s === "string" && DAY_RE.test(s);

/** Day index (days since 1970-01-01, calendar-based) of a day key. */
export function dayIndex(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export const keyFromIndex = (i) => new Date(i * DAY_MS).toISOString().slice(0, 10);

/**
 * Wall-clock day key for an instant.
 * @param {number|Date|string} input epoch ms, Date, ISO date-time string, or an existing day key (returned as is)
 * @param {{tz?: string, rolloverHour?: number}} [opts]
 */
export function dayKey(input, opts = {}) {
  if (isDayKey(input)) return input;
  const p = wallParts(toMs(input), opts.tz);
  let idx = Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);
  if (opts.rolloverHour && p.h < opts.rolloverHour) idx -= 1;
  return keyFromIndex(idx);
}

/** Hour 0-23 and minute on the wall clock in a zone. */
export function wallClock(input, tz) {
  const p = wallParts(toMs(input), tz);
  return { hour: p.h, minute: p.min };
}

export const addDays = (key, n) => keyFromIndex(dayIndex(key) + n);
/** Whole days from b to a (a - b): positive when `a` is the later day. */
export const diffDays = (a, b) => dayIndex(a) - dayIndex(b);
/** 0 = Sunday ... 6 = Saturday. */
export const weekday = (key) => (((dayIndex(key) + 4) % 7) + 7) % 7;

/** Key of the first day of the week containing `key`. weekStart: 1 = Monday (default), 0 = Sunday. */
export function weekStartKey(key, weekStart = 1) {
  const off = (weekday(key) - weekStart + 7) % 7;
  return addDays(key, -off);
}

/** Days left in the week including `key` itself. */
export const daysLeftInWeek = (key, weekStart = 1) => 7 - ((weekday(key) - weekStart + 7) % 7);

/** Epoch ms of local midnight is not needed anywhere: keep everything in keys. */
export const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
