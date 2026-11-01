/*
  util.js — small helpers used everywhere.
  - Ring: a "rolling" list of readings that forgets the oldest ones.
  - stats(): min / max / mean of one axis over a time window.
  - fmt(): turn numbers into short, readable text.
  This file also works in Node.js (used by the tests), see the bottom.
*/
(function (root) {
  "use strict";

  // A rolling buffer of { t: time in ms, v: [values...] } readings.
  // It keeps at most `max` readings; older ones are dropped.
  class Ring {
    constructor(max) { this.max = max; this.t = []; this.v = []; }
    push(t, v) {
      this.t.push(t); this.v.push(v);
      // Drop old readings in batches (faster than one at a time).
      if (this.t.length > this.max * 1.25) {
        const extra = this.t.length - this.max;
        this.t.splice(0, extra); this.v.splice(0, extra);
      }
    }
    get length() { return this.t.length; }
    // Index of the first reading at or after time `since` (binary search).
    indexFrom(since) {
      let lo = 0, hi = this.t.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.t[mid] < since) lo = mid + 1; else hi = mid; }
      return lo;
    }
    clear() { this.t = []; this.v = []; }
  }

  const isNum = (x) => typeof x === "number" && isFinite(x);

  // Statistics for axis number `axis` between time `from` and `to` (ms).
  function stats(ring, axis, from, to) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0, last = null;
    const start = ring.indexFrom(from);
    for (let i = start; i < ring.t.length; i++) {
      if (to != null && ring.t[i] > to) break;
      const x = ring.v[i][axis];
      if (!isNum(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
      sum += x; n++; last = x;
    }
    return n ? { min, max, mean: sum / n, n, last } : { min: null, max: null, mean: null, n: 0, last: null };
  }

  // Readings per second, measured from timestamps in the last `windowMs`.
  function rate(ring, now, windowMs) {
    const i = ring.indexFrom(now - windowMs);
    const n = ring.t.length - i;
    if (n < 2) return n ? 0 : 0;
    const span = ring.t[ring.t.length - 1] - ring.t[i];
    return span > 0 ? ((n - 1) * 1000) / span : 0;
  }

  // Format a number with a fixed number of decimals; "—" if missing.
  function fmt(x, digits) {
    if (!isNum(x)) return "—";
    const d = digits == null ? (Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 10 ? 2 : 3) : digits;
    return x.toFixed(d);
  }

  // "12:03:04.123" style clock time for timestamps.
  function clock(t) {
    if (!isNum(t)) return "—";
    const d = new Date(t);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  // "1:05" or "1:02:03" for durations in ms.
  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  }

  function bytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  // Compass words for a heading in degrees (0 = north).
  function compassWord(deg) {
    if (!isNum(deg)) return "—";
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  // Escape text before putting it inside HTML (prevents broken layouts).
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const Util = { Ring, stats, rate, fmt, clock, duration, bytes, compassWord, esc, isNum };
  if (typeof module !== "undefined" && module.exports) module.exports = Util; // Node (tests)
  else root.Util = Util;                                                       // browser
})(typeof window !== "undefined" ? window : globalThis);
