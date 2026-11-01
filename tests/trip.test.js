/*
  Unit tests for trip summary math. No browser, no libraries.
  Run: node tests/trip.test.js
*/
"use strict";
const assert = require("assert");
const T = require("../js/trip-math.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok  " + name);
}
function close(a, b, eps, note) {
  assert.ok(Math.abs(a - b) <= eps, (note || "") + " expected " + b + " ± " + eps + ", got " + a);
}

check("haversine is zero at one point and symmetric", () => {
  close(T.haversine(37.5, -122.2, 37.5, -122.2), 0, 1e-6);
  const ab = T.haversine(10, 20, -5, 40);
  const ba = T.haversine(-5, 40, 10, 20);
  close(ab, ba, 1e-6);
});

check("one degree along the equator is the Earth radius arc", () => {
  const expected = T.EARTH_R * Math.PI / 180;
  close(T.haversine(0, 0, 0, 1), expected, 0.01);
  close(T.haversine(0, 0, 1, 0), expected, 0.01);
});

check("path distance sums steps and drops a GPS glitch", () => {
  // 0.0002° of longitude at the equator is ~22 m, about 80 km/h per second.
  const step = T.haversine(0, 0, 0, 0.0002);
  const samples = [];
  for (let i = 0; i <= 10; i++) samples.push({ t: i * 1000, lat: 0, lon: i * 0.0002 });
  close(T.pathDistance(samples), step * 10, 0.05);
  // A one-second jump of a whole degree is ~111 km and must not count.
  // The following real step is measured from the last good point.
  const glitch = [
    { t: 0, lat: 0, lon: 0 },
    { t: 1000, lat: 0, lon: 1 },
    { t: 2000, lat: 0, lon: 0.0002 },
  ];
  close(T.pathDistance(glitch), step, 0.05);
});

check("heading delta wraps across north", () => {
  close(T.headingDelta(350, 10), 20, 1e-9);
  close(T.headingDelta(10, 350), -20, 1e-9);
  close(T.headingDelta(10, 10), 0, 1e-9);
});

check("speed change past 0.3 g is one hard brake or one hard acceleration", () => {
  const limit = 0.3 * T.G;
  assert.ok(limit > 2.9 && limit < 3);
  const brake = T.summarize([
    { t: 0, speed: 20 },
    { t: 1000, speed: 16 }, // -4 m/s², past 0.3 g
  ]);
  assert.strictEqual(brake.hardBrakes, 1);
  assert.strictEqual(brake.hardAccels, 0);
  const accel = T.summarize([
    { t: 0, speed: 0 },
    { t: 1000, speed: 4 },
  ]);
  assert.strictEqual(accel.hardAccels, 1);
  assert.strictEqual(accel.hardBrakes, 0);
  const gentle = T.summarize([
    { t: 0, speed: 10 },
    { t: 1000, speed: 12 }, // +2 m/s², under 0.3 g
  ]);
  assert.strictEqual(gentle.hardAccels, 0);
  assert.strictEqual(gentle.hardBrakes, 0);
});

check("a harsh stretch is one event, and a calm sample starts a new one", () => {
  const held = T.summarize([
    { t: 0, speed: 20 },
    { t: 1000, speed: 15 },
    { t: 2000, speed: 10 },
  ]);
  assert.strictEqual(held.hardBrakes, 1);
  const split = T.summarize([
    { t: 0, speed: 20 },
    { t: 1000, speed: 15 },
    { t: 2000, speed: 15 },
    { t: 3000, speed: 10 },
  ]);
  assert.strictEqual(split.hardBrakes, 2);
});

check("phone Y axis counts when GPS speed is missing", () => {
  const s = T.summarize([
    { t: 0, ay: 0 },
    { t: 1000, ay: -4 },
  ]);
  assert.strictEqual(s.hardBrakes, 1);
  const named = T.summarize([{ t: 0, longAccel: -4 }, { t: 1000, longAccel: -4 }]);
  assert.strictEqual(named.hardBrakes, 1);
});

check("sharp turns use heading change, including the wrap, or a yaw rate", () => {
  const sharp = T.summarize([
    { t: 0, heading: 0 },
    { t: 1000, heading: 80 },
    { t: 2000, heading: 90 },
  ]);
  assert.strictEqual(sharp.sharpTurns, 1);
  const wrapped = T.summarize([
    { t: 0, heading: 350 },
    { t: 1000, heading: 10 }, // +20 °/s, under the 45 °/s line
  ]);
  assert.strictEqual(wrapped.sharpTurns, 0);
  const yaw = T.summarize([
    { t: 0, yaw: 60 },
    { t: 1000, yaw: 60 },
    { t: 2000, yaw: 10 },
    { t: 3000, yaw: -70 },
  ]);
  assert.strictEqual(yaw.sharpTurns, 2);
  // A quiet gyro must not hide a real change in heading.
  const headingWins = T.summarize([
    { t: 0, heading: 0, yaw: 1 },
    { t: 1000, heading: 80, yaw: 1 },
  ]);
  assert.strictEqual(headingWins.sharpTurns, 1);
});

