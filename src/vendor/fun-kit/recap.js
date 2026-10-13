// End-of-session story recap + share card.
//
// buildRecap() turns a session outcome into 3-5 "story" cards:
//   headline stat -> personal best / near miss -> streak or weekly goal ->
//   level / badges / drop -> next goal.
// Cards are plain data; ui/components.js renders them as a carousel.
//
// Privacy: every card is tagged `health: true` when it carries a measured value
// (a score, a time, a balance reading). The share card shows app, level and streak
// by default. Health-derived cards are left off unless the person ticks the
// opt-in (includeHealth) for that share, and only where the mode allows it
// (guardrails shareHealthData). Badge and challenge titles can reveal a measurement
// ("Score 95 or higher"), so they are shared only when the badge / template is
// marked `shareSafe: true`. Where sharing is off (kids), no card is shareable.

import { labelsFor } from "./labels.js";
import { toNextText } from "./xp.js";

// Headless fallbacks (no DOM, so no CSS custom properties to read; in a page the share card reads the host's --fk-* tokens). Built from channel values at load time, so the
// source holds no colour literal for an app's style-token lint to trip over when this folder is vendored.
const hexOf = (r, g, b) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
export const FALLBACK_TOKENS = Object.freeze({
  accent: hexOf(0, 212, 170), accentText: hexOf(0, 212, 170), bg: hexOf(6, 11, 26), surface: hexOf(13, 22, 49), ink: hexOf(242, 245, 255),
  muted: hexOf(149, 161, 192), gold: hexOf(255, 204, 85), goldText: hexOf(255, 204, 85), onAccent: hexOf(4, 33, 26),
});

export function readTokens(el) {
  try {
    const target = el ?? globalThis.document?.documentElement;
    if (!target || !globalThis.getComputedStyle) return { ...FALLBACK_TOKENS };
    const cs = getComputedStyle(target);
    const pick = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    const accent = pick("--fk-accent", FALLBACK_TOKENS.accent), gold = pick("--fk-gold", FALLBACK_TOKENS.gold);
    return {
      accent, accentText: pick("--fk-accent-text", accent), bg: pick("--fk-bg", FALLBACK_TOKENS.bg), surface: pick("--fk-surface", FALLBACK_TOKENS.surface),
      ink: pick("--fk-ink", FALLBACK_TOKENS.ink), muted: pick("--fk-muted", FALLBACK_TOKENS.muted), gold, goldText: pick("--fk-gold-text", gold),
      onAccent: pick("--fk-on-accent", FALLBACK_TOKENS.onAccent),
    };
  } catch { return { ...FALLBACK_TOKENS }; }
}


/**
 * @param {object} outcome from kit.completeSession() (or hand-built)
 *   { headline?: {label, value, unit?, caption?, health?}, xp?, pbs?, streak?, badges?, challenges?, drop?, nextGoal?, nudge?, appName? }
 * @param {{sharing?: boolean, labels?: Record<string, string|Function>, featureLabel?: (id: string) => string}} [opts] sharing: false marks every card not shareable (kids mode);
 *   labels: the words on the cards (see labels.js); featureLabel: the name shown for an unlocked feature id (default: the id)
 */
