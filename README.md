# Athletic Explosiveness Demo — Brilliant Wear

Vertical leap, first-step quickness, IMU foot speed, reactive strength, and arm
drive — live in the browser from Brilliant Sole insoles (+ optional wrist-worn
Sense), in the same single-page style as the Warehouse Ergonomics demo.

**Run it:** serve over HTTPS or localhost (Web Bluetooth requires a secure
context) — `npx serve .` or GitHub Pages — or open `index.html` and hit
**Simulate** (no hardware needed).

## What it measures and how

### Vertical leap (flight-time method)
Combined insole load drops below 12% of the standing reference → airborne;
re-load → landed. Height `h = g·t²/8` from flight time `t`, stored in cm and
shown in the chosen unit system (cm or in). Takeoff foot (L / R / BOTH) is classified from the load share in the
250 ms before takeoff (one side >75% ⇒ single-leg).

**Calibration against a real jump device:** log the device-measured height
next to each rep in the table (type it in whichever system the header switch is
on; it is stored in cm). Pairs export to CSV; fit
`device_cm = a·est_cm + b` (they measure different constructs — flight time
tracks center-of-mass rise; a Vertec-style device measures standing-reach
delta, which adds arm/timing skill — so expect a stable linear offset, not
identity). ~20 paired reps per athlete type is enough for a solid fit.

### First-step quickness — directional
Audio GO after a random 1.5–3.5 s delay (space bar arms it). From the insole
stream: **reaction** = first load redistribution after GO, **push-off** =
stepping foot's unload edge, **first contact** = that foot's re-plant. All
three per trial, with the stepping side.

