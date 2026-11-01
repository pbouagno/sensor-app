/*
  recorder.js — records every raw reading from every sensor into IndexedDB,
  and turns a saved session into CSV or JSON files.

  While recording, readings collect in a small in-memory list that is saved
  ("flushed") to the database every 2 seconds. Each saved row looks like
  [streamId, timeMs, value1, value2, ...].
*/
(function () {
  "use strict";
  const FLUSH_MS = 2000;
  let session = null, pending = [], flushTimer = null, lastKept = {}, wakeLock = null;

  const settings = () => window.AppSettings || {};

  function onSample(id, t, values) {
    if (!session) return;
    // Optional rate limit (Settings → recording rate). 0 = keep everything.
    const hz = settings().recordHz || 0;
    if (hz > 0) {
      if (lastKept[id] && t - lastKept[id] < 1000 / hz - 1) return;
      lastKept[id] = t;
    }
    pending.push([id, t, ...values]);
    session.counts[id] = (session.counts[id] || 0) + 1;
    session.samples++;
  }

  async function flush() {
    if (!session || !pending.length) return;
    const rows = pending; pending = [];
    session.bytes += JSON.stringify(rows).length;
    session.lastSaved = Date.now();
    await DB.addChunk(session.id, rows);
    await DB.saveSession(session);
  }

  // Keep the screen on while recording (where the browser supports it).
  async function keepAwake() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => { if (session && document.visibilityState === "visible") keepAwake(); });

  async function start(name) {
    if (session) return session;
    const streams = {};
    for (const d of Sensors.DEFS) streams[d.id] = { name: d.name, axes: d.axes, units: d.units, api: d.api };
    session = {
      id: "s" + Date.now(), name: name || "", start: Date.now(), end: null,
      counts: {}, samples: 0, bytes: 0, streams, device: Sensors.deviceInfo(),
      recordHz: settings().recordHz || 0,
    };
    pending = []; lastKept = {};
    Sensors.onSample(onSample);
    await DB.saveSession(session);
    flushTimer = setInterval(() => flush().catch(console.warn), FLUSH_MS);
    keepAwake();
    return session;
  }

  async function stop() {
    if (!session) return null;
    Sensors.offSample(onSample);
    clearInterval(flushTimer);
    session.end = Date.now();
    await flush();
    await DB.saveSession(session);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    const done = session; session = null;
    return done;
  }

  // ---------- Export ----------
  // JSON: { session, streams: { id: { axes, units, samples: [[t, v...], ...] } } }
  async function toJSON(id) {
    const s = await DB.getSession(id);
    const rows = await DB.getRows(id);
    const streams = {};
    for (const r of rows) {
      const sid = r[0];
      if (!streams[sid]) streams[sid] = { ...(s.streams[sid] || {}), samples: [] };
      streams[sid].samples.push(r.slice(1));
    }
    return { format: "telematics-session-v1", session: s, streams };
  }

  // CSV in "long" (tidy) format: one row per value. Easy to filter and
  // pivot in Excel / Google Sheets:  time_iso, elapsed_s, sensor, field, value, unit
  async function toCSV(id) {
    const s = await DB.getSession(id);
    const rows = await DB.getRows(id);
    const out = ["time_iso,elapsed_s,sensor,field,value,unit"];
    const q = (x) => (/[",\n]/.test(x) ? '"' + String(x).replace(/"/g, '""') + '"' : x);
    for (const r of rows) {
      const meta = s.streams[r[0]] || { axes: [], units: [] };
      const t = r[1], iso = new Date(t).toISOString(), el = ((t - s.start) / 1000).toFixed(3);
      for (let i = 2; i < r.length; i++) {
        if (r[i] == null) continue;
        out.push([iso, el, r[0], q(meta.axes[i - 2] || "v" + (i - 2)), r[i], q(meta.units[i - 2] || "")].join(","));
      }
    }
    return out.join("\n") + "\n";
  }

  // Save text as a file. On iPhone this opens the share/save sheet.
  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  window.Recorder = {
    start, stop, toJSON, toCSV, download,
    get session() { return session; },
    get pendingCount() { return pending.length; },
    get wakeLockActive() { return !!wakeLock && !wakeLock.released; },
  };
})();
