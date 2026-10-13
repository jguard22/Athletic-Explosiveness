// Tiny event emitter. Handler errors never break the caller.

export function createEmitter() {
  const handlers = new Map();
  const api = {
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, new Set());
      handlers.get(evt).add(fn);
      return () => api.off(evt, fn);
    },
    once(evt, fn) {
      const off = api.on(evt, (p) => { off(); fn(p); });
      return off;
    },
    off(evt, fn) { handlers.get(evt)?.delete(fn); },
    emit(evt, payload) {
      for (const fn of [...(handlers.get(evt) ?? []), ...(handlers.get("*") ?? [])]) {
        try { fn(payload, evt); } catch (e) { try { console.warn(`[fun-kit] handler for "${evt}" threw`, e); } catch {} }
      }
    },
    clear() { handlers.clear(); },
  };
  return api;
}