**Direction** (the AWE dashboard's directional-quickness polar): the stepping
foot's world-frame horizontal velocity at first contact gives the push-off
azimuth, relative to a "forward" heading locked at calibration (mean foot yaw
while standing still). Trials bin into 8 directions; the polar overlays
push-off quickness **off LEFT vs off RIGHT foot** (best-time normalized) and
calls out the weakest direction. Run trials in all 8 directions off each foot
to fill the chart — that asymmetry map is the coaching product.

### Sprint acceleration (first N steps)
Beep start (S key arms it) → every insole contact edge after GO is a step,
and each swing's ZUPT peak speed attaches to its step. Output: per-step speed
ladder (L/R colored), **time to step N**, **speed at step N**, **avg
acceleration** (vN / tN), and the **3-step split** — with a per-rep
timing-gate / video ground-truth column.

**Why N = 5 by default** (selectable 3/5/7): steps 1–2 are dominated by
reaction and stance variability; 3 steps ≈ 2.5–3 m is the classic coaching
"first three steps" burst but gives only 3 samples and — with odd counts —
always ends on the same foot that started. 5 steps ≈ 4.5–6 m lands in the
5-yard burst zone where field-sport separation actually happens, still fully
inside the acceleration phase (~60–70 % of max velocity), with enough
samples to smooth L/R asymmetry and short enough for indoor runways. 7 steps
≈ a 10-yard split (the combine's acceleration standard) when there's room.
Every step is captured and exported regardless, so N is an analysis choice,
not a capture limit. For symmetric assessment, run reps starting off each
foot (start side is logged).

### Foot speed from IMU (ZUPT)
World-frame linear acceleration (rotated by the game-rotation quaternion) is
integrated to velocity **between pressure-detected stances**. While the foot
is flat (load ≥60% of ref, |accel| quiet) velocity is clamped to zero — a
zero-velocity update every single step. That pressure-anchored ZUPT is the
insole's edge over IMU-only trackers: drift can only accumulate for one swing
(~300–500 ms) before it's zeroed again. Output: per-swing peak speed (m/s or
mph) and step displacement (m or ft).

**Calibration:** residual scale error vs 240 fps slow-mo video + floor tape
(or timing gates / treadmill belt speed). Export CSV, fit per-firmware scale.

### Reactive strength (RSI)
Consecutive flights with a short ground contact between them (pogo hops):
RSI = flight ms / contact ms.

### Wrist — arm drive
Decay-integrated wrist speed peaks during the jump window → arm-swing
contribution.

## Units (metric / imperial)
A **Metric | Imperial** switch in the header sets how lengths and speeds are
read and typed; the choice is remembered per browser, and until it is made
the default follows the locale (en-US → imperial, as in Steady and Burst).

| Quantity | Metric | Imperial |
|---|---|---|
| Vertical leap, jump-device height | cm | in |
| Stride / step displacement | m | ft |
| Sprint, foot-swing and arm-drive speed | m/s | mph |
| Sprint average acceleration | m/s² | ft/s² |

Only the display and the input convert (`units.js`). Everything stored,
computed and exported stays metric, and the per-rep **device** ground-truth
box follows the switch while storing cm — flip the switch after typing and the
box re-reads in the new unit. Times (ms, s) are unchanged. The sprint run-up
distances in the notes below (3 / 5 / 7 steps ≈ 2.5–3 / 4.5–6 / ~9 m) are
guidance text, not measured values.

Session-log lines carry their lengths and speeds as live values (`BWUnits.html`),
so flipping the switch repaints old log lines too; the page never mixes systems.
Sprint step bars with no speed show `·` (`data-empty`), not the unit dash.

**Hotkeys:** Space arms GO and S arms the sprint, but both are ignored while you
type in a field (gate time, device height), and Space on a focused button
activates that button (so keyboard users can toggle Metric / Imperial). A mouse
or touch click blurs its button, so "click Simulate, then Space" still arms GO.

Colors, radii and control padding are CSS custom properties in `:root`
(`index.html`); the polar canvas reads the same tokens. The sprint table scrolls
inside its card on narrow screens instead of widening the page.

## CSV export
One row per jump / first-step trial / foot-speed swing, with the ground-truth
columns (`device_cm`) alongside estimates — feeds the `bwml` calibration fits
directly. **Always metric, whatever the display switch says:** `est_cm`,
`device_cm`, `peak_speed_ms` (m/s), `accel_ms2` (m/s²), times in ms / s.
(`est_in` / `device_in` from the first draft were renamed to the cm columns
when the units switch landed — update any saved fit scripts.)

## Combine (the engagement layer)
The page opens in **Combine mode**: two minutes, five stations (two-foot leap,
one foot at a time, first step x3, sprint, bounce), one **Explosiveness Card**
(five stamps, Heat flames, a line of story) and a rematch. The dashboard above
is untouched and is **Lab mode**.

| URL | What you get |
|---|---|
| `index.html` | Combine (or the mode you last chose with the header Combine / Lab switch) |
| `?mode=lab` | the original dashboard, with the switch (not remembered) |
| `?fun=0` | the original page, byte for byte: no layer module, no kit file is fetched |
| `?booth=1` | booth mode: no profile, each visitor starts fresh, "Next visitor" resets (remembered) |

No insoles? **Simulate** plays a whole Combine for you: first stamp at about 1.6 s,
the Card at about 18 s. Nothing simulated is ever saved, ranked or put on the board.

**Files** (`src/fun/`): `early.js` (classic script in `<head>`: mode, theme,
motion), `boot.js` (loads the layer only when it is on), `layer.js` (controller),
`ui.js` (drawing), `fun.js` (the one kit config, the sounds and the quiet gate),
`config.js` / `combine.js` (rules and the station state machine, pure),
`board.js`, `stats.js`, `copy.js` (every word), `tokens.css` (the only raw colours
and sizes, both themes), `fun.css` (tokens only). The kit is vendored,
untouched, in `src/vendor/fun-kit/` (see its `VERSION`).

**How it talks to the page.** `app.js` only *reports*: `bwfun` events (`jump`,
`firststep`, `sprint`, `rsi`, `go`, `cal.start`, `cal.done`, `sim`, `truth`) with
metric values, plus a frozen `window.BWAE` with nine small controls (is a
measurement running, arm a drill, stop a drill, park / replay the Simulate script).
It never imports the layer, and a test greps that it never mentions the kit.

**Rules worth knowing** (all app-side and tested, `test/fun-config.test.mjs`):
- Judgments are relative to you: PB! / Photo finish / Close / Warm-up for jumps and
  sprints, Lightning / Quick / Ready / Calibrating against your own median for first
  steps. Each is a shape plus a word, never colour alone.
- Heat is 1 to 5 flames: finishing the circuit and beating your *previous visit's*
  Card. A first-time visitor tops out at 3; a same-visit rematch cannot add flames.
- Maximal efforts get a real rest: a visible two-minute countdown before a
  same-visit rematch ("I'm rested" ends it early), two Combines per visit, and the
  first three jumps of a visit are warm-ups (no best, no board) until "I'm warm".
  Simulate has no body to rest, so neither rule applies there.
- XP caps: 5 jumps per jump station, 6 first steps, 3 sprints per round; a daily soft
  cap of 120. Ground-truth pairs pay a flat 2 XP inside physical plausibility
  (5 to 120 cm, 0.5 to 4 s), at most 20 XP a day, and agreement with the estimate is
  never a condition (a revised entry replaces, it never adds).
- Rewards (sound, particles, toasts, the level-up dialog, the PB ribbon) all go
  through **one quiet gate**, shut while a calibration, GO window, sprint or flight
  is being read and for 300 ms after each edge. The measured result itself (number,
  judgment, stamp) shows at once. No haptic is sent today (no device send is wired,
  `TODO[SDK]`); every cue has a picture and a word, and results are announced to
  screen readers.
- Metric / imperial everywhere: values are drawn from `data-base` (metric) and
  repaint when the switch flips; the Card, board, near-miss lines and Moon line too.

**Saved on this device only:** the kit's profile (`fk:ae-demo:*`, created when a
Combine on a body first finishes, never by Simulate), the board (`bw-ae-board`),
local fun stats (`bw-ae-stats`: counts of named events, the one-tap "Loved it /
Fine / Not for me" and the first-win time, no body or sensor value), and a few
choices (`bw-ae-mode|theme|motion|sound|booth|safety`). **Settings and privacy**
has Sound, Motion (Auto / Reduced / Full), Theme (Auto / Light / Dark), booth mode,
the stats CSV, Clear the board, and **Forget my data** (`kit.reset()` plus the
board and stats; two taps, no browser dialog).

**Easter eggs (for fun, never scored):** press `M` for Moon mode, `J` for Jupiter.

**Not built yet (P2 and later):** the full 23 badges, daily and weekly challenges,
quests, athlete tags and the weekly goal, the share card, Pass-the-Laptop Duel,
cosmetics, seasonal events, kiosk attract mode, device haptics.

## Tests
`npm test` runs everything with Node's built-in runner (no install):
- `units.test.js`: conversions, locale default, persistence, the ground-truth round
  trip, the self-repainting `html()` markup, the `data-empty` placeholder.
- `fun-config`: judgment edges, Heat, XP and caps, the level curve through the kit's
  `xpToReach`, rest and visit rules, plausibility, Moon maths, the copy lint.
- `fun-combine`: the station state machine driven with the page's own events.
- `fun-kit`: the layer against the real vendored kit (XP, badges, Heat from the last
  visit, the demo twin, Forget my data, the first-win clock, ground truth, the gate).
- `fun-local`: the board and the stats.
- `fun-boundaries`: safety and measurement code never imports the kit, one gate for
  every reward, one `createFunKit`, only named events.
- `fun-hygiene`: the sibling apps' lint rules over the tree with the vendored kit,
  tokens only, nothing flashes, a reduced-motion twin for every animation.

`npm run smoke` (needs Google Chrome and `playwright-core`; about 2.5 minutes) drives
the page headlessly: `?fun=0` and `?mode=lab`, a Simulate Combine, the Metric /
Imperial repaint, a real round fed with the page's own events, the board, the rest
rule, Forget my data, the motion and theme controls, zero console errors, no
horizontal scroll at 390 and 414 px, and it saves the shots in
`docs/screenshots/fun/` (390 px, light, dark and reduced motion).
`npm run serve` serves the page on port 5492.

## SDK notes
All hardware touchpoints live in `SDKAdapter` (app.js) — `BS.DevicePair.insoles`
pressure + per-side IMU, plus a solo `BS.Device` for the wrist. `TODO[SDK]`
marks the per-side IMU event names to verify on real hardware.

*Estimates are wellness/performance summaries — not medical measurements.*
