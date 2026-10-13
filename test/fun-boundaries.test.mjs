// Where the engagement layer may reach. Safety and measurement code (app.js, units.js) never imports the kit or the layer; only a
// few fun files import the kit; every reward (sound, particles, toasts, the level-up dialog, the PB ribbon, any haptic) is played in
// fun.js behind ONE quiet gate; the layer only uses the small control surface app.js exposes; "Forget my data" is kit.reset().
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const funFiles = readdirSync(join(root, "src/fun")).filter((n) => n.endsWith(".js") && !/ 2\./.test(n)).map((n) => `src/fun/${n}`);
const importsOf = (src) => [...src.matchAll(/(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3]);

test("the layer's file list is what the tests expect", () => {
  assert.deepEqual(funFiles.map((f) => f.replace("src/fun/", "")).sort(), ["board.js", "boot.js", "combine.js", "config.js", "copy.js", "early.js", "fun.js", "layer.js", "stats.js", "ui.js"]);
});

test("safety and measurement code never imports the kit, the layer or its files", () => {
  for (const f of ["app.js", "units.js"]) {
    const src = strip(read(f));
    assert.deepEqual(importsOf(src), [], `${f} has no import at all`);
    assert.doesNotMatch(src, /fun-kit|createFunKit|completeSession|playOutcome|createQuietGate|src\/fun|layer\.js|BWFun/, `${f} does not mention the kit or the layer`);
  }
  // the only things app.js knows about the layer: the bridge event and the small control surface
  const app = strip(read("app.js"));
  assert.match(app, /new CustomEvent\("bwfun"/);
  assert.match(app, /window\.BWAE = Object\.freeze\(/);
});

test("the pure rule files import nothing from the kit; only the files that need it do", () => {
  const users = funFiles.filter((f) => importsOf(strip(read(f))).some((p) => /fun-kit/.test(p))).map((f) => f.replace("src/fun/", "")).sort();
  assert.deepEqual(users, ["board.js", "fun.js", "stats.js", "ui.js"]);
  for (const f of ["config.js", "combine.js", "copy.js"]) assert.deepEqual(importsOf(strip(read(`src/fun/${f}`))).filter((p) => /fun-kit|document/.test(p)), [], f);
  // and they touch no DOM or storage at all
  for (const f of ["config.js", "combine.js", "copy.js"]) assert.doesNotMatch(strip(read(`src/fun/${f}`)), /\bdocument\b|\bwindow\b|localStorage|sessionStorage/, f);
});

test("every reward is played in fun.js, behind the one quiet gate; nothing else plays a sound, a particle, a toast or a dialog", () => {
  const REWARD = /\b(playOutcome|confetti|levelUpModal|unlockToast|toast|bloom|burst|ribbons?|gentleGlow)\s*\(|\b(sound|haptics)\.play\s*\(/;
  for (const f of funFiles) {
    if (f === "src/fun/fun.js") continue;
    assert.doesNotMatch(strip(read(f)), REWARD, `${f} must not play rewards`);
  }
  const fun = strip(read("src/fun/fun.js"));
  assert.equal((fun.match(/createQuietGate\(/g) ?? []).length, 1, "one gate");
  assert.equal((fun.match(/playOutcome\(/g) ?? []).length, 1);
  assert.match(fun, /gate, pause,/, "playOutcome is always handed the gate");
  // rep() and stamp() run their effects inside gate.run(...)
  assert.match(fun, /rep\(\{[^}]*\} = \{\}\) \{\s*return gate\.run\(/);
  assert.match(fun, /stamp\(\) \{\s*return gate\.run\(/);
  // every effect is checked against the gate again just before it fires
  assert.match(fun, /live = \(\) => mine === epoch && !gate\.quiet/);
  assert.match(fun, /throw new Cancelled/);
  // an effort's edge holds the gate 300 ms
  assert.match(fun, /gate\.hold\("edge"\)/);
  assert.match(fun, /edge\(ms = 300\)/);
  // the gate's isQuiet is what the page says: a calibration, GO window, sprint or flight
  assert.match(fun, /isQuiet: \(\) => !!measuring\(\)/);
  assert.match(strip(read("src/fun/layer.js")), /measuring: \(\) => AE\.measuring\(\)/);
  assert.match(strip(read("app.js")), /measuring: \(\) => S\.calUntil > 0 \|\| S\.fs\.armed \|\| S\.fs\.goAt != null \|\| S\.sprint\.armed \|\| S\.sprint\.goAt != null \|\| S\.combinedAirborneAt != null/);
});

test("the PB ribbon is a reward: it is only ever applied from inside the gated moment", () => {
  const layer = strip(read("src/fun/layer.js"));
  assert.match(layer, /visual: pb \? shown\.markPb : undefined/);
  const ui = strip(read("src/fun/ui.js"));
  assert.equal((ui.match(/classList\.add\("is-pb"\)/g) ?? []).length, 1);
  assert.match(ui, /markPb: \(\) => res\.classList\.add\("is-pb"\)/);
});

test("no haptic can be sent today, and none could fire in an effort: patterns registered, no device send, the gate owns every play", () => {
  const fun = strip(read("src/fun/fun.js"));
  assert.match(fun, /createHaptics\(\{ store: kit\.store, send,/);
  assert.match(strip(read("src/fun/layer.js")), /createFun\(\{[^}]*\}\)/);
  assert.doesNotMatch(strip(read("src/fun/layer.js")), /send:/, "the layer wires no vibration device");
  assert.match(read("src/fun/fun.js"), /TODO\[SDK\]/, "the missing device send is marked, like the page's own SDK touchpoints");
});

test("the layer only uses the control surface app.js exposes, and none of it changes how anything is measured", () => {
  const exposed = strip(read("app.js")).match(/window\.BWAE = Object\.freeze\(\{([\s\S]*?)\n  \}\);/)[1];
  const names = [...exposed.matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, ["armGo", "armSprint", "cancelDrills", "hasDevice", "isSim", "measuring", "simHold", "simReplay", "sprintSteps"]);
  const used = new Set([...strip(read("src/fun/layer.js")).matchAll(/\bAE\.(\w+)/g)].map((m) => m[1]));
  for (const u of used) assert.ok(names.includes(u), `AE.${u} is part of the surface`);
  // nothing in the surface sets a threshold, a window or a reference: the tunables stay inside app.js
  assert.doesNotMatch(exposed, /CFG|ref\b|flightFrac|contactOnFrac|setSensor/);
  // the layer never reaches for the page's measurement state or its tunables by another door
  const layer = strip(read("src/fun/layer.js"));
  assert.doesNotMatch(layer, /\bS\.(fs|sprint|ref|load|imu|jumps)\b|\bCFG\b|SDKAdapter|BS\.Device/);
});

test("Forget my data is kit.reset(); there is one kit config and the demo twin sits on memory storage", () => {
  const fun = strip(read("src/fun/fun.js"));
  assert.match(fun, /forget\(\) \{ api\.cancel\(\); kit\.reset\(\); \}/);
  assert.match(strip(read("src/fun/layer.js")), /real\.fun\.forget\(\)/);
  assert.match(strip(read("src/fun/layer.js")), /ask|Tap again|sure\(/i.source ? /real\.fun\.forget/ : /x/);
  const all = [...funFiles, "app.js", "units.js"];
  const calls = all.flatMap((f) => (strip(read(f)).match(/createFunKit\(/g) ?? []).map(() => f));
  assert.deepEqual(calls, ["src/fun/fun.js"], "createFunKit is called once in the whole app");
  assert.match(fun, /storage: demo \? createMemoryStorage\(\) : storage/);
  assert.match(fun, /app: sim \? SIM_ID : APP_ID/);
  // the settings screen asks first, with no browser dialog
  const ui = strip(read("src/fun/ui.js"));
  assert.match(ui, /COPY\.settings\.forget, COPY\.settings\.forgetSure, o\.act\.forget/);
});

test("only named events are counted; the layer records nothing else and never a value", async () => {
  const { EVENTS } = await import("../src/fun/stats.js");
  const layer = strip(read("src/fun/layer.js"));
  const named = [...layer.matchAll(/stats\.record\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
  assert.ok(named.length >= 8);
  for (const n of named) assert.ok(EVENTS.includes(n), `${n} is on the allowlist`);
  assert.doesNotMatch(layer, /stats\.record\([^"']/, "event names are literals");
  // the pulse carries an answer and the first-win time, nothing from the body
  assert.match(layer, /stats\.pulse\(answer, \{ firstWinMs: lastFirstWinMs \?\? ctx\.fun\.firstWin\.state\(\)\.timeToWinMs, sim: ctx\.sim \}\)/);
  assert.doesNotMatch(layer, /fetch\(|XMLHttpRequest|sendBeacon|navigator\.sendBeacon|gtag|analytics/i, "nothing leaves the browser");
  for (const f of funFiles) assert.doesNotMatch(strip(read(f)), /fetch\(|XMLHttpRequest|sendBeacon/, f);
});

test("boot.js loads the layer only when early.js turned it on; ?fun=0 loads nothing", () => {
  const boot = strip(read("src/fun/boot.js"));
  assert.match(boot, /hasAttribute\("data-fun"\)/);
  assert.deepEqual(importsOf(boot), ["./layer.js"]);
  assert.doesNotMatch(boot, /^import /m, "no static import: the kit is not fetched unless the layer is on");
  const early = strip(read("src/fun/early.js"));
  assert.match(early, /get\("fun"\) === "0"\) return;/);
  const html = read("index.html");
  assert.ok(html.indexOf("src/fun/early.js") < html.indexOf("src/fun/tokens.css"), "early.js runs before the styles");
  assert.ok(html.indexOf("app.js?") < html.indexOf("src/fun/boot.js"), "the layer module comes after app.js");
  assert.match(html, /<script type="module" src="src\/fun\/boot\.js"><\/script>/);
  assert.doesNotMatch(strip(read("src/fun/fun.css")), /@import/, "the kit stylesheet is added by layer.js, so ?fun=0 fetches no kit file");
  assert.match(strip(read("src/fun/layer.js")), /vendor\/fun-kit\/ui\/fun-kit\.css/);
});
