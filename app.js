/* Brilliant Wear — Athletic Explosiveness Demo
   Vertical leap (flight-time) · first-step quickness (audio GO) · IMU foot
   speed (ZUPT) · reactive strength · wrist arm-drive, in the browser.
   Hardware path: Brilliant Wear JS SDK (window.BS from unpkg build).
   Every SDK touchpoint lives in SDKAdapter — event/method drift gets fixed
   there (marked TODO[SDK]). Simulate exercises the entire UI, no hardware.

   Ground-truth capture is first-class: per-rep device-measured jump height
   inputs and the CSV export feed the calibration fits documented in the
   README (flight-time → device height; ZUPT speed → 240fps video).

   Units: a header Metric / Imperial switch (units.js). Everything stored,
   computed and exported is metric (cm, m, m/s, m/s²); values are shown and
   typed in the chosen system and converted only at that edge.

   Engagement bridge: this file only REPORTS what happened, through fun() ->
   a "bwfun" CustomEvent, and exposes a tiny read-only/control surface on
   window.BWAE. It imports nothing from the optional Combine layer (src/fun/);
   with the layer off (?fun=0) every event goes unheard and nothing changes. */

(() => {
  "use strict";

  // ---------- tunables ----------
  const CFG = {
    sensorRateMs: 10,          // 100 Hz — jump/step edges need timing
    contactOnFrac: 0.45,       // of standing ref (calibrated on real FSRs: swing residual ≈25-30%)
    contactOffFrac: 0.30,
    flightFrac: 0.12,          // combined load below this = airborne
    flightMinMs: 120,
    flightMaxMs: 900,
    takeoffWindowMs: 250,      // pre-flight window that classifies L/R/BOTH takeoff
    singleFootShare: 0.75,     // one side above this share ⇒ single-leg takeoff
    pogoContactMaxMs: 1000,
    goDelayMinMs: 1500,        // random GO delay bounds
    goDelayMaxMs: 3500,
    fsUnloadDrop: 0.30,        // load drop (of ref) that marks the stepping foot's push-off
    zuptLoadFrac: 0.60,        // foot considered planted above this…
    zuptStillAcc: 0.8,         // …and |linAcc| below this (m/s²)
    speedWindowMaxMs: 1200,    // ignore "swings" longer than this (walking away)
    calMs: 1500,
    sprintStepsDefault: 5,     // see README: 5 ≈ the 5-yard burst zone; 3-split always shown
    sprintMaxMs: 6000,         // give up if N contacts don't arrive
  };
  const G = 9.80665;

  // ---------- state ----------
  const S = {
    sim: false, simTimer: null, simT: 0, simScript: null,
    ref: { left: null, right: null },      // standing normalizedSum per foot
    load: { left: 0, right: 0 },           // latest normalizedSum
    loaded: { left: true, right: true },   // hysteresis contact state
    lastEdge: { left: 0, right: 0 },
    combinedAirborneAt: null,
    preFlight: [],                          // rolling [t, l, r] for takeoff classification
    jumps: [],                              // {n, foot, flightMs, estCm, deviceCm}
    flights: [],                            // recent flight spans for RSI
    calUntil: 0, calBuf: { left: [], right: [] },
    // first-step drill (+ directional push-off)
    fs: { armed: false, goAt: null, timer: null, reactionMs: null, pushSide: null,
          pushMs: null, stepMs: null, trials: [], vdir: { left: [0, 0], right: [0, 0] } },
    headingRef: 0,                          // "forward" yaw captured at calibration
    polarTimes: { L: Array(8).fill(null), R: Array(8).fill(null) }, // best first-contact ms per direction
    // sprint acceleration drill
    sprint: { armed: false, goAt: null, timer: null, killT: null, n: 5, steps: [], trials: [] },
    // per-foot ZUPT integrator
    imu: {
      left:  { q: null, v: [0, 0, 0], d: [0, 0, 0], swingStart: 0, planted: true, lastT: 0, peak: 0 },
      right: { q: null, v: [0, 0, 0], d: [0, 0, 0], swingStart: 0, planted: true, lastT: 0, peak: 0 },
    },
    peakSpeed: { left: null, right: null }, lastStride: null,
    lastPair: null, hopChain: 0,           // consecutive pogo pairs share a flight (reported with the rsi event)
    simHold: false,                        // the optional layer can park the Simulate script between stations
    wrist: { q: null, v: [0, 0, 0], lastT: 0, peak: 0, window: false, connected: false, best: null, last: null },
    audio: null,
  };
  const now = () => performance.now();
  const $ = (id) => document.getElementById(id);
  const U = window.BWUnits;   // display units; all state below stays metric
  // One-way bridge to the optional Combine layer: report what happened (metric values), never ask it anything.
  const fun = (type, d = {}) => window.dispatchEvent(new CustomEvent("bwfun", { detail: { type, ...d, sim: S.sim } }));

  // msg may carry U.html(...) spans: they repaint when the units switch flips,
  // so old log lines never mix systems with the cards.
  function log(msg, cls = "") {
    const el = $("log");
    el.insertAdjacentHTML("afterbegin", `<div class="${cls}">${new Date().toLocaleTimeString()} — ${msg}</div>`);
    U.bind(el.firstElementChild);
  }
  // theme token -> value, for canvas drawing (CSS custom properties stay the single source)
  const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---------- calibration (standing reference) ----------
  function startCal() {
    S.calUntil = now() + CFG.calMs;
    S.calBuf = { left: [], right: [] };
    log("Calibrating — stand still, weight even…");
    fun("cal.start");
  }
  function feedCal(side, v) {
    if (now() > S.calUntil) return finishCal();
    S.calBuf[side].push(v);
  }
  function finishCal() {
    if (!S.calUntil) return;
    for (const side of ["left", "right"]) {
      const b = S.calBuf[side].sort((a, z) => a - z);
      if (b.length > 10) S.ref[side] = b[Math.floor(b.length / 2)];
    }
    S.calUntil = 0;
    // lock "forward" = the athlete's facing during calibration (mean foot yaw)
    const yl = S.imu.left.q ? yawOf(S.imu.left.q) : null;
    const yr = S.imu.right.q ? yawOf(S.imu.right.q) : null;
    S.headingRef = yl != null && yr != null ? (yl + yr) / 2 : (yl ?? yr ?? 0);
    if (S.ref.left && S.ref.right) log(`Calibrated — ref L ${S.ref.left.toFixed(2)} · R ${S.ref.right.toFixed(2)} · forward locked.`, "ok");
    fun("cal.done", { ok: !!(S.ref.left && S.ref.right) });
  }

  // ---------- vertical leap ----------
  function combined() { return S.load.left + S.load.right; }
  function refCombined() { return (S.ref.left ?? 0.5) + (S.ref.right ?? 0.5); }

  function onLoad(side, v, t) {
    S.load[side] = v;
    if (S.calUntil) feedCal(side, v);
    const ref = S.ref[side] ?? 0.5;
    // per-foot contact hysteresis (feeds ZUPT + first-step)
    if (S.loaded[side] && v <= ref * CFG.contactOffFrac) { S.loaded[side] = false; S.lastEdge[side] = t; }
    else if (!S.loaded[side] && v >= ref * CFG.contactOnFrac) {
      S.loaded[side] = true; S.lastEdge[side] = t;
      if (S.sprint.goAt != null) recordSprintContact(side, t);
    }

    // rolling buffer for takeoff-foot classification — must survive the whole
    // flight, since classification runs at landing over [takeoff-250ms, takeoff]
    S.preFlight.push([t, S.load.left, S.load.right]);
    while (S.preFlight.length && t - S.preFlight[0][0] > CFG.takeoffWindowMs + CFG.flightMaxMs + 300) S.preFlight.shift();

    // combined airborne detection
    const airborne = combined() <= refCombined() * CFG.flightFrac;
    if (airborne && S.combinedAirborneAt == null) {
      S.combinedAirborneAt = t;
    } else if (!airborne && S.combinedAirborneAt != null) {
      const flight = t - S.combinedAirborneAt;
      const takeoffAt = S.combinedAirborneAt;
      S.combinedAirborneAt = null;
      if (flight >= CFG.flightMinMs && flight <= CFG.flightMaxMs) onJump(flight, takeoffAt, t);
    }
    if (S.fs.goAt != null) fsTick(side, v, t);
  }

  function classifyTakeoff(takeoffAt) {
    let l = 0, r = 0, n = 0;
    for (const [pt, pl, pr] of S.preFlight) {
      if (pt < takeoffAt - CFG.takeoffWindowMs || pt > takeoffAt) continue;
      l += pl / (S.ref.left ?? 0.5); r += pr / (S.ref.right ?? 0.5); n++;
    }
    if (!n || l + r <= 0) return "BOTH";
    const shareL = l / (l + r);
    if (shareL >= CFG.singleFootShare) return "L";
    if (shareL <= 1 - CFG.singleFootShare) return "R";
    return "BOTH";
  }

  function onJump(flightMs, takeoffAt, landAt) {
    const h = (G * (flightMs / 1000) ** 2) / 8;   // meters, flight-time method
    const estCm = h * 100;
    const foot = classifyTakeoff(takeoffAt);
    const rep = { n: S.jumps.length + 1, foot, flightMs: Math.round(flightMs), estCm, deviceCm: null };
    S.jumps.push(rep);
    S.flights.push({ start: takeoffAt, end: landAt, flightMs });
    if (S.flights.length > 8) S.flights.shift();
    renderJumps(rep);
    fun("jump", { rep: { ...rep } });
    computeRsi();
    if (S.wrist.connected || S.sim) captureWristPeak();
    log(`Jump #${rep.n}: ${U.html("height", estCm, { trim: false })} (${Math.round(flightMs)} ms flight, ${foot}).`, "ok");
  }

  function computeRsi() {
    // pogo pattern: consecutive flights with a short ground contact between
    if (S.flights.length < 2) return;
    const a = S.flights[S.flights.length - 2], b = S.flights[S.flights.length - 1];
    const contact = b.start - a.end;
    if (contact > 60 && contact <= CFG.pogoContactMaxMs) {
      $("rsi").textContent = (b.flightMs / contact).toFixed(2);
      $("rsi-contact").textContent = Math.round(contact);
      $("rsi-flight").textContent = Math.round(b.flightMs);
      S.hopChain = S.lastPair === a ? S.hopChain + 1 : 1;   // pairs (1,2) then (2,3) are one chain of three hops
      S.lastPair = b;
      fun("rsi", { rsi: b.flightMs / contact, contactMs: Math.round(contact), flightMs: Math.round(b.flightMs), hops: S.hopChain + 1 });
    }
  }

  // Displayed numbers carry their metric value in data-base (units.js repaints
  // them when the switch flips); bars/rows are built once and relabelled in place.
  function renderJumps(rep) {
    U.put($("jump-h"), "height", rep.estCm);
    $("jump-flight").textContent = rep.flightMs;
    $("jump-count").textContent = `${S.jumps.length} rep${S.jumps.length === 1 ? "" : "s"}`;
    const badge = $("jump-foot");
    badge.style.display = "inline-block";
    badge.textContent = rep.foot;
    badge.className = `foot-badge foot-${rep.foot}`;
    U.put($("jump-best"), "height", Math.max(...S.jumps.map((j) => j.estCm)));
    const bars = $("jump-bars");
    const max = Math.max(...S.jumps.map((x) => x.estCm), 1);
    bars.innerHTML = S.jumps.slice(-12).map((j) =>
      `<div class="bar ${j.foot}" style="height:${Math.max(8, (j.estCm / max) * 78)}%"><span data-kind="height" data-base="${j.estCm}"></span></div>`).join("");
    const tb = $("jump-table").querySelector("tbody");
    tb.insertAdjacentHTML("afterbegin",
      `<tr><td>${rep.n}</td><td>${rep.foot}</td><td>${rep.flightMs}</td><td data-kind="height" data-base="${rep.estCm}"></td>
       <td><input type="number" step="0.1" placeholder="—" data-kind="height" data-base="" data-rep="${rep.n}" /></td></tr>`);
    U.bind(bars);
    U.bind(tb.firstElementChild);
  }
  // ground-truth entry: typed in the display unit, stored metric (cm)
  $("jump-table").querySelector("tbody").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-rep]");
    const j = inp && S.jumps.find((x) => x.n === Number(inp.dataset.rep));
    if (!j) return;
    j.deviceCm = U.toBase("height", inp.value);
    U.put(inp, "height", j.deviceCm);
    log(j.deviceCm == null
      ? `Rep ${j.n}: device height cleared.`
      : `Rep ${j.n}: device height ${U.html("height", j.deviceCm, { trim: false })} logged (est ${U.html("height", j.estCm, { trim: false })}).`);
    fun("truth", { kind: "jump", n: j.n, estimate: j.estCm, device: j.deviceCm });
  });

  // ---------- first-step quickness ----------
  function armGo(opts) {
    if (S.fs.armed || S.sprint.armed || S.sprint.goAt != null) return;
    S.fs.armed = true;
    Object.assign(S.fs, { goAt: null, reactionMs: null, pushSide: null, pushMs: null, stepMs: null, baseline: { ...S.load } });
    $("btn-go").classList.add("armed");
    $("go-light").className = "go-light armed";
    const delay = typeof opts?.delayMs === "number" ? opts.delayMs : CFG.goDelayMinMs + Math.random() * (CFG.goDelayMaxMs - CFG.goDelayMinMs);
    S.fs.timer = setTimeout(fireGo, delay);
    log("GO armed — hold still…");
  }
  function fireGo() {
    S.fs.goAt = now();
    S.fs.baseline = { ...S.load };
    S.fs.vdir = { left: [0, 0], right: [0, 0] };
    $("go-light").className = "go-light go";
    beep(880, 120);
    fun("go", { kind: "firststep" });
    if (S.sim) simFirstStepResponse();
  }
  function fsTick(side, v, t) {
    const fs = S.fs;
    const goT = fs.goAt;
    const ref = S.ref[side] ?? 0.5;
    if (fs.reactionMs == null && Math.abs(v - fs.baseline[side]) > ref * 0.12) {
      fs.reactionMs = t - goT;
      $("fs-react").textContent = Math.round(fs.reactionMs);
    }
    if (fs.pushSide == null && fs.baseline[side] - v > ref * CFG.fsUnloadDrop) {
      fs.pushSide = side; fs.pushMs = t - goT;
      $("fs-push").textContent = Math.round(fs.pushMs);
      $("fs-side").textContent = side === "left" ? "L" : "R";
    }
    if (fs.pushSide === side && fs.stepMs == null && fs.pushMs != null &&
        t - goT > fs.pushMs + 60 && v >= ref * CFG.contactOnFrac) {
      fs.stepMs = t - goT;
      $("fs-step").textContent = Math.round(fs.stepMs);
      finishTrial();
    }
  }
  function finishTrial() {
    const fs = S.fs;
    const trial = { n: fs.trials.length + 1, side: fs.pushSide === "left" ? "L" : "R",
      reactionMs: Math.round(fs.reactionMs ?? 0), pushMs: Math.round(fs.pushMs ?? 0), stepMs: Math.round(fs.stepMs ?? 0),
      dir: null, azDeg: null };
    // push-off direction: azimuth of the stepping foot's horizontal velocity at
    // first contact, relative to the calibrated "forward" heading
    const vd = fs.vdir[fs.pushSide] ?? [0, 0];
    if (Math.hypot(vd[0], vd[1]) > 0.25) {
      const az = Math.atan2(vd[1], vd[0]) * 180 / Math.PI - S.headingRef;
      trial.azDeg = Math.round(((az % 360) + 360) % 360);
      // TODO[SDK]: verify world-frame handedness on hardware (sign of the CW mapping)
      const idx = ((Math.round(-az / 45) % 8) + 8) % 8;
      trial.dir = DIRS[idx];
      const tArr = S.polarTimes[trial.side];
      if (tArr[idx] == null || trial.stepMs < tArr[idx]) tArr[idx] = trial.stepMs;
      drawPolar();
    }
    fs.trials.push(trial);
    $("fs-dir").textContent = trial.dir ?? "—";
    updateWeakest();
    $("fs-table").querySelector("tbody").insertAdjacentHTML("afterbegin",
      `<tr><td>${trial.n}</td><td>${trial.side}</td><td>${trial.dir ?? "—"}</td><td>${trial.reactionMs}</td><td>${trial.pushMs}</td><td>${trial.stepMs}</td></tr>`);
    fs.armed = false; fs.goAt = null;
    $("btn-go").classList.remove("armed");
    $("go-light").className = "go-light";
    log(`First step #${trial.n}: ${trial.side}${trial.dir ? " → " + trial.dir : ""} — contact in ${trial.stepMs} ms.`, "ok");
    fun("firststep", { trial: { ...trial } });
  }

  // ---------- directional quickness polar (AWE dashboard concept) ----------
  const DIRS = ["FWD", "FWD-R", "RIGHT", "BACK-R", "BACK", "BACK-L", "LEFT", "FWD-L"]; // clockwise from top
  function yawOf(q) { return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180 / Math.PI; }
  function bestTime() {
    const all = [...S.polarTimes.L, ...S.polarTimes.R].filter((v) => v != null);
    return all.length ? Math.min(...all) : null;
  }
  function drawPolar() {
    const c = $("fs-polar"), ctx = c.getContext("2d");
    const W = c.width, H = c.height, cx = W / 2, cy = H / 2 + 4, R = H / 2 - 26;
    ctx.clearRect(0, 0, W, H);
    const teal = tok("--teal"), blue = tok("--blue"), muted = tok("--muted"), line = tok("--line");
    ctx.strokeStyle = line; ctx.fillStyle = muted;
    ctx.font = "9px sans-serif"; ctx.textAlign = "center"; ctx.lineWidth = 1;
    [0.33, 0.66, 1].forEach((f) => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, 7); ctx.stroke(); });
    DIRS.forEach((d, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 4;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
      ctx.fillText(d, cx + Math.cos(a) * (R + 13), cy + Math.sin(a) * (R + 13) + 3);
    });
    const best = bestTime();
    if (best == null) return;
    const poly = (times, color, fillAlpha) => {
      ctx.beginPath();
      times.forEach((tm, i) => {
        const v = tm != null ? Math.min(1, best / tm) : 0.05; // quickness = best/time
        const a = -Math.PI / 2 + i * Math.PI / 4;
        const x = cx + Math.cos(a) * R * v, y = cy + Math.sin(a) * R * v;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.globalAlpha = fillAlpha; ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    };
    poly(S.polarTimes.L, teal, 0.16);
    poly(S.polarTimes.R, blue, 0.14);
    ctx.textAlign = "left";
    ctx.fillStyle = teal; ctx.fillRect(10, 10, 8, 8); ctx.fillStyle = muted; ctx.fillText("off LEFT foot", 22, 17);
    ctx.fillStyle = blue; ctx.fillRect(10, 24, 8, 8); ctx.fillStyle = muted; ctx.fillText("off RIGHT foot", 22, 31);
  }
  function updateWeakest() {
    const best = bestTime();
    if (best == null) return;
    let worst = null;
    for (const f of ["L", "R"]) S.polarTimes[f].forEach((tm, i) => {
      if (tm != null && (!worst || tm > worst.t)) worst = { t: tm, i, f };
    });
    if (worst && worst.t > best) $("fs-weak").textContent = `${DIRS[worst.i]} off ${worst.f} · ${Math.round((best / worst.t) * 100)}% of best`;
  }

  // ---------- sprint acceleration (first N steps) ----------
  function armSprint(opts) {
    const sp = S.sprint;
    if (sp.armed || sp.goAt != null || S.fs.armed || S.fs.goAt != null) return;
    sp.armed = true;
    $("btn-sprint").classList.add("armed");
    $("sp-light").className = "go-light sm armed";
    sp.timer = setTimeout(fireSprint, typeof opts?.delayMs === "number" ? opts.delayMs : CFG.goDelayMinMs + Math.random() * (CFG.goDelayMaxMs - CFG.goDelayMinMs));
    log(`Sprint armed — ${sp.n} steps on the beep…`);
  }
  function fireSprint() {
    const sp = S.sprint;
    sp.armed = false; sp.goAt = now(); sp.steps = [];
    $("sp-light").className = "go-light sm go";
    beep(660, 150);
    fun("go", { kind: "sprint" });
    sp.killT = setTimeout(() => finalizeSprint(true), CFG.sprintMaxMs);
    if (S.sim) simSprintResponse();
  }
  function recordSprintContact(side, t) {
    const sp = S.sprint;
    if (sp.goAt == null || sp.steps.length >= sp.n) return null;
    const rec = { step: sp.steps.length + 1, side, tMs: Math.round(t - sp.goAt), v: null };
    sp.steps.push(rec);
    if (sp.steps.length >= sp.n) setTimeout(() => finalizeSprint(false), 500); // let the last ZUPT commit
    return rec;
  }
  function fillSprintSpeed(side, v) {
    const rec = [...S.sprint.steps].reverse().find((s) => s.side === side && s.v == null);
    if (rec) rec.v = v;
  }
  function finalizeSprint(timedOut) {
    const sp = S.sprint;
    if (sp.goAt == null) return;
    clearTimeout(sp.killT);
    sp.goAt = null;
    $("sp-light").className = "go-light sm";
    $("btn-sprint").classList.remove("armed");
    if (sp.steps.length < 2) { log("Sprint: not enough steps detected.", "warn"); fun("sprint.fail"); return; }
    const last = sp.steps[sp.steps.length - 1];
    const vN = last.v;
    const trial = {
      n: sp.trials.length + 1, N: sp.steps.length, startSide: sp.steps[0].side === "left" ? "L" : "R",
      t3: sp.steps[2] ? sp.steps[2].tMs : null, tN: last.tMs, vN,
      accel: vN != null ? vN / (last.tMs / 1000) : null, gate: null,
      steps: sp.steps.map((s) => ({ ...s })),
    };
    sp.trials.push(trial);
    $("sp-time").textContent = (trial.tN / 1000).toFixed(2);
    U.put($("sp-v"), "speed", vN);
    U.put($("sp-acc"), "accel", trial.accel);
    $("sp-split3").textContent = trial.t3 != null ? (trial.t3 / 1000).toFixed(2) : "—";
    const maxV = Math.max(...trial.steps.map((s) => s.v ?? 0), 1);
    $("sp-bars").innerHTML = trial.steps.map((s) =>
      `<div class="bar ${s.side === "right" ? "R" : ""}" title="step ${s.step} · ${s.tMs} ms" style="height:${Math.max(8, ((s.v ?? 0) / maxV) * 78)}%"><span data-kind="speed" data-digits="1" data-empty="·" data-base="${s.v ?? ""}"></span></div>`).join("");
    U.bind($("sp-bars"));
    $("sp-table").querySelector("tbody").insertAdjacentHTML("afterbegin",
      `<tr><td>${trial.n}</td><td>${trial.startSide}</td><td>${trial.N}</td><td>${trial.t3 ?? "—"}</td><td>${trial.tN}</td>
       <td data-kind="speed" data-base="${vN ?? ""}"></td><td data-kind="accel" data-base="${trial.accel ?? ""}"></td>
       <td><input type="number" step="0.01" placeholder="—" data-sprint="${trial.n}" /></td></tr>`);
    U.bind($("sp-table").querySelector("tbody").firstElementChild);
    $("sp-table").querySelector("input").addEventListener("change", (e) => {
      const tr = sp.trials.find((x) => x.n === Number(e.target.dataset.sprint));
      if (tr) {
        tr.gate = e.target.value === "" ? null : Number(e.target.value);
        log(`Sprint ${tr.n}: gate time ${tr.gate}s logged (est ${(tr.tN / 1000).toFixed(2)}s).`);   // seconds — no unit conversion
        fun("truth", { kind: "gate", n: tr.n, estimate: tr.tN / 1000, device: tr.gate });
      }
    });
    log(`Sprint #${trial.n}: ${trial.N} steps in ${(trial.tN / 1000).toFixed(2)}s${vN != null ? ` → ${U.html("speed", vN, { trim: false })}` : ""}${timedOut ? " (timeout)" : ""}.`, "ok");
    fun("sprint", { trial: { n: trial.n, N: trial.N, startSide: trial.startSide, t3: trial.t3, tN: trial.tN, vN: trial.vN, accel: trial.accel } });
  }

  // ---------- per-foot ZUPT speed (world-frame linear acceleration) ----------
  // The insole gives the two things IMU-only trackers lack: an exact zero-
  // velocity anchor (pressure says the foot is planted) and the swing window.
  function quatRotate(q, v) {
    // rotate vector v by quaternion q (x,y,z,w)
    const { x, y, z, w } = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  }
  function onFootQuat(side, q) { S.imu[side].q = q; }
  function onFootLinAcc(side, a, t) {
    const st = S.imu[side];
    const dt = st.lastT ? Math.min(0.05, (t - st.lastT) / 1000) : 0;
    st.lastT = t;
    if (!dt) return;
    const world = st.q ? quatRotate(st.q, [a.x, a.y, a.z]) : [a.x, a.y, a.z];
    if (S.fs.goAt != null) { const vd = S.fs.vdir[side]; vd[0] += world[0] * dt; vd[1] += world[1] * dt; }
    const mag = Math.hypot(...world);
    const plantedNow = S.loaded[side] && S.load[side] >= (S.ref[side] ?? 0.5) * CFG.zuptLoadFrac && mag < CFG.zuptStillAcc;
    if (plantedNow) {
      // ZUPT: clamp — this kills integration drift at every stance
      if (!st.planted && st.peak > 0.3 && t - st.swingStart < CFG.speedWindowMaxMs) {
        S.peakSpeed[side] = st.peak;
        S.lastStride = Math.hypot(st.d[0], st.d[1]); // horizontal displacement of the swing
        renderSpeed();
        if (S.sprint.goAt != null || S.sprint.steps.length) fillSprintSpeed(side, st.peak);
      }
      st.planted = true; st.v = [0, 0, 0]; st.d = [0, 0, 0]; st.peak = 0;
      return;
    }
    if (st.planted) { st.planted = false; st.swingStart = t; }
    for (let i = 0; i < 3; i++) { st.v[i] += world[i] * dt; st.d[i] += st.v[i] * dt; }
    const speed = Math.hypot(...st.v);
    if (speed > st.peak) st.peak = speed;
  }
  function renderSpeed() {
    const l = S.peakSpeed.left, r = S.peakSpeed.right;
    U.put($("speed-L"), "speed", l);
    U.put($("speed-R"), "speed", r);
    const best = Math.max(l ?? 0, r ?? 0);
    U.put($("speed-best"), "speed", best || null);
    U.put($("stride"), "dist", S.lastStride);
  }

  // ---------- wrist arm-drive ----------
  function onWristQuat(q) { S.wrist.q = q; }
  function onWristLinAcc(a, t) {
    const w = S.wrist;
    const dt = w.lastT ? Math.min(0.05, (t - w.lastT) / 1000) : 0;
    w.lastT = t;
    if (!dt) return;
    const world = w.q ? quatRotate(w.q, [a.x, a.y, a.z]) : [a.x, a.y, a.z];
    // decay-integrated speed: leaks to zero between efforts, peaks on the swing
    for (let i = 0; i < 3; i++) w.v[i] = w.v[i] * 0.985 + world[i] * dt;
    const s = Math.hypot(...w.v);
    if (s > w.peak) w.peak = s;
  }
  function captureWristPeak() {
    const w = S.wrist;
    if (w.peak > 0.3) {
      w.best = Math.max(w.best ?? 0, w.peak);
      w.last = w.peak;
      U.put($("wrist-speed"), "speed", w.last);
    }
    w.peak = 0; w.v = [0, 0, 0];
  }

  // ---------- audio ----------
  function beep(freq, ms) {
    try {
      S.audio ??= new (window.AudioContext || window.webkitAudioContext)();
      const o = S.audio.createOscillator(), g = S.audio.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(S.audio.destination);
      g.gain.value = 0.25; o.start(); o.stop(S.audio.currentTime + ms / 1000);
    } catch { /* no audio */ }
  }

  // ---------- CSV export (features + ground truth → calibration fits) ----------
  function exportCsv() {
    // metric throughout, whatever the display switch says (est_cm / device_cm in cm)
    const lines = ["kind,n,foot,flight_ms,est_cm,device_cm,reaction_ms,pushoff_ms,contact_ms,peak_speed_ms,dir,az_deg,t3_ms,tN_ms,accel_ms2,gate_s"];
    for (const j of S.jumps) lines.push(`jump,${j.n},${j.foot},${j.flightMs},${j.estCm.toFixed(2)},${j.deviceCm != null ? j.deviceCm.toFixed(2) : ""},,,,,,,,,,`);
    for (const t of S.fs.trials) lines.push(`first_step,${t.n},${t.side},,,,${t.reactionMs},${t.pushMs},${t.stepMs},,${t.dir ?? ""},${t.azDeg ?? ""},,,,`);
    for (const tr of S.sprint.trials) {
      lines.push(`sprint,${tr.n},${tr.startSide},,,,,,,${tr.vN != null ? tr.vN.toFixed(3) : ""},,,${tr.t3 ?? ""},${tr.tN},${tr.accel != null ? tr.accel.toFixed(3) : ""},${tr.gate ?? ""}`);
      for (const s of tr.steps) lines.push(`sprint_step,${tr.n},${s.side === "left" ? "L" : "R"},,,,,,${s.tMs},${s.v != null ? s.v.toFixed(3) : ""},,,,,,`);
    }
    if (S.peakSpeed.left != null) lines.push(`foot_speed,1,L,,,,,,,${S.peakSpeed.left.toFixed(3)},,,,,,`);
    if (S.peakSpeed.right != null) lines.push(`foot_speed,1,R,,,,,,,${S.peakSpeed.right.toFixed(3)},,,,,,`);
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `explosiveness-${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
    log(`Exported ${S.jumps.length} jumps · ${S.fs.trials.length} first-step trials · ${S.sprint.trials.length} sprints.`);
  }

  // ---------- SDK adapter (every BS.* touchpoint lives here) ----------
  const SDKAdapter = {
    devicePair: null, wrist: null,
    hasSDK() { return typeof window.BS !== "undefined"; },

    async connectInsoles() {
      if (!this.hasSDK()) { log("SDK not loaded — check network / unpkg.", "bad"); return; }
      try {
        this.devicePair = BS.DevicePair.insoles;
        this.devicePair.addEventListener("isConnected", () => {
          $("btn-insoles").classList.toggle("connected", this.devicePair.isConnected);
          if (this.devicePair.isConnected) startCal();
        });
        this.devicePair.addEventListener("deviceIsConnected", (e) => {
          const { device, side, isConnected } = e.message;
          if (!isConnected) return;
          // pressure for contacts/flight + IMU for ZUPT speed
          device.setSensorConfiguration({
            pressure: CFG.sensorRateMs,
            linearAcceleration: CFG.sensorRateMs,
            gameRotation: CFG.sensorRateMs * 2,
          });
          device.resetPressureRange?.();
          log(`${side} insole connected @ ${CFG.sensorRateMs}ms.`);
        });
        this.devicePair.addEventListener("devicePressure", (e) => {
          const { pressure: p, side } = e.message;
          if (p?.normalizedSum != null) onLoad(side, p.normalizedSum, now());
        });
        // TODO[SDK]: verify per-side IMU event names on the pair; fall back to
        // per-device listeners if deviceLinearAcceleration is not emitted.
        this.devicePair.addEventListener("deviceLinearAcceleration", (e) => {
          const { linearAcceleration: a, side } = e.message;
          if (a) onFootLinAcc(side, a, now());
        });
        this.devicePair.addEventListener("deviceGameRotation", (e) => {
          const { gameRotation: q, side } = e.message;
          if (q) onFootQuat(side, q);
        });
        const device = new BS.Device();
        device.connect();
        log("Insoles: Bluetooth chooser opened. Pick one, then click again for the other foot.");
      } catch (err) { log(`Insole connect failed: ${err.message}`, "bad"); }
    },

    async connectWrist() {
      if (!this.hasSDK()) { log("SDK not loaded — check network / unpkg.", "bad"); return; }
      try {
        const device = new BS.Device();
        this.wrist = device;
        device.addEventListener("isConnected", () => {
          S.wrist.connected = device.isConnected;
          $("btn-wrist").classList.toggle("connected", device.isConnected);
          $("wrist-state").textContent = device.isConnected ? "connected" : "not connected";
          if (device.isConnected) {
            device.setSensorConfiguration({ linearAcceleration: CFG.sensorRateMs, gameRotation: CFG.sensorRateMs * 2 });
          }
        });
        device.addEventListener("linearAcceleration", (e) => {
          const a = e.message.linearAcceleration;
          if (a) onWristLinAcc(a, now());
        });
        device.addEventListener("gameRotation", (e) => {
          const q = e.message.gameRotation ?? e.message.quaternion;
          if (q) onWristQuat(q);
        });
        device.connect();
        log("Wrist Sense: Bluetooth chooser opened.");
      } catch (err) { log(`Wrist connect failed: ${err.message}`, "bad"); }
    },
  };

  // ---------- simulate ----------
  // The scripted athlete: 3 jumps (BOTH / L / R), then three pogo hops. Built fresh so the optional layer can replay it for a rematch.
  function buildSimScript() {
    const seq = [];
    const still = (ms) => { for (let i = 0; i < ms / 20; i++) seq.push({ l: 0.5, r: 0.5 }); };
    const jump = (foot, flightMs) => {
      for (let i = 0; i < 15; i++) { // crouch+push 300ms
        const share = foot === "L" ? 0.95 : foot === "R" ? 0.05 : 0.5;
        const load = 0.5 + 0.45 * Math.sin((i / 15) * Math.PI);
        seq.push({ l: 2 * load * share, r: 2 * load * (1 - share) });
      }
      for (let i = 0; i < flightMs / 20; i++) seq.push({ l: 0.02, r: 0.02, air: true });
      for (let i = 0; i < 12; i++) seq.push({ l: 0.9, r: 0.9 }); // landing
    };
    still(800); jump("BOTH", 520); still(900); jump("L", 380); still(900); jump("R", 400);
    still(700); jump("BOTH", 300); jump("BOTH", 320); jump("BOTH", 310); // pogo-ish
    still(1200);
    return seq;
  }
  function simStart() {
    if (S.sim) return simStop();
    S.sim = true;
    $("btn-sim").classList.add("connected");
    S.ref = { left: 0.5, right: 0.5 };
    log("Simulate: 3 jumps (BOTH/L/R), pogo hops, then arm GO yourself.", "ok");
    S.simScript = buildSimScript();
    S.simTimer = setInterval(() => {
      // pause the script while a GO/sprint drill is live — the drill scripts its
      // own response, and mixed frames would race the drill state machines
      if (S.fs.armed || S.fs.goAt != null || S.sprint.armed || S.sprint.goAt != null) return;
      if (S.simHold) return;   // parked by the optional layer between stations
      const f = S.simScript.shift();
      if (!f) return; // idle at end; GO drill drives its own sim response
      const tt = now();
      onLoad("left", f.l + (Math.random() - 0.5) * 0.03, tt);
      onLoad("right", f.r + (Math.random() - 0.5) * 0.03, tt);
      if (f.air) { // fake foot/wrist speeds during flight
        S.peakSpeed.left = 3.1 + Math.random(); S.peakSpeed.right = 3.0 + Math.random();
        S.lastStride = 0.4 + Math.random() * 0.2;
        S.wrist.peak = 4.2 + Math.random(); renderSpeed();
      }
    }, 20);
    fun("sim", { on: true });
  }
  function simFirstStepResponse() {
    // scripted human-ish response ~230ms after GO, pushing off in a random direction
    const side = Math.random() > 0.5 ? "left" : "right";
    const react = 180 + Math.random() * 90;
    const idx = Math.floor(Math.random() * 8);
    const az = -idx * 45 * Math.PI / 180; // inverse of the CW chart mapping
    setTimeout(() => { onLoad(side, 0.62, now()); }, react);
    setTimeout(() => { onLoad(side, 0.12, now()); }, react + 90);
    for (let k = 0; k < 8; k++) setTimeout(() => {
      onFootLinAcc(side, { x: 9 * Math.cos(az), y: 9 * Math.sin(az), z: 0 }, now());
    }, react + 80 + k * 20);
    setTimeout(() => { onLoad(side, 0.75, now()); }, react + 260);
    setTimeout(() => { onLoad(side, 0.5, now()); onLoad(side === "left" ? "right" : "left", 0.5, now()); }, react + 500);
  }
  function simSprintResponse() {
    const sp = S.sprint;
    let side = Math.random() > 0.5 ? "left" : "right";
    let t = 320 + Math.random() * 80; // first contact after GO
    for (let i = 0; i < sp.n; i++) {
      const v = 1.8 + 0.75 * i * (0.92 + Math.random() * 0.16);
      const at = t, s = side;
      setTimeout(() => {
        S.peakSpeed[s] = v; renderSpeed();
        const rec = recordSprintContact(s, now());
        if (rec) rec.v = v; // sim fills speed directly; hardware path fills via ZUPT commit
      }, at);
      t += 430 * Math.pow(0.92, i) * (0.95 + Math.random() * 0.1);
      side = side === "left" ? "right" : "left";
    }
  }
  function simStop() {
    S.sim = false;
    clearInterval(S.simTimer);
    $("btn-sim").classList.remove("connected");
    S.simHold = false;
    log("Simulate stopped.");
    fun("sim", { on: false });
  }

  // ---------- wire up ----------
  $("btn-insoles").addEventListener("click", () => SDKAdapter.connectInsoles());
  $("btn-wrist").addEventListener("click", () => SDKAdapter.connectWrist());
  $("btn-cal").addEventListener("click", startCal);
  $("btn-sim").addEventListener("click", simStart);
  $("btn-go").addEventListener("click", () => armGo());
  $("btn-sprint").addEventListener("click", () => armSprint());
  document.querySelectorAll("#sp-seg button").forEach((b) => b.addEventListener("click", () => {
    S.sprint.n = Number(b.dataset.n);
    document.querySelectorAll("#sp-seg button").forEach((x) => x.classList.toggle("on", x === b));
    $("sp-n-label").textContent = b.dataset.n;
  }));
  $("btn-export").addEventListener("click", exportCsv);
  // Space / S are the drill hotkeys, but never while the user is working a control:
  //  - typing in a field (gate time, device height) must not arm anything;
  //  - a focused button keeps its native Space activation (units switch, keyboard users).
  // A mouse/touch click blurs its button, so "click Simulate, then Space" still arms GO.
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button");
    if (b && e.detail > 0) b.blur();   // detail 0 = keyboard-activated, keep focus
  });
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target.closest ? e.target : document.body;
    if (t.closest("input, select, textarea, [contenteditable]")) return;
    if (e.code === "Space") {
      if (t.closest("button")) return;
      e.preventDefault(); armGo();
    }
    if (e.code === "KeyS") armSprint();
  });
  // The whole surface the optional Combine layer gets: ask whether a measurement is running, arm a drill, stop one, and park or replay
  // the Simulate script. It never receives a way to change how anything is measured.
  function cancelDrills() {
    clearTimeout(S.fs.timer); clearTimeout(S.sprint.timer); clearTimeout(S.sprint.killT);
    Object.assign(S.fs, { armed: false, goAt: null });
    Object.assign(S.sprint, { armed: false, goAt: null });
    $("btn-go").classList.remove("armed"); $("go-light").className = "go-light";
    $("btn-sprint").classList.remove("armed"); $("sp-light").className = "go-light sm";
  }
  window.BWAE = Object.freeze({
    /** true while a calibration, GO window, sprint or flight is being read: nothing should pop up then */
    measuring: () => S.calUntil > 0 || S.fs.armed || S.fs.goAt != null || S.sprint.armed || S.sprint.goAt != null || S.combinedAirborneAt != null,
    hasDevice: () => !!(SDKAdapter.devicePair && SDKAdapter.devicePair.isConnected),
    isSim: () => S.sim,
    sprintSteps: () => S.sprint.n,
    armGo: (opts) => armGo(opts),
    armSprint: (opts) => armSprint(opts),
    cancelDrills,
    simHold: (on) => { S.simHold = !!on; },
    simReplay: () => { if (S.sim) S.simScript = buildSimScript(); },
  });
  document.addEventListener("bwtheme", drawPolar);   // the polar canvas reads theme tokens: redraw when the theme changes
  S.sprint.n = CFG.sprintStepsDefault;
  U.init($("units-seg"));
  drawPolar();
  log("Ready. Connect insoles (+ optional wrist Sense) or hit Simulate.");
})();
