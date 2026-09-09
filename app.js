/* Brilliant Wear — Athletic Explosiveness Demo
   Vertical leap (flight-time) · first-step quickness (audio GO) · IMU foot
   speed (ZUPT) · reactive strength · wrist arm-drive, in the browser.
   Hardware path: Brilliant Wear JS SDK (window.BS from unpkg build).
   Every SDK touchpoint lives in SDKAdapter — event/method drift gets fixed
   there (marked TODO[SDK]). Simulate exercises the entire UI, no hardware.

   Ground-truth capture is first-class: per-rep device-measured jump height
   inputs and the CSV export feed the calibration fits documented in the
   README (flight-time → device height; ZUPT speed → 240fps video). */

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
    jumps: [],                              // {n, foot, flightMs, estIn, deviceIn}
    flights: [],                            // recent flight spans for RSI
    calUntil: 0, calBuf: { left: [], right: [] },
    // first-step drill
    fs: { armed: false, goAt: null, timer: null, reactionMs: null, pushSide: null,
          pushMs: null, stepMs: null, trials: [] },
    // per-foot ZUPT integrator
    imu: {
      left:  { q: null, v: [0, 0, 0], d: [0, 0, 0], swingStart: 0, planted: true, lastT: 0, peak: 0 },
      right: { q: null, v: [0, 0, 0], d: [0, 0, 0], swingStart: 0, planted: true, lastT: 0, peak: 0 },
    },
    peakSpeed: { left: null, right: null }, lastStride: null,
    wrist: { q: null, v: [0, 0, 0], lastT: 0, peak: 0, window: false, connected: false, best: null },
    audio: null,
  };
  const now = () => performance.now();
  const $ = (id) => document.getElementById(id);
  const M2IN = 39.3701;

  function log(msg, cls = "") {
    const el = $("log");
    el.insertAdjacentHTML("afterbegin", `<div class="${cls}">${new Date().toLocaleTimeString()} — ${msg}</div>`);
  }

  // ---------- calibration (standing reference) ----------
  function startCal() {
    S.calUntil = now() + CFG.calMs;
    S.calBuf = { left: [], right: [] };
    log("Calibrating — stand still, weight even…");
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
    if (S.ref.left && S.ref.right) log(`Calibrated — ref L ${S.ref.left.toFixed(2)} · R ${S.ref.right.toFixed(2)}.`, "ok");
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
    else if (!S.loaded[side] && v >= ref * CFG.contactOnFrac) { S.loaded[side] = true; S.lastEdge[side] = t; }

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
    const estIn = h * M2IN;
    const foot = classifyTakeoff(takeoffAt);
    const rep = { n: S.jumps.length + 1, foot, flightMs: Math.round(flightMs), estIn, deviceIn: null };
    S.jumps.push(rep);
    S.flights.push({ start: takeoffAt, end: landAt, flightMs });
    if (S.flights.length > 8) S.flights.shift();
    renderJumps(rep);
    computeRsi();
    if (S.wrist.connected || S.sim) captureWristPeak();
    log(`Jump #${rep.n}: ${estIn.toFixed(1)} in (${Math.round(flightMs)} ms flight, ${foot}).`, "ok");
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
    }
  }

  function renderJumps(rep) {
    $("jump-in").textContent = rep.estIn.toFixed(1);
    $("jump-cm").textContent = `(${(rep.estIn * 2.54).toFixed(1)} cm)`;
    $("jump-flight").textContent = rep.flightMs;
    $("jump-count").textContent = `${S.jumps.length} rep${S.jumps.length === 1 ? "" : "s"}`;
    const badge = $("jump-foot");
    badge.style.display = "inline-block";
    badge.textContent = rep.foot;
    badge.className = `foot-badge foot-${rep.foot}`;
    $("jump-best").textContent = Math.max(...S.jumps.map((j) => j.estIn)).toFixed(1);
    const bars = $("jump-bars");
    bars.innerHTML = S.jumps.slice(-12).map((j) => {
      const max = Math.max(...S.jumps.map((x) => x.estIn), 1);
      return `<div class="bar ${j.foot}" style="height:${Math.max(8, (j.estIn / max) * 78)}%"><span>${j.estIn.toFixed(1)}</span></div>`;
    }).join("");
    const tb = $("jump-table").querySelector("tbody");
    tb.insertAdjacentHTML("afterbegin",
      `<tr><td>${rep.n}</td><td>${rep.foot}</td><td>${rep.flightMs}</td><td>${rep.estIn.toFixed(1)}</td>
       <td><input type="number" step="0.1" placeholder="—" data-rep="${rep.n}" /></td></tr>`);
    tb.querySelector("input").addEventListener("change", (e) => {
      const j = S.jumps.find((x) => x.n === Number(e.target.dataset.rep));
      if (j) { j.deviceIn = Number(e.target.value); log(`Rep ${j.n}: device height ${j.deviceIn} in logged (est ${j.estIn.toFixed(1)}).`); }
    });
  }

  // ---------- first-step quickness ----------
  function armGo() {
    if (S.fs.armed) return;
    S.fs.armed = true;
    Object.assign(S.fs, { goAt: null, reactionMs: null, pushSide: null, pushMs: null, stepMs: null, baseline: { ...S.load } });
    $("btn-go").classList.add("armed");
    $("go-light").className = "go-light armed";
    const delay = CFG.goDelayMinMs + Math.random() * (CFG.goDelayMaxMs - CFG.goDelayMinMs);
    S.fs.timer = setTimeout(fireGo, delay);
    log("GO armed — hold still…");
  }
  function fireGo() {
    S.fs.goAt = now();
    S.fs.baseline = { ...S.load };
    $("go-light").className = "go-light go";
    beep(880, 120);
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
      reactionMs: Math.round(fs.reactionMs ?? 0), pushMs: Math.round(fs.pushMs ?? 0), stepMs: Math.round(fs.stepMs ?? 0) };
    fs.trials.push(trial);
    $("fs-table").querySelector("tbody").insertAdjacentHTML("afterbegin",
      `<tr><td>${trial.n}</td><td>${trial.side}</td><td>${trial.reactionMs}</td><td>${trial.pushMs}</td><td>${trial.stepMs}</td></tr>`);
    fs.armed = false; fs.goAt = null;
    $("btn-go").classList.remove("armed");
    $("go-light").className = "go-light";
    log(`First step #${trial.n}: ${trial.side} — contact in ${trial.stepMs} ms.`, "ok");
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
    const mag = Math.hypot(...world);
    const plantedNow = S.loaded[side] && S.load[side] >= (S.ref[side] ?? 0.5) * CFG.zuptLoadFrac && mag < CFG.zuptStillAcc;
    if (plantedNow) {
      // ZUPT: clamp — this kills integration drift at every stance
      if (!st.planted && st.peak > 0.3 && t - st.swingStart < CFG.speedWindowMaxMs) {
        S.peakSpeed[side] = st.peak;
        S.lastStride = Math.hypot(st.d[0], st.d[1]); // horizontal displacement of the swing
        renderSpeed();
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
    $("speed-L").textContent = l != null ? l.toFixed(2) : "—";
    $("speed-R").textContent = r != null ? r.toFixed(2) : "—";
    const best = Math.max(l ?? 0, r ?? 0);
    $("speed-fts").textContent = best ? (best * 3.28084).toFixed(1) : "—";
    $("stride-m").textContent = S.lastStride != null ? S.lastStride.toFixed(2) : "—";
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
      $("wrist-speed").textContent = w.peak.toFixed(2);
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
    const lines = ["kind,n,foot,flight_ms,est_in,device_in,reaction_ms,pushoff_ms,contact_ms,peak_speed_ms"];
    for (const j of S.jumps) lines.push(`jump,${j.n},${j.foot},${j.flightMs},${j.estIn.toFixed(2)},${j.deviceIn ?? ""},,,,`);
    for (const t of S.fs.trials) lines.push(`first_step,${t.n},${t.side},,,,${t.reactionMs},${t.pushMs},${t.stepMs},`);
    if (S.peakSpeed.left != null) lines.push(`foot_speed,1,L,,,,,,,${S.peakSpeed.left.toFixed(3)}`);
    if (S.peakSpeed.right != null) lines.push(`foot_speed,1,R,,,,,,,${S.peakSpeed.right.toFixed(3)}`);
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `explosiveness-${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
    log(`Exported ${S.jumps.length} jumps · ${S.fs.trials.length} first-step trials.`);
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
  function simStart() {
    if (S.sim) return simStop();
    S.sim = true;
    $("btn-sim").classList.add("connected");
    S.ref = { left: 0.5, right: 0.5 };
    log("Simulate: 3 jumps (BOTH/L/R), pogo hops, then arm GO yourself.", "ok");
    let t = 0;
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
    S.simScript = seq;
    S.simTimer = setInterval(() => {
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
  }
  function simFirstStepResponse() {
    // scripted human-ish response ~230ms after GO
    const side = Math.random() > 0.5 ? "left" : "right";
    const react = 180 + Math.random() * 90;
    setTimeout(() => { onLoad(side, 0.62, now()); }, react);
    setTimeout(() => { onLoad(side, 0.12, now()); }, react + 90);
    setTimeout(() => { onLoad(side, 0.75, now()); }, react + 260);
    setTimeout(() => { onLoad(side, 0.5, now()); onLoad(side === "left" ? "right" : "left", 0.5, now()); }, react + 500);
  }
  function simStop() {
    S.sim = false;
    clearInterval(S.simTimer);
    $("btn-sim").classList.remove("connected");
    log("Simulate stopped.");
  }

  // ---------- wire up ----------
  $("btn-insoles").addEventListener("click", () => SDKAdapter.connectInsoles());
  $("btn-wrist").addEventListener("click", () => SDKAdapter.connectWrist());
  $("btn-cal").addEventListener("click", startCal);
  $("btn-sim").addEventListener("click", simStart);
  $("btn-go").addEventListener("click", armGo);
  $("btn-export").addEventListener("click", exportCsv);
  document.addEventListener("keydown", (e) => { if (e.code === "Space") { e.preventDefault(); armGo(); } });
  log("Ready. Connect insoles (+ optional wrist Sense) or hit Simulate.");
})();
