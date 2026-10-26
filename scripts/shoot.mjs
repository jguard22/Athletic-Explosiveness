// Screenshots of the main screens, for design review: desktop, TV, phone and a narrow phone, light and dark.
//   node scripts/shoot.mjs <outdir> [prefix]        (prefix: "before" / "after"; default "shot")
// Names: <prefix>-<screen>-<size>-<scheme>.png. Uses system Chrome through playwright-core and its own server on :5494 (PORT to override).
// Also checks, at every size, that nothing scrolls sideways and that the console stays clean.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./serve.mjs";

const require = createRequire(import.meta.url);
function findPw() {
  if (process.env.PW) return process.env.PW;
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) { const p = path.join(npx, d, "node_modules/playwright-core"); if (existsSync(p)) return p; }
  return "playwright-core";
}
const { chromium } = require(findPw());

const OUT = process.argv[2] || "shots";
const PREFIX = process.argv[3] || "shot";
const PORT = Number(process.env.PORT || 5494);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;   // e.g. ONLY=tv-dark,phone-light
mkdirSync(OUT, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}/index.html`;

const SIZES = [
  { id: "desk", width: 1280, height: 800, scheme: "light" },
  { id: "desk", width: 1280, height: 800, scheme: "dark" },
  { id: "tv", width: 1920, height: 1080, scheme: "dark" },
  { id: "phone", width: 390, height: 844, scheme: "light" },
  { id: "phone", width: 390, height: 844, scheme: "dark" },
  { id: "narrow", width: 320, height: 640, scheme: "light" },
];

const server = await startServer(PORT);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hard = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 420000);
const errors = [];
const overflow = [];

const evt = (page, detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent("bwfun", { detail: { sim: false, ...d } })), detail);
const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 60 });
async function newCtx({ width, height, scheme }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "no-preference", locale: "en-US", deviceScaleFactor: 1 });
  await ctx.route("**/unpkg.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "/* sdk stub */" }));
  return ctx;
}
async function open(ctx, tag, url = BASE) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${tag} ${m.type()}: ${m.text()}`); });
  await page.goto(url);
  await page.waitForTimeout(900);
  return page;
}
async function settle(page) {
  for (let i = 0; i < 60; i++) {
    const modal = await page.$(".fk-modal button");
    if (modal) { await modal.click(); await page.waitForTimeout(500); }
    const busy = await page.evaluate(() => document.querySelectorAll(".fk-toast, .fk-modal, canvas.fk-fx-canvas, .fk-glow").length + (window.BWFun.gate().busy ? 1 : 0));
    if (!busy) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
}
/** The page clips sideways overflow, so scrollWidth hides problems: look for elements that poke past the viewport and are not inside their own scroller. */
async function noHScroll(page, tag) {
  const bad = await page.evaluate(() => {
    const W = window.innerWidth, out = [];
    const scroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (b.width && b.right > W + 1 && getComputedStyle(el).position !== "fixed" && !scroller(el)) out.push(`${el.tagName}.${String(el.className).slice(0, 30)}#${el.id} right=${Math.round(b.right)}`);
    }
    return { sw: document.documentElement.scrollWidth, W, out: out.slice(0, 6) };
  });
  if (bad.sw > bad.W + 1 || bad.out.length) overflow.push(`${tag}: ${bad.sw} vs ${bad.W} ${bad.out.join(" | ")}`);
}
const shot = async (page, name, tag, opts = {}) => { await noHScroll(page, `${tag}/${name}`); await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}-${tag}.png`), ...opts }); };

/** A returning athlete: one real round fed with the page's own events, so the profile has bests, then the page is reloaded. */
async function seedReturning(ctx) {
  const page = await open(ctx, "seed");
  await page.click("#ae-start");
  await evt(page, { type: "jump", rep: { n: 1, foot: "BOTH", flightMs: 520, estCm: 33.1 } });
  await page.click("#ae-stop");
  await page.click("#ae-rested");
  await page.click("#ae-rematch");
  await page.click("#ae-warm");
  const feeds = [
    { type: "jump", rep: { n: 2, foot: "BOTH", flightMs: 560, estCm: 38.4 } },
    { type: "jump", rep: { n: 3, foot: "L", flightMs: 400, estCm: 19.6 } },
    { type: "jump", rep: { n: 4, foot: "R", flightMs: 420, estCm: 21.6 } },
    { type: "firststep", trial: { n: 1, side: "L", reactionMs: 220, pushMs: 300, stepMs: 480, dir: "FWD", azDeg: 0 } },
    { type: "firststep", trial: { n: 2, side: "R", reactionMs: 210, pushMs: 290, stepMs: 462, dir: "FWD", azDeg: 0 } },
    { type: "firststep", trial: { n: 3, side: "L", reactionMs: 215, pushMs: 295, stepMs: 470, dir: "FWD", azDeg: 0 } },
    { type: "sprint", trial: { n: 1, N: 5, startSide: "L", t3: 1100, tN: 1900, vN: 4.8, accel: 2.5 } },
    { type: "jump", rep: { n: 5, foot: "BOTH", flightMs: 300, estCm: 11 } }, { type: "rsi", rsi: 0.9, hops: 2 },
    { type: "jump", rep: { n: 6, foot: "BOTH", flightMs: 320, estCm: 12 } }, { type: "rsi", rsi: 1.1, hops: 3 },
  ];
  for (const f of feeds) { await evt(page, f); await page.waitForTimeout(40); }
  await waitFor(page, () => window.BWFun.view() === "card", null, 5000);
  await settle(page);
  await page.evaluate(() => localStorage.removeItem("bw-ae-visit"));   // the next visit, a few hours later: no rest, no cap, the bests are still there
  await page.close();
}

try {
  for (const sz of SIZES) {
    const tag = `${sz.id}-${sz.scheme}`;
    if (ONLY && !ONLY.has(tag)) continue;
    console.log("shooting", tag);

    // ---- first visit: idle, then a Simulate round
    {
      const ctx = await newCtx(sz);
      const page = await open(ctx, tag);
      await shot(page, "idle-first", tag);
      await shot(page, "idle-first-full", tag, { fullPage: true });
      await page.click("#ae-sim, #btn-sim");
      await waitFor(page, () => window.BWFun.view() === "run", null, 5000);
      await page.waitForTimeout(500);
      await shot(page, "run-leap-ready", tag);
      await waitFor(page, () => !!document.querySelector("#ae-result .ae-judge"), null, 8000);
      await page.waitForTimeout(1300);
      await shot(page, "run-leap-result", tag);
      // wait for the first-step station's GO
      await waitFor(page, () => /First step/.test(document.querySelector(".ae-station")?.textContent ?? ""), null, 20000);
      await page.waitForTimeout(250);
      await shot(page, "run-firststep-wait", tag);
      await waitFor(page, () => !!document.querySelector("#ae-prompt.is-go"), null, 12000);
      await page.waitForTimeout(150);
      await shot(page, "run-firststep-go", tag);
      await waitFor(page, () => /Sprint/.test(document.querySelector(".ae-station")?.textContent ?? ""), null, 20000);
      await waitFor(page, () => !!document.querySelector("#ae-prompt.is-go"), null, 12000);
      await page.waitForTimeout(150);
      await shot(page, "run-sprint-go", tag);
      await waitFor(page, () => window.BWFun.view() === "card", null, 40000);
      await settle(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(900);
      await shot(page, "card-top", tag);
      await page.evaluate(() => document.getElementById("ae-card").scrollIntoView({ block: "start" }));
      await page.waitForTimeout(500);
      await shot(page, "card", tag);
      await shot(page, "card-full", tag, { fullPage: true });
      await ctx.close();
    }

    // ---- returning athlete: idle with bests, board, settings, lab
    {
      const ctx = await newCtx(sz);
      await seedReturning(ctx);
      const page = await open(ctx, tag);
      await shot(page, "idle-returning", tag);
      await shot(page, "idle-returning-full", tag, { fullPage: true });
      // the same athlete steps up: a higher leap than their best is a PB
      await page.click("#ae-start");
      await page.click("#ae-warm").catch(() => {});
      await evt(page, { type: "jump", rep: { n: 7, foot: "BOTH", flightMs: 640, estCm: 50.2 } });
      await page.waitForTimeout(2000);
      await shot(page, "run-pb", tag);
      await page.click("#ae-stop"); await settle(page);
      await page.fill("#ae-initials", "jef"); await page.click("#ae-add button[type=submit]");   // the board gets an entry, so its design is shot with content
      await page.goto(BASE); await page.waitForTimeout(800);
      await page.evaluate(() => document.getElementById("fun-board").scrollIntoView());
      await page.waitForTimeout(300);
      await shot(page, "board", tag);
      await page.evaluate(() => { document.querySelector("#fun-settings").open = true; document.getElementById("fun-settings").scrollIntoView(); });
      await page.waitForTimeout(300);
      await shot(page, "settings", tag);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click("#ae-lab-toggle");
      await page.evaluate(() => document.getElementById("fun-lab").scrollIntoView());
      await page.waitForTimeout(300);
      await shot(page, "lab", tag);
      await ctx.close();
    }
  }
} catch (e) {
  console.error("exception", e);
  errors.push(`exception: ${e.message}`);
}

console.log(overflow.length ? `OVERFLOW:\n${overflow.join("\n")}` : "no sideways overflow in any shot");
console.log(errors.length ? `CONSOLE:\n${[...new Set(errors)].join("\n")}` : "zero console errors");
clearTimeout(hard);
await browser.close();
server.close();
process.exit(errors.length || overflow.length ? 1 : 0);