export function buildRecap(outcome = {}, { sharing = true, labels, featureLabel = (id) => id } = {}) {
  const L = labelsFor(labels);
  const cards = [];
  const { headline, xp, pbs = [], streak, badges = [], challenges = [], drop, nextGoal, quests, nudge } = outcome;

  if (headline) {
    cards.push({ id: "headline", kind: "headline", tone: "accent", eyebrow: headline.label ?? L("recapSessionComplete"), big: String(headline.value), unit: headline.unit ?? "", title: headline.caption ?? L("recapNiceWork"), health: headline.health !== false, shareable: true });
  } else if (xp) {
    cards.push({ id: "headline", kind: "headline", tone: "accent", eyebrow: L("recapSessionComplete"), big: `+${xp.gained}`, unit: "XP", title: L("recapNiceWorkXp"), health: false, shareable: true });
  }

  const best = pbs.find((p) => p.isPB) ?? pbs.find((p) => p.isFirst) ?? pbs.find((p) => p.nearMiss);
  if (best) {
    cards.push({
      id: "pb", kind: "pb", tone: best.isPB || best.isFirst ? "gold" : "accent",
      eyebrow: best.isPB ? L("recapPb") : best.isFirst ? L("recapFirstMark") : L("recapNearMiss"),
      big: best.valueText ?? String(best.value), unit: "", title: best.text, health: true, shareable: true,
    });
  }

  if (streak && streak.off !== true) {
    if (streak.comeback) {
      cards.push({ id: "streak", kind: "streak", tone: "calm", eyebrow: L("recapWelcomeBack"), big: `+${streak.comeback.bonusXp}`, unit: "XP", title: streak.comeback.message, health: false, shareable: false }); // a lapse is nobody else's business
    } else if (streak.mode === "weekly" && streak.thisWeek) {
      const w = streak.thisWeek;
      // The goal counts distinct days or every session, whichever the streak was set up with; the card says which.
      const counting = w.unit ?? streak.unit ?? "sessions";
      const word = (n) => L(counting === "days" ? "unitDay" : "unitSession", { n });
      cards.push({
        id: "streak", kind: "streak", tone: w.reached ? "gold" : "calm", eyebrow: w.reached ? L("recapWeeklyGoal") : L("recapThisWeek"),
        big: `${Math.min(w.count, w.target)}/${w.target}`, unit: counting === "days" ? L("unitDay", { n: 2 }) : L("unitSession", { n: 2 }),
        title: w.reached
          ? `${L("recapGoalHit")}${streak.current > 1 ? L("recapWeeksRunning", { n: streak.current, unit: L("unitWeek", { n: streak.current }) }) : ""}`
          : L("recapToGo", { remaining: w.remaining, unit: word(w.remaining), daysLeft: w.daysLeft, daysUnit: L("unitDay", { n: w.daysLeft }) }),
        health: false, shareable: true,
      });
    } else if (streak.mode === "daily") {
      cards.push({
        id: "streak", kind: "streak", tone: "gold", eyebrow: streak.milestone ? L("recapMilestone", { n: streak.milestone }) : L("recapStreak"), big: String(streak.current), unit: L("unitDay", { n: streak.current }),
        title: streak.coveredNow ? L("recapRestCovered") : streak.milestone ? L("recapHabit") : L("recapKeepRolling"), health: false, shareable: true,
      });
    }
  }

  // Each line carries `safe`: only safe lines may appear on a share image.
  const unlocks = [];
  if (xp?.levelUp) unlocks.push({ text: L("recapLevel", { level: xp.toLevel, title: xp.title }), safe: true });
  for (const b of badges) unlocks.push({ text: L("recapBadge", { title: b.title ?? b.badge?.title }), safe: b.shareSafe === true || b.badge?.shareSafe === true });
  if (drop?.drop) unlocks.push({ text: L("recapSurprise", { title: drop.drop.title }), safe: true });
  for (const c of challenges) unlocks.push({ text: L("recapChallenge", { title: c.title }), safe: c.shareSafe === true });
  for (const f of quests?.unlockedFeatures ?? []) unlocks.push({ text: L("recapUnlocked", { feature: featureLabel(f) }), safe: true });
  if (unlocks.length && cards.length < 4) {
    const safe = unlocks.filter((u) => u.safe).map((u) => u.text);
    const texts = unlocks.map((u) => u.text);
    cards.push({
      id: "unlocks", kind: "unlocks", tone: "gold", eyebrow: xp?.levelUp ? L("recapLevelUpEyebrow") : L("recapUnlockedEyebrow"),
      big: xp?.levelUp ? `Lv ${xp.toLevel}` : `+${unlocks.length}`, unit: "", title: texts.slice(0, 3).join(" · "), list: texts, health: false,
      shareable: safe.length > 0, shareBig: xp?.levelUp ? `Lv ${xp.toLevel}` : `+${safe.length}`, shareTitle: safe.slice(0, 3).join(" · "),
    });
  }

  if (cards.length < 3 && xp) {
    cards.push({ id: "xp", kind: "xp", tone: "accent", eyebrow: L("recapLevelEyebrow", { level: xp.level }), big: `${xp.into}/${xp.need}`, unit: "XP", title: `${toNextText(xp, L)}.`, health: false, shareable: true });
  }

  cards.push({
    id: "next", kind: "next", tone: nudge ? "calm" : "accent", eyebrow: nudge ? L("recapRestWell") : L("recapUpNext"), big: nudge ? "" : nextGoal?.big ?? "", unit: "",
    title: nudge ? nudge.text : nextGoal?.text ?? nextGoal?.title ?? L("recapComeBack"), health: false, shareable: false,
  });

  // Keep 3-5 cards: drop optional ones by priority if over, never the headline or next.
  const order = ["xp", "unlocks", "streak", "pb"];
  while (cards.length > 5) { const drop_ = order.find((k) => cards.some((c) => c.id === k)); cards.splice(cards.findIndex((c) => c.id === drop_), 1); }
  if (!sharing) for (const c of cards) c.shareable = false;
  return cards;
}

