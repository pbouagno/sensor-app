/*
  sensors.js — reads every sensor the browser lets a web page use.

  Each sensor is a "stream": a name, a list of axes (x, y, z ...), units,
  a status, and a rolling buffer of recent readings. Other files read
  Sensors.streams and call Sensors.onSample() to hear about new readings.

  Statuses:
    idle        — not started yet (tap START SENSORS)
    waiting     — started, no reading yet
    live        — readings are arriving
    unavailable — this phone/browser can't provide it
    denied      — you (or the browser) said no to permission
    error       — something else went wrong (see the message)

  Every API is "feature-detected": we check it exists before using it,
  so a missing sensor just shows "Not available" instead of crashing.
*/
(function () {
  "use strict";
  const { Ring, isNum } = window.Util;
  const BUFFER = 60 * 70; // keep ~60 s of readings at 70 Hz

  // ---------- The list of streams ----------
  // api: the browser feature it comes from (shown in the Detail view)
  // units: one per axis.  chart: which axes to draw (default: all)
  const DEFS = [
    { id: "accelG", name: "Accelerometer", sub: "Including gravity", api: "DeviceMotionEvent.accelerationIncludingGravity", axes: ["x", "y", "z"], units: "m/s²", viz: "lines" },
    { id: "accel", name: "Linear acceleration", sub: "Gravity removed", api: "DeviceMotionEvent.acceleration", axes: ["x", "y", "z"], units: "m/s²", viz: "lines" },
    { id: "gyro", name: "Rotation rate", sub: "Gyroscope", api: "DeviceMotionEvent.rotationRate", axes: ["alpha", "beta", "gamma"], units: "°/s", viz: "lines" },
    { id: "orient", name: "Orientation", sub: "Tilt / attitude", api: "DeviceOrientationEvent", axes: ["alpha", "beta", "gamma"], units: "°", viz: "attitude", wrap: [0] },
    { id: "compass", name: "Compass", sub: "Heading from north", api: "webkitCompassHeading (iPhone) · deviceorientationabsolute (Android)", axes: ["heading", "accuracy"], units: ["°", "± °"], viz: "compass", chart: [0], wrap: [0] },
    { id: "geo", name: "Location", sub: "GPS / network", api: "navigator.geolocation.watchPosition", axes: ["lat", "lon", "accuracy", "altitude", "alt. accuracy", "speed", "heading"], units: ["°", "°", "m", "m", "m", "m/s", "°"], digits: [6, 6, 1, 1, 1, 2, 1], viz: "trace", chart: [2, 3, 5] },
    { id: "mag", name: "Magnetometer", sub: "Generic Sensor API", api: "Magnetometer", axes: ["x", "y", "z", "|B|"], units: "µT", viz: "lines" },
    { id: "light", name: "Ambient light", sub: "Generic Sensor API", api: "AmbientLightSensor", axes: ["illuminance"], units: "lx", viz: "gauge" },
    { id: "gsAccel", name: "Accelerometer (raw)", sub: "Generic Sensor API", api: "Accelerometer", axes: ["x", "y", "z"], units: "m/s²", viz: "lines" },
    { id: "gsGyro", name: "Gyroscope (raw)", sub: "Generic Sensor API", api: "Gyroscope", axes: ["x", "y", "z"], units: "rad/s", viz: "lines" },
    { id: "absOrient", name: "Absolute orientation", sub: "Quaternion · Generic Sensor API", api: "AbsoluteOrientationSensor", axes: ["qx", "qy", "qz", "qw"], units: "", digits: 4, viz: "lines" },
    { id: "mic", name: "Microphone", sub: "Sound level (uncalibrated)", api: "getUserMedia + Web Audio AnalyserNode", axes: ["rms", "peak"], units: "dBFS", digits: 1, viz: "mic", optIn: true },
    { id: "battery", name: "Battery", sub: "Polled 1 Hz", api: "navigator.getBattery()", axes: ["level", "charging"], units: ["%", ""], digits: [0, 0], viz: "gauge", chart: [0] },
    { id: "network", name: "Network", sub: "Polled 1 Hz", api: "navigator.connection + navigator.onLine", axes: ["downlink", "rtt", "online"], units: ["Mb/s", "ms", ""], digits: [1, 0, 0], viz: "gauge", chart: [0, 1] },
    { id: "screen", name: "Screen", sub: "Polled 1 Hz", api: "screen.orientation · innerWidth · devicePixelRatio", axes: ["width", "height", "pixel ratio", "angle"], units: ["px", "px", "×", "°"], digits: [0, 0, 2, 0], viz: "lines", chart: [3] },
    { id: "visibility", name: "Page visibility", sub: "Polled 1 Hz", api: "document.visibilityState", axes: ["visible"], units: [""], digits: [0], viz: "lines" },
  ];

  const streams = {};
  for (const d of DEFS) {
    d.units = Array.isArray(d.units) ? d.units : d.axes.map(() => d.units);
    d.digits = Array.isArray(d.digits) ? d.digits : d.axes.map(() => d.digits);
    d.chart = d.chart || d.axes.map((_, i) => i);
    streams[d.id] = { def: d, status: "idle", msg: "", ring: new Ring(BUFFER), last: null, count: 0, info: {} };
  }

  const listeners = [];
  const changeListeners = [];
  function setStatus(id, status, msg) {
    const s = streams[id];
    if (s.status === status && s.msg === (msg || "")) return;
    s.status = status; s.msg = msg || "";
    changeListeners.forEach((fn) => fn(id));
  }
  // Every new reading goes through here.
  function push(id, values, t) {
    const s = streams[id];
    t = t || Date.now();
    s.ring.push(t, values);
    s.last = { t, v: values };
    s.count++;
    if (s.status !== "live") setStatus(id, "live", s.keepMsg ? s.msg : "");
    for (const fn of listeners) fn(id, t, values);
  }
  const num = (x) => (isNum(x) ? x : null);
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // If no reading arrives within `ms`, mark the stream unavailable.
  function timeout(id, ms, msg) {
    setTimeout(() => { if (streams[id].status === "waiting") setStatus(id, "unavailable", msg); }, ms);
  }

  // ---------- Motion (accelerometer + gyroscope) ----------
  let motionOn = false;
  function startMotion() {
    if (motionOn) return;
    if (!("DeviceMotionEvent" in window)) {
      ["accel", "accelG", "gyro"].forEach((id) => setStatus(id, "unavailable", "DeviceMotionEvent is not supported in this browser."));
      return;
    }
    motionOn = true;
    ["accel", "accelG", "gyro"].forEach((id) => {
      setStatus(id, "waiting", "");
      timeout(id, 4000, "No readings. This device may have no motion sensor (e.g. a laptop), or the page isn't on HTTPS.");
    });
    window.addEventListener("devicemotion", (e) => {
      const t = Date.now();
      const a = e.acceleration, g = e.accelerationIncludingGravity, r = e.rotationRate;
      // Some browsers report interval in seconds, some in ms: show ms.
      let interval = num(e.interval);
      if (interval != null && interval > 0 && interval < 1) interval *= 1000;
      if (g && (isNum(g.x) || isNum(g.y) || isNum(g.z))) { push("accelG", [num(g.x), num(g.y), num(g.z)], t); streams.accelG.info.interval = interval; }
      if (a && (isNum(a.x) || isNum(a.y) || isNum(a.z))) { push("accel", [num(a.x), num(a.y), num(a.z)], t); streams.accel.info.interval = interval; }
      if (r && (isNum(r.alpha) || isNum(r.beta) || isNum(r.gamma))) { push("gyro", [num(r.alpha), num(r.beta), num(r.gamma)], t); streams.gyro.info.interval = interval; }
    });
  }

  // ---------- Orientation + compass ----------
  let orientOn = false;
  function startOrientation() {
    if (orientOn) return;
    if (!("DeviceOrientationEvent" in window)) {
      setStatus("orient", "unavailable", "DeviceOrientationEvent is not supported in this browser.");
      setStatus("compass", "unavailable", "Needs DeviceOrientationEvent, which this browser lacks.");
      return;
    }
    orientOn = true;
    setStatus("orient", "waiting"); setStatus("compass", "waiting");
    timeout("orient", 4000, "No readings. This device may have no orientation sensor, or the page isn't on HTTPS.");
    timeout("compass", 5000, "No compass heading. Needs a magnetometer (iPhone: webkitCompassHeading; Android: absolute orientation).");
    let gotAbsolute = false;
    window.addEventListener("deviceorientation", (e) => {
      if (!isNum(e.alpha) && !isNum(e.beta) && !isNum(e.gamma)) return;
      push("orient", [num(e.alpha), num(e.beta), num(e.gamma)]);
      streams.orient.info.absolute = !!e.absolute;
      if (isNum(e.webkitCompassHeading)) { // iPhone / iPad
        push("compass", [e.webkitCompassHeading, num(e.webkitCompassAccuracy)]);
        streams.compass.info.source = "webkitCompassHeading (iOS)";
      } else if (e.absolute && isNum(e.alpha) && !gotAbsolute) {
        push("compass", [(360 - e.alpha) % 360, null]);
        streams.compass.info.source = "deviceorientation (absolute)";
      }
    });
    // Android Chrome: a separate event whose alpha is relative to north.
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", (e) => {
        if (!isNum(e.alpha)) return;
        gotAbsolute = true;
        push("compass", [(360 - e.alpha) % 360, null]);
        streams.compass.info.source = "deviceorientationabsolute (Android)";
      });
    }
  }

  // ---------- Generic Sensor API (mostly Android Chrome) ----------
  function startGeneric(id, ctorName, read, opts) {
    const s = streams[id];
    if (s.sensor) return;
    const Ctor = window[ctorName];
    if (typeof Ctor !== "function") {
      const why = isIOS ? "Safari on iPhone does not support the Generic Sensor API." :
        (ctorName === "Magnetometer" || ctorName === "AmbientLightSensor")
          ? `${ctorName} is not enabled in this browser (Chrome on Android hides it behind chrome://flags → "Generic Sensor Extra Classes").`
          : `${ctorName} is not supported in this browser.`;
      return setStatus(id, "unavailable", why);
    }
    try {
      const sensor = new Ctor(opts || { frequency: 60 });
      sensor.addEventListener("reading", () => push(id, read(sensor)));
      sensor.addEventListener("error", (e) => {
        const name = e.error && e.error.name;
        if (name === "NotAllowedError") setStatus(id, "denied", "Permission to use this sensor was denied.");
        else if (name === "NotReadableError") setStatus(id, "unavailable", "The browser supports it, but this device has no such sensor (or it's busy).");
        else setStatus(id, "error", (e.error && e.error.message) || "Sensor error");
      });
      setStatus(id, "waiting");
      timeout(id, 4000, "The API exists but no readings arrived — the device may lack this sensor.");
      sensor.start();
      s.sensor = sensor;
    } catch (err) {
      setStatus(id, err.name === "SecurityError" ? "denied" : "unavailable", err.message);
    }
  }
  function startAllGeneric() {
    startGeneric("gsAccel", "Accelerometer", (s) => [s.x, s.y, s.z]);
    startGeneric("gsGyro", "Gyroscope", (s) => [s.x, s.y, s.z]);
    startGeneric("mag", "Magnetometer", (s) => [s.x, s.y, s.z, Math.hypot(s.x, s.y, s.z)]);
    startGeneric("absOrient", "AbsoluteOrientationSensor", (s) => (s.quaternion ? s.quaternion.slice() : [null, null, null, null]));
    startGeneric("light", "AmbientLightSensor", (s) => [s.illuminance], { frequency: 5 });
  }

  // ---------- Location ----------
  let geoWatch = null;
  function startGeo() {
    if (geoWatch != null) return;
    if (!navigator.geolocation) return setStatus("geo", "unavailable", "Geolocation is not supported in this browser.");
    setStatus("geo", "waiting", "Waiting for a location fix… (outdoors helps)");
    geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        push("geo", [c.latitude, c.longitude, num(c.accuracy), num(c.altitude), num(c.altitudeAccuracy),
          isNum(c.speed) && c.speed >= 0 ? c.speed : null, isNum(c.heading) && c.heading >= 0 ? c.heading : null], p.timestamp || Date.now());
      },
      (err) => {
        if (err.code === 1) setStatus("geo", "denied", "Location permission was denied. iPhone: Settings → Privacy → Location Services → Safari Websites.");
        else if (err.code === 2) setStatus("geo", "unavailable", "Position unavailable: " + err.message);
        // code 3 (timeout): keep waiting, watchPosition retries on its own.
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  // ---------- Microphone level ----------
  let audio = null;
  function startMic(ctx) {
    if (audio) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("mic", "unavailable", "Microphone access needs HTTPS and a browser with getUserMedia.");
      return Promise.resolve();
    }
    setStatus("mic", "waiting", "Asking for microphone permission…");
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = ctx || (AC ? new AC() : null); // created during the tap so iPhone lets it play
    if (!ctx) { setStatus("mic", "unavailable", "Web Audio is not supported."); return Promise.resolve(); }
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .then((stream) => {
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        if (ctx.state === "suspended") ctx.resume();
        const timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0, peak = 0;
          for (let i = 0; i < buf.length; i++) { const x = buf[i]; sum += x * x; const ax = Math.abs(x); if (ax > peak) peak = ax; }
          const rms = Math.sqrt(sum / buf.length);
          const db = (x) => Math.max(-100, 20 * Math.log10(x || 1e-10));
          streams.mic.info.wave = buf.slice(0, 512);
          push("mic", [db(rms), db(peak)]);
        }, 50); // 20 Hz
        audio = { ctx, stream, timer };
        streams.mic.info.sampleRate = ctx.sampleRate;
      })
      .catch((err) => {
        setStatus("mic", err.name === "NotAllowedError" ? "denied" : "unavailable", err.message || "Microphone unavailable");
      });
  }
  function stopMic() {
    if (!audio) return;
    clearInterval(audio.timer);
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close && audio.ctx.close();
    audio = null;
    setStatus("mic", "idle", "Microphone is off.");
  }

  // ---------- Battery, network, screen, visibility (polled once a second) ----------
  let battery = null, pollTimer = null;
  function startPassive() {
    if (pollTimer) return;
    if (typeof navigator.getBattery === "function") {
      setStatus("battery", "waiting");
      navigator.getBattery().then((b) => { battery = b; pollBattery(); ["levelchange", "chargingchange"].forEach((ev) => b.addEventListener(ev, pollBattery)); })
        .catch((e) => setStatus("battery", "unavailable", e.message));
    } else {
      setStatus("battery", "unavailable", isIOS ? "Safari on iPhone does not expose the Battery Status API." : "Battery Status API not supported in this browser.");
    }
    if (!navigator.connection) streams.network.keepMsg = true;
    if (!navigator.connection) streams.network.msg = isIOS
      ? "Safari on iPhone has no Network Information API — showing online/offline only."
      : "No Network Information API — showing online/offline only.";
    pollTimer = setInterval(poll, 1000);
    poll();
    document.addEventListener("visibilitychange", () => { streams.visibility.info.changes = (streams.visibility.info.changes || 0) + 1; poll(); });
    window.addEventListener("online", poll); window.addEventListener("offline", poll);
    window.addEventListener("resize", poll);
  }
  function pollBattery() {
    if (!battery) return;
    push("battery", [Math.round(battery.level * 100), battery.charging ? 1 : 0]);
    Object.assign(streams.battery.info, { chargingTime: battery.chargingTime, dischargingTime: battery.dischargingTime, charging: battery.charging });
  }
  function poll() {
    const c = navigator.connection;
    push("network", [c && isNum(c.downlink) ? c.downlink : null, c && isNum(c.rtt) ? c.rtt : null, navigator.onLine ? 1 : 0]);
    if (c) Object.assign(streams.network.info, { effectiveType: c.effectiveType, type: c.type, saveData: c.saveData });
    const so = screen.orientation;
    const angle = so && isNum(so.angle) ? so.angle : isNum(window.orientation) ? window.orientation : 0;
    push("screen", [window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, angle]);
    Object.assign(streams.screen.info, {
      type: so ? so.type : (Math.abs(angle) === 90 ? "landscape" : "portrait"),
      screen: `${screen.width}×${screen.height}`, colorDepth: screen.colorDepth,
      standalone: window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
    });
    push("visibility", [document.visibilityState === "visible" ? 1 : 0]);
    streams.visibility.info.state = document.visibilityState;
    if (battery && Date.now() - (streams.battery.last ? streams.battery.last.t : 0) >= 1000) pollBattery();
  }

  // ---------- Device info (doesn't change) ----------
  function deviceInfo() {
    const n = navigator;
    let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* old browser */ }
    return {
      "User agent": n.userAgent,
      "Platform": (n.userAgentData && n.userAgentData.platform) || n.platform || "—",
      "Mobile (UA hint)": n.userAgentData ? String(n.userAgentData.mobile) : "—",
      "CPU cores": n.hardwareConcurrency || "—",
      "Memory (approx.)": n.deviceMemory ? n.deviceMemory + " GB" : "— (not shared by this browser)",
      "Language": (n.languages || [n.language]).join(", "),
      "Time zone": tz || "—",
      "Touch points": n.maxTouchPoints != null ? n.maxTouchPoints : "—",
      "Screen": `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`,
      "Secure (HTTPS)": String(window.isSecureContext),
      "Installed app mode": String(window.matchMedia("(display-mode: standalone)").matches || n.standalone === true),
      "Vibration API": String("vibrate" in n),
      "Screen Wake Lock API": String("wakeLock" in n),
    };
  }

  // ---------- START SENSORS (must run inside a tap) ----------
  // iPhone only shows the motion permission popup if requestPermission()
  // is called directly inside a tap, before any "await". So we fire every
  // permission request right away, then wait for the answers.
  function startAll(opts) {
    opts = opts || {};
    const ask = (Ev) => (Ev && typeof Ev.requestPermission === "function")
      ? Ev.requestPermission().catch((e) => "error:" + e.message)
      : Promise.resolve("granted");
    const motionP = ask(window.DeviceMotionEvent);
    const orientP = ask(window.DeviceOrientationEvent);
    let audioCtx = null;
    if (opts.mic) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
    // safe(): one sensor failing must never stop the others from starting
    const safe = (fn) => { try { return fn(); } catch (e) { console.warn(e); } };
    safe(startGeo);
    const micP = (opts.mic && safe(() => startMic(audioCtx))) || Promise.resolve();
    safe(startPassive);
    safe(startAllGeneric);
    Sensors.started = true;
    return Promise.all([motionP, orientP, micP]).then(([m, o]) => {
      if (m === "granted") startMotion();
      else ["accel", "accelG", "gyro"].forEach((id) => setStatus(id, "denied", "Motion access was not allowed. iPhone: quit Safari fully and try again, or check Settings → Safari → Motion & Orientation Access."));
      if (o === "granted") startOrientation();
      else ["orient", "compass"].forEach((id) => setStatus(id, "denied", "Orientation access was not allowed."));
      changeListeners.forEach((fn) => fn(null));
    });
  }

  // Things that need no permission start as soon as the page opens.
  function startPassiveOnLoad() {
    startPassive();
    const needsTap = (Ev) => Ev && typeof Ev.requestPermission === "function";
    if (!needsTap(window.DeviceMotionEvent)) startMotion();       // Android: no popup needed
    if (!needsTap(window.DeviceOrientationEvent)) startOrientation();
    if (streams.mic.status === "idle") streams.mic.msg = "Off. Tick \"Include microphone\" and tap START SENSORS.";
  }

  const Sensors = {
    DEFS, streams, started: false, isIOS,
    startAll, startPassiveOnLoad, startMic, stopMic, deviceInfo,
    micOn: () => !!audio,
    onSample: (fn) => listeners.push(fn),
    offSample: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    onStatus: (fn) => changeListeners.push(fn),
  };
  window.Sensors = Sensors;
})();
