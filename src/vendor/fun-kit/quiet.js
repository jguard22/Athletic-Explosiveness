// Quiet gate: hold celebrations (sound, haptics, confetti, modals) while something must not be interrupted, and
// release them afterwards. A balance test, a stance, a measurement, a recording or a live session is no moment for a
// buzz on the foot or a level-up modal, and a buzz can change what the sensor reads.
//
//   const gate = createQuietGate({ isQuiet: () => session.running });   // and/or hold("stance") / release("stance")
//   gate.run(() => playOutcome(outcome, { sound, haptics }));            // plays now, or waits until the gate opens
//   playOutcome(outcome, { sound, haptics, gate });                      // same thing, built in
//
// The gate only holds what is sent through it. XP, streaks and badges are saved at once either way; only the
// celebration is deferred. Queued work is bounded (a size cap, an age limit), coalesced by key, and runs one item at a
// time with a short gap so a backlog never lands as a pile-up. Nothing is persisted: a reload drops the queue, and the
// recap screen still has the result.
//
// Two ways to close the gate, and they combine:
//   isQuiet()          a function the gate asks every time (is a session running?)
//   hold(name) / release(name)   named holds. Idempotent per name (holding twice needs one release) and self-expiring
//                      (`maxHoldMs`, default 30 minutes), so a crashed session can never mute the app for good.
//
// With isQuiet() alone (no events to hook), the gate checks again every `pollMs` (500 ms) for as long as something is
// waiting, then stops: nothing to start, nothing to dispose. `watch(ms)` is still there to poll all the time.
//
// A live moment (a smash, a rep landing) that is only worth playing right now goes through `run(fn, { live: true })`:
// it plays at once when the gate is open, even while earlier celebrations are still unwinding, and is dropped, never
// queued, when the gate is closed.
//
// If isQuiet() throws, the gate stays closed: the safe side of a safety gate is silence.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{isQuiet?: () => boolean, maxQueue?: number, maxAgeMs?: number, maxHoldMs?: number, spacingMs?: number,
 *   autoFlush?: boolean, now?: () => number, sleep?: (ms: number) => Promise<any>}} [o]
 *   maxQueue   waiting items kept (default 6); past that the lowest-priority, oldest one is dropped.
 *   maxAgeMs   a queued item older than this is dropped instead of run (default 10 minutes); a late celebration is a false one.
 *   maxHoldMs  a named hold older than this lapses by itself (default 30 minutes; 0 = never).
 *   spacingMs  pause between queued items when flushing (default 350).
 *   autoFlush  releasing the last hold flushes the queue (default true).
 *   pollMs     with `isQuiet`: re-check this often while items wait, and flush when it opens (default 500; 0 = never, flush yourself).
 */