check("elevation gain ignores noise and counts the next climb", () => {
  const samples = [
    { t: 0, alt: 100 },
    { t: 1000, alt: 103 },
    { t: 2000, alt: 90 },
    { t: 3000, alt: 95 },
  ];
  close(T.elevationGain(samples, 1), 8, 1e-9);
  close(T.summarize(samples).elevationGainM, 8, 1e-9);
});

check("summary reports distance, average and max speed", () => {
  const s = T.summarize([
    { t: 0, lat: 0, lon: 0, speed: 10, alt: 5 },
    { t: 10000, lat: 0, lon: 0.001, speed: 12, alt: 8 },
  ]);
  close(s.distanceM, T.haversine(0, 0, 0, 0.001), 0.05);
  close(s.durationMs, 10000, 0);
  close(s.maxSpeed, 12, 1e-9);
  close(s.avgSpeed, s.distanceM / 10, 1e-6);
  close(s.currentSpeed, 12, 1e-9);
  close(s.elevationGainM, 3, 1e-9);
});

check("a derived speed fills in when the GPS speed field is empty", () => {
  const s = T.summarize([
    { t: 0, lat: 0, lon: 0 },
    { t: 10000, lat: 0, lon: 0.001 },
  ]);
  close(s.currentSpeed, s.distanceM / 10, 1e-6);
  assert.ok(s.maxSpeed > 0);
});

check("smooth trip scores 100 and says nothing lowered it", () => {
  const s = T.summarize([
    { t: 0, speed: 10, heading: 0, g: 0.1 },
    { t: 1000, speed: 10.5, heading: 5, g: 0.1 },
  ]);
  assert.strictEqual(s.score, 100);
  assert.strictEqual(s.explanation, "Smooth trip. Nothing in this recording lowered the score.");
});

check("score names every cause and stays inside 0..100", () => {
  const one = T.scoreFrom({ hardBrakes: 1, hardAccels: 0, sharpTurns: 0, maxG: 0.4 });
  assert.strictEqual(one.score, 92);
  assert.strictEqual(one.explanation, "Lowered by 1 hard brake.");
  const mixed = T.scoreFrom({ hardBrakes: 2, hardAccels: 1, sharpTurns: 1, maxG: 0.8 });
  // 16 + 6 + 4 + (0.8-0.6)*30 = 32, 100-32 = 68
  assert.strictEqual(mixed.score, 68);
  assert.strictEqual(mixed.explanation, "Lowered by 2 hard brakes, 1 hard acceleration, 1 sharp turn, and a peak of 0.80 g.");
  const wiped = T.scoreFrom({ hardBrakes: 20, hardAccels: 20, sharpTurns: 20, maxG: 3 });
  assert.strictEqual(wiped.score, 0);
  const peakOnly = T.scoreFrom({ hardBrakes: 0, hardAccels: 0, sharpTurns: 0, maxG: 0.8 });
  assert.strictEqual(peakOnly.score, 94);
  assert.strictEqual(peakOnly.explanation, "Lowered by a peak of 0.80 g.");
});

check("a 0.3 g brake is not also charged the peak-g penalty", () => {
  const s = T.summarize([
    { t: 0, speed: 20, ay: 0 },
    { t: 1000, speed: 16, ay: -4 }, // 0.41 g, under the 0.6 g peak line
  ]);
  assert.strictEqual(s.hardBrakes, 1);
  close(s.maxG, 4 / T.G, 0.02);
  assert.ok(s.maxG < 0.6);
  assert.strictEqual(s.score, 92);
  assert.strictEqual(s.explanation, "Lowered by 1 hard brake.");
});

check("thresholds are configurable", () => {
  const samples = [
    { t: 0, speed: 10 },
    { t: 1000, speed: 14 }, // +4 m/s² ≈ 0.41 g
  ];
  assert.strictEqual(T.summarize(samples, { harshG: 0.3 }).hardAccels, 1);
  assert.strictEqual(T.summarize(samples, { harshG: 0.5 }).hardAccels, 0);
  const turn = [{ t: 0, heading: 0 }, { t: 1000, heading: 30 }];
  assert.strictEqual(T.summarize(turn, { turnDegPerS: 45 }).sharpTurns, 0);
  assert.strictEqual(T.summarize(turn, { turnDegPerS: 20 }).sharpTurns, 1);
});

check("unit conversion", () => {
  close(T.speedTo(10, "kmh"), 36, 1e-9);
  close(T.speedTo(10, "mph"), 22.369362920544, 1e-9);
  assert.strictEqual(T.formatSpeed(10, "kmh"), "36.0");
  assert.strictEqual(T.formatSpeed(null, "mph"), "—");
  assert.strictEqual(T.formatDistance(500, "kmh"), "500 m");
  assert.strictEqual(T.formatDistance(2500, "kmh"), "2.50 km");
  assert.strictEqual(T.formatDistance(1609.344, "mph"), "1.00 mi");
  assert.strictEqual(T.formatClimb(10, "mph"), "33 ft");
});

check("no samples is an empty summary, not a perfect score", () => {
  const s = T.summarize([]);
  assert.strictEqual(s.score, null);
  assert.strictEqual(s.distanceM, 0);
  assert.strictEqual(s.explanation, "No samples were recorded.");
});

console.log("\n" + passed + " passed");