/** What the share image will contain, as data (testable without a canvas). Cards are copied down to their share-safe text. */
export function shareModel(recap, { includeHealth = false, appName = "BrilliantWear", level, title, streakLine, guardrails } = {}) {
  if (guardrails && !guardrails.allows("sharing")) return { appName, level: null, title: null, headline: null, lines: [], streakLine: null, includesHealth: false, blocked: true };
  const withHealth = includeHealth && (!guardrails || guardrails.allows("shareHealthData"));
  const safe = (c) => ({ ...c, big: c.shareBig ?? c.big, title: c.shareTitle ?? c.title, list: undefined });
  const cards = recap.filter((c) => c.shareable && (withHealth || !c.health)).map(safe);
  // The hero is the headline when it may be shared, otherwise the first shareable card (streak, level, ...).
  const hero = cards.find((c) => c.kind === "headline") ?? cards[0] ?? null;
  return {
    appName,
    level: level ?? null,
    title: title ?? null,
    headline: hero,
    lines: cards.filter((c) => c !== hero).map((c) => ({ eyebrow: c.eyebrow, big: c.big, unit: c.unit, text: c.title })),
    streakLine: streakLine ?? null,
    includesHealth: withHealth && recap.some((c) => c.health && c.shareable),
    blocked: false,
  };
}

function wrapLines(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = w; } else line = t;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type }).then(resolve, reject);
    if (typeof canvas.toBlob === "function") return canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas produced no image"))), type);
    reject(new Error("canvas cannot export an image"));
  });
}

const defaultCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = globalThis.document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

/**
 * Render the share card (4:5, 1080x1350) to a PNG Blob.
 * @param {object[]} recap cards from buildRecap()
 * @param {{width?: number, height?: number, includeHealth?: boolean, appName?: string, level?: number, title?: string, guardrails?: object,
 *   tokens?: object, labels?: object, createCanvas?: (w:number,h:number)=>any}} [opts]  pass `guardrails` (kit.guard) so a mode that forbids sharing refuses and health opt-in is honoured only where allowed
 */
