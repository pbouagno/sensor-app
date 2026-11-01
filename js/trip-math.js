/*
  trip-math.js — the numbers behind a trip.

  Pure functions (no browser APIs) so the unit tests can run them in Node.
  Speeds are meters per second, distances meters, acceleration m/s²,
  headings and turn rates degrees. The screen converts to mph or km/h.

  A "sample" is one moment:
    t          time in ms
    lat, lon   degrees (optional)
    alt        meters (optional)
    speed      m/s (optional; filled in from GPS movement when missing)
    heading    degrees, 0 = north (optional)
    ay         device linear acceleration along the top of the phone, m/s²
    ax, az     the other two linear axes, m/s²
    longAccel  longitudinal accel already measured for this moment, m/s²
               (positive = speeding up). Preferred over speed and ay.
    yaw        turn rate already measured, degrees per second
    g          peak g already measured for this moment
*/
(function (root) {
  "use strict";

  const G = 9.80665;          // standard gravity, m/s²
  const EARTH_R = 6371000;    // mean Earth radius, meters
  const MAX_SPEED = 90;       // m/s (~200 mph). Faster GPS jumps are glitches.
  // A peak above this is an extra score penalty, on top of the harsh-event count,
  // so a bare 0.3 g brake is not charged twice.
  const G_PENALTY_START = 0.6;

  const DEFAULTS = { harshG: 0.3, turnDegPerS: 45, elevNoiseM: 1 };

  const isNum = (x) => typeof x === "number" && isFinite(x);

  // Great-circle distance between two WGS84 points, in meters.
  function haversine(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const p1 = lat1 * rad, p2 = lat2 * rad;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Shortest signed turn from `fromDeg` to `toDeg`, in -180..180.
  function headingDelta(fromDeg, toDeg) {
    let d = (toDeg - fromDeg) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // One GPS step. Null when a coordinate is missing, time didn't advance,
  // or the implied speed is a glitch.
  function segment(a, b) {
    if (!a || !b || !isNum(a.lat) || !isNum(a.lon) || !isNum(b.lat) || !isNum(b.lon)) return null;
    if (!isNum(a.t) || !isNum(b.t) || !(b.t > a.t)) return null;
    const meters = haversine(a.lat, a.lon, b.lat, b.lon);
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) return null;
    const speed = meters / dt;
    if (speed > MAX_SPEED) return null;
    return { meters, dt, speed };
  }

  function pathDistance(samples) {
    let total = 0, prev = null;
    for (const s of samples) {
      if (!isNum(s.lat) || !isNum(s.lon) || !isNum(s.t)) continue;
      if (!prev) { prev = s; continue; }
      const seg = segment(prev, s);
      if (seg) { total += seg.meters; prev = s; }
      // A rejected glitch does not move the anchor, so the next real point
      // is still measured from the last good one.
    }
    return total;
  }

  // Copy samples and fill a missing speed from the previous good GPS step.
  function withDerivedSpeed(samples) {
    const out = samples.map((s) => ({ ...s }));
    for (let i = 1; i < out.length; i++) {
      if (isNum(out[i].speed)) continue;
      const seg = segment(out[i - 1], out[i]);
      if (seg) out[i].speed = seg.speed;
    }
    return out;
  }

  // Positive = speeding up, negative = braking. m/s².
  // longAccel (measured between saved samples) wins, then the change in
  // speed, then the phone's "up the screen" axis for a dash-mounted phone.
  function longitudinalAccel(prev, curr) {
    if (!curr) return null;
    if (isNum(curr.longAccel)) return curr.longAccel;
    if (prev && prev !== curr && isNum(prev.speed) && isNum(curr.speed) && isNum(prev.t) && curr.t > prev.t) {
      return (curr.speed - prev.speed) / ((curr.t - prev.t) / 1000);
    }
    if (isNum(curr.ay)) return curr.ay;
    return null;
  }

  // Degrees per second. Uses whichever is larger: the measured yaw rate
  // (rotation about gravity) or the change in heading. Heading change wraps
  // across north, so 359° → 10° is a small turn, not a spin.
  function yawRate(prev, curr) {
    if (!curr) return null;
    let fromHeading = null;
    if (prev && prev !== curr && isNum(prev.heading) && isNum(curr.heading) && curr.t > prev.t) {
      fromHeading = headingDelta(prev.heading, curr.heading) / ((curr.t - prev.t) / 1000);
    }
    if (isNum(curr.yaw) && (fromHeading == null || Math.abs(curr.yaw) >= Math.abs(fromHeading))) return curr.yaw;
    return fromHeading;
  }

  // Peak acceleration in g, gravity not included.
  function gForce(sample) {
    if (!sample) return null;
    if (isNum(sample.g)) return sample.g;
    if (isNum(sample.ax) || isNum(sample.ay) || isNum(sample.az)) {
      return Math.hypot(sample.ax || 0, sample.ay || 0, sample.az || 0) / G;
    }
    return null;
  }

  // Climb only. A change smaller than `noiseM` is GPS noise and is ignored.
  // A real drop resets the baseline so the next climb counts again.
  function elevationGain(samples, noiseM) {
    const noise = isNum(noiseM) ? noiseM : DEFAULTS.elevNoiseM;
    let gain = 0, base = null;
    for (const s of samples) {
      if (!isNum(s.alt)) continue;
      if (base == null) { base = s.alt; continue; }
      const d = s.alt - base;
      if (d > noise) { gain += d; base = s.alt; }
      else if (d < -noise) base = s.alt;
    }
    return gain;
  }

  // One harsh moment starts an event. Further samples past the line keep
  // that same event; a sample back under the line ends it.
  function detectEvents(samples, opts) {
    const o = { ...DEFAULTS, ...opts };
    const limit = o.harshG * G;
    const turn = o.turnDegPerS;
    let hardBrakes = 0, hardAccels = 0, sharpTurns = 0, maxG = 0, inBrake = false, inAccel = false, inTurn = false;
    for (let i = 0; i < samples.length; i++) {
      const curr = samples[i], prev = i > 0 ? samples[i - 1] : null;
      const a = longitudinalAccel(prev, curr);
      if (a != null && a <= -limit) { if (!inBrake) hardBrakes++; inBrake = true; } else inBrake = false;
      if (a != null && a >= limit) { if (!inAccel) hardAccels++; inAccel = true; } else inAccel = false;
      const yaw = yawRate(prev, curr);
      if (yaw != null && Math.abs(yaw) >= turn) { if (!inTurn) sharpTurns++; inTurn = true; } else inTurn = false;
      // Peak g is the larger of the measured vector and this moment's longitudinal accel.
      const g = gForce(curr);
      const fromLong = a != null ? Math.abs(a) / G : null;
      const gNow = fromLong != null && (g == null || fromLong > g) ? fromLong : g;
      if (gNow != null && gNow > maxG) maxG = gNow;
    }
    return { hardBrakes, hardAccels, sharpTurns, maxG };
  }

  function joinList(bits) {
    if (bits.length === 1) return bits[0];
    if (bits.length === 2) return bits[0] + " and " + bits[1];
    return bits.slice(0, -1).join(", ") + ", and " + bits[bits.length - 1];
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  // 100, minus capped penalties. The caps stop one noisy sensor from
  // wiping the whole score.
  function scoreFrom(events) {
    const hardBrakes = events.hardBrakes || 0;
    const hardAccels = events.hardAccels || 0;
    const sharpTurns = events.sharpTurns || 0;
    const maxG = isNum(events.maxG) ? events.maxG : 0;
    const brakes = Math.min(40, hardBrakes * 8);
    const accels = Math.min(30, hardAccels * 6);
    const turns = Math.min(20, sharpTurns * 4);
    const gPenalty = maxG > G_PENALTY_START ? Math.min(15, (maxG - G_PENALTY_START) * 30) : 0;
    const score = Math.max(0, Math.min(100, Math.round(100 - brakes - accels - turns - gPenalty)));
    const bits = [];
    if (hardBrakes) bits.push(plural(hardBrakes, "hard brake"));
    if (hardAccels) bits.push(plural(hardAccels, "hard acceleration"));
    if (sharpTurns) bits.push(plural(sharpTurns, "sharp turn"));
    if (gPenalty > 0) bits.push("a peak of " + maxG.toFixed(2) + " g");
    const explanation = bits.length
      ? "Lowered by " + joinList(bits) + "."
      : "Smooth trip. Nothing in this recording lowered the score.";
    return { score, explanation, penalties: { brakes, accels, turns, g: gPenalty } };
  }

  function summarize(samples, opts) {
    const o = { ...DEFAULTS, ...opts };
    const list = (samples || []).filter((s) => s && isNum(s.t)).slice().sort((a, b) => a.t - b.t);
    const empty = {
      samples: 0, durationMs: 0, distanceM: 0, currentSpeed: null, maxSpeed: null, avgSpeed: null,
      elevationGainM: 0, hardBrakes: 0, hardAccels: 0, sharpTurns: 0, maxG: null,
      score: null, explanation: "No samples were recorded.",
      thresholds: { harshG: o.harshG, turnDegPerS: o.turnDegPerS },
    };
    if (!list.length) return empty;
    const derived = withDerivedSpeed(list);
    const durationMs = derived[derived.length - 1].t - derived[0].t;
    const distanceM = pathDistance(derived);
    const speeds = derived.map((s) => s.speed).filter(isNum);
    const events = detectEvents(derived, o);
    const scored = scoreFrom(events);
    return {
      samples: derived.length,
      durationMs,
      distanceM,
      currentSpeed: speeds.length ? derived[derived.length - 1].speed : null,
      maxSpeed: speeds.length ? Math.max(...speeds) : null,
      avgSpeed: durationMs > 0 ? distanceM / (durationMs / 1000) : null,
      elevationGainM: elevationGain(derived, o.elevNoiseM),
      hardBrakes: events.hardBrakes,
      hardAccels: events.hardAccels,
      sharpTurns: events.sharpTurns,
      maxG: events.maxG,
      score: scored.score,
      explanation: scored.explanation,
      thresholds: { harshG: o.harshG, turnDegPerS: o.turnDegPerS },
    };
  }

  function speedTo(mps, unit) {
    if (!isNum(mps)) return null;
    return unit === "mph" ? mps * 2.2369362920544 : mps * 3.6;
  }
  function speedLabel(unit) { return unit === "mph" ? "mph" : "km/h"; }

  function formatSpeed(mps, unit) {
    const v = speedTo(mps, unit);
    return v == null ? "—" : v.toFixed(1);
  }
  function formatDistance(meters, unit) {
    if (!isNum(meters)) return "—";
    if (unit === "mph") {
      const mi = meters / 1609.344;
      return mi < 0.1 ? Math.round(meters * 3.28084) + " ft" : mi.toFixed(2) + " mi";
    }
    return meters < 1000 ? Math.round(meters) + " m" : (meters / 1000).toFixed(2) + " km";
  }
  function formatClimb(meters, unit) {
    if (!isNum(meters)) return "—";
    return unit === "mph" ? Math.round(meters * 3.28084) + " ft" : Math.round(meters) + " m";
  }

  const TripMath = {
    G, EARTH_R, MAX_SPEED, DEFAULTS,
    haversine, headingDelta, segment, pathDistance, withDerivedSpeed,
    longitudinalAccel, yawRate, gForce, elevationGain, detectEvents, scoreFrom, summarize,
    speedTo, speedLabel, formatSpeed, formatDistance, formatClimb, isNum,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = TripMath;
  else root.TripMath = TripMath;
})(typeof window !== "undefined" ? window : globalThis);
