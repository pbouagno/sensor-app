/*
  app.js — draws the screens and keeps them updated.

  Screens (the part after # in the address):
    #/sensors        every sensor in one dashboard
    #/detail/<id>    one sensor: big chart, min/max/mean, pause, time window
    #/record         start / stop a recording
    #/sessions       saved recordings, export CSV / JSON, delete
    #/device         device info, vibration test, settings
*/
(function () {
  "use strict";
  const { esc, fmt, clock, duration, bytes, compassWord, stats, rate, isNum } = Util;
  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $("#app");

  // ---------- Settings (saved in localStorage) ----------
  const DEFAULTS = { recordHz: 0, windowS: 10, mic: false };
  let settings;
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("telematics.settings") || "{}") }; }
  catch (e) { settings = { ...DEFAULTS }; }
  window.AppSettings = settings;
  const saveSettings = () => localStorage.setItem("telematics.settings", JSON.stringify(settings));

  const STATUS_TEXT = { idle: "Off", waiting: "Waiting", live: "Live", unavailable: "Not available", denied: "Denied", error: "Error" };
  const OFF_STATES = ["unavailable", "denied", "error"];

  // ---------- Small toast message ----------
  let toastTimer;
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- Router ----------
  let view = null; // { name, draw(frame), text() }
  function route() {
    const parts = (location.hash || "#/sensors").slice(2).split("/");
    const name = parts[0] || "sensors";
    document.querySelectorAll(".tabbar a").forEach((a) => {
      const on = a.dataset.tab === (name === "detail" ? "sensors" : name);
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const views = { sensors: viewSensors, detail: () => viewDetail(parts[1]), record: viewRecord, sessions: viewSessions, device: viewDevice };
    view = (views[name] || viewSensors)();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => { app.classList.remove("quiet"); route(); });

  // ---------- Shared pieces ----------
  function startCard() {
    const on = Sensors.started;
    return `
      <section class="card start-card">
        ${window.isSecureContext ? "" : `<p class="warn">This page is not on HTTPS, so phones will block most sensors. Open the https:// address instead.</p>`}
        ${on ? `<p class="eyebrow">Sensors on</p><p class="muted small">Tap any tile for a bigger chart and statistics.</p>`
             : `<p class="eyebrow">Step 1</p><p class="small muted">Your phone asks permission for motion, location and (optionally) the microphone. Nothing leaves your phone.</p>`}
        <label class="check"><input type="checkbox" id="mic-opt" ${settings.mic || Sensors.micOn() ? "checked" : ""} /> <span>Include microphone (sound level)</span></label>
        <button class="btn ${on ? "" : "btn-primary"} btn-block" id="start-btn">${on ? "Re-check sensors" : "Start sensors"}</button>
      </section>`;
  }
  function bindStart() {
    const btn = $("#start-btn"), mic = $("#mic-opt");
    if (mic) mic.onchange = () => {
      settings.mic = mic.checked; saveSettings();
      if (!mic.checked && Sensors.micOn()) Sensors.stopMic();
      else if (mic.checked && Sensors.started) Sensors.startMic();
    };
    if (btn) btn.onclick = () => {
      // Everything inside startAll() runs right inside this tap (iPhone needs that).
      Sensors.startAll({ mic: mic && mic.checked }).then(() => { toast("Sensors started"); if (view && view.name === "sensors") route(); });
    };
  }

  function valueRows(s, cls) {
    const d = s.def;
    return d.axes.map((ax, i) => `
      <div class="val ${cls || ""}">
        <span class="ax">${d.chart.includes(i) && d.viz !== "gauge" ? Charts.swatch(d.chart.indexOf(i)) : ""}${esc(ax)}</span>
        <span class="v mono" data-ax="${i}">—</span>
        <span class="u">${esc(d.units[i] || "")}</span>
      </div>`).join("");
  }
  function fillValues(root, s) {
    const v = s.last ? s.last.v : [];
    root.querySelectorAll("[data-ax]").forEach((el) => {
      const i = +el.dataset.ax;
      let txt = fmt(v[i], s.def.digits[i]);
      if (s.def.id === "battery" && i === 1 && isNum(v[1])) txt = v[1] ? "yes" : "no";
      if (s.def.id === "network" && i === 2 && isNum(v[2])) txt = v[2] ? "online" : "offline";
      if (s.def.id === "visibility" && isNum(v[0])) txt = v[0] ? "visible" : "hidden";
      if (el.textContent !== txt) el.textContent = txt;
    });
  }
  // One extra line of plain-English context per sensor.
  function extraLine(s) {
    const v = s.last ? s.last.v : [], info = s.info;
    switch (s.def.id) {
      case "accelG": {
        if (!isNum(v[2])) return "";
        const g = Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) / 9.80665;
        return `|a| = ${g.toFixed(2)} g${isNum(info.interval) ? ` · interval ${info.interval.toFixed(1)} ms` : ""}`;
      }
      case "accel": return isNum(v[0]) ? `|a| = ${(Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) / 9.80665).toFixed(3)} g` : "";
      case "orient": {
        if (!isNum(v[1])) return "";
        const b = v[1], g = v[2] || 0;
        const pose = Math.abs(b) < 25 && Math.abs(g) < 25 ? "flat, screen up" : Math.abs(b) > 155 ? "flat, screen down"
          : Math.abs(g) > 60 ? "on its side (landscape)" : b > 45 ? "upright (portrait)" : "tilted";
        return `Phone is ${pose}${info.absolute ? " · absolute" : ""}`;
      }
      case "compass": return isNum(v[0]) ? `Facing ${compassWord(v[0])}${info.source ? " · " + info.source : ""}` : "";
      case "geo": return isNum(v[5]) ? `Speed ${(v[5] * 3.6).toFixed(1)} km/h · ${(v[5] * 2.23694).toFixed(1)} mph` : (s.last ? "Speed not reported (stand still or move faster)" : "");
      case "mic": return isNum(v[0]) ? (v[0] > -20 ? "Loud" : v[0] > -40 ? "Moderate" : v[0] > -60 ? "Quiet" : "Very quiet") + (info.sampleRate ? ` · ${info.sampleRate} Hz audio` : "") : "";
      case "battery": return info.charging ? (isFinite(info.chargingTime) && info.chargingTime > 0 ? `Charging · full in ${duration(info.chargingTime * 1000)}` : "Charging")
        : (isFinite(info.dischargingTime) && info.dischargingTime > 0 ? `${duration(info.dischargingTime * 1000)} left` : "On battery");
      case "network": return info.effectiveType ? `Type ${info.effectiveType}${info.type ? " · " + info.type : ""}${info.saveData ? " · data saver" : ""}` : "";
      case "screen": return info.type ? `${info.type} · screen ${info.screen}${info.standalone ? " · installed" : ""}` : "";
      case "visibility": return `Changes: ${info.changes || 0}`;
      case "light": return isNum(v[0]) ? (v[0] < 10 ? "Dark" : v[0] < 200 ? "Indoor light" : v[0] < 2000 ? "Bright room" : "Daylight") : "";
      case "mag": return isNum(v[3]) ? `Earth's field is about 25–65 µT` : "";
      default: return "";
    }
  }
  function gaugeFor(s) {
    const v = s.last ? s.last.v : [];
    if (s.def.id === "battery") return [isNum(v[0]) ? v[0] / 100 : null, isNum(v[0]) ? v[0] + "%" : "—", v[1] ? "charging" : "battery"];
    if (s.def.id === "light") return [isNum(v[0]) ? Math.log10(1 + v[0]) / 5 : null, isNum(v[0]) ? Math.round(v[0]) + "" : "—", "lux (log scale)"];
    if (s.def.id === "network") return [isNum(v[0]) ? Math.min(1, v[0] / 20) : (v[2] ? 1 : 0), isNum(v[0]) ? v[0] + "" : v[2] ? "online" : "offline", isNum(v[0]) ? "Mb/s (estimate)" : "connection"];
    return [null, "—", ""];
  }
  // Draw a stream's special picture (compass, tilt, trace...) on a canvas.
  function drawViz(canvas, s, opts) {
    const v = s.last ? s.last.v : [];
    switch (s.def.viz) {
      case "compass": return Charts.compass(canvas, v[0]);
      case "attitude": return Charts.attitude(canvas, v[0], v[1], v[2]);
      case "trace": return Charts.trace(canvas, s.ring);
      case "mic": return Charts.wave(canvas, s.info.wave, v[0]);
      case "gauge": { const [f, t, l] = gaugeFor(s); return Charts.gauge(canvas, f, t, l); }
      default: return Charts.lines(canvas, s, opts);
    }
  }
  function tag(s) { return `<span class="tag tag-${s.status}" data-f="status">${STATUS_TEXT[s.status]}</span>`; }

  // ---------- SENSORS dashboard ----------
  function viewSensors() {
    const all = Sensors.DEFS.map((d) => Sensors.streams[d.id]);
    const active = all.filter((s) => !OFF_STATES.includes(s.status));
    const off = all.filter((s) => OFF_STATES.includes(s.status));
    app.innerHTML = `
      <h1 class="page-title">Sensors</h1>
      <p class="subtitle" id="sum-line">Every sensor this browser can read, in one place.</p>
      ${startCard()}
      <div class="tiles">
        ${active.map((s) => `
          <a class="tile" href="#/detail/${s.def.id}" data-id="${s.def.id}" aria-label="${esc(s.def.name)} details">
            <div class="tile-head"><h2>${esc(s.def.name)}</h2>${tag(s)}</div>
            <p class="tile-sub mono"><span data-f="hz">—</span> · <span data-f="time">—</span></p>
            <div class="vals">${valueRows(s)}</div>
            <div class="viz-row">
              ${s.def.viz !== "lines" ? `<canvas class="viz viz-${s.def.viz}" data-viz="special" aria-hidden="true"></canvas>` : ""}
              ${s.def.viz === "lines" || s.def.viz === "trace" || s.def.viz === "attitude" ? `<canvas class="viz viz-mini" data-viz="lines" aria-hidden="true"></canvas>` : ""}
            </div>
            <p class="tile-extra small" data-f="extra"></p>
            <p class="tile-msg small muted" data-f="msg">${esc(s.status === "idle" && !s.msg ? "Tap START SENSORS above." : s.msg)}</p>
          </a>`).join("")}
      </div>
      ${off.length ? `
        <h2 class="section-title">Not available on this device / browser</h2>
        <ul class="na-list">
          ${off.map((s) => `<li><a href="#/detail/${s.def.id}"><span class="na-name">${esc(s.def.name)}</span>${tag(s)}<span class="na-msg small muted">${esc(s.msg)}</span></a></li>`).join("")}
        </ul>` : ""}
      <p class="foot small muted">Tip: add this app to your Home Screen for full-screen use. Readings stay on your phone unless you export them.</p>`;
    bindStart();
    const tiles = [...app.querySelectorAll(".tile")].map((el) => ({ el, s: Sensors.streams[el.dataset.id] }));
    return {
      name: "sensors",
      draw() {
        const now = Date.now();
        for (const { el, s } of tiles) {
          el.querySelectorAll("canvas").forEach((c) => {
            if (c.dataset.viz === "lines") Charts.lines(c, s, { windowMs: 10000, now, small: true });
            else drawViz(c, s, { windowMs: 10000, now, small: true });
          });
        }
      },
      text() {
        const now = Date.now();
        for (const { el, s } of tiles) {
          fillValues(el, s);
          const set = (f, txt) => { const n = el.querySelector(`[data-f="${f}"]`); if (n && n.textContent !== txt) n.textContent = txt; };
          set("hz", s.last ? rate(s.ring, now, 3000).toFixed(1) + " Hz" : "— Hz");
          set("time", s.last ? clock(s.last.t) : "no data yet");
          set("extra", extraLine(s));
          set("status", STATUS_TEXT[s.status]);
          if (s.status === "live" && s.msg === "") set("msg", "");
        }
        const live = Sensors.DEFS.filter((d) => Sensors.streams[d.id].status === "live").length;
        const sum = $("#sum-line");
        if (sum) sum.textContent = `${live} of ${Sensors.DEFS.length} streams live · ${summary()}`;
      },
    };
  }

  // One plain-English sentence about what the phone is doing right now.
  function summary() {
    const S = Sensors.streams, out = [];
    const geo = S.geo.last, o = S.orient.last, b = S.battery.last, n = S.network.last;
    if (geo && isNum(geo.v[5])) out.push(geo.v[5] > 1 ? `moving ${(geo.v[5] * 3.6).toFixed(0)} km/h` : "stationary");
    else if (S.accel.last) {
      const st = [0, 1, 2].map((i) => stats(S.accel.ring, i, Date.now() - 2000));
      const spread = Math.max(...st.map((x) => (x.n ? x.max - x.min : 0)));
      out.push(spread > 1.5 ? "being moved" : "still");
    }
    if (o && isNum(o.v[1])) out.push(Math.abs(o.v[1]) < 25 && Math.abs(o.v[2] || 0) < 25 ? "face-up" : Math.abs(o.v[1]) > 155 ? "face-down" : "tilted");
    if (S.compass.last) out.push("facing " + compassWord(S.compass.last.v[0]));
    if (b) out.push(`battery ${b.v[0]}%${b.v[1] ? " charging" : ""}`);
    if (n) out.push(n.v[2] ? (S.network.info.effectiveType ? `online (${S.network.info.effectiveType})` : "online") : "offline");
    if (S.mic.last) out.push(extraLine(S.mic).split(" ·")[0].toLowerCase());
    return out.length ? out.join(", ") : "start sensors to see a summary";
  }

  // ---------- DETAIL view ----------
  function viewDetail(id) {
    const s = Sensors.streams[id];
    if (!s) { location.hash = "#/sensors"; return viewSensors(); }
    const d = s.def;
    const st = { windowMs: (settings.windowS || 10) * 1000, paused: false, frozenAt: 0, axes: d.chart.slice() };
    const special = d.viz !== "lines";
    app.innerHTML = `
      <a href="#/sensors" class="back">← Sensors</a>
      <div class="detail-head"><h1 class="page-title">${esc(d.name)}</h1>${tag(s)}</div>
      <p class="subtitle">${esc(d.sub)}</p>
      <p class="api mono small">API: ${esc(d.api)}</p>
      <p class="tile-msg small muted" data-f="msg">${esc(s.msg)}</p>
      ${special ? `<canvas class="viz viz-big viz-${d.viz}" id="d-special" aria-label="${esc(d.name)} picture" role="img"></canvas>` : ""}
      <canvas class="viz viz-chart" id="d-chart" role="img" aria-label="Line chart of recent ${esc(d.name)} readings"></canvas>
      <div class="legend">${st.axes.map((a, k) => `<button class="chip" aria-pressed="true" data-axis="${a}">${Charts.swatch(k)}${esc(d.axes[a])}</button>`).join("")}</div>
      <div class="controls">
        <div class="seg" role="group" aria-label="Time window">
          ${[5, 10, 30, 60].map((w) => `<button class="seg-btn" data-w="${w}" aria-pressed="${w * 1000 === st.windowMs}">${w}s</button>`).join("")}
        </div>
        <button class="btn" id="pause-btn" aria-pressed="false">Pause</button>
      </div>
      <h2 class="section-title">Last <span id="w-label">${st.windowMs / 1000}</span> seconds</h2>
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th scope="col">Axis</th><th scope="col">Now</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Mean</th><th scope="col">Unit</th></tr></thead>
        <tbody>${d.axes.map((a, i) => `<tr><th scope="row">${esc(a)}</th><td data-s="${i}:last">—</td><td data-s="${i}:min">—</td><td data-s="${i}:max">—</td><td data-s="${i}:mean">—</td><td class="muted">${esc(d.units[i] || "")}</td></tr>`).join("")}</tbody>
      </table></div>
      <dl class="meta" id="d-meta"></dl>`;
    app.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => {
      st.windowMs = +b.dataset.w * 1000; settings.windowS = +b.dataset.w; saveSettings();
      app.querySelectorAll("[data-w]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      $("#w-label").textContent = b.dataset.w;
    }));
    app.querySelectorAll("[data-axis]").forEach((b) => (b.onclick = () => {
      const a = +b.dataset.axis, on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      st.axes = on ? [...st.axes, a].sort((x, y) => d.chart.indexOf(x) - d.chart.indexOf(y)) : st.axes.filter((x) => x !== a);
    }));
    $("#pause-btn").onclick = (e) => {
      st.paused = !st.paused; st.frozenAt = Date.now();
      e.currentTarget.textContent = st.paused ? "Resume" : "Pause";
      e.currentTarget.setAttribute("aria-pressed", String(st.paused));
    };
    const nowT = () => (st.paused ? st.frozenAt : Date.now());
    // Keep each axis's line style even when other axes are hidden.
    const chartOpts = () => ({ windowMs: st.windowMs, now: nowT(), axes: st.axes, styleIdx: st.axes.map((a) => d.chart.indexOf(a)) });
    return {
      name: "detail",
      draw() {
        if (st.paused) return;
        const c = $("#d-chart"); if (c) Charts.lines(c, s, chartOpts());
        const sp = $("#d-special"); if (sp) drawViz(sp, s, chartOpts());
      },
      text() {
        if (st.paused && st.textDone) return;
        const now = nowT();
        d.axes.forEach((_, i) => {
          const r = stats(s.ring, i, now - st.windowMs, now);
          ["last", "min", "max", "mean"].forEach((k) => { const el = app.querySelector(`[data-s="${i}:${k}"]`); if (el) el.textContent = fmt(r[k], d.digits[i]); });
        });
        const info = Object.entries(s.info).filter(([k, v]) => k !== "wave" && v != null && v !== "");
        const meta = [
          ["Status", STATUS_TEXT[s.status]],
          ["Update rate", s.last ? rate(s.ring, now, 3000).toFixed(1) + " Hz" : "—"],
          ["Samples (this visit)", String(s.count)],
          ["Last reading", s.last ? new Date(s.last.t).toISOString() : "—"],
          ...info.map(([k, v]) => [k, typeof v === "number" ? fmt(v) : String(v)]),
        ];
        $("#d-meta").innerHTML = meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join("");
        const tg = app.querySelector('[data-f="status"]'); if (tg) { tg.textContent = STATUS_TEXT[s.status]; tg.className = `tag tag-${s.status}`; }
        const m = app.querySelector('[data-f="msg"]'); if (m && m.textContent !== s.msg) m.textContent = s.msg;
        st.textDone = st.paused;
      },
    };
  }
  // ---------- RECORD ----------
  function viewRecord() {
    const rec = Recorder.session;
    app.innerHTML = `
      <h1 class="page-title">Record</h1>
      <p class="subtitle">Save every raw reading from every live sensor.</p>
      ${Sensors.started ? "" : startCard()}
      <section class="card rec-card">
        <div class="big-stats">
          <div><div class="stat-num mono" id="r-time">${rec ? duration(Date.now() - rec.start) : "0:00"}</div><div class="stat-label">Elapsed</div></div>
          <div><div class="stat-num mono" id="r-count">${rec ? rec.samples : 0}</div><div class="stat-label">Samples</div></div>
          <div><div class="stat-num mono" id="r-size">${rec ? bytes(rec.bytes) : "0 B"}</div><div class="stat-label">Saved</div></div>
        </div>
        <label class="field">Name (optional)
          <input id="r-name" maxlength="60" placeholder="e.g. Drive to work" autocomplete="off" ${rec ? "disabled" : ""} value="${rec ? esc(rec.name) : ""}" />
        </label>
        <button class="btn btn-block ${rec ? "btn-stop" : "btn-primary"}" id="rec-btn">${rec ? "Stop recording" : "Start recording"}</button>
        <p class="small muted" id="r-note">${"wakeLock" in navigator ? "The screen stays on while recording." : "Keep the screen on: this browser can't hold it awake."} Phones pause web pages when the screen locks or you switch apps, so readings stop until you come back.</p>
      </section>
      <h2 class="section-title">Samples per sensor</h2>
      <ul class="count-list" id="r-streams">
        ${Sensors.DEFS.map((d) => `<li><span>${esc(d.name)}</span><span class="mono" data-c="${d.id}">0</span></li>`).join("")}
      </ul>`;
    bindStart();
    $("#rec-btn").onclick = async () => {
      if (Recorder.session) {
        const s = await Recorder.stop();
        toast(`Saved ${s.samples} samples`);
        location.hash = "#/sessions";
      } else {
        if (!Sensors.started) await Sensors.startAll({ mic: settings.mic });
        await Recorder.start($("#r-name").value.trim());
        route();
      }
    };
    return {
      name: "record",
      draw() {},
      text() {
        const r = Recorder.session;
        if (!r) return;
        $("#r-time").textContent = duration(Date.now() - r.start);
        $("#r-count").textContent = r.samples;
        $("#r-size").textContent = bytes(r.bytes);
        Sensors.DEFS.forEach((d) => { const el = app.querySelector(`[data-c="${d.id}"]`); if (el) el.textContent = r.counts[d.id] || 0; });
      },
    };
  }

  // ---------- SESSIONS ----------
  function viewSessions() {
    app.innerHTML = `<h1 class="page-title">Sessions</h1><p class="subtitle">Recordings saved on this phone.</p><div id="s-list"><p class="muted">Loading…</p></div>`;
    DB.listSessions().then((list) => {
      const el = $("#s-list"); if (!el) return;
      if (!list.length) { el.innerHTML = `<div class="empty"><p>No recordings yet.</p><a class="btn" href="#/record">Go to Record</a></div>`; return; }
      el.innerHTML = list.map((s) => {
        const end = s.end || s.lastSaved || s.start;
        const used = Object.entries(s.counts).filter(([, n]) => n > 0);
        return `
        <article class="card session" data-id="${s.id}">
          <div class="session-head">
            <div><h2>${esc(s.name || new Date(s.start).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}</h2>
              <p class="small muted">${s.name ? esc(new Date(s.start).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })) + " · " : ""}${duration(end - s.start)} · ${s.samples} samples · ${bytes(s.bytes)}${s.end ? "" : " · interrupted"}</p></div>
          </div>
          <details><summary>${used.length} sensors</summary>
            <ul class="count-list">${used.map(([id, n]) => `<li><span>${esc((s.streams[id] || {}).name || id)}</span><span class="mono">${n}</span></li>`).join("")}</ul>
          </details>
          <div class="btn-row">
            <button class="btn" data-act="csv">Export CSV</button>
            <button class="btn" data-act="json">Export JSON</button>
            <button class="btn btn-ghost" data-act="del" aria-label="Delete this session">Delete</button>
          </div>
        </article>`;
      }).join("");
      el.querySelectorAll(".session").forEach((card) => {
        const id = card.dataset.id;
        card.querySelector('[data-act="csv"]').onclick = async () => Recorder.download(`telematics-${id}.csv`, await Recorder.toCSV(id), "text/csv");
        card.querySelector('[data-act="json"]').onclick = async () => Recorder.download(`telematics-${id}.json`, JSON.stringify(await Recorder.toJSON(id), null, 1), "application/json");
        card.querySelector('[data-act="del"]').onclick = async () => {
          if (!confirm("Delete this recording? This can't be undone.")) return;
          await DB.deleteSession(id); toast("Deleted"); route();
        };
      });
    }).catch((e) => { const el = $("#s-list"); if (el) el.innerHTML = `<p class="warn">Couldn't open saved data: ${esc(e.message)}</p>`; });
    return { name: "sessions", draw() {}, text() {} };
  }

  // ---------- DEVICE + SETTINGS ----------
  function viewDevice() {
    const info = Sensors.deviceInfo();
    app.innerHTML = `
      <h1 class="page-title">Device</h1>
      <p class="subtitle">What this browser says about your phone.</p>
      <dl class="meta">${Object.entries(info).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`).join("")}</dl>
      <h2 class="section-title">Vibration</h2>
      <div class="btn-row"><button class="btn" id="vib-btn" ${"vibrate" in navigator ? "" : "disabled"}>Test vibration</button></div>
      <p class="small muted">${"vibrate" in navigator ? "Buzzes three times." : "Not available: Safari on iPhone has no Vibration API."}</p>
      <h2 class="section-title">Settings</h2>
      <label class="field">Recording rate
        <select id="set-hz">
          ${[[0, "Every reading (raw)"], [50, "Up to 50 per second"], [10, "Up to 10 per second"], [1, "Up to 1 per second"]].map(([v, l]) => `<option value="${v}" ${settings.recordHz === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field">Default chart window
        <select id="set-win">${[5, 10, 30, 60].map((w) => `<option value="${w}" ${settings.windowS === w ? "selected" : ""}>${w} seconds</option>`).join("")}</select>
      </label>
      <div class="btn-row"><button class="btn btn-ghost" id="clear-btn">Delete all recordings</button></div>
      <h2 class="section-title">About</h2>
      <p class="small muted">Sensors only work on a secure (https://) page. iPhone asks for motion access the first time you tap START SENSORS; if you said no, fully close Safari and try again. Location needs Location Services turned on for Safari.</p>`;
    $("#vib-btn").onclick = () => navigator.vibrate && navigator.vibrate([120, 80, 120, 80, 120]);
    $("#set-hz").onchange = (e) => { settings.recordHz = +e.target.value; saveSettings(); toast("Saved"); };
    $("#set-win").onchange = (e) => { settings.windowS = +e.target.value; saveSettings(); toast("Saved"); };
    $("#clear-btn").onclick = async () => {
      if (!confirm("Delete ALL saved recordings?")) return;
      await DB.clearAll(); toast("All recordings deleted");
    };
    return { name: "device", draw() {}, text() {} };
  }

  // ---------- Update loop ----------
  let frame = 0, statusDirty = false;
  Sensors.onStatus(() => { statusDirty = true; });
  function loop() {
    frame++;
    if (view && document.visibilityState === "visible") {
      try {
        // Rebuild the dashboard when a sensor becomes (un)available.
        if (statusDirty && view.name === "sensors" && frame % 15 === 0) { statusDirty = false; const y = scrollY; app.classList.add("quiet"); route(); window.scrollTo(0, y); }
        if (frame % 2 === 0) view.draw();          // charts ~30 fps
        if (frame % 6 === 0) view.text();           // numbers ~10 per second
      } catch (e) { console.error(e); }
    }
    if (frame % 10 === 0) header();
    requestAnimationFrame(loop);
  }
  function header() {
    const live = Sensors.DEFS.filter((d) => Sensors.streams[d.id].status === "live").length;
    const lt = $("#live-tag"); const txt = live ? `${live} live` : "Idle";
    if (lt.textContent !== txt) lt.textContent = txt;
    const rt = $("#rec-tag"), r = Recorder.session;
    rt.hidden = !r;
    if (r) rt.textContent = "REC " + duration(Date.now() - r.start);
  }

  // ---------- Start up ----------
  Sensors.startPassiveOnLoad();
  if (!location.hash) location.replace("#/sensors");
  route();
  requestAnimationFrame(loop);

  // Offline support (needs https or localhost).
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    // Relative script and scope so the worker stays under /sensor-app/ on GitHub Pages.
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((e) => console.warn("SW:", e.message)));
  }
  window.App = { route, settings, summary };
})();
