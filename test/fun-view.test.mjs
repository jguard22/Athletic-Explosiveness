// What the first screen, the height tower and the rail draw, as pure data: tested without a page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "../src/fun/config.js";
import { COPY, allStrings } from "../src/fun/copy.js";

const root = join(import.meta.dirname, "..");
const read = (f) => readFileSync(join(root, f), "utf8");

test("idleView: a first-time athlete has no marks, still sees the next drill, and nothing to chase", () => {
  const v = C.idleView({});
  assert.equal(v.marks, 0);
  assert.equal(v.returning, false);
  assert.equal(v.next, "leap");
  assert.equal(v.chase, null);
  assert.deepEqual(Object.keys(v.stations), ["leap", "onefoot", "firststep", "sprint", "bounce"]);
  assert.ok(Object.values(v.stations).every((s) => s === null));
});

test("idleView: bests per station in storage units, the better foot as the headline, junk values ignored", () => {
  const v = C.idleView({ jump: 38.4, singleL: 19.6, singleR: 21.6, firstStep: 462, sprint: 1.9, sprintN: 5, rsi: 1.1 });
  assert.equal(v.marks, 5);
  assert.equal(v.returning, true);
  assert.deepEqual(v.stations.leap, { kind: "height", value: 38.4 });
  assert.deepEqual(v.stations.onefoot, { kind: "height", value: 21.6, l: 19.6, r: 21.6 });
  assert.deepEqual(v.stations.firststep, { kind: "ms", value: 462 });
  assert.deepEqual(v.stations.sprint, { kind: "s", value: 1.9, n: 5 });
  assert.deepEqual(v.stations.bounce, { kind: "score", value: 1.1 });
  const junk = C.idleView({ jump: 0, singleL: -3, singleR: NaN, firstStep: null, sprint: undefined, rsi: "x" });
  assert.equal(junk.marks, 0);
  const oneSide = C.idleView({ singleL: 20 });
  assert.deepEqual(oneSide.stations.onefoot, { kind: "height", value: 20, l: 20, r: null });
});

test("idleView: the foot to chase appears at 5 percent apart or more, and names the lower side", () => {
  assert.equal(C.idleView({ singleL: 20, singleR: 20.5 }).chase, null, "2 percent apart is level");
  assert.deepEqual(C.idleView({ singleL: 19.6, singleR: 21.6 }).chase, { side: "Left", pct: 9 });
  assert.deepEqual(C.idleView({ singleL: 25, singleR: 20 }).chase, { side: "Right", pct: 20 });
  assert.equal(C.idleView({ singleL: 25 }).chase, null, "one side only: nothing to compare");
});

test("towerScale: metric ticks every 10 cm, imperial every 4 in, a floor of 50 cm (20 in) and headroom above the tallest value", () => {
  const m = C.towerScale({ system: "metric", values: [33.1] });
  assert.equal(m.maxCm, 50);
  assert.deepEqual(m.ticks.filter((t) => t.label != null).map((t) => t.label), [0, 10, 20, 30, 40, 50]);
  assert.equal(m.pct(25), 50);
  const i = C.towerScale({ system: "imperial", values: [33.1] });
  assert.ok(Math.abs(i.maxCm - 20 * 2.54) < 1e-9, "20 in at the top");
  assert.deepEqual(i.ticks.filter((t) => t.label != null).map((t) => t.label), [0, 4, 8, 12, 16, 20]);
  // a big leap grows the tower, and the tallest value always fits with room above it
  for (const v of [48, 61, 79.9, 100, 118]) {
    const s = C.towerScale({ system: "metric", values: [v, 20] });
    assert.ok(s.maxCm >= v * 1.15 - 1e-9 && s.maxCm < v * 1.15 + 10 + 1e-9, `${v}: top ${s.maxCm}`);
    assert.ok(s.pct(v) < 100);
  }
  // nothing to draw yet: the floor scale, no crash
  assert.equal(C.towerScale({ values: [null, undefined, NaN] }).maxCm, 50);
});

test("towerScale: big ticks are labelled in the chosen system, small ticks sit between them, a tall scale labels every second one", () => {
  const s = C.towerScale({ system: "metric", values: [100] });
  const big = s.ticks.filter((t) => t.major), small = s.ticks.filter((t) => !t.major);
  assert.equal(small.length, big.length - 1, "one small tick between each pair of big ones");
  assert.ok(s.steps > 9);
  assert.deepEqual(big.filter((t) => t.label != null).map((t) => t.label).slice(0, 4), [0, 20, 40, 60], "every second big tick");
  for (const t of s.ticks) assert.ok(t.cm >= 0 && t.cm <= s.maxCm);
});

