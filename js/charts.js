/*
  charts.js — every picture in the app, drawn by hand on <canvas>
  (no chart library). A chart with two or more series draws them solid,
  in the CSS variables --axis-x, --axis-y and --axis-z. A single series
  stays white. Compass, attitude, trace, waveform and gauge stay white too.

  Charts.lines(canvas, stream, opts)   rolling multi-axis line chart
  Charts.compass(canvas, heading)      compass dial
  Charts.attitude(canvas, a, b, g)     3D wireframe phone showing tilt
  Charts.trace(canvas, ring)           GPS position trace (no map)
  Charts.wave(canvas, samples, db)     microphone waveform + level
  Charts.gauge(canvas, frac, text, label)  half-circle gauge
*/
(function () {
  "use strict";
  const INK = "240,240,250"; // #F0F0FA as r,g,b
  const ink = (a) => `rgba(${INK},${a})`;
  const WHITE = "#F0F0FA";
  const MONO = '"Roboto Mono", ui-monospace, monospace';
  const AXIS_VARS = ["--axis-x", "--axis-y", "--axis-z"];
  // Read once. The stylesheet is already applied by the time a chart draws.
  let axisPalette = null;
  function seriesColor(index, multi) {
    if (!multi || index > 2) return WHITE;
    if (!axisPalette) {
      const cs = getComputedStyle(document.documentElement);
      axisPalette = AXIS_VARS.map((name) => cs.getPropertyValue(name).trim() || WHITE);
    }
    return axisPalette[index] || WHITE;
  }

  // Make the canvas sharp on high-DPI screens; returns a ready context.
  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // A "nice" number for axis labels (1, 2, 5, 10, 20 ...).
  function nice(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  // Rolling line chart of a stream's recent readings.
  // opts: { windowMs, now, axes: [indexes], small: bool }
  function lines(canvas, stream, opts) {
    const c = setup(canvas); if (!c) return;
    const { ctx, w, h } = c;
    const small = !!opts.small;
    const axes = opts.axes || stream.def.chart;
    const now = opts.now || Date.now();
    const from = now - opts.windowMs;
    const ring = stream.ring;
    const start = Math.max(0, ring.indexFrom(from) - 1);
    const padL = small ? 4 : 44, padR = 6, padT = 6, padB = small ? 4 : 18;
    const pw = w - padL - padR, ph = h - padT - padB;

    // Find the value range of the visible data.
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < ring.t.length; i++) {
      for (const a of axes) { const v = ring.v[i][a]; if (typeof v === "number" && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    }
    if (lo === Infinity) { lo = -1; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
    const X = (t) => padL + ((t - from) / opts.windowMs) * pw;
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ph;

    // Grid lines and labels.
    ctx.lineWidth = 1; ctx.strokeStyle = ink(0.1); ctx.fillStyle = ink(0.5);
    ctx.font = `10px ${MONO}`; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    const step = nice((hi - lo) / (small ? 2 : 4));
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      if (!small) ctx.fillText(Math.abs(v) < step / 1e6 ? "0" : +v.toPrecision(4) + "", padL - 6, y);
    }
    if (!small) {
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`-${Math.round(opts.windowMs / 1000)}s`, padL, h - 4);
      ctx.textAlign = "right"; ctx.fillText("now", w - padR, h - 4);
    }

    // One solid line per axis. Color follows the axis slot, not how many are visible.
    const multi = (stream.def.chart || axes).length > 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT - 2, pw, ph + 4); ctx.clip();
    axes.forEach((a, k) => {
      const slot = opts.styleIdx ? opts.styleIdx[k] : k;
      ctx.setLineDash([]); ctx.lineWidth = 1.6; ctx.strokeStyle = seriesColor(slot, multi);
      ctx.lineJoin = "round"; ctx.beginPath();
      let pen = false, prev = null;
      // Angles like compass heading jump from 359° to 0°: don't draw that jump.
      const wraps = (stream.def.wrap || []).includes(a);
      for (let i = start; i < ring.t.length; i++) {
        const v = ring.v[i][a];
        if (typeof v !== "number" || !isFinite(v)) { pen = false; continue; }
        if (wraps && prev != null && Math.abs(v - prev) > 180) pen = false;
        prev = v;
        const x = X(ring.t[i]), y = Y(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    });
    ctx.restore();
    ctx.setLineDash([]);
  }

  // Small legend swatch. `multi` is false for a one-series chart, which stays white.
  function swatch(k, multi) {
    const color = seriesColor(k, multi !== false);
    return `<svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke="${color}" stroke-width="1.6"/></svg>`;
  }

  // Compass dial: the card rotates so the top always shows where you face.
  function compass(canvas, heading) {
    const c = setup(canvas); if (!c) return;
    const { ctx, w, h } = c;
    const r = Math.min(w, h) / 2 - 6, cx = w / 2, cy = h / 2;
    ctx.strokeStyle = ink(0.35); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const has = typeof heading === "number" && isFinite(heading);
    const rot = has ? (-heading * Math.PI) / 180 : 0;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    for (let d = 0; d < 360; d += 10) {
      const major = d % 90 === 0, mid = d % 30 === 0;
      const len = major ? r * 0.16 : mid ? r * 0.1 : r * 0.05;
      const a = (d * Math.PI) / 180;
      ctx.strokeStyle = ink(major ? 1 : mid ? 0.6 : 0.3); ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.sin(a) * r, -Math.cos(a) * r);
      ctx.lineTo(Math.sin(a) * (r - len), -Math.cos(a) * (r - len));
      ctx.stroke();
    }
    ctx.fillStyle = ink(0.9); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.max(10, r * 0.16)}px Barlow, Arial, sans-serif`;
    [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([l, d]) => {
      const a = (d * Math.PI) / 180, rr = r * 0.68;
      ctx.save(); ctx.translate(Math.sin(a) * rr, -Math.cos(a) * rr); ctx.rotate(a); ctx.fillText(l, 0, 0); ctx.restore();
    });
    ctx.restore();
    // Fixed pointer at the top (where the phone's top edge points).
    ctx.fillStyle = ink(1);
    ctx.beginPath(); ctx.moveTo(cx, cy - r - 2); ctx.lineTo(cx - 6, cy - r + 10); ctx.lineTo(cx + 6, cy - r + 10); ctx.closePath(); ctx.fill();
    ctx.font = `${Math.max(12, r * 0.22)}px ${MONO}`; ctx.fillStyle = ink(has ? 1 : 0.35);
    ctx.fillText(has ? Math.round(heading) + "°" : "—", cx, cy);
  }

  // 3D-ish attitude indicator: a wireframe phone rotated like your phone.
  // Uses the W3C order: rotate alpha about Z, then beta about X, then gamma about Y.
  function attitude(canvas, alpha, beta, gamma) {
    const c = setup(canvas); if (!c) return;
    const { ctx, w, h } = c;
    const rad = Math.PI / 180;
    const A = (alpha || 0) * rad, B = (beta || 0) * rad, G = (gamma || 0) * rad;
    const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B), cG = Math.cos(G), sG = Math.sin(G);
    // Rotation matrix R = Rz(A)·Rx(B)·Ry(G)
    const R = [
      [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
      [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
      [-cB * sG, sB, cB * cG],
    ];
    const tilt = -55 * rad; // we look at the "table" from above and in front
    const s = Math.min(w, h) * 0.3;
    const project = ([x, y, z]) => {
      const wx = R[0][0] * x + R[0][1] * y + R[0][2] * z;
      const wy = R[1][0] * x + R[1][1] * y + R[1][2] * z;
      const wz = R[2][0] * x + R[2][1] * y + R[2][2] * z;
      const vy = wy * Math.cos(tilt) - wz * Math.sin(tilt);
      const vz = wy * Math.sin(tilt) + wz * Math.cos(tilt);
      const k = 4 / (4 - vz); // simple perspective
      return [w / 2 + wx * s * k, h / 2 - vy * s * k, vz];
    };
    // Ground ellipse (the "table") + north tick.
    ctx.strokeStyle = ink(0.15); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const gx = Math.cos(a) * 1.5, gy = Math.sin(a) * 1.5;
      const vy = gy * Math.cos(tilt), x = w / 2 + gx * s, y = h / 2 - vy * s;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = ink(0.35); ctx.font = `10px ${MONO}`; ctx.textAlign = "center";
    ctx.fillText("N", w / 2, h / 2 - 1.5 * Math.cos(tilt) * s - 6);
    // Phone box corners (width 0.7, height 1.4, depth 0.08).
    const X = 0.36, Y = 0.72, Z = 0.05;
    const P = [[-X, -Y, Z], [X, -Y, Z], [X, Y, Z], [-X, Y, Z], [-X, -Y, -Z], [X, -Y, -Z], [X, Y, -Z], [-X, Y, -Z]].map(project);
    const faceUp = R[2][2] > 0; // is the screen facing the sky?
    // Screen face (filled) — drawn on top if it faces us.
    const face = (idx, fill, stroke) => {
      ctx.beginPath(); idx.forEach((i, k) => (k ? ctx.lineTo(P[i][0], P[i][1]) : ctx.moveTo(P[i][0], P[i][1]))); ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      ctx.strokeStyle = stroke; ctx.stroke();
    };
    ctx.lineWidth = 1.4;
    const back = [4, 5, 6, 7], front = [0, 1, 2, 3];
    face(faceUp ? back : front, faceUp ? null : ink(0.1), ink(0.35));
    [[0, 4], [1, 5], [2, 6], [3, 7]].forEach(([a, b]) => { ctx.strokeStyle = ink(0.5); ctx.beginPath(); ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); ctx.stroke(); });
    face(faceUp ? front : back, faceUp ? ink(0.12) : null, ink(0.9));
    // Top-edge marker (speaker slot) so you can tell which end is up.
    const t1 = project([-0.12, 0.6, Z]), t2 = project([0.12, 0.6, Z]);
    ctx.strokeStyle = ink(faceUp ? 1 : 0.35); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(t1[0], t1[1]); ctx.lineTo(t2[0], t2[1]); ctx.stroke();
  }

  // GPS trace without a map: positions projected to meters, newest bright.
  function trace(canvas, ring) {
    const c = setup(canvas); if (!c) return;
    const { ctx, w, h } = c;
    const n = ring.t.length;
    ctx.strokeStyle = ink(0.1); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!n) return;
    const last = ring.v[n - 1];
    const lat0 = last[0], lon0 = last[1];
    const mPerLat = 111320, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const pts = [];
    let maxD = Math.max(10, (last[2] || 5) * 1.2);
    for (let i = 0; i < n; i++) {
      const v = ring.v[i];
      const x = (v[1] - lon0) * mPerLon, y = (v[0] - lat0) * mPerLat;
      pts.push([x, y]);
      maxD = Math.max(maxD, Math.abs(x), Math.abs(y));
    }
    const scale = (Math.min(w, h) / 2 - 10) / maxD;
    const P = ([x, y]) => [w / 2 + x * scale, h / 2 - y * scale];
    // Accuracy circle around the latest fix.
    ctx.strokeStyle = ink(0.35); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(w / 2, h / 2, Math.max(3, (last[2] || 0) * scale), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.6; ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const a = P(pts[i - 1]), b = P(pts[i]);
      ctx.strokeStyle = ink(0.15 + 0.85 * (i / pts.length));
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.fillStyle = ink(1); ctx.beginPath(); ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2); ctx.fill();
    // Scale bar.
    const bar = nice(maxD / 2);
    ctx.strokeStyle = ink(0.5); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8, h - 10); ctx.lineTo(8 + bar * scale, h - 10); ctx.stroke();
    ctx.fillStyle = ink(0.5); ctx.font = `10px ${MONO}`; ctx.textAlign = "left";
    ctx.fillText(bar >= 1000 ? bar / 1000 + " km" : bar + " m", 8, h - 14);
  }

  // Microphone: waveform plus a level bar (-100 to 0 dBFS).
  function wave(canvas, samples, db) {
    const c = setup(canvas); if (!c) return;
    const { ctx, w, h } = c;
    const barH = 8, mid = (h - barH - 8) / 2;
    ctx.strokeStyle = ink(0.1); ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    if (samples && samples.length) {
      ctx.strokeStyle = ink(0.9); ctx.lineWidth = 1.2; ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const x = (i / (samples.length - 1)) * w, y = mid - Math.max(-1, Math.min(1, samples[i] * 4)) * (mid - 2);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    const frac = typeof db === "number" ? Math.max(0, Math.min(1, (db + 100) / 100)) : 0;
    ctx.fillStyle = ink(0.15); ctx.fillRect(0, h - barH, w, barH);
    ctx.fillStyle = ink(0.9); ctx.fillRect(0, h - barH, w * frac, barH);
  }

  // Half-circle gauge. frac = 0..1 (or null for "no data").
  function gauge(canvas, frac, text, label) {
    const c = setup(canvas); if (!c) return;
    const { ctx, w, h } = c;
    const r = Math.min(w / 2, h * 0.85) - 8, cx = w / 2, cy = h * 0.82;
    ctx.lineCap = "butt"; ctx.lineWidth = 8;
    ctx.strokeStyle = ink(0.15); ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 2 * Math.PI); ctx.stroke();
    if (typeof frac === "number" && isFinite(frac)) {
      ctx.strokeStyle = ink(0.9);
      ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * Math.max(0, Math.min(1, frac))); ctx.stroke();
    }
    ctx.fillStyle = ink(1); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = `${Math.max(14, r * 0.34)}px ${MONO}`; ctx.fillText(text, cx, cy - 4);
    if (label) { ctx.fillStyle = ink(0.5); ctx.font = `10px ${MONO}`; ctx.fillText(label, cx, cy + 14); }
  }

  window.Charts = { lines, swatch, compass, attitude, trace, wave, gauge, seriesColor };
})();
