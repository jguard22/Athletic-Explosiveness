// Reminders without push: a recurring .ics calendar event the person adds to
// their own calendar app, at a time THEY choose. No notification permission,
// no server, no nagging from us.

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** RFC 5545 text escaping. */
export function icsEscape(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets with CRLF + space (RFC 5545 3.1), without splitting a code point. */
export function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) { out.push(cur); cur = ch; bytes = b; limit = 74; } else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.join("\r\n ");
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/**
 * @param {{title: string, description?: string, time: string, days?: "daily"|number[]|string[], startDate: string,
 *   durationMin?: number, alarmMin?: number, uid?: string, url?: string, appName?: string, now?: number}} o
 *   time: "HH:MM" local; days: "daily" | [1,3,5] (0=Sun) | ["MO","WE"]; startDate: "YYYY-MM-DD" (first possible day)
 */
export function buildReminderIcs(o) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(o.time ?? "");
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('fun-kit reminders: time must be "HH:MM"');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.startDate ?? "")) throw new Error('fun-kit reminders: startDate must be "YYYY-MM-DD"');
  const hh = pad(+m[1]), mm = m[2];
  const dt = o.startDate.replace(/-/g, "");
  const byday = o.days && o.days !== "daily" ? o.days.map((d) => (typeof d === "number" ? DAYS[d] : String(d).toUpperCase())) : null;
  if (byday?.some((d) => !DAYS.includes(d))) throw new Error("fun-kit reminders: unknown weekday");
  const rrule = byday ? `RRULE:FREQ=WEEKLY;BYDAY=${byday.join(",")}` : "RRULE:FREQ=DAILY";
  const endMin = +m[1] * 60 + +m[2] + (o.durationMin ?? 20);
  const dtEnd = `${dt}T${pad(Math.floor(endMin / 60) % 24)}${pad(endMin % 60)}00`;
  const now = new Date(o.now ?? Date.now());
  const uid = o.uid ?? `${(o.appName ?? "brilliantwear").toLowerCase().replace(/\W+/g, "-")}-${dt}-${hh}${mm}@brilliantwear.com`;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BrilliantWear//Fun Kit//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${dt}T${hh}${mm}00`, // floating local time: fires at that clock time wherever the person is
    `DTEND:${dtEnd}`,
    rrule,
    `SUMMARY:${icsEscape(o.title)}`,
    o.description ? `DESCRIPTION:${icsEscape(o.description)}` : null,
    o.url ? `URL:${o.url}` : null,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(o.title)}`, `TRIGGER:-PT${Math.max(0, o.alarmMin ?? 0)}M`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/** Offer the .ics for download (opens in the calendar app on most phones). */
export function downloadIcs(ics, filename = "reminder.ics", { doc = globalThis.document, urlApi = globalThis.URL } = {}) {
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = urlApi.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url; a.download = filename;
  doc.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => urlApi.revokeObjectURL(url), 4000);
  return blob;
}
