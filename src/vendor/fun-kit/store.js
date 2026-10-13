// Namespaced, versioned key-value store on localStorage.
//
// - Keys live under "fk:<app>:" so several apps (or the kit and the host
//   app) never collide on one origin.
// - A schema version is stored beside the data; `migrations[n]` upgrades a
//   whole snapshot from n-1 to n. A failing migration leaves a backup and the
//   version untouched (it retries next load) instead of destroying data.
// - Reads go to storage every time (parsed JSON is cached by its raw string),
//   so a second tab's writes are always seen and a stale tab can never write
//   an old copy of a key over a newer one. A `storage` event also fires the
//   store's "change" subscribers with `external: true`.
// - Private windows / blocked storage / quota errors fall back to memory
//   without throwing. A failed write only marks THAT key unsaved (memory stays
//   authoritative for it and the next write retries); later small writes still
//   persist. `store.persistent` is false while anything is unsaved (or there is no storage at all).
//   `store.kind` says what is behind it: "local" (a real Storage), "memory" (createMemoryStorage(), by choice: tests,
//   a demo twin) or "none" (storage was unavailable). `store.durable` is true only when the data will survive a reload:
//   a real Storage with nothing unsaved.
// - `transaction(fn)` rolls every write back if `fn` throws.
// - `exportData()` / `importData()` move the whole namespace as plain JSON, and
//   `requestPersistence()` asks the browser not to evict it (Safari purges
//   script-written storage after about 7 days without a visit).
// - Values are JSON; get() returns a fresh clone so callers can't mutate
//   the cache by accident.

import { createEmitter } from "./emitter.js";

