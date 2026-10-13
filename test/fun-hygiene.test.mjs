// Repo rules with the vendored kit inside: the lint the sibling apps run (wording, colours, dialogs, names), applied to src/ (the
// vendored copy included), scripts/, index.html and the two page scripts. Plus this layer's own: tokens only in its styles, nothing
// flashes, every animation has a reduced-motion twin, every kit token is mapped, and the static markup says what COPY says.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { COPY } from "../src/fun/copy.js";

const root = join(import.meta.dirname, "..");
const word = (...p) => p.join("");
const TEXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json"]);
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  if (["node_modules", ".git", "docs", ".DS_Store"].includes(f)) return [];
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = [...["src", "scripts"].flatMap((d) => walk(join(root, d))), join(root, "index.html"), join(root, "app.js"), join(root, "units.js")];
const text = files.filter((f) => TEXT.has(extname(f)));
const rel = (f) => relative(root, f);
const read = (f) => readFileSync(join(root, f), "utf8");

/** index.html carries the page's own token block (:root { ... }): raw colours live there on purpose, like tokens.css. */
const scanText = (f) => {
  const t = readFileSync(f, "utf8");
  return rel(f) === "index.html" ? t.replace(/:root\s*\{[\s\S]*?\n  \}/, "") : t;
};
const scan = (re, { only, skip } = {}) => {
  const hits = [];
  for (const f of text) {
    if (only && !only.test(rel(f))) continue;
    if (skip && skip.test(rel(f))) continue;
    scanText(f).split("\n").forEach((l, i) => { if (re.test(l)) hits.push(`${rel(f)}:${i + 1} ${l.trim().slice(0, 100)}`); });
  }
  return hits;
};

