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
re-load → landed. Height `h = g·t²/8` from flight time `t`, shown in inches +
cm. Takeoff foot (L / R / BOTH) is classified from the load share in the
250 ms before takeoff (one side >75% ⇒ single-leg).

**Calibration against a real jump device:** log the device-measured height
next to each rep in the table. Pairs export to CSV; fit
`device_in = a·est_in + b` (they measure different constructs — flight time
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
(~300–500 ms) before it's zeroed again. Output: per-swing peak speed (m/s +
ft/s) and step displacement.

**Calibration:** residual scale error vs 240 fps slow-mo video + floor tape
(or timing gates / treadmill belt speed). Export CSV, fit per-firmware scale.

### Reactive strength (RSI)
Consecutive flights with a short ground contact between them (pogo hops):
RSI = flight ms / contact ms.

### Wrist — arm drive
Decay-integrated wrist speed peaks during the jump window → arm-swing
contribution.

## CSV export
One row per jump / first-step trial / foot-speed swing, with the ground-truth
columns (`device_in`) alongside estimates — feeds the `bwml` calibration fits
directly.

## SDK notes
All hardware touchpoints live in `SDKAdapter` (app.js) — `BS.DevicePair.insoles`
pressure + per-side IMU, plus a solo `BS.Device` for the wrist. `TODO[SDK]`
marks the per-side IMU event names to verify on real hardware.

*Estimates are wellness/performance summaries — not medical measurements.*
