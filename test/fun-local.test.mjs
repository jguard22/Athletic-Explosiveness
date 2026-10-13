// The two small local stores: today's booth board and the fun stats. Both live in this browser only.
import test from "node:test";
import assert from "node:assert/strict";
import { createBoard } from "../src/fun/board.js";
import { createStats, EVENTS, PULSE_ANSWERS } from "../src/fun/stats.js";
import * as C from "../src/fun/config.js";

function storage() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test("board: opt-in initials and a two-foot leap; simulated and warm-up results never get on", () => {
  let t = Date.UTC(2026, 9, 13, 15);
  const st = storage();
  const board = createBoard({ storage: st, now: () => t });
  assert.deepEqual(board.add({ who: "abc", cm: 40, sim: true }), { ok: false, reason: "sim" });
  assert.deepEqual(board.add({ who: "abc", cm: 40, warmup: true }), { ok: false, reason: "warmup" });
  assert.deepEqual(board.add({ who: "12", cm: 40 }), { ok: false, reason: "initials" });
  assert.deepEqual(board.add({ who: "fuk", cm: 40 }), { ok: false, reason: "blocked" }, "a short list of letters that do not belong on a shared screen");
  assert.deepEqual(board.add({ who: "abc", cm: 0 }), { ok: false, reason: "invalid" });
  assert.deepEqual(board.add({ who: "abc", cm: NaN }), { ok: false, reason: "invalid" });
  assert.equal(board.count(), 0);
  assert.equal(st.getItem("bw-ae-board"), null, "refusals write nothing");

  const r = board.add({ who: "jeffrey", cm: 41.2 });
  assert.equal(r.ok, true);
  assert.equal(r.entry.who, "JEF", "three letters only");
  assert.equal(r.rank, 1);
  assert.equal(r.text, null, "no rank until five people are on today's board");
  const stored = JSON.parse(st.getItem("bw-ae-board"));
  assert.deepEqual(Object.keys(stored[0]).sort(), ["at", "cm", "day", "id", "who"], "initials, a height and a time: nothing else");
});

test("board: top five, a rank once five are on, sorted by height, and only today's entries", () => {
  let t = Date.UTC(2026, 9, 13, 15);
  const board = createBoard({ storage: storage(), now: () => t });
  const heights = [30, 50, 40, 20, 45, 35, 25];
  const ids = heights.map((cm, i) => board.add({ who: `P${String.fromCharCode(65 + i)}`, cm }).entry.id);
  assert.equal(board.count(), 7);
  assert.deepEqual(board.top().map((e) => e.cm), [50, 45, 40, 35, 30]);
  assert.equal(board.top().length, C.CAPS.boardShown);
  const me = board.rankOf(ids[2]); // 40 cm
  assert.equal(me.rank, 3); assert.equal(me.total, 7);
  assert.deepEqual(me.text, { nth: "3rd", total: 7 });
  assert.equal(board.rankOf("nope").rank, null);
  // the next day starts a fresh board (day rolls over at 4 am)
  t += 24 * 3600000;
  assert.equal(board.count(), 0);
  board.add({ who: "NEW", cm: 33 });
  assert.equal(board.count(), 1);
  // clearing is total
  board.clear();
  assert.equal(board.count(), 0);
});

test("board: a 2 am visitor counts for the evening before (the day rolls over at 4 am, local time)", () => {
  let t = new Date(2026, 9, 14, 2, 0).getTime();
  const board = createBoard({ storage: storage(), now: () => t });
  board.add({ who: "LTE", cm: 30 });
  t = new Date(2026, 9, 14, 3, 30).getTime();
  assert.equal(board.count(), 1, "still the same board at 3:30 am");
  t = new Date(2026, 9, 14, 4, 30).getTime();
  assert.equal(board.count(), 0, "a fresh board after 4 am");
});

test("board: broken storage falls back to memory without throwing", () => {
  const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  const board = createBoard({ storage: bad });
  assert.equal(board.add({ who: "ABC", cm: 31 }).ok, true);
  assert.doesNotThrow(() => board.top());
  assert.doesNotThrow(() => board.clear());
});

test("stats: only named events are counted, with no payload; pulse answers and first-win time are the only other things kept", () => {
  const st = storage();
  const stats = createStats({ storage: st, now: () => Date.UTC(2026, 9, 13, 15) });
  assert.equal(stats.record("combine_start"), true);
  assert.equal(stats.record("combine_start"), true);
  assert.equal(stats.record("jump_height"), false, "an unknown name is refused");
  assert.equal(stats.record("combine_start", { cm: 33 }), true, "extra arguments are ignored, there is no payload");
  assert.equal(stats.pulse("loved", { firstWinMs: 1700.4 }).firstWinMs, 1700);
  assert.equal(stats.pulse("amazing"), null);
  stats.firstWin(1700, { sim: true });
  const snap = stats.snapshot();
  assert.equal(snap.days["2026-10-13"].combine_start, 3);
  const text = st.getItem("bw-ae-stats");
  assert.doesNotMatch(text, /33|heartRate|pressure|speed|cm"/, "no measurement ever reaches the stats");
  assert.ok(PULSE_ANSWERS.includes("loved") && PULSE_ANSWERS.includes("fine") && PULSE_ANSWERS.includes("not-for-me"));
  assert.ok(EVENTS.every((e) => /^[a-z_]+$/.test(e)));
});

test("stats: the CSV is counts, pulse tallies and first-win times", () => {
  const stats = createStats({ storage: storage(), now: () => Date.UTC(2026, 9, 13, 15) });
  stats.record("combine_start"); stats.record("board_add");
  stats.pulse("fine", { firstWinMs: 5000 }); stats.pulse("fine"); stats.pulse("loved");
  stats.firstWin(5000);
  const csv = stats.csv().split("\n");
  assert.equal(csv[0], "kind,day,name,value");
  assert.ok(csv.includes("count,2026-10-13,combine_start,1"));
  assert.ok(csv.includes("count,2026-10-13,board_add,1"));
  assert.ok(csv.includes("pulse,2026-10-13,fine,2"));
  assert.ok(csv.includes("pulse,2026-10-13,loved,1"));
  assert.ok(csv.includes("first_win_ms,2026-10-13,real,5000"));
  stats.clear();
  assert.equal(stats.csv(), "kind,day,name,value");
});
