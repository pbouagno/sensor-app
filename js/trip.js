/*
  trip.js — one drive, logged about once a second.

  Each second it reads the latest GPS and motion samples already collected
  by sensors.js (it does not open the sensors itself). Between seconds it
  watches the raw stream so a short hard brake is not missed. Rows go to
  IndexedDB. The Wake Lock API keeps the screen on where the browser allows it.
*/
(function () {
  "use strict";
  const SAMPLE_MS = 1000;
  let trip = null, lastTrip = null, timer = null, wakeLock = null;
  // Peaks since the last saved second.
  let peakLong = null, peakAy = null, hadGpsLong = false, peakYaw = null, peakG = 0;
  let lastSpeed = null, lastSpeedT = 0, lastGravity = null, lastGyro = null;

  const isNum = (x) => window.TripMath.isNum(x);

  function thresholds() {
    const s = window.AppSettings || {};
    const harsh = isNum(+s.harshG) ? +s.harshG : TripMath.DEFAULTS.harshG;
    const turn = isNum(+s.turnDps) ? +s.turnDps : TripMath.DEFAULTS.turnDegPerS;
    return {
      harshG: Math.min(1.5, Math.max(0.05, harsh)),
      turnDegPerS: Math.min(180, Math.max(5, turn)),
      elevNoiseM: TripMath.DEFAULTS.elevNoiseM,
    };
  }

  function resetPeaks() {
    peakLong = null; peakAy = null; hadGpsLong = false; peakYaw = null; peakG = 0;
  }

  function noteYaw() {
    if (!lastGyro) return;
    let yaw = null;
    if (lastGravity) {
      const gx = lastGravity[0] || 0, gy = lastGravity[1] || 0, gz = lastGravity[2] || 0;
      const mag = Math.hypot(gx, gy, gz);
      // rotationRate: alpha is Z (out of the screen), beta is X, gamma is Y.
      if (mag > 3) {
        const wx = lastGyro[1] || 0, wy = lastGyro[2] || 0, wz = lastGyro[0] || 0;
        yaw = (wx * gx + wy * gy + wz * gz) / mag;
      }
    }
    if (yaw == null && isNum(lastGyro[0])) yaw = lastGyro[0];
    if (isNum(yaw) && (peakYaw == null || Math.abs(yaw) > Math.abs(peakYaw))) peakYaw = yaw;
  }

  // Hear every raw reading so a spike between the 1 Hz rows is kept.
  function onSample(id, t, values) {
    if (!trip) return;
    if (id === "geo") {
      const speed = values[5];
      if (isNum(speed) && isNum(lastSpeed) && t > lastSpeedT) {
        const a = (speed - lastSpeed) / ((t - lastSpeedT) / 1000);
        if (peakLong == null || Math.abs(a) > Math.abs(peakLong)) peakLong = a;
        hadGpsLong = true;
      }
      if (isNum(speed)) { lastSpeed = speed; lastSpeedT = t; }
    } else if (id === "accel") {
      const g = Math.hypot(values[0] || 0, values[1] || 0, values[2] || 0) / TripMath.G;
      if (g > peakG) peakG = g;
      if (isNum(values[1]) && (peakAy == null || Math.abs(values[1]) > Math.abs(peakAy))) peakAy = values[1];
    } else if (id === "accelG") {
      lastGravity = values;
      noteYaw();
    } else if (id === "gyro") {
      lastGyro = values;
      noteYaw();
    }
  }

  function readSample(t) {
    const geo = Sensors.streams.geo.last;
    const accel = Sensors.streams.accel.last;
    const g = geo && geo.v;
    const compass = Sensors.streams.compass.last;
    const heading = compass && isNum(compass.v[0]) ? compass.v[0] : (g && isNum(g[6]) ? g[6] : null);
    // Sub-second GPS speed changes win. Otherwise leave longitudinal accel empty
    // so the summary can use the once-a-second speeds. The phone's Y axis is
    // only a stand-in when this second has no GPS speed at all.
    const gpsSpeed = g && isNum(g[5]) ? g[5] : null;
    let longAccel = null;
    if (hadGpsLong && isNum(peakLong)) longAccel = peakLong;
    else if (gpsSpeed == null && isNum(peakAy)) longAccel = peakAy;
    const sample = {
      t,
      lat: g && isNum(g[0]) ? g[0] : null,
      lon: g && isNum(g[1]) ? g[1] : null,
      accuracy: g && isNum(g[2]) ? g[2] : null,
      alt: g && isNum(g[3]) ? g[3] : null,
      speed: gpsSpeed,
      heading,
      ax: accel && isNum(accel.v[0]) ? accel.v[0] : null,
      ay: accel && isNum(accel.v[1]) ? accel.v[1] : null,
      az: accel && isNum(accel.v[2]) ? accel.v[2] : null,
      longAccel,
      yaw: isNum(peakYaw) ? peakYaw : null,
      g: peakG > 0 ? peakG : null,
    };
    const prev = trip.samples[trip.samples.length - 1];
    if (sample.speed == null && prev) {
      const seg = TripMath.segment(prev, sample);
      if (seg) sample.speed = seg.speed;
    }
    resetPeaks();
    return sample;
  }

  function recompute() {
    trip.thresholds = thresholds();
    trip.summary = TripMath.summarize(trip.samples, trip.thresholds);
    trip.summary.durationMs = Date.now() - trip.start;
  }

  function tick() {
    if (!trip) return;
    trip.samples.push(readSample(Date.now()));
    recompute();
    if (trip.samples.length % 5 === 0) DB.saveTrip(strip(trip)).catch((e) => console.warn(e));
  }

  // IndexedDB cannot clone the live object while we keep mutating it in place
  // if a field were a function. A plain copy is enough.
  function strip(t) {
    return {
      id: t.id, start: t.start, end: t.end, name: t.name || "",
      samples: t.samples, summary: t.summary, thresholds: t.thresholds,
    };
  }

  async function keepAwake() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (trip && document.visibilityState === "visible") keepAwake();
  });

  async function start() {
    if (trip) return trip;
    resetPeaks();
    lastSpeed = null; lastSpeedT = 0; lastGravity = null; lastGyro = null;
    trip = {
      id: "t" + Date.now(), start: Date.now(), end: null, name: "",
      samples: [], summary: null, thresholds: thresholds(),
    };
    Sensors.onSample(onSample);
    // Ask to keep the screen on before the first await, while the tap still counts.
    keepAwake();
    trip.samples.push(readSample(trip.start));
    recompute();
    try {
      await DB.saveTrip(strip(trip));
    } catch (e) {
      Sensors.offSample(onSample);
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      trip = null;
      throw e;
    }
    timer = setInterval(tick, SAMPLE_MS);
    return trip;
  }

  async function stop() {
    if (!trip) return null;
    Sensors.offSample(onSample);
    clearInterval(timer); timer = null;
    trip.end = Date.now();
    // One last row if the interval has not just fired.
    const last = trip.samples[trip.samples.length - 1];
    if (!last || trip.end - last.t > 250) trip.samples.push(readSample(trip.end));
    recompute();
    trip.summary.durationMs = trip.end - trip.start;
    await DB.saveTrip(strip(trip));
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    const done = trip;
    lastTrip = done;
    trip = null;
    return done;
  }

  // Continue a trip that was still open when the page was closed.
  async function resume() {
    if (trip) return trip;
    const list = await DB.listTrips();
    if (trip) return trip;
    const open = list.filter((t) => !t.end);
    if (!open.length) return null;
    // Continue the newest trip. Close older ones that never received an end time.
    const newest = open[0];
    for (const old of open.slice(1)) {
      old.end = old.samples && old.samples.length ? old.samples[old.samples.length - 1].t : old.start;
      old.summary = TripMath.summarize(old.samples || [], old.thresholds || thresholds());
      old.summary.durationMs = old.end - old.start;
      DB.saveTrip(old).catch(() => {});
    }
    trip = newest;
    if (!Array.isArray(trip.samples)) trip.samples = [];
    if (trip.samples.length) {
      trip.summary = TripMath.summarize(trip.samples, thresholds());
      trip.summary.durationMs = Date.now() - trip.start;
    }
    Sensors.onSample(onSample);
    timer = setInterval(tick, SAMPLE_MS);
    keepAwake();
    return trip;
  }

  function toJSON(t) {
    return { format: "telematics-trip-v1", trip: strip(t) };
  }

  function toCSV(t) {
    const header = "time_iso,elapsed_s,lat,lon,accuracy_m,alt_m,speed_mps,heading_deg,ax,ay,az,long_accel_mps2,yaw_dps,g";
    const cell = (x) => (x == null || x === "" ? "" : String(x));
    const lines = [header];
    for (const s of t.samples || []) {
      const iso = new Date(s.t).toISOString();
      const el = ((s.t - t.start) / 1000).toFixed(3);
      lines.push([iso, el, cell(s.lat), cell(s.lon), cell(s.accuracy), cell(s.alt), cell(s.speed), cell(s.heading), cell(s.ax), cell(s.ay), cell(s.az), cell(s.longAccel), cell(s.yaw), cell(s.g)].join(","));
    }
    return lines.join("\n") + "\n";
  }

  window.Trip = {
    start, stop, resume, toJSON, toCSV, thresholds,
    get active() { return trip; },
    get last() { return trip || lastTrip; },
    get wakeLockActive() { return !!wakeLock && !wakeLock.released; },
  };
})();
