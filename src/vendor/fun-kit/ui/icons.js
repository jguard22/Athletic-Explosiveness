// Small inline icon set (24x24, stroke = currentColor so tokens drive colour).

const P = {
  star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z",
  flame: "M12 3c.6 3.2-2.6 4.6-2.6 8a3.6 3.6 0 007.2 0c0-1.2-.5-2-1-2.8.2 1.4-.7 2.2-1.6 2.2.5-3-1.1-4.7-2-7.4zM9 16.2a3.2 3.2 0 006 0",
  bolt: "M13 2.5L5 13.5h6l-1 8 8-11h-6z",
  trophy: "M8 4h8v5a4 4 0 01-8 0zM8 6H4.5a2.5 2.5 0 002.8 3.6M16 6h3.5a2.5 2.5 0 01-2.8 3.6M12 13v4M8.5 20h7M10 17h4",
  lock: "M6.5 10.5h11v9h-11zM8.5 10.5V8a3.5 3.5 0 017 0v2.5",
  gift: "M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7s-1-3.5-3.5-3.5S8 7 12 7zm0 0s1-3.5 3.5-3.5S16 7 12 7z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  heart: "M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z",
  rest: "M12 3v18M5.6 6.6l12.8 10.8M18.4 6.6L5.6 17.4M3 12h18",
  target: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM12 11a1 1 0 100 2 1 1 0 000-2z",
  refresh: "M20 11a8 8 0 00-14.5-4M4 4v4h4M4 13a8 8 0 0014.5 4M20 20v-4h-4",
  share: "M12 15V4M8 8l4-4 4 4M5 13v6h14v-6",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M9 5l7 7-7 7",
};

export function iconSvg(name, { size = "1.15em", cls = "" } = {}) {
  const d = P[name] ?? P.star;
  return `<svg class="fk-i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

export const ICON_NAMES = Object.keys(P);
