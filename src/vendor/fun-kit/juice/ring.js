// SVG progress rings. Colours come from CSS classes -> --fk-* tokens.
// Animation is a CSS transition on stroke-dashoffset (disabled under reduced motion).

export function ringGeometry(size, stroke, value) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return { r, c, offset: c * (1 - v), cx: size / 2, cy: size / 2, value: v };
}

/**
 * @param {{value?: number, size?: number, stroke?: number, label?: string, rings?: Array<{value: number, tone?: string}>, center?: string, animate?: boolean}} o
 * `rings` draws concentric activity-style rings (outermost first); each `tone` maps to class fk-tone-<tone>.
 */
export function ringSvg({ value = 0, size = 96, stroke = 10, label = "", rings, center = "", animate = true } = {}) {
  const list = rings ?? [{ value }];
  const gap = stroke + 4;
  const parts = list.map((rg, i) => {
    const g = ringGeometry(size - i * gap * 2, stroke, rg.value);
    const off = i * gap;
    const initial = animate ? g.c : g.offset;
    return `<g transform="translate(${off} ${off})">`
      + `<circle class="fk-ring-track" cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="none" stroke-width="${stroke}"/>`
      + `<circle class="fk-ring-bar fk-tone-${rg.tone ?? "accent"}" cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="none" stroke-width="${stroke}" stroke-linecap="round"`
      + ` stroke-dasharray="${g.c.toFixed(2)}" stroke-dashoffset="${initial.toFixed(2)}" data-target="${g.offset.toFixed(2)}" transform="rotate(-90 ${g.cx} ${g.cy})"/></g>`;
  }).join("");
  const pct = Math.round(Math.max(0, Math.min(1, list[0].value)) * 100);
  return `<svg class="fk-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${(label || "Progress").replace(/"/g, "")}: ${pct}%">${parts}`
    + (center ? `<text class="fk-ring-center" x="50%" y="50%" text-anchor="middle" dominant-baseline="central">${center}</text>` : "") + `</svg>`;
}

/** Mount a ring and animate it to its value on the next frame. Returns { update(value|values), el }. */
export function mountRing(container, opts = {}) {
  container.innerHTML = ringSvg(opts);
  const svg = container.firstElementChild;
  const settle = () => svg.querySelectorAll(".fk-ring-bar").forEach((c) => c.setAttribute("stroke-dashoffset", c.dataset.target));
  const raf = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
  raf(() => raf(settle));
  return {
    el: svg,
    update(value) {
      const values = Array.isArray(value) ? value : [value];
      svg.querySelectorAll(".fk-ring-bar").forEach((c, i) => {
        const r = Number(c.getAttribute("r")), circ = 2 * Math.PI * r;
        const v = Math.max(0, Math.min(1, values[i] ?? 0));
        c.setAttribute("stroke-dashoffset", (circ * (1 - v)).toFixed(2));
      });
      svg.setAttribute("aria-label", `${(opts.label || "Progress")}: ${Math.round((values[0] ?? 0) * 100)}%`);
    },
  };
}
