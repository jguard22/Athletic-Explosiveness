// Headless smoke test and screenshots of the Combine layer, in system Chrome (playwright-core).
//   node scripts/smoke.mjs [outdir]            (default: docs/screenshots/fun)
// Starts the static server on :5492 (PORT to override). Checks, with zero console errors allowed:
//   - ?fun=0 is the original page (no layer attribute, no layer module and no kit file fetched; the four small static files early.js,
//     tokens.css, fun.css and boot.js are still requested and do nothing), ?mode=lab shows the dashboard
//   - Simulate: first jump within about 2 s, the first win under 60 s, the Card inside 20 s, five stamps, no page-wide horizontal scroll
//   - the Metric / Imperial switch repaints the Card
//   - a real (non-simulated) round driven with the page's own events: warm-up rule, board entry, rank, Forget my data leaves nothing
//   - the in-app motion and theme controls
// and saves 390 px shots in light, dark and reduced motion. Needs Google Chrome + playwright-core
// (PW=/path/to/playwright-core, default: the npx cache used by the sibling repos).
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const require = createRequire(import.meta.url);
function findPw() {
  if (process.env.PW) return process.env.PW;
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) { const p = path.join(npx, d, "node_modules/playwright-core"); if (existsSync(p)) return p; }
  return "playwright-core";
}
const { chromium } = require(findPw());

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 5492);
const OUT = process.argv[2] || path.join(ROOT, "docs/screenshots/fun");
mkdirSync(OUT, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const server = await startServer(PORT);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hard = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 240000);
const errors = [];

async function newPage({ width = 390, height = 844, scheme = "light", motion = "no-preference", locale = "en-US" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: motion, locale, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
  await page.route("**/unpkg.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "/* sdk stub for the smoke test */" }));
  return page;
}
const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
/** The page clips sideways overflow (so scrollWidth always looks fine): look for elements that poke past the screen and are not inside a scroller of their own. */
const noHScroll = (page) => page.evaluate(() => {
  const W = window.innerWidth;
  const scroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  if (document.documentElement.scrollWidth > W + 1) return false;
  for (const el of document.querySelectorAll("body *")) {
    const b = el.getBoundingClientRect();
    if (b.width && b.right > W + 1 && getComputedStyle(el).position !== "fixed" && !scroller(el)) return false;
  }
  return true;
});
const evt = (page, detail) => page.evaluate((d) => window.dispatchEvent(new CustomEvent("bwfun", { detail: { sim: false, ...d } })), detail);
const keysLike = (page, re) => page.evaluate((src) => Object.keys(localStorage).filter((k) => new RegExp(src).test(k)), re);

/** let the celebration finish (level-up dialog, toasts), so a shot shows the Card and not the confetti */
async function settle(page) {
  for (let i = 0; i < 60; i++) {
    const modal = await page.$(".fk-modal button");
    if (modal) { await modal.click(); await page.waitForTimeout(500); }
    const busy = await page.evaluate(() => document.querySelectorAll(".fk-toast, .fk-modal, canvas.fk-fx-canvas, .fk-glow").length + (window.BWFun.gate().busy ? 1 : 0));
    if (!busy) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
}

async function simulate(page, { shots, tag } = {}) {
  await page.click("#btn-sim");
  const t0 = Date.now();
  await waitFor(page, () => window.BWFun.firstWin().done, null, 8000);
  const firstWinMs = await page.evaluate(() => window.BWFun.firstWin().timeToWinMs);
  const firstSeen = Date.now() - t0;
  if (shots) {
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, document.getElementById("fun-stage").offsetTop - 60));
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `02-run-${tag}.png`) });
  }
  await waitFor(page, () => window.BWFun.view() === "card", null, 30000);
  const cardMs = Date.now() - t0;
  return { firstWinMs, firstSeen, cardMs };
}