export function createMemoryStorage() {
  const m = new Map();
  const api = {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
  Object.defineProperty(api, "isMemory", { value: true }); // not enumerable: a spread copy of it is an ordinary Storage
  return api;
}

function resolveStorage(explicit) {
  const candidate = explicit ?? (() => { try { return globalThis.localStorage; } catch { return null; } })();
  if (!candidate) return null;
  try {
    const probe = "__fk_probe__";
    candidate.setItem(probe, "1");
    candidate.removeItem(probe);
    return candidate;
  } catch { return null; }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const VERSION_SENTINEL = "\u0000version";

/**
 * @param {{app: string, version?: number, migrations?: Record<number,(snapshot:any)=>any>, storage?: Storage, listen?: boolean}} opts
 */
export function createStore({ app, version = 1, migrations = {}, storage, listen = true } = {}) {
  if (!app) throw new Error("fun-kit store: `app` is required");
  const prefix = `fk:${app}:`;
  const VKEY = `${prefix}__v`;
  const emitter = createEmitter();
  let backing = resolveStorage(storage);
  const mem = new Map();
  const parsed = new Map(); // key -> { raw, value }: skips re-parsing unchanged strings
  const unsaved = new Set(); // keys whose last write to storage failed; memory is authoritative for them
  const kind = !backing ? "none" : backing.isMemory === true ? "memory" : "local";
  const status = { persistent: !!backing, kind, version, storedVersion: null, migrated: false, migrationError: null, newerData: false, corrupt: [], writeErrors: 0 };
  const syncPersistent = () => { status.persistent = !!backing && unsaved.size === 0; };
  let versionOwed = false; // after wipe(): the schema marker is written again with the next real write

  const rawKeys = () => {
    if (!backing) return [];
    const out = [];
    try { for (let i = 0; i < backing.length; i++) { const k = backing.key(i); if (k && k.startsWith(prefix) && k !== VKEY && !k.startsWith(`${prefix}__`)) out.push(k.slice(prefix.length)); } } catch {}
    return out;
  };

  const writeThrough = (key, value) => {
    if (!backing) return;
    try {
      if (value === undefined) { backing.removeItem(prefix + key); parsed.delete(key); }
      else {
        const raw = JSON.stringify(value);
        backing.setItem(prefix + key, raw); parsed.set(key, { raw, value });
        if (versionOwed) { versionOwed = false; backing.setItem(VKEY, String(version)); }
      }
      unsaved.delete(key);
    } catch { unsaved.add(key); status.writeErrors++; }
    syncPersistent();
  };

  /** Current value of a key: storage first (other tabs may have written), memory for unsaved keys and as a fallback. */
  function read(key) {
    if (backing && !unsaved.has(key)) {
      try {
        const raw = backing.getItem(prefix + key);
        if (raw == null) { mem.delete(key); parsed.delete(key); return undefined; }
        const hit = parsed.get(key);
        if (hit && hit.raw === raw) return hit.value;
        const value = JSON.parse(raw);
        parsed.set(key, { raw, value }); mem.set(key, value);
        return value;
      } catch { if (!status.corrupt.includes(key)) status.corrupt.push(key); }
    }
    return mem.get(key);
  }

  // ---- load
  for (const k of rawKeys()) {
    try { const raw = backing.getItem(prefix + k); const value = JSON.parse(raw); mem.set(k, value); parsed.set(k, { raw, value }); } catch { status.corrupt.push(k); }
  }
  let stored = null;
  try { const v = backing?.getItem(VKEY); stored = v == null ? null : Number(v); } catch {}
  status.storedVersion = stored;

  function writeVersion(v) { try { backing?.setItem(VKEY, String(v)); } catch { unsaved.add(VERSION_SENTINEL); status.writeErrors++; syncPersistent(); } }

  /** Pure: run migrations (from, version] over a snapshot. */
  function migrate(snapshot, from) {
    let snap = clone(snapshot);
    for (let v = from + 1; v <= version; v++) {
      const fn = migrations[v];
      if (typeof fn === "function") snap = fn(snap) ?? snap;
    }
    return snap;
  }

  function runMigrations(from) {
    const backup = Object.fromEntries(mem);
    try {
      const snap = migrate(backup, from);
      for (const k of [...mem.keys()]) if (!(k in snap)) { mem.delete(k); writeThrough(k, undefined); }
      for (const [k, v] of Object.entries(snap)) { mem.set(k, v); writeThrough(k, v); }
      writeVersion(version);
      status.migrated = true;
    } catch (e) {
      status.migrationError = String(e?.message ?? e);
      // Roll memory back to the untouched snapshot and keep a raw backup.
      mem.clear();
      for (const [k, v] of Object.entries(backup)) mem.set(k, v);
      try { backing?.setItem(`${prefix}__backup_v${from}`, JSON.stringify(backup)); } catch {}
    }
  }

  // ---- migrate
  if (stored == null) {
    // Fresh namespace (or pre-versioning data, read as v1).
    const start = mem.size ? 1 : version;
    if (start < version) runMigrations(start);
    else writeVersion(version);
  } else if (stored < version) runMigrations(stored);
  else if (stored > version) status.newerData = true;

  // ---- other tabs
  let onStorage = null;
  if (listen && typeof globalThis.addEventListener === "function") {
    onStorage = (e) => {
      if (!backing || (e.storageArea && e.storageArea !== backing)) return;
      if (e.key == null) { mem.clear(); parsed.clear(); emitter.emit("change", { key: null, value: undefined, external: true }); return; }
      if (!e.key.startsWith(prefix) || e.key.startsWith(`${prefix}__`)) return;
      const key = e.key.slice(prefix.length);
      mem.delete(key); parsed.delete(key); unsaved.delete(key); syncPersistent();
      emitter.emit("change", { key, value: clone(read(key)), external: true });
    };
    globalThis.addEventListener("storage", onStorage);
  }

  // ---- transactions
  let journal = null;
  const note = (key) => { if (journal && !journal.has(key)) journal.set(key, clone(read(key))); };

  const api = {
    get app() { return app; },
    get persistent() { return status.persistent; },
    /** "local" (a real Storage), "memory" (createMemoryStorage() on purpose) or "none" (storage was unavailable). */
    get kind() { return status.kind; },
    /** True when what is saved will survive a reload: a real Storage and nothing unsaved. False for memory-only stores (tests, demo twins). */
    get durable() { return status.kind === "local" && status.persistent; },
    status,
    get(key, fallback) { const v = read(key); return v === undefined ? fallback : clone(v); },
    has: (key) => read(key) !== undefined,
    set(key, value) {
      if (value === undefined) return api.remove(key);
      note(key);
      const v = clone(value);
      mem.set(key, v);
      writeThrough(key, v);
      emitter.emit("change", { key, value: clone(v) });
      return value;
    },
    /** Read-modify-write; fn receives a clone and returns the new value (or mutates and returns undefined). */
    update(key, fn, fallback) {
      const cur = api.get(key, fallback);
      const next = fn(cur);
      return api.set(key, next === undefined ? cur : next);
    },
    remove(key) {
      note(key);
      mem.delete(key);
      writeThrough(key, undefined);
      emitter.emit("change", { key, value: undefined });
    },
    keys: () => (backing ? [...new Set([...rawKeys(), ...[...unsaved].filter((k) => mem.has(k))])] : [...mem.keys()]),
    snapshot() { const out = {}; for (const k of api.keys()) { const v = read(k); if (v !== undefined) out[k] = clone(v); } return out; },
    clear() { for (const k of api.keys()) api.remove(k); },
    /**
     * Forget everything: every key of this namespace, the schema marker and any migration backup, leaving nothing in
     * storage. The marker is written again by the next real write, so a data-forgetting screen leaves no footprint
     * until the app saves something new. (clear() keeps the marker.)
     */
    wipe() {
      for (const k of api.keys()) { mem.delete(k); parsed.delete(k); }
      if (backing) {
        const all = [];
        try { for (let i = 0; i < backing.length; i++) { const k = backing.key(i); if (k && k.startsWith(prefix)) all.push(k); } } catch {}
        for (const k of all) { try { backing.removeItem(k); } catch {} }
      }
      mem.clear(); parsed.clear(); unsaved.clear();
      versionOwed = true;
      syncPersistent();
      emitter.emit("change", { key: null, value: undefined });
    },
    subscribe: (fn) => emitter.on("change", fn),

    /** Run `fn` synchronously; if it throws, every key it wrote is restored and the error rethrown. */
    transaction(fn) {
      if (journal) return fn();
      journal = new Map();
      try { return fn(); }
      catch (e) {
        const undo = journal; journal = null;
        for (const [k, prev] of undo) { if (prev === undefined) api.remove(k); else api.set(k, prev); }
        throw e;
      } finally { journal = null; }
    },

    /** Everything in this namespace as plain JSON-able data (for a backup file). */
    exportData() { return { format: "fk-export", app, version, exportedAt: Date.now(), data: api.snapshot() }; },
    /** Restore an export (object or JSON string). Replaces the namespace unless `merge`. Older exports are migrated. */
    importData(payload, { merge = false } = {}) {
      const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (!obj || obj.format !== "fk-export" || obj.app !== app || !obj.data || typeof obj.data !== "object") throw new Error("fun-kit store: that file is not a backup for this app");
      const from = Number(obj.version) || 1;
      if (from > version) throw new Error("fun-kit store: that backup is from a newer version of the app");
      const data = from < version ? migrate(obj.data, from) : clone(obj.data);
      api.transaction(() => {
        if (!merge) api.clear();
        for (const [k, v] of Object.entries(data)) api.set(k, v);
      });
      return Object.keys(data).length;
    },
    /** Ask the browser to keep this origin's storage (resolves false when unsupported or declined). */
    async requestPersistence(nav = globalThis.navigator) {
      try { return !!(await nav?.storage?.persist?.()); } catch { return false; }
    },
    /** Stop listening for other tabs (tests, hot reload). */
    dispose() { if (onStorage) { globalThis.removeEventListener?.("storage", onStorage); onStorage = null; } },

    /** Sub-store: every key is prefixed with `name.` */
    scoped(name) {
      const p = `${name}.`;
      return {
        get: (k, f) => api.get(p + k, f),
        set: (k, v) => api.set(p + k, v),
        update: (k, fn, f) => api.update(p + k, fn, f),
        remove: (k) => api.remove(p + k),
        has: (k) => api.has(p + k),
      };
    },
  };
  return api;
}
