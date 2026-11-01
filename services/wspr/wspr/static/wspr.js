(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const API = new URL("api/spots", location.href.replace(/[?#].*$/, "").replace(/\/?$/, "/"));
  const REFRESH_MS = 120000;  // one WSPR cycle
  const form = $("#q"), tip = $("#tip"), statusEl = $("#status");
  const css = getComputedStyle(document.querySelector(".wspr"));
  const v = (n) => css.getPropertyValue(n).trim();
  const SNR_STEPS = [1, 2, 3, 4, 5, 6].map((i) => v(`--snr-${i}`));
  const BAND_ORDER = ["2200m","630m","160m","80m","60m","40m","30m","20m","17m","15m","12m","10m","6m","4m","2m","70cm","23cm"];

  let data = null, sortKey = "time", sortDir = -1, timer = null;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString();
  const km2mi = (k) => Math.round(k * 0.621371);
  const dist = (k) => `${fmt(k)} km`;
  const snrStr = (s) => `${s > 0 ? "+" : ""}${s} dB`;
  const dbm2w = (d) => { const w = Math.pow(10, (d - 30) / 10); return w >= 1 ? `${+w.toFixed(1)} W` : `${Math.round(w * 1000)} mW`; };
  const snrColor = (s) => SNR_STEPS[Math.max(0, Math.min(5, Math.floor((s + 30) / 6)))];
  const qrz = (c) => `https://www.qrz.com/db/${encodeURIComponent(c.split("/").find((p) => /\d/.test(p) && p.length > 2) || c)}`;
  const ago = (t) => { const m = Math.round((Date.now() - Date.parse(t.replace(" ", "T") + "Z")) / 60000); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  function showTip(html, e) {
    tip.innerHTML = html; tip.hidden = false;
    const x = e.clientX ?? e.originalEvent?.clientX, y = e.clientY ?? e.originalEvent?.clientY;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + "px";
    tip.style.top = Math.min(y + 14, innerHeight - r.height - 8) + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- map ----------
  const map = L.map("map", { worldCopyJump: true, minZoom: 1, zoomSnap: 0.5 }).setView([25, -40], 2);
  const tileStyle = v("--tiles") === "light" ? "light_all" : "dark_all";
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${tileStyle}/{z}/{x}/{y}{r}.png`, {
    subdomains: "abcd", maxZoom: 10,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  const pathLayer = L.layerGroup().addTo(map);
  const ptLayer = L.layerGroup().addTo(map);

  // great-circle points, longitudes unwrapped so lines don't streak across the map
  function gc(a, b, n = 48) {
    const r = Math.PI / 180, [la1, lo1, la2, lo2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    if (d < 1e-6) return [a, b];
    const out = []; let prev = null;
    for (let i = 0; i <= n; i++) {
      const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      let lon = Math.atan2(y, x) / r; const lat = Math.atan2(z, Math.hypot(x, y)) / r;
      if (prev !== null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
      prev = lon; out.push([lat, lon]);
    }
    return out;
  }

  // ---------- data shaping ----------
  function shape(spots, role) {
    // "other" = the far end relative to the searched station
    for (const s of spots) {
      const o = role === "tx" ? "rx" : "tx";
      s.other = s[`${o}_sign`]; s.other_loc = s[`${o}_loc`];
      s.olat = s[`${o}_lat`]; s.olon = s[`${o}_lon`];
      s.me = s[`${role}_sign`]; s.mlat = s[`${role}_lat`]; s.mlon = s[`${role}_lon`]; s.mloc = s[`${role}_loc`];
    }
    const stations = new Map();
    for (const s of spots) {
      const k = s.other;
      let st = stations.get(k);
      if (!st) stations.set(k, st = { call: k, loc: s.other_loc, lat: s.olat, lon: s.olon, n: 0, best: -99, maxd: 0, bands: new Set(), me: [s.mlat, s.mlon], last: s.time });
      st.n++; st.best = Math.max(st.best, s.snr); st.maxd = Math.max(st.maxd, s.distance); st.bands.add(s.band_label);
      if (s.time > st.last) st.last = s.time;
    }
    return [...stations.values()];
  }

  // ---------- render ----------
  function render() {
    const { spots, truncated, query } = data;
    const stations = shape(spots, query.role);
    const label = query.call || `grid ${query.grid}`;
    const heard = query.role === "tx";

    // tiles
    $("#t-spots").textContent = fmt(spots.length);
    $("#t-spots-s").textContent = `${query.hours} h window${truncated ? " · capped" : ""}`;
    $("#t-uniq").textContent = fmt(stations.length);
    $("#t-uniq-s").textContent = heard ? "reporters heard " + label : "transmitters heard by " + label;
    const far = spots.reduce((a, s) => (!a || s.distance > a.distance ? s : a), null);
    const best = spots.reduce((a, s) => (!a || s.snr > a.snr ? s : a), null);
    $("#t-dx").textContent = far ? dist(far.distance) : "–";
    $("#t-dx-s").textContent = far ? `${far.other} · ${fmt(km2mi(far.distance))} mi · ${far.band_label}` : "";
    $("#t-snr").textContent = best ? snrStr(best.snr) : "–";
    $("#t-snr-s").textContent = best ? `${best.other} · ${best.band_label}` : "";

    // map
    pathLayer.clearLayers(); ptLayer.clearLayers();
    const bounds = [];
    const homes = new Map();
    for (const st of [...stations].sort((a, b) => a.best - b.best)) {  // strongest drawn last (on top)
      const pts = gc(st.me, [st.lat, st.lon]);
      const color = snrColor(st.best);
      const html = `<b>${esc(st.call)}</b> <span class="m">${esc(st.loc)}</span><br>${dist(st.maxd)} (${fmt(km2mi(st.maxd))} mi)<br>Best ${snrStr(st.best)} · ${st.n} spot${st.n > 1 ? "s" : ""}<br><span class="m">${[...st.bands].sort((a, b) => BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b)).join(", ")} · ${ago(st.last)}</span>`;
      const line = L.polyline(pts, { color, weight: 2, opacity: 0.85, interactive: false }).addTo(pathLayer);
      const hit = L.polyline(pts, { color: "#000", weight: 12, opacity: 0 }).addTo(pathLayer);  // fat invisible hit target
      const end = pts[pts.length - 1];
      const mk = L.circleMarker(end, { radius: 5, color: v("--surface-1"), weight: 2, fillColor: color, fillOpacity: 1 }).addTo(ptLayer);
      for (const el of [hit, mk]) {
        el.on("mousemove", (e) => { line.setStyle({ weight: 4, opacity: 1 }); showTip(html, e); });
        el.on("mouseout", () => { line.setStyle({ weight: 2, opacity: 0.85 }); hideTip(); });
        el.on("click", () => window.open(qrz(st.call), "_blank", "noopener"));
      }
      bounds.push(end, st.me);
      homes.set(st.me.join(","), st.me);
    }
    for (const h of homes.values()) {
      L.circleMarker(h, { radius: 7, color: v("--surface-1"), weight: 2, fillColor: v("--text-primary"), fillOpacity: 1 })
        .bindTooltip(esc(label), { direction: "top" }).addTo(ptLayer);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 5 });

    // bands
    const counts = {};
    for (const s of spots) counts[s.band_label] = (counts[s.band_label] || 0) + 1;
    const rows = Object.entries(counts).sort((a, b) => BAND_ORDER.indexOf(a[0]) - BAND_ORDER.indexOf(b[0]));
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const bandsEl = $("#bands");
    bandsEl.innerHTML = rows.length ? rows.map(([b, n]) =>
      `<div class="brow" data-b="${esc(b)}" data-n="${n}"><span class="lbl">${esc(b)}</span><span class="track"><span class="fill" style="display:block;width:${(n / max) * 100}%"></span></span><span class="n">${fmt(n)}</span></div>`).join("")
      : `<div class="empty">No spots in this window.</div>`;
    bandsEl.querySelectorAll(".brow").forEach((r) => {
      const b = r.dataset.b, ss = spots.filter((s) => s.band_label === b);
      const uniq = new Set(ss.map((s) => s.other)).size, mx = Math.max(...ss.map((s) => s.distance));
      r.addEventListener("mousemove", (e) => showTip(`<b>${esc(b)}</b><br>${fmt(ss.length)} spots · ${uniq} stations<br><span class="m">Longest ${dist(mx)}</span>`, e));
      r.addEventListener("mouseleave", hideTip);
    });

    // top stations by distance
    const top = [...stations].sort((a, b) => b.maxd - a.maxd).slice(0, 8);
    $("#top").innerHTML = top.length ? top.map((st) =>
      `<li><span class="c"><a href="${qrz(st.call)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${esc(st.call)}</a><small>${esc(st.loc)}</small></span><span class="d">${dist(st.maxd)}</span><span class="r">${snrStr(st.best)}</span></li>`).join("")
      : `<li class="empty">—</li>`;

    renderTable();
    $("#log-hint").textContent = `${fmt(spots.length)} spots${truncated ? " (most recent shown; narrow the band or window for full history)" : ""}`;
  }

  function renderTable() {
    const spots = [...data.spots].sort((a, b) => {
      let x = a[sortKey], y = b[sortKey];
      if (sortKey === "band") { x = BAND_ORDER.indexOf(a.band_label); y = BAND_ORDER.indexOf(b.band_label); }
      return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
    });
    document.querySelectorAll("#log th").forEach((th) => th.setAttribute("aria-sort", th.dataset.k === sortKey ? (sortDir > 0 ? "ascending" : "descending") : "none"));
    $("#log tbody").innerHTML = spots.slice(0, 1000).map((s) => `<tr>
      <td>${esc(s.time.slice(5, 16))}</td><td>${esc(s.band_label)}</td>
      <td class="num">${(s.frequency / 1e6).toFixed(6)}</td>
      <td class="call"><a href="${qrz(s.other)}" target="_blank" rel="noopener">${esc(s.other)}</a></td>
      <td>${esc(s.other_loc)}</td>
      <td class="num" title="${fmt(km2mi(s.distance))} mi">${fmt(s.distance)} km</td>
      <td class="num">${snrStr(s.snr)}</td><td class="num">${dbm2w(s.power)}</td><td class="num">${s.drift}</td></tr>`).join("");
  }

  document.querySelectorAll("#log th").forEach((th) => th.addEventListener("click", () => {
    if (!data) return;
    const k = th.dataset.k;
    sortDir = k === sortKey ? -sortDir : (["time", "distance", "snr", "power"].includes(k) ? -1 : 1);
    sortKey = k; renderTable();
  }));

  // ---------- fetching ----------
  function params() {
    const fd = new FormData(form), p = new URLSearchParams();
    for (const k of ["call", "grid", "role", "band", "hours"]) { const val = (fd.get(k) || "").toString().trim(); if (val) p.set(k, k === "call" ? val.toUpperCase() : val); }
    return p;
  }

  async function load() {
    const p = params();
    history.replaceState(null, "", "?" + p.toString());
    statusEl.className = "status"; statusEl.textContent = "Loading…";
    try {
      const r = await fetch(API + "?" + p.toString());
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      data = j; render();
      const t = new Date(j.fetched_at * 1000);
      statusEl.textContent = `Updated ${t.toLocaleTimeString()}${$("#auto").checked ? " · refreshes every 2 min" : ""}`;
    } catch (e) {
      statusEl.className = "status err"; statusEl.textContent = e.message;
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    $(".dot").classList.toggle("live", $("#auto").checked);
    if ($("#auto").checked) timer = setTimeout(() => { if (!document.hidden) load(); else schedule(); }, REFRESH_MS);
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
  form.addEventListener("change", (e) => { if (e.target.matches("select, input[type=radio]")) load(); });
  $("#auto").addEventListener("change", schedule);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && $("#auto").checked && data && Date.now() / 1000 - data.fetched_at > REFRESH_MS / 1000) load(); });

  // restore from URL (shareable links)
  const qs = new URLSearchParams(location.search);
  for (const [k, val] of qs) {
    const el = form.elements[k];
    if (!el) continue;
    if (el instanceof RadioNodeList) { for (const r of el) r.checked = r.value === val; } else el.value = val;
  }
  load();
})();