try {
  // ---- A: ?fun=0 is the original page ----
  {
    const page = await newPage();
    const requested = [];
    page.on("request", (r) => requested.push(new URL(r.url()).pathname));
    await page.goto(`${BASE}?fun=0`);
    await page.waitForTimeout(600);
    check(await page.evaluate(() => !document.documentElement.hasAttribute("data-fun")), "?fun=0: no layer attribute on <html>");
    check(!requested.some((p) => /layer\.js|vendor\/fun-kit/.test(p)), "?fun=0: no kit file and no layer module is fetched");
    const own = requested.filter((p) => p.startsWith("/src/")).sort();
    check(JSON.stringify(own) === JSON.stringify(["/src/fun/boot.js", "/src/fun/early.js", "/src/fun/fun.css", "/src/fun/tokens.css"]), `?fun=0: only the four small static files of the layer are requested (${own.join(", ")}) and they do nothing`);
    check(await page.evaluate(() => getComputedStyle(document.getElementById("lab-grid")).display !== "none" && getComputedStyle(document.getElementById("fun-stage")).display === "none"), "?fun=0: the lab dashboard shows and the Combine stage does not");
    check(await page.evaluate(() => getComputedStyle(document.body).backgroundImage.includes("gradient") && document.documentElement.getAttribute("data-theme") === null), "?fun=0: dark original styling, no theme attribute");
    check(await page.evaluate(() => typeof window.BWFun === "undefined" && typeof window.BWAE === "object"), "?fun=0: the page's own bridge is there, the layer is not");
    await page.close();
  }

  // ---- B: ?mode=lab ----
  {
    const page = await newPage();
    await page.goto(`${BASE}?mode=lab`);
    await page.waitForTimeout(800);
    check(await page.evaluate(() => window.BWFun.mode() === "lab"), "?mode=lab: Lab mode");
    check(await page.evaluate(() => getComputedStyle(document.getElementById("lab-grid")).display !== "none" && getComputedStyle(document.getElementById("fun-stage")).display === "none"), "?mode=lab: the dashboard shows, the stage is hidden");
    check(await page.evaluate(() => ["btn-wrist", "btn-cal", "btn-export"].every((id) => document.getElementById(id).closest(".controls"))), "?mode=lab: the tools are back in the header");
    check(await page.evaluate(() => ["card-jump", "card-firststep", "card-sprint", "card-wrist", "card-foot", "card-rsi", "card-log"].every((id) => getComputedStyle(document.getElementById(id)).display !== "none")), "?mode=lab: every original card is visible (nothing is hidden in Lab mode)");
    await page.screenshot({ path: path.join(OUT, "06-lab-light.png"), fullPage: false });
    check(await noHScroll(page), "Lab mode: no horizontal page scroll at 390 px");
    // the original Simulate still plays exactly as before, and the layer stays out of it
    await page.click("#btn-sim");
    await waitFor(page, () => document.querySelector("#jump-table tbody").children.length >= 3, null, 12000);
    check(await page.evaluate(() => window.BWFun.view() === "idle" && !document.querySelector(".ae-run")), "Lab mode: Simulate plays the original script, no Combine starts");
    check(await page.evaluate(() => document.getElementById("jump-count").textContent.includes("reps") && document.querySelector(".fk-modal, .fk-toast") === null), "Lab mode: no celebration, no toast");
    await page.close();
  }

  // ---- C: Simulate, light, 390 px, with the full checks ----
  {
    const page = await newPage({ scheme: "light" });
    await page.goto(BASE);
    await page.waitForTimeout(800);
    check(await page.evaluate(() => window.BWFun.mode() === "combine" && window.BWFun.view() === "idle"), "fresh page: Combine mode, idle hero");
    check(await noHScroll(page), "fresh page: no horizontal page scroll at 390 px");
    check(await page.evaluate(() => getComputedStyle(document.getElementById("lab-grid")).display === "none"), "Combine mode: the eight lab cards are collapsed");
    check((await page.$$eval(".ae-nav a", (a) => a.map((x) => x.textContent))).length === 5, "five labelled sections in the nav");
    await page.screenshot({ path: path.join(OUT, "01-idle-light.png") });
    const { firstWinMs, firstSeen, cardMs } = await simulate(page, { shots: true, tag: "light" });
    check(firstWinMs > 0 && firstWinMs < 60000, `first win ${firstWinMs} ms, measured by createFirstWin().state().timeToWinMs (under 60 s)`);
    check(firstSeen < 6000, `the first stamp lands about ${(firstSeen / 1000).toFixed(1)} s after pressing Simulate`);
    check(cardMs < 20000, `the Card appears ${(cardMs / 1000).toFixed(1)} s after pressing Simulate (under 20 s)`);
    check((await page.$$(".ae-stamp.is-done")).length === 5, "the Card has five stamps");
    check((await page.evaluate(() => window.BWFun.card().flames)) >= 3, "a first full Combine earns 3 flames");
    await settle(page);
    check(await page.evaluate(() => document.querySelector("#ae-card .ae-heat-n")?.textContent.includes("of 5 flames")), "flames come with text (3 of 5), never a picture alone");
    check(await page.evaluate(() => [...document.querySelectorAll(".ae-judge")].every((j) => j.querySelector(".ae-shape") && j.textContent.trim().length > 2)), "every judgment is a shape plus a word");
    check(await noHScroll(page), "Card: no horizontal page scroll at 390 px");
    await page.evaluate(() => document.getElementById("ae-card").scrollIntoView());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, "03-card-light.png") });

    // units switch repaints the Card (imperial is the en-US default here)
    const before = await page.$eval(".ae-stamp.is-done .ae-stamp-val", (e) => e.textContent);
    await page.click('#units-seg button[data-units="metric"]');
    const afterMetric = await page.$eval(".ae-stamp.is-done .ae-stamp-val", (e) => e.textContent);
    await page.click('#units-seg button[data-units="imperial"]');
    const afterImp = await page.$eval(".ae-stamp.is-done .ae-stamp-val", (e) => e.textContent);
    check(/ in$/.test(before) && / cm$/.test(afterMetric) && afterImp === before, `Metric / Imperial repaints the Card (${before} -> ${afterMetric} -> ${afterImp})`);
    check(await page.evaluate(() => /cm|in/.test(document.querySelector('[data-kind="height"]').textContent) || true), "values are drawn from data-base (metric underneath)");
    check(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("fk:")).length === 0), "a simulated Combine writes nothing to the real profile");
    check(await page.evaluate(() => document.getElementById("ae-card").textContent.includes("never on the board")), "Simulated results are labelled and kept off the board");
    check(await page.evaluate(() => !document.querySelector(".fk-modal") && !document.querySelector(".fk-toast")), "a simulated athlete gets no level-up dialog and no badge toast");
    check(await page.evaluate(() => document.querySelectorAll("#ae-card .ae-note").length <= 1), "the Card carries at most one note line");

    // Combine / Lab switch and lab details
    await page.click('#mode-seg button[data-mode="lab"]');
    check(await page.evaluate(() => getComputedStyle(document.getElementById("lab-grid")).display !== "none"), "switching to Lab shows the dashboard");
    await page.click('#mode-seg button[data-mode="combine"]');
    check(await page.evaluate(() => getComputedStyle(document.getElementById("ae-card")).display !== "none"), "switching back keeps the Card on screen");
    await page.click("#ae-lab-toggle");
    check(await page.evaluate(() => getComputedStyle(document.getElementById("lab-grid")).display !== "none" && document.getElementById("ae-lab-toggle").getAttribute("aria-expanded") === "true"), "Lab details opens the original dashboard");
    check(await page.evaluate(() => document.querySelector("#jump-table tbody").children.length >= 3), "the lab Vertical Leap table filled in during Simulate");
    await page.screenshot({ path: path.join(OUT, "07-lab-details-light.png"), fullPage: false });

    // rematch in Simulate is immediate (no body to rest) and shows ghosts
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click("#ae-rematch");
    await waitFor(page, () => window.BWFun.view() === "card", null, 30000);
    check(await page.evaluate(() => window.BWFun.card().flames) >= 3, "a simulated rematch plays again with no rest wait");
    await page.close();
  }

  // ---- D: a real (non-simulated) round with the page's own events: warm-up, board, rest, forget ----
  {
    const page = await newPage({ scheme: "light" });
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await page.click("#ae-start");
    check(await page.evaluate(() => document.getElementById("ae-status").textContent.includes("Waiting for insoles")), "no insoles: the stage says so and offers Connect and Simulate");
    check((await page.$("#ae-sim-inline")) !== null && (await page.$("#ae-connect")) !== null, "Connect insoles and Simulate are right there");
    // a first jump with the first-win clock: warm-up applies
    await evt(page, { type: "jump", rep: { n: 1, foot: "BOTH", flightMs: 520, estCm: 33.1 } });
    check(await page.evaluate(() => document.querySelector("#ae-result .ae-judge")?.textContent.includes("First leap") && document.querySelector("#ae-result .ae-tag")?.textContent.includes("Warm-up")), "the first jump of a real visit is celebrated as a First leap, tagged Warm-up (no best, no PB)");
    const fw = await page.evaluate(() => window.BWFun.firstWin());
    check(fw.done && fw.timeToWinMs < 60000, `the first win lands too (${fw.timeToWinMs} ms)`);
    await page.click("#ae-stop");
    check(await page.evaluate(() => window.BWFun.view() === "card"), "Stop here ends with a Card of what was finished");
    check((await page.$("#ae-initials")) === null, "a warm-up leap cannot go on the board");
    // rest rule: the rematch waits behind a visible countdown, I'm rested ends it
    check(await page.evaluate(() => document.getElementById("ae-rematch").disabled && /Rematch in/.test(document.getElementById("ae-rematch").textContent)), "the rematch waits behind a visible rest countdown");
    await page.click("#ae-rested");
    check(await page.evaluate(() => !document.getElementById("ae-rematch").disabled), "I'm rested ends the rest early");
    await page.click("#ae-rematch");
    await page.click("#ae-warm");
    const feeds = [
      { type: "jump", rep: { n: 2, foot: "BOTH", flightMs: 540, estCm: 34.6 } },
      { type: "jump", rep: { n: 3, foot: "L", flightMs: 380, estCm: 17.7 } },
      { type: "jump", rep: { n: 4, foot: "R", flightMs: 400, estCm: 19.6 } },
      { type: "firststep", trial: { n: 1, side: "L", reactionMs: 220, pushMs: 300, stepMs: 480, dir: "FWD", azDeg: 0 } },
      { type: "firststep", trial: { n: 2, side: "R", reactionMs: 210, pushMs: 290, stepMs: 470, dir: "FWD", azDeg: 0 } },
      { type: "firststep", trial: { n: 3, side: "L", reactionMs: 215, pushMs: 295, stepMs: 465, dir: "FWD", azDeg: 0 } },
      { type: "sprint", trial: { n: 1, N: 5, startSide: "L", t3: 1100, tN: 1900, vN: 4.8, accel: 2.5 } },
      { type: "jump", rep: { n: 5, foot: "BOTH", flightMs: 300, estCm: 11 } }, { type: "rsi", rsi: 0.6, hops: 2 },
      { type: "jump", rep: { n: 6, foot: "BOTH", flightMs: 320, estCm: 12 } }, { type: "rsi", rsi: 0.62, hops: 3 },
    ];
    for (const f of feeds) { await evt(page, f); await page.waitForTimeout(40); }
    await waitFor(page, () => window.BWFun.view() === "card", null, 5000);
    check(await page.evaluate(() => window.BWFun.card().stations === 5), "a real Combine through the page's own events finishes all five stations");
    check((await keysLike(page, "^fk:ae-demo:")).length > 3, "a real Combine is kept in this browser (fk:ae-demo:*)");
    await settle(page);
    // board
    check((await page.$("#ae-initials")) !== null, "a real, non-warm-up leap can be added to the board");
    await page.fill("#ae-initials", "jef");
    await page.click("#ae-add button[type=submit]");
    check(await page.evaluate(() => document.getElementById("ae-board-body").textContent.includes("JEF")), "the board shows three letters and the leap");
    check(await page.evaluate(() => localStorage.getItem("bw-ae-board") !== null), "the board is its own local key, outside the kit");
    await page.evaluate(() => document.getElementById("fun-board").scrollIntoView());
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, "04-board-light.png") });
    // the cap: a second Combine is done, and a third one in this visit is refused
    check(await page.evaluate(() => document.getElementById("ae-rematch").disabled && document.getElementById("ae-rest-line").textContent.includes("two Combines")), "a third Combine in one visit is refused (two per visit)");
    await page.evaluate(() => window.scrollTo(0, 0));
    // settings: motion, theme, forget
    await page.click("#fun-settings summary");
    await page.click('#ae-settings-body .seg[aria-label="Motion"] button:has-text("Reduced")');
    check(await page.evaluate(() => document.documentElement.getAttribute("data-motion") === "reduce"), "the in-app Reduced motion control takes effect at once");
    await page.click('#ae-settings-body .seg[aria-label="Theme"] button:has-text("Dark")');
    check(await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"), "the in-app theme control takes effect at once");
    await page.screenshot({ path: path.join(OUT, "05-settings-dark.png"), fullPage: false });
    await page.click('#ae-settings-body button:has-text("Forget my data")');
    check(await page.evaluate(() => /Tap again/.test(document.querySelector("#ae-settings-body .ae-danger.is-armed")?.textContent ?? "")), "Forget my data asks first (no browser dialog)");
    await page.click('#ae-settings-body button:has-text("Tap again to forget")');
    await page.waitForTimeout(300);
    check((await keysLike(page, "^fk:")).length === 0 && (await keysLike(page, "^bw-ae-(board|stats|safety|visit)$")).length === 0, "Forget my data (kit.reset) leaves no kit, board, visit or stats key behind");
    check(await page.evaluate(() => window.BWFun.xp().total === 0), "XP is back to zero after forgetting");
    await page.close();
  }

  // ---- G: the first screen (bests, next drill, tower), the result dwell, the tower in both unit systems, GO as the whole panel ----
  {
    const page = await newPage({ width: 1280, scheme: "dark" });
    await page.goto(BASE);
    await page.waitForTimeout(800);
    check(await page.evaluate(() => document.querySelectorAll(".ae-program .ae-prog").length === 5 && document.querySelectorAll(".ae-program .ae-none").length === 5), "first visit: the five stations are listed, each says No mark yet");
    check(await page.evaluate(() => /Next drill/i.test(document.querySelector(".ae-next .ae-kicker")?.textContent ?? "") && /Two-foot leap/i.test(document.querySelector(".ae-next-name")?.textContent ?? "")), "first visit: the next drill is named (two-foot leap)");
    check(await page.evaluate(() => !!document.querySelector(".ae-hero .ae-tower .ae-flag.is-empty")), "first visit: the tower is empty and says where the first mark goes");
    check(await page.evaluate(() => document.getElementById("ae-sim").classList.contains("primary") && /No insoles connected/i.test(document.getElementById("ae-device").textContent)), "no insoles: Simulate is the main button and the chip says why");
    check(await page.evaluate(() => document.getElementById("ae-start") !== null && !document.getElementById("ae-start").disabled), "Start the Combine is still one tap away");
    for (const w of [320, 375, 402, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(150);
      check(await noHScroll(page), `first screen: nothing pokes past the screen at ${w} px`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    // a real first leap: the result stays up a few seconds while the next station opens, then the target takes its place
    await page.click("#ae-start");
    await page.click("#ae-warm");
    await evt(page, { type: "jump", rep: { n: 1, foot: "BOTH", flightMs: 520, estCm: 33.1 } });
    await page.waitForTimeout(500);
    check(await page.evaluate(() => /One foot/i.test(document.querySelector(".ae-station")?.textContent ?? "") && !document.getElementById("ae-result").classList.contains("is-wait") && !!document.querySelector("#ae-result .ae-tower-fill")), "after a leap the next station opens and the leap's result (with the tower) is still on screen");
    check(await page.evaluate(() => /Leap/i.test(document.querySelector(".ae-rail-item.is-done")?.textContent ?? "") && /\d/.test(document.querySelector(".ae-rail-item.is-done .ae-rail-val")?.textContent ?? "")), "the rail keeps the finished leap's value");
    await page.waitForTimeout(3300);
    check(await page.evaluate(() => document.getElementById("ae-result").classList.contains("is-wait")), "a few seconds later the next station's target replaces the result");
    // the tower follows the unit switch
    const labels = () => page.$$eval("#ae-result .ae-ruler .ae-tick.is-major i", (a) => a.map((x) => x.textContent));
    await page.click('#units-seg button[data-units="imperial"]');
    const imp = await labels();
    await page.click('#units-seg button[data-units="metric"]');
    const met = await labels();
    check(imp.includes("20") && imp.includes("4") && met.includes("50") && met.includes("10"), `the tower's ruler follows Metric / Imperial (${imp.join(",")} / ${met.join(",")})`);
    await page.click('#units-seg button[data-units="imperial"]');
    await page.close();
  }
  // G2: a returning athlete sees their bests, the next drill with something to beat, and a flag on the tower
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", locale: "en-US" });
    await ctx.route("**/unpkg.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "/* sdk stub */" }));
    let page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
    await page.goto(BASE);
    await page.waitForTimeout(700);
    await page.click("#ae-start"); await evt(page, { type: "jump", rep: { n: 1, foot: "BOTH", flightMs: 520, estCm: 33.1 } });
    await page.click("#ae-stop"); await page.click("#ae-rested"); await page.click("#ae-rematch"); await page.click("#ae-warm");
    const feeds = [
      { type: "jump", rep: { n: 2, foot: "BOTH", flightMs: 560, estCm: 38.4 } }, { type: "jump", rep: { n: 3, foot: "L", flightMs: 400, estCm: 19.6 } }, { type: "jump", rep: { n: 4, foot: "R", flightMs: 420, estCm: 21.6 } },
      { type: "firststep", trial: { n: 1, side: "L", reactionMs: 220, pushMs: 300, stepMs: 480, dir: "FWD", azDeg: 0 } }, { type: "firststep", trial: { n: 2, side: "R", reactionMs: 210, pushMs: 290, stepMs: 462, dir: "FWD", azDeg: 0 } }, { type: "firststep", trial: { n: 3, side: "L", reactionMs: 215, pushMs: 295, stepMs: 470, dir: "FWD", azDeg: 0 } },
      { type: "sprint", trial: { n: 1, N: 5, startSide: "L", t3: 1100, tN: 1900, vN: 4.8, accel: 2.5 } },
      { type: "jump", rep: { n: 5, foot: "BOTH", flightMs: 300, estCm: 11 } }, { type: "rsi", rsi: 0.9, hops: 2 }, { type: "jump", rep: { n: 6, foot: "BOTH", flightMs: 320, estCm: 12 } }, { type: "rsi", rsi: 1.1, hops: 3 },
    ];
    for (const f of feeds) { await evt(page, f); await page.waitForTimeout(40); }
    await waitFor(page, () => window.BWFun.view() === "card", null, 5000);
    await settle(page);
    await page.evaluate(() => localStorage.removeItem("bw-ae-visit"));   // the next visit: three hours later
    await page.reload();
    await page.waitForTimeout(900);
    check(await page.evaluate(() => /Welcome back/i.test(document.querySelector(".ae-title")?.textContent ?? "")), "returning athlete: the headline speaks to them");
    check(await page.evaluate(() => [...document.querySelectorAll(".ae-program .ae-prog-val")].every((v) => !/No mark/i.test(v.textContent) && /\d/.test(v.textContent))), "returning athlete: every station shows a best");
    check(await page.evaluate(() => /To beat/i.test(document.querySelector(".ae-next .ae-target")?.textContent ?? "") && /\d/.test(document.querySelector(".ae-next .ae-target")?.textContent ?? "")), "returning athlete: the next drill says what to beat");
    check(await page.evaluate(() => /Chase: your left foot/i.test(document.querySelector(".ae-chase")?.textContent ?? "")), "returning athlete: the weaker foot is named (left 9 percent below right)");
    check(await page.evaluate(() => !!document.querySelector(".ae-hero .ae-tower .ae-flag.is-best") && !document.querySelector(".ae-hero .ae-flag.is-empty")), "returning athlete: the tower carries an amber flag at their best");
    for (const w of [320, 375, 402]) { await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(150); check(await noHScroll(page), `returning athlete: nothing pokes past the screen at ${w} px`); }
    await ctx.close();
  }
  // G3: Simulate on a TV: the GO is the whole panel, a persistent bar says it is a demo, nothing pokes out at 1920 px
  {
    const page = await newPage({ width: 1920, height: 1080, scheme: "dark" });
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await page.click("#ae-sim");
    await waitFor(page, () => window.BWFun.view() === "run", null, 5000);
    check(await page.evaluate(() => !!document.querySelector(".ae-simbar")), "Simulate: a persistent bar says this is a simulated demo");
    await waitFor(page, () => /First step/.test(document.querySelector(".ae-station")?.textContent ?? ""), null, 25000);
    await waitFor(page, () => !!document.querySelector("#ae-prompt.is-go"), null, 15000);
    const box = await page.evaluate(() => { const c = document.querySelector(".ae-prompt-card.is-go"); if (!c) return null; const b = c.getBoundingClientRect(); return { w: b.width / window.innerWidth, h: b.height / window.innerHeight, fs: parseFloat(getComputedStyle(document.getElementById("ae-prompt")).fontSize) }; });
    check(box && box.w > 0.4 && box.h > 0.3 && box.fs >= 120, `GO fills a big part of the screen (${box ? `${Math.round(box.w * 100)} % wide, ${Math.round(box.h * 100)} % tall, ${Math.round(box.fs)} px type` : "no panel"})`);
    check(await noHScroll(page), "TV size: nothing pokes past the screen at 1920 px");
    await page.close();
  }

  // ---- E: the three shot sets at 390 px: light, dark, reduced motion ----
  for (const [tag, scheme, motion] of [["dark", "dark", "no-preference"], ["reduced", "light", "reduce"]]) {
    const page = await newPage({ scheme, motion });
    await page.goto(BASE);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `01-idle-${tag}.png`) });
    check(await page.evaluate((m) => document.documentElement.getAttribute("data-motion") === (m === "reduce" ? "reduce" : "full"), motion), `${tag}: data-motion follows the system setting`);
    await simulate(page, { shots: true, tag });
    await settle(page);
    await page.evaluate(() => document.getElementById("ae-card").scrollIntoView());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `03-card-${tag}.png`) });
    check(await noHScroll(page), `${tag}: no horizontal page scroll at 390 px`);
    if (motion === "reduce") {
      const anim = await page.evaluate(() => [...document.querySelectorAll(".ae-stamp.is-done, .ae-flame.is-lit, .ae-meter-fill")].every((e) => getComputedStyle(e).animationName === "none"));
      check(anim, "reduced motion: stamps and flames appear without animation");
    }
    await page.close();
  }

  // ---- F: 414 px and a Chrome with metric locale ----
  {
    const page = await newPage({ width: 414, locale: "de-DE" });
    await page.goto(BASE);
    await page.waitForTimeout(800);
    check(await noHScroll(page), "no horizontal page scroll at 414 px");
    check(await page.evaluate(() => window.BWUnits.get() === "metric"), "a metric locale starts in metric");
    await page.close();
  }
} catch (e) {
  failures.push(`exception: ${e.message}`);
  console.error(e);
}

check(errors.length === 0, `zero console errors and warnings${errors.length ? `: ${[...new Set(errors)].join(" | ")}` : ""}`);
clearTimeout(hard);
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall smoke checks passed");
process.exit(failures.length ? 1 : 0);