export function createQuietGate({ isQuiet, maxQueue = 6, maxAgeMs = 10 * 60000, maxHoldMs = 30 * 60000, spacingMs = 350, autoFlush = true, pollMs = 500, now = Date.now, sleep = wait } = {}) {
  const holds = new Map(); // name -> since
  const queue = [];
  const listeners = new Map();
  let nextId = 1, draining = null, watchTimer = null, pollTimer = null, lastQuiet = null;

  const emit = (type, payload) => { for (const fn of listeners.get(type) ?? []) { try { fn(payload); } catch {} } };
  const on = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn); };

  function expireHolds() {
    if (!(maxHoldMs > 0)) return;
    const t = now();
    for (const [name, since] of holds) if (t - since > maxHoldMs) { holds.delete(name); emit("expire", { name }); }
  }
  function quietNow() {
    expireHolds();
    if (holds.size) return true;
    if (typeof isQuiet !== "function") return false;
    try { return !!isQuiet(); } catch { return true; }
  }
  function noteChange() {
    const q = quietNow();
    if (q !== lastQuiet) { lastQuiet = q; emit(q ? "quiet" : "open", { quiet: q, holds: [...holds.keys()] }); }
    return q;
  }

  function settle(item, outcome) { try { item.resolve(outcome); } catch {} }
  function drop(item, reason) { emit("drop", { id: item.id, key: item.key, label: item.label, reason }); settle(item, { ran: false, reason }); }

  async function execute(item) {
    try {
      const result = await item.fn();
      settle(item, { ran: true, result });
    } catch (error) {
      emit("error", { id: item.id, label: item.label, error });
      settle(item, { ran: true, error }); // a failed celebration never takes the app down
    }
  }

  /**
   * Run `fn` now if the gate is open, otherwise queue it.
   * @param {() => any} fn  may return a promise; the next queued item waits for it
   * @param {{key?: string, priority?: number, label?: string, maxAgeMs?: number, keep?: "latest"|"first", live?: boolean}} [opts]
   *   key       items with the same key coalesce: the newest replaces the waiting one (keep: "first" keeps the old one)
   *   priority  higher runs first when flushing (default 0); on overflow the lowest goes first
   *   live      play now or drop: runs at once when the gate is open (never behind a backlog or a flush still unwinding),
   *             and is dropped with `{ ran: false, reason: "quiet" }` when it is closed. Never queued.
   * @returns {{ran: boolean, queued: boolean, id: number, done: Promise<{ran: boolean, result?: any, error?: any, reason?: string}>}}
   */
  function run(fn, { key, priority = 0, label, maxAgeMs: ttl = maxAgeMs, keep = "latest", live = false } = {}) {
    if (typeof fn !== "function") throw new Error("fun-kit quiet gate: run() needs a function");
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const item = { id: nextId++, fn, key, priority, label, at: now(), ttl, resolve };
    if (live) {
      if (noteChange()) { drop(item, "quiet"); return { ran: false, queued: false, id: item.id, done }; }
      execute(item);
      return { ran: true, queued: false, id: item.id, done };
    }
    if (!queue.length && !draining && !noteChange()) {
      execute(item);
      return { ran: true, queued: false, id: item.id, done };
    }
    if (key != null) {
      const same = queue.findIndex((q) => q.key === key);
      if (same >= 0) {
        if (keep === "first") { drop(item, "coalesced"); return { ran: false, queued: false, id: item.id, done }; }
        drop(queue[same], "coalesced");
        queue.splice(same, 1);
      }
    }
    queue.push(item);
    emit("queue", { id: item.id, key, label, pending: queue.length });
    while (queue.length > maxQueue) {
      let worst = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[worst].priority) worst = i; // oldest among the lowest
      const [gone] = queue.splice(worst, 1);
      drop(gone, "overflow");
    }
    if (!quietNow() && !draining) flush(); // the gate was already open (a drain was not running): get going
    else if (queue.length) pollStart();
    return { ran: false, queued: queue.includes(item), id: item.id, done };
  }

  /**
   * Run what is waiting, one at a time, while the gate stays open. Stops (leaving the rest queued) if it closes again.
   * `force` opens the gate for this flush only. Returns what happened.
   * @returns {Promise<{ran: number, dropped: number, remaining: number}>}
   */
  function flush({ force = false } = {}) {
    if (draining) return draining;
    draining = (async () => {
      await null; // let `draining` be assigned before the body can finish and clear it
      let ran = 0, dropped = 0;
      try {
        while (queue.length && (force || !quietNow())) {
          queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
          const item = queue.shift();
          if (now() - item.at > item.ttl) { drop(item, "expired"); dropped++; continue; }
          await execute(item); ran++;
          if (queue.length && spacingMs > 0) await sleep(spacingMs);
        }
      } finally {
        draining = null;
      }
      const result = { ran, dropped, remaining: queue.length };
      if (!queue.length) pollStop();
      if (ran || dropped) emit("flush", result);
      noteChange();
      return result;
    })();
    return draining;
  }

  /** Close the gate under a name (idempotent). Returns a function that releases it. */
  function hold(name = "hold") {
    if (!holds.has(name)) holds.set(name, now());
    noteChange();
    return () => release(name);
  }

  /** Open a named hold. When it was the last thing keeping the gate shut, the queue flushes (unless autoFlush is off). */
  function release(name = "hold") {
    const had = holds.delete(name);
    const quiet = noteChange();
    if (had && !quiet && autoFlush && queue.length) flush();
    return had;
  }

  /** Throw the waiting items away (each resolves `{ ran: false, reason }`). */
  function clear(reason = "cleared") {
    const gone = queue.splice(0);
    pollStop();
    for (const item of gone) drop(item, reason);
    return gone.length;
  }

  /** While something waits on an `isQuiet` gate: re-check every `pollMs`, flush when it opens, stop when the queue is empty. */
  function pollStart() {
    if (pollTimer || watchTimer || typeof isQuiet !== "function" || !(pollMs > 0) || !autoFlush) return;
    pollTimer = setInterval(() => {
      if (!queue.length) return pollStop();
      if (!noteChange() && !draining) flush();
    }, pollMs);
    pollTimer.unref?.();
  }
  function pollStop() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  /** For an `isQuiet` gate with no events: re-check every `ms` and flush when it opens. Returns a stop function. */
  function watch(ms = 500) {
    unwatch(); pollStop();
    watchTimer = setInterval(() => { if (!noteChange() && queue.length && !draining) flush(); }, ms);
    return unwatch;
  }
  function unwatch() { if (watchTimer) clearInterval(watchTimer); watchTimer = null; }

  return {
    run, flush, hold, release, clear, watch, unwatch, on,
    /** Wrap a function so every call goes through the gate. */
    wrap: (fn, opts) => (...args) => run(() => fn(...args), opts),
    get quiet() { return quietNow(); },
    get pending() { return queue.length; },
    get holds() { expireHolds(); return [...holds.keys()]; },
    /** What is waiting, in the order it would run. */
    list: () => [...queue].sort((a, b) => b.priority - a.priority || a.id - b.id).map((q) => ({ id: q.id, key: q.key, label: q.label, priority: q.priority, ageMs: now() - q.at })),
    dispose() { unwatch(); pollStop(); clear("disposed"); holds.clear(); listeners.clear(); },
  };
}