test("flagOffsets: flags that would overlap are kept a gap apart, in order, and never move down", () => {
  assert.deepEqual(C.flagOffsets([40]), [40]);
  assert.deepEqual(C.flagOffsets([20, 60]), [20, 60]);
  const close = C.flagOffsets([50, 52, 51], 9);
  const sorted = [...close].sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k] - sorted[k - 1] >= 9 - 1e-9);
  close.forEach((at, i) => assert.ok(at >= [50, 52, 51][i]));
  assert.deepEqual(C.flagOffsets([]), []);
});

test("railValues: only finished stations show a value, in storage units", () => {
  assert.deepEqual(C.railValues(null), {});
  const sum = {
    status: { leap: "done", onefoot: "skipped", firststep: "done", sprint: "todo", bounce: "notrun" },
    leap: { cm: 33.1 }, onefoot: { anyBest: 19 }, firststep: { bestMs: 462 }, sprint: null, bounce: { rsi: null },
  };
  assert.deepEqual(C.railValues(sum), { leap: { kind: "height", value: 33.1 }, firststep: { kind: "ms", value: 462 } });
  const all = {
    status: { leap: "done", onefoot: "done", firststep: "done", sprint: "done", bounce: "done" },
    leap: { cm: 40 }, onefoot: { anyBest: 22 }, firststep: { bestMs: 450 }, sprint: { s: 1.8 }, bounce: { rsi: 1.2 },
  };
  assert.deepEqual(Object.keys(C.railValues(all)), ["leap", "onefoot", "firststep", "sprint", "bounce"]);
});

test("a result stays up for a few seconds before the next station's target replaces it, and that is a named, bounded constant", () => {
  assert.ok(C.CAPS.resultDwellMs >= 2000 && C.CAPS.resultDwellMs <= 5000, `${C.CAPS.resultDwellMs} ms`);
  const layer = read("src/fun/layer.js"), ui = read("src/fun/ui.js");
  assert.match(layer, /enterStation\(\{ dwell: true \}\)/, "only a finished station dwells");
  assert.match(layer, /dwellMs: dwell \? C\.CAPS\.resultDwellMs : 0/);
  assert.match(ui, /clearTimeout\(dwellTimer\)/, "a new result cancels a pending swap");
});

test("the first screen's words live in COPY, pass the same lint, and carry no hard-coded units", () => {
  for (const s of [COPY.hero.backTitle, COPY.hero.backSub, COPY.next.kicker, COPY.next.chase("Left", 9), COPY.device.on, COPY.device.off, COPY.sim.flag, COPY.sim.line, COPY.program.noMark]) {
    assert.equal(typeof s, "string");
    assert.doesNotMatch(s, /\d+(\.\d+)?\s?(cm|in|m\/s|mph|ft)\b/i);
  }
  assert.ok(allStrings().includes(COPY.next.chase("Left", 9)) || allStrings().some((s) => /Chase: your/.test(s)), "the chase line is part of the linted table");
  assert.match(COPY.next.chase("Right", 12), /right foot is 12 percent/);
});

test("nothing on the page pans sideways: the root clips, no layer rule makes a scroller, and the nav wraps", () => {
  const css = read("src/fun/fun.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /html\[data-fun\]\s*\{\s*overflow-x:\s*clip;\s*overscroll-behavior-x:\s*none;\s*\}/);
  assert.match(css, /html\[data-fun\] body\s*\{[^}]*overflow-x:\s*clip/);
  assert.doesNotMatch(css, /overflow-x:\s*(auto|scroll)/, "no sideways scroller in the layer's styles");
  assert.doesNotMatch(css, /scrollbar-width:\s*none|::-webkit-scrollbar/, "no hidden-scrollbar carousel");
  assert.match(css, /\.ae-nav\s*\{[^}]*flex-wrap:\s*wrap/);
  // every grid track that holds text can shrink
  assert.doesNotMatch(css, /grid-template-columns:[^;]*repeat\(\d+,\s*1fr\)/, "minmax(0, 1fr), never a bare 1fr");
});

test("the display type is a pairing with fallbacks, and every size the booth reads from afar is a token", () => {
  const t = read("src/fun/tokens.css");
  assert.match(t, /--font-display:\s*"Avenir Next Condensed"/);
  assert.match(t, /--font-mono:\s*ui-monospace/);
  for (const name of ["--fs-title", "--fs-prompt", "--fs-num", "--fs-stamp", "--tower-h", "--font-display", "--font-mono"]) assert.ok(t.includes(name), name);
  assert.match(t, /html\[data-fun\]\s*\{\s*font-size:\s*clamp\(16px/, "the booth scale: the whole UI grows with the screen");
});