test("the sibling apps' lint rules, with the vendored kit in the tree", () => {
  assert.deepEqual(files.filter((f) => / 2\.[A-Za-z0-9]+$/.test(f)).map(rel), [], "no iCloud conflict copies");
  assert.deepEqual(scan(new RegExp(word("gh", "aps"), "i")), [], "no forbidden project word");
  assert.deepEqual(scan(new RegExp(word("/firm", "ware\\b"))), [], "no firmware path");
  assert.deepEqual(scan(/\b(rehabilitat\w*|rehab|heal(s|ed|ing)?|therap\w*|cure[sd]?|treat(s|ed|ing|ment|ments)?|diagnos\w*)\b/i), [], "wellness wording only");
  assert.deepEqual(scan(/injury risk|prevents? injur|clinically|medical device|fall risk/i), [], "no medical or risk claims");
  assert.deepEqual(scan(/(^|[^.\w])(alert|confirm|prompt)\(|window\.open\(|target\s*=\s*["']_blank/, { only: /\.(js|mjs|html)$/ }), [], "no browser dialogs or new windows");
  assert.deepEqual(scan(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/, { only: /\.(js|mjs|css)$/, skip: /(^|\/)tokens\.css$/ }), [], "no raw colours outside the token files");
});

test("the vendored kit has its VERSION stamp and is not a dirty copy", () => {
  const v = read("src/vendor/fun-kit/VERSION");
  assert.match(v, /^bw-fun-kit \d+\.\d+\.\d+/);
  assert.match(v, /commit [0-9a-f]{40}\n/);
  assert.doesNotMatch(v, /-dirty/);
});

test("tokens.css holds the brand teal and both themes; the layer's styles hold only tokens", () => {
  const t = read("src/fun/tokens.css");
  assert.ok(t.includes("#00d4aa"), "brand teal");
  assert.match(t, /data-theme="light"/);
  assert.match(read("index.html"), /--teal: #00d4aa/, "the page's own dark theme keeps brand teal");
  const css = read("src/fun/fun.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const bad = [];
  css.split("\n").forEach((l, i) => { if (/(?<![\w-])-?\d*\.?\d+(px|ms|s)\b/.test(l)) bad.push(`fun.css:${i + 1} ${l.trim().slice(0, 90)}`); });
  assert.deepEqual(bad, [], "no raw pixel sizes or durations in fun.css: they come from tokens.css");
  for (const f of ["src/fun/ui.js", "src/fun/layer.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /style:\s*\{[^}]*\d+px/, f);
    assert.doesNotMatch(src, /style\.[a-zA-Z]+\s*=\s*["'`][^"'`]*(#[0-9a-f]{3,6}|\d+px)/i, f);
  }
});

test("nothing flashes: the layer's own animations are one-shot, never a loop or a stepped strobe", () => {
  const css = read("src/fun/fun.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /infinite|steps\(|alternate/);
  const tokens = read("src/fun/tokens.css");
  // every animation lasts at least a fifth of a second, so no cue can repeat anywhere near three times a second
  for (const m of tokens.matchAll(/--t-(fast|base|slow|stamp|fill):\s*([\d.]+)s/g)) assert.ok(Number(m[2]) >= 0.15, `--t-${m[1]} is ${m[2]}s`);
  // the page's own armed pulse is one cycle a second; the kit's only loop (the lit flame) keeps a 2.4 s period, and this layer does not use it
  assert.doesNotMatch(read("src/fun/ui.js"), /fk-flame|renderStreakFlame/);
});

test("every animation in the layer has a reduced-motion twin", () => {
  const css = read("src/fun/fun.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const animated = rules.filter((r) => /animation:\s*(?!none)\S/.test(r.body) && !/data-motion/.test(r.sel)).flatMap((r) => r.sel.split(",").map((s) => s.trim()));
  const reduced = rules.filter((r) => /data-motion="reduce"/.test(r.sel) && /animation:\s*none/.test(r.body)).flatMap((r) => r.sel.split(",").map((s) => s.trim())).join(" | ");
  assert.ok(animated.length >= 6, `${animated.length} animated selectors`);
  for (const sel of animated) {
    const klass = sel.match(/\.[a-z][\w-]*(?:\.[a-z][\w-]*)*(?:\s+\.[a-z][\w-]*)?$/)?.[0];
    assert.ok(klass && reduced.includes(klass), `${sel} needs a reduced-motion rule`);
  }
});

test("every --fk-* token the kit's stylesheet reads is mapped in fun.css, and the kit's own tokens.css is never used", () => {
  const kitCss = read("src/vendor/fun-kit/ui/fun-kit.css");
  const used = new Set([...kitCss.matchAll(/var\((--fk-[a-z0-9-]+)/g)].map((m) => m[1]));
  const css = read("src/fun/fun.css");
  const mapped = new Set([...css.matchAll(/(--fk-[a-z0-9-]+):/g)].map((m) => m[1]));
  const own = new Set(["--fk-pct", "--fk-spot-x", "--fk-spot-y", "--fk-spot-w", "--fk-spot-h", "--fk-card-y"]); // set on elements by the kit itself
  assert.deepEqual([...used].filter((v) => !mapped.has(v) && !own.has(v)), []);
  assert.match(css, /--fk-accent:\s*var\(--teal\)/);
  assert.match(css, /--fk-accent-text:\s*var\(--teal-text\)/);
  assert.match(css, /--fk-gold-text:\s*var\(--amber-text\)/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /tokens\.css/);
  assert.doesNotMatch(read("index.html"), /fun-kit\/ui\/tokens\.css/);
});

test("every rule of the layer needs the layer on: with ?fun=0 none of it matches", () => {
  const css = read("src/fun/fun.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}@]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter((s) => !/^(from|to|\d+%)$/.test(s));
  const loose = rules.flatMap((s) => s.split(",").map((x) => x.trim())).filter((sel) => !/html\[data-fun|^\.fun-only$|^\.ae-/.test(sel));
  assert.deepEqual(loose, [], "selectors that do not start from html[data-fun] or an ae- / fun-only class");
  // and the ae- classes only exist in markup the layer draws or that fun-only hides
  const html = read("index.html");
  for (const id of ["fun-stage", "fun-board", "fun-level", "fun-lab", "fun-settings", "ae-nav", "mode-seg"]) {
    const tag = html.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
    assert.match(tag, /fun-only/, `${id} is hidden unless the layer is on`);
  }
});

test("the static first-paint markup in index.html says what COPY says (one source of words)", () => {
  const html = read("index.html");
  const has = (s) => assert.ok(html.includes(s.replace(/'/g, "'")), `index.html has "${s}"`);
  has(COPY.hero.title); has(COPY.hero.sub); has(COPY.hero.start); has(COPY.hero.sim); has(COPY.hero.eyebrow);
  has(COPY.stage.label); has(COPY.board.label); has(COPY.level.label); has(COPY.lab.label); has(COPY.lab.sub); has(COPY.lab.open); has(COPY.settings.label);
  const nav = [...html.match(/<nav[^>]*id="ae-nav"[\s\S]*?<\/nav>/)[0].matchAll(/<a href="#([\w-]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(nav, [["fun-stage", COPY.nav.combine], ["fun-board", COPY.nav.board], ["fun-level", COPY.nav.level], ["fun-lab", COPY.nav.lab], ["fun-settings", COPY.nav.settings]]);
  for (const [anchor] of nav) assert.ok(html.includes(`id="${anchor}"`), `the nav target #${anchor} exists`);
  assert.equal([...html.matchAll(/<h2 class="ae-h"/g)].length, 5, "five labelled sections");
  assert.match(html, /aria-label="View"/);
  assert.ok(html.includes(COPY.mode.combine) && html.includes(COPY.mode.lab));
});

test("nothing on the page says GO before the real cue, and no two controls share a name but differ in what they do", () => {
  // a reaction measurement: the word GO is the cue (a filled block and a beep), so no station prompt may show it earlier
  for (const id of ["firststep", "sprint"]) assert.notEqual(COPY.stations[id].prompt.toUpperCase(), COPY.stage.go.toUpperCase(), `${id} prompt`);
  // the header switch (Combine / Lab view) and the section links use different words
  const labels = [COPY.nav.combine, COPY.nav.board, COPY.nav.level, COPY.nav.lab, COPY.nav.settings];
  assert.ok(!labels.includes(COPY.mode.combine) && !labels.includes(COPY.mode.lab), "nav labels differ from the view switch's");
});

test("package.json keeps npm test as the dependency-free node runner and adds the smoke and serve scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts.smoke, "node scripts/smoke.mjs");
  assert.equal(pkg.scripts.serve, "node scripts/serve.mjs");
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
});