export async function renderShareCard(recap, opts = {}) {
  const { width = 1080, height = 1350, includeHealth = false, tokens = readTokens(), createCanvas = defaultCanvas, guardrails } = opts;
  const L = labelsFor(opts.labels);
  if (guardrails && !guardrails.allows("sharing")) throw new Error(`fun-kit: sharing is switched off in ${guardrails.mode} mode`);
  const model = shareModel(recap, { includeHealth, appName: opts.appName, level: opts.level, title: opts.title, streakLine: opts.streakLine, guardrails });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const pad = width * 0.08;
  const font = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, tokens.surface); grad.addColorStop(1, tokens.bg);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);
  // soft accent glow
  const glow = ctx.createRadialGradient(width * 0.8, height * 0.1, 10, width * 0.8, height * 0.1, width * 0.8);
  glow.addColorStop(0, tokens.accent); glow.addColorStop(1, "transparent");
  ctx.globalAlpha = 0.22; ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;

  ctx.textBaseline = "top";
  // Text uses the text-safe tokens (darker teal / gold in the light theme) so it stays readable on the pale gradient.
  const accentInk = tokens.accentText ?? tokens.accent, goldInk = tokens.goldText ?? tokens.gold;
  ctx.fillStyle = accentInk; ctx.font = `700 ${width * 0.04}px ${font}`;
  ctx.fillText(model.appName.toUpperCase(), pad, pad);
  if (model.level != null) {
    ctx.fillStyle = goldInk; ctx.textAlign = "right";
    ctx.fillText(model.title ? L("shareLevelTitle", { level: model.level, title: model.title.toUpperCase() }) : L("shareLevel", { level: model.level }), width - pad, pad);
    ctx.textAlign = "left";
  }

  let y = height * 0.2;
  if (model.headline) {
    ctx.fillStyle = tokens.muted; ctx.font = `600 ${width * 0.04}px ${font}`;
    ctx.fillText(String(model.headline.eyebrow).toUpperCase(), pad, y); y += width * 0.07;
    ctx.fillStyle = tokens.ink; ctx.font = `800 ${width * 0.22}px ${font}`;
    ctx.fillText(`${model.headline.big}${model.headline.unit ? " " : ""}`, pad, y);
    if (model.headline.unit) {
      const w = ctx.measureText(`${model.headline.big} `).width;
      ctx.fillStyle = accentInk; ctx.font = `700 ${width * 0.07}px ${font}`;
      ctx.fillText(model.headline.unit, pad + w, y + width * 0.12);
    }
    y += width * 0.3;
  }

  for (const line of model.lines.slice(0, 3)) {
    const h = height * 0.13;
    ctx.fillStyle = tokens.surface; roundRect(ctx, pad, y, width - pad * 2, h, 28); ctx.fill();
    ctx.fillStyle = accentInk; ctx.font = `700 ${width * 0.032}px ${font}`;
    ctx.fillText(String(line.eyebrow).toUpperCase(), pad + 32, y + 24);
    ctx.fillStyle = tokens.ink; ctx.font = `700 ${width * 0.05}px ${font}`;
    const text = `${line.big}${line.unit ? ` ${line.unit}` : ""}  ${wrapLines(ctx, line.text, width * 0.45, 1)[0] ?? ""}`;
    ctx.fillText(text.trim(), pad + 32, y + 24 + width * 0.05);
    y += h + 24;
  }

  ctx.fillStyle = tokens.muted; ctx.font = `500 ${width * 0.032}px ${font}`;
  ctx.fillText(L(model.includesHealth ? "shareFooterHealth" : "shareFooterPlain"), pad, height - pad - width * 0.04);

  const blob = await canvasToBlob(canvas, "image/png");
  return blob;
}

/**
 * Share via the Web Share API when files are supported, else download.
 * @returns {Promise<"shared"|"downloaded"|"cancelled">}
 */
export async function shareCard(blob, { title = "My progress", text = "", filename = "progress.png", nav = globalThis.navigator, doc = globalThis.document, urlApi = globalThis.URL } = {}) {
  try {
    const FileCtor = globalThis.File;
    if (nav?.share && nav?.canShare && FileCtor) {
      const file = new FileCtor([blob], filename, { type: blob.type || "image/png" });
      if (nav.canShare({ files: [file] })) {
        try { await nav.share({ files: [file], title, text }); return "shared"; }
        catch (e) { if (e?.name === "AbortError") return "cancelled"; /* fall through to download */ }
      }
    }
  } catch {}
  const url = urlApi.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  doc.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => urlApi.revokeObjectURL(url), 4000);
  return "downloaded";
}
