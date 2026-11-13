/* kn0ble.com/space -- ham satellite pass predictions.
 *
 * Everything is computed in the browser with satellite.js (SGP4).
 * Orbit data (TLEs) come from CelesTrak and live transmitter data from
 * SatNOGS DB, both through kn0ble.com's own nginx (/space/api/...),
 * which caches them so we never hammer the upstream sites. The last
 * good copy is also kept in this browser, so the page still works
 * offline or on the GitHub Pages copy where the proxy does not exist.
 */
(() => {
  'use strict';

  const S = window.satellite;
  const C_KMS = 299792.458;
  const RE_KM = 6378.137;
  const DEG = 180 / Math.PI;
  const RAD = Math.PI / 180;

  const TLE_MAX_AGE_MS = 2 * 3600e3;   // CelesTrak updates roughly every 2 h
  const TX_MAX_AGE_MS = 24 * 3600e3;
  const AMSAT_MAX_AGE_MS = 10 * 60e3;   // AMSAT asks for <= 1 poll / 5 min; the site caches 5 min
  const AMSAT_CAT_MAX_AGE_MS = 24 * 3600e3;
  const RECENT_MS = 48 * 3600e3;
  const RECALC_MS = 10 * 60e3;

  const LS = {
    loc: 'kn0ble.space.loc.v1',
    tle: 'kn0ble.space.tle.v1',
    tx: 'kn0ble.space.tx.v1',
    amsat: 'kn0ble.space.amsat.v1',
    amsatCat: 'kn0ble.space.amsatcat.v1',
    prefs: 'kn0ble.space.prefs.v1',
  };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ---------------------------------------------------------------
  // Curated satellites. Frequencies from AMSAT's "Live FM Satellites"
  // (updated Oct 31, 2026) and "Live Analog Satellites" (updated
  // Feb 21, 2026) lists, checked Nov 13, 2026. SatNOGS live data is
  // shown alongside so new or changed transmitters still appear.
  // ---------------------------------------------------------------
  const FREQ_ASOF = 'AMSAT lists, checked Nov 13, 2026';
  const CURATED = [
    { norad: 25544, name: 'ISS', type: 'FM',
      up: 145.990, tone: 67.0, down: 437.800,
      note: 'Crossband repeater. Check ARISS / AMSAT status, it is not always on. APRS digipeater on 145.825 simplex.' },
    { norad: 27607, name: 'SO-50', type: 'FM',
      up: 145.850, tone: 67.0, down: 436.795,
      note: 'Arm the 10-minute timer first: key up for 2 seconds with a 74.4 Hz tone, then use 67.0 Hz.' },
    { norad: 61781, name: 'AO-123', type: 'FM',
      up: 145.850, tone: 67.0, down: 435.400, note: 'ASRTU-1.' },
    { norad: 43017, name: 'AO-91', type: 'FM', sunOnly: true,
      up: 435.250, tone: 67.0, down: 145.960,
      note: 'RadFxSat / Fox-1B. Battery is weak: do not use it while the satellite is in eclipse.' },
    { norad: 43678, name: 'PO-101', type: 'FM',
      up: 437.500, tone: 141.3, down: 145.900,
      note: 'Diwata-2. Repeater runs on a schedule and may be failing.' },
    { norad: 40931, name: 'IO-86', type: 'FM',
      up: 145.880, tone: 88.5, down: 435.880,
      note: 'LAPAN-A2. Low inclination (about 6 deg), so it stays near the equator. Runs on a schedule.' },
    { norad: 40908, name: 'CAS-3H', type: 'FM',
      up: 144.350, tone: null, down: 437.200,
      note: 'LilacSat-2. FM repeater has no fixed schedule; when off you hear only the 437.200 telemetry beacon.' },
    { norad: 67291, name: 'RS95S', type: 'FM',
      up: 145.920, tone: 67.0, down: 436.950,
      note: 'QMR-KWT-2. On during testing, watch AMSAT-BB. Also sends SSTV.' },

    { norad: 44909, name: 'RS-44', type: 'Linear', inverting: true,
      upLo: 145.935, upHi: 145.995, upMode: 'LSB', downLo: 435.610, downHi: 435.670, downMode: 'USB',
      note: 'V/u inverting. CW beacon 435.605. The big easy linear bird, high orbit with long passes.' },
    { norad: 24278, name: 'FO-29', type: 'Linear', inverting: true,
      upLo: 145.900, upHi: 146.000, upMode: 'LSB', downLo: 435.800, downHi: 435.900, downMode: 'USB',
      note: 'V/u inverting. Turned on by schedule. CW beacon 435.795.' },
    { norad: 7530, name: 'AO-7', type: 'Linear', inverting: true, sunOnly: true,
      upLo: 432.125, upHi: 432.175, upMode: 'LSB', downLo: 145.925, downHi: 145.975, downMode: 'USB',
      note: 'Mode B (U/v inverting) shown. Mode A: up 145.850-145.950 USB, down 29.400-29.500 USB. Works only in sunlight; mode flips on a 24 h timer.' },
    { norad: 39444, name: 'AO-73', type: 'Linear', inverting: true,
      upLo: 435.130, upHi: 435.150, upMode: 'LSB', downLo: 145.950, downHi: 145.970, downMode: 'USB',
      note: 'FUNcube-1. Transponder works in eclipse. Telemetry 145.935 BPSK.' },
    { norad: 43803, name: 'JO-97', type: 'Linear', inverting: true,
      upLo: 435.100, upHi: 435.120, upMode: 'LSB', downLo: 145.855, downHi: 145.875, downMode: 'USB',
      note: 'JY1Sat. Telemetry is not working.' },
    { norad: 44881, name: 'TO-108', type: 'Linear', inverting: true,
      upLo: 435.270, upHi: 435.290, upMode: 'LSB', downLo: 145.915, downHi: 145.935, downMode: 'USB',
      note: 'CAS-6. Transponder cycles about 2 s on, 5 s off. CW beacon 145.910.' },
    { norad: 60209, name: 'MO-122', type: 'Linear', inverting: true,
      upLo: 145.910, upHi: 145.940, upMode: 'LSB', downLo: 435.810, downHi: 435.840, downMode: 'USB',
      note: 'MESAT1. Beacon 435.800 (1k2 BPSK).' },
  ];
  const CURATED_BY_ID = new Map(CURATED.map(s => [s.norad, s]));

  // ---------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = az => COMPASS[Math.round(((az % 360) + 360) % 360 / 22.5) % 16];

  const fmtTime = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtTimeSec = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const fmtDay = d => {
    const today = new Date(); const tmr = new Date(Date.now() + 864e5);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === tmr.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const fmtDur = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtAgo = t => {
    if (!t) return 'never';
    const m = Math.round((Date.now() - t) / 60e3);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  };
  const fmtIn = ms => {
    const m = Math.round(ms / 60e3);
    if (m < 1) return 'now';
    if (m < 60) return `in ${m} min`;
    const h = Math.floor(m / 60); const r = m % 60;
    return r ? `in ${h} h ${r} min` : `in ${h} h`;
  };
  const mhz = f => f.toFixed(3);

  // ---------------------------------------------------------------
  // Location: grid square, "lat, lon", or an address (geocoded)
  // ---------------------------------------------------------------
  function gridToLatLon(grid) {
    const g = grid.trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 - 180;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90;
    lon += Number(g[2]) * 2; lat += Number(g[3]);
    let dLon = 2, dLat = 1;
    if (g.length >= 6) {
      lon += (g.charCodeAt(4) - 65) * (5 / 60); lat += (g.charCodeAt(5) - 65) * (2.5 / 60);
      dLon = 5 / 60; dLat = 2.5 / 60;
    }
    if (g.length === 8) {
      lon += Number(g[6]) * (0.5 / 60); lat += Number(g[7]) * (0.25 / 60);
      dLon = 0.5 / 60; dLat = 0.25 / 60;
    }
    return { lat: lat + dLat / 2, lon: lon + dLon / 2 };
  }

  function latLonToGrid(lat, lon) {
    let x = lon + 180, y = lat + 90;
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    const f1 = A[Math.floor(x / 20)] + A[Math.floor(y / 10)];
    x %= 20; y %= 10;
    const f2 = String(Math.floor(x / 2)) + String(Math.floor(y));
    x %= 2; y %= 1;
    const f3 = A[Math.floor(x * 12)].toLowerCase() + A[Math.floor(y * 24)].toLowerCase();
    return f1 + f2 + f3;
  }

  async function fetchJson(url, ms = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function fetchText(url, ms = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } finally { clearTimeout(t); }
  }

  async function geocode(q) {
    const qs = encodeURIComponent(q);
    const urls = [
      `/space/api/geocode?q=${qs}`,
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${qs}`,
    ];
    let lastErr;
    for (const u of urls) {
      try {
        const res = await fetchJson(u, 12000);
        if (Array.isArray(res)) return res;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Lookup failed');
  }

  async function resolveLocation(input) {
    const raw = input.trim();
    if (!raw) throw new Error('Type an address, a grid square, or lat, lon.');
    const g = gridToLatLon(raw);
    if (g) return { ...g, label: `Grid ${raw.toUpperCase()}`, source: 'grid' };
    const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = Number(m[1]), lon = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, source: 'coords' };
    }
    const hits = await geocode(raw);
    if (!hits.length) throw new Error('Could not find that address. Try adding the city and state, or use your grid square.');
    const h = hits[0];
    return { lat: Number(h.lat), lon: Number(h.lon), label: h.display_name, source: 'address' };
  }

  // ---------------------------------------------------------------
  // Orbit data (TLEs)
  // ---------------------------------------------------------------
  function parseTle(text) {
    const out = new Map();
    const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const l1 = lines[i], l2 = lines[i + 1];
      if (l1 && l2 && l1.startsWith('1 ') && l2.startsWith('2 ')) {
        const name = (i > 0 && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 ')) ? lines[i - 1].trim() : '';
        const norad = Number(l1.slice(2, 7));
        if (norad) out.set(norad, { name: name || `NORAD ${norad}`, l1, l2 });
        i++;
      }
    }
    return out;
  }

  const tleToText = map => [...map.values()].map(t => `${t.name}\n${t.l1}\n${t.l2}`).join('\n');

  async function fetchTles() {
    let text = '';
    // 1) kn0ble.com proxy (cached by nginx), 2) CelesTrak directly.
    const groupUrls = ['/space/api/tle/amateur', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle'];
    for (const u of groupUrls) {
      try { const t = await fetchText(u); if (/^1 \d{5}/m.test(t)) { text = t; break; } } catch (e) { /* next */ }
    }
    const map = parseTle(text);
    // Curated sats missing from the amateur group: fetch one by one.
    const missing = CURATED.filter(s => !map.has(s.norad));
    await Promise.all(missing.map(async s => {
      for (const u of [`/space/api/tle/cat/${s.norad}`, `https://celestrak.org/NORAD/elements/gp.php?CATNR=${s.norad}&FORMAT=tle`]) {
        try {
          const t = await fetchText(u, 12000);
          const one = parseTle(t);
          if (one.has(s.norad)) { map.set(s.norad, one.get(s.norad)); return; }
        } catch (e) { /* next */ }
      }
    }));
    if (!map.size) throw new Error('No orbit data');
    return map;
  }

  // ---------------------------------------------------------------
  // SatNOGS transmitters (live frequencies)
  // ---------------------------------------------------------------
  async function fetchTransmitters() {
    const urls = ['/space/api/transmitters', 'https://db.satnogs.org/api/transmitters/?format=json'];
    for (const u of urls) {
      try {
        const all = await fetchJson(u, 30000);
        if (!Array.isArray(all)) continue;
        // Keep only what the page uses, so it fits in localStorage.
        return all
          .filter(t => t && t.alive && t.status === 'active' && t.norad_cat_id && (!t.service || t.service === 'Amateur'))
          .map(t => ({
            n: t.norad_cat_id, d: t.description || '', ty: t.type || '', m: t.mode || '',
            ul: t.uplink_low, uh: t.uplink_high, dl: t.downlink_low, dh: t.downlink_high,
            inv: !!t.invert, bd: t.baud || null,
          }));
      } catch (e) { /* next */ }
    }
    throw new Error('No transmitter data');
  }

  // ---------------------------------------------------------------
  // AMSAT live status (status.amsat.org API v1)
  //   catalog.php  -> status names <-> NORAD numbers (one sat can have
  //                   several names, e.g. AO-7[A] / AO-7[B])
  //   summary.php  -> per name and report type: count + latest time
  // ---------------------------------------------------------------
  async function fetchAmsatCatalog() {
    const urls = ['/space/api/amsat/catalog', 'https://status.amsat.org/api/v1/catalog.php'];
    for (const u of urls) {
      try {
        const res = await fetchJson(u, 15000);
        const rows = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : null);
        if (!rows) continue;
        return rows.filter(r => r && r.name).map(r => ({ name: r.name, disp: r.display_name || r.name, n: Number(r.norad_cat_id) || 0 }));
      } catch (e) { /* next */ }
    }
    throw new Error('No AMSAT catalog');
  }

  async function fetchAmsatSummary() {
    const urls = ['/space/api/amsat/summary', 'https://status.amsat.org/api/v1/summary.php?hours=48'];
    for (const u of urls) {
      try {
        const res = await fetchJson(u, 15000);
        const rows = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : null);
        if (!rows) continue;
        return rows.filter(r => r && r.name && r.report).map(r => ({
          name: r.name, report: r.report, count: Number(r.report_count) || 0,
          t: parseUtc(r.latest_observation_time || r.latest_reported_time),
        }));
      } catch (e) { /* next */ }
    }
    throw new Error('No AMSAT status');
  }

  // AMSAT timestamps are UTC; accept "2026-11-13 20:15:00", ISO with or without Z.
  function parseUtc(v) {
    if (!v) return 0;
    let str = String(v).trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(str)) str += 'Z';
    const t = Date.parse(str);
    return Number.isFinite(t) ? t : 0;
  }

  const AMSAT_LABEL = { 'Heard': 'Heard', 'Telemetry Only': 'Telemetry only', 'Not Heard': 'Not heard', 'Crew Active': 'Crew active' };
  const AMSAT_CLASS = { 'Heard': 'st-heard', 'Telemetry Only': 'st-tlm', 'Not Heard': 'st-not', 'Crew Active': 'st-crew' };

  // Status for one NORAD number: { latest: {name, report, t}, modes: [{name, disp, latest, counts}] }
  function amsatFor(sat) {
    if (!state.amsatCat || !state.amsat) return null;
    let names = state.amsatCat.filter(c => c.n === sat.norad);
    if (!names.length) return { none: true };
    // For an FM bird, prefer FM-ish status entries (ISS has FM, SSTV, packet...).
    if (sat.type === 'FM') {
      const fm = names.filter(c => /FM/i.test(c.name) || /FM/i.test(c.disp));
      if (fm.length) names = fm;
    }
    const modes = names.map(c => {
      const rows = state.amsat.filter(r => r.name === c.name);
      const latest = rows.reduce((a, r) => (!a || r.t > a.t ? r : a), null);
      const counts = {};
      rows.forEach(r => { counts[r.report] = (counts[r.report] || 0) + r.count; });
      return { name: c.name, disp: c.disp, latest, counts };
    });
    const latest = modes.map(m => m.latest).filter(Boolean).reduce((a, r) => (!a || r.t > a.t ? r : a), null);
    return { latest, modes };
  }

  function heardRecently(sat) {
    const a = amsatFor(sat);
    if (!a || a.none) return null;               // unknown: don't hide it
    return a.modes.some(m => (m.counts['Heard'] || 0) + (m.counts['Crew Active'] || 0) > 0 && m.latest && Date.now() - m.latest.t < RECENT_MS);
  }

  function amsatBadge(sat) {
    const a = amsatFor(sat);
    if (!a) return '';
    if (a.none) return '';
    if (!a.latest) return ' <span class="badge st-none" title="No AMSAT reports in the last 48 h">no reports</span>';
    return ` <span class="badge ${AMSAT_CLASS[a.latest.report] || 'st-none'}" title="Latest AMSAT report">${esc(AMSAT_LABEL[a.latest.report] || a.latest.report)} ${esc(fmtAgo(a.latest.t).replace(' ago', ''))}</span>`;
  }

  function amsatHtml(sat) {
    const a = amsatFor(sat);
    const link = '<a href="https://www.amsat.org/status/" target="_blank" rel="noopener">AMSAT status</a>';
    if (!a) return `<p class="small muted">AMSAT live status not loaded. ${link}</p>`;
    if (a.none) return `<p class="small muted">Not tracked on the ${link} page.</p>`;
    const rows = a.modes.map(m => {
      const c = m.counts;
      const parts = ['Heard', 'Crew Active', 'Telemetry Only', 'Not Heard'].filter(k => c[k]).map(k => `${c[k]} ${AMSAT_LABEL[k].toLowerCase()}`);
      const last = m.latest ? `<span class="badge ${AMSAT_CLASS[m.latest.report] || 'st-none'}">${esc(AMSAT_LABEL[m.latest.report] || m.latest.report)}</span> ${esc(fmtAgo(m.latest.t))}` : '<span class="muted">no reports</span>';
      return `<tr><td>${esc(m.disp)}</td><td>${last}</td><td>${parts.join(', ') || '-'}</td></tr>`;
    }).join('');
    return `<div class="tablewrap"><table class="txtable"><thead><tr><th>Mode</th><th>Latest report</th><th>Last 48 h</th></tr></thead><tbody>${rows}</tbody></table></div><p class="small muted">From ${link}. Heard a pass? Report it there.</p>`;
  }

  // ---------------------------------------------------------------
  // Orbit math
  // ---------------------------------------------------------------
  function makeObserver(loc) {
    return { latitude: loc.lat * RAD, longitude: loc.lon * RAD, height: (loc.altM || 0) / 1000 };
  }

  function look(satrec, date, obs) {
    const pv = S.propagate(satrec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
    const gmst = S.gstime(date);
    const ecf = S.eciToEcf(pv.position, gmst);
    const la = S.ecfToLookAngles(obs, ecf);
    return { az: la.azimuth * DEG, el: la.elevation * DEG, range: la.rangeSat, eci: pv.position };
  }

  // km/s, positive = moving away
  function rangeRate(satrec, t, obs) {
    const a = look(satrec, new Date(t - 500), obs);
    const b = look(satrec, new Date(t + 500), obs);
    return (a && b) ? (b.range - a.range) : 0;
  }

  // Low-precision sun position (ECI, km). Good to ~0.01 deg, plenty
  // for "is the satellite in sunlight".
  function sunEci(date) {
    const jd = date.getTime() / 864e5 + 2440587.5;
    const n = jd - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;
    const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * 149597870.7;
    return { x: R * Math.cos(lam), y: R * Math.cos(eps) * Math.sin(lam), z: R * Math.sin(eps) * Math.sin(lam) };
  }

  function sunlit(eci, date) {
    const s = sunEci(date);
    const sl = Math.hypot(s.x, s.y, s.z);
    const u = { x: s.x / sl, y: s.y / sl, z: s.z / sl };
    const dot = eci.x * u.x + eci.y * u.y + eci.z * u.z;
    if (dot > 0) return true;
    const px = eci.x - dot * u.x, py = eci.y - dot * u.y, pz = eci.z - dot * u.z;
    return Math.hypot(px, py, pz) > RE_KM;
  }

  // Find passes between start and start+hours with max elevation >= minEl.
  function findPasses(satrec, obs, start, hours, minEl) {
    const STEP = 30e3;
    const end = start + hours * 3600e3;
    const elAt = t => { const l = look(satrec, new Date(t), obs); return l ? l.el : -90; };
    const bisect = (lo, hi, risingEdge) => {
      // lo/hi bracket the horizon crossing; return time near el = 0
      for (let i = 0; i < 20 && hi - lo > 500; i++) {
        const mid = (lo + hi) / 2;
        const above = elAt(mid) > 0;
        if (above === risingEdge) hi = mid; else lo = mid;
      }
      return Math.round((lo + hi) / 2);
    };
    const passes = [];
    let t = start;
    let prevEl = elAt(t);
    if (Number.isNaN(prevEl)) return passes;
    let aos = null;
    let inProgress = prevEl > 0;
    if (inProgress) {
      // Already up: walk back to the real rise time.
      let b = start;
      while (elAt(b - STEP) > 0 && start - b < 3 * 3600e3) b -= STEP;
      aos = bisect(b - STEP, b, true);
    }
    let maxEl = prevEl, maxT = t;
    while (t < end + 3600e3) {   // allow a pass that starts in-window to finish
      const nt = t + STEP;
      const el = elAt(nt);
      if (aos === null) {
        if (prevEl <= 0 && el > 0) {
          if (nt > end) break;
          aos = bisect(t, nt, true); maxEl = el; maxT = nt;
        }
      } else {
        if (el > maxEl) { maxEl = el; maxT = nt; }
        if (el <= 0) {
          const los = bisect(t, nt, false);
          // refine TCA (golden-section-ish around the best sample)
          let lo = Math.max(aos, maxT - STEP), hi = Math.min(los, maxT + STEP);
          for (let i = 0; i < 25 && hi - lo > 1000; i++) {
            const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
            if (elAt(m1) < elAt(m2)) lo = m1; else hi = m2;
          }
          const tca = Math.round((lo + hi) / 2);
          const tcaEl = elAt(tca);
          if (Math.max(tcaEl, maxEl) >= minEl) passes.push(buildPass(satrec, obs, aos, tca, los, inProgress));
          aos = null; inProgress = false;
        }
      }
      prevEl = el; t = nt;
    }
    return passes;
  }

  function buildPass(satrec, obs, aos, tca, los, inProgress) {
    const at = t => look(satrec, new Date(t), obs);
    const A = at(aos), T = at(tca), L = at(los);
    const track = [];
    const step = Math.max(5e3, (los - aos) / 60);
    for (let t = aos; t <= los; t += step) { const l = at(t); if (l) track.push({ az: l.az, el: Math.max(0, l.el) }); }
    track.push({ az: L.az, el: 0 });
    return {
      aos, tca, los, inProgress,
      aosAz: A.az, tcaAz: T.az, losAz: L.az, maxEl: T.el,
      rr: { aos: rangeRate(satrec, aos + 2000, obs), tca: rangeRate(satrec, tca, obs), los: rangeRate(satrec, los - 2000, obs) },
      sun: { aos: sunlit(A.eci, new Date(aos)), tca: sunlit(T.eci, new Date(tca)), los: sunlit(L.eci, new Date(los)) },
      track,
    };
  }

  // Doppler: what to listen on (downlink) and transmit on (uplink).
  const rxFreq = (f, rr) => f * (1 - rr / C_KMS);
  const txFreq = (f, rr) => f / (1 - rr / C_KMS);

  // ---------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------
  const state = {
    loc: store.get(LS.loc),
    tle: null, tleAt: 0, tleStale: false,
    tx: null, txAt: 0,
    amsat: null, amsatAt: 0, amsatCat: null, amsatCatAt: 0,
    prefs: Object.assign({ minEl: 10, hours: 24, show: 'curated', heardOnly: false }, store.get(LS.prefs) || {}),
    passes: [],
    computedAt: 0,
    syncing: false,
  };

  function txFor(norad) {
    return (state.tx || []).filter(t => t.n === norad);
  }

  // Which satellites to predict, with their display info.
  function satList() {
    const list = [];
    const showFM = state.prefs.show !== 'linear';
    const showLin = state.prefs.show !== 'fm';
    for (const s of CURATED) {
      if ((s.type === 'FM' && !showFM) || (s.type === 'Linear' && !showLin)) continue;
      if (state.tle && state.tle.has(s.norad)) list.push({ ...s, tle: state.tle.get(s.norad) });
    }
    if (state.prefs.show === 'all' && state.tle && state.tx) {
      const twoWay = new Set(state.tx.filter(t => t.ul && (/transp|transc/i.test(t.ty))).map(t => t.n));
      for (const [norad, tle] of state.tle) {
        if (CURATED_BY_ID.has(norad) || !twoWay.has(norad)) continue;
        const name = tle.name.replace(/\s+/g, ' ');
        list.push({ norad, name, type: 'Other', tle, live: true, note: 'From SatNOGS live data. Check status before you call CQ.' });
      }
    }
    if (state.prefs.heardOnly && state.amsat) return list.filter(s => heardRecently(s) !== false);
    return list;
  }

  function computeAll() {
    if (!state.loc || !state.tle) { state.passes = []; return; }
    const obs = makeObserver(state.loc);
    const now = Date.now();
    const out = [];
    for (const sat of satList()) {
      let satrec;
      try { satrec = S.twoline2satrec(sat.tle.l1, sat.tle.l2); } catch (e) { continue; }
      if (!satrec || satrec.error) continue;
      let ps = [];
      try { ps = findPasses(satrec, obs, now, state.prefs.hours, state.prefs.minEl); } catch (e) { ps = []; }
      for (const p of ps) out.push({ sat, satrec, ...p });
    }
    out.sort((a, b) => a.aos - b.aos);
    state.passes = out;
    state.computedAt = now;
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function polarSvg(p, live) {
    const R = 70, cx = 80, cy = 80;
    const xy = (az, el) => {
      const r = R * (1 - el / 90);
      return [cx + r * Math.sin(az * RAD), cy - r * Math.cos(az * RAD)];
    };
    const path = p.track.map((pt, i) => { const [x, y] = xy(pt.az, pt.el); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
    const [ax, ay] = xy(p.aosAz, 0);
    const [lx, ly] = xy(p.losAz, 0);
    const [tx, ty] = xy(p.tcaAz, Math.max(0, p.maxEl));
    let liveDot = '';
    if (live) { const [x, y] = xy(live.az, Math.max(0, live.el)); liveDot = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" class="pp-live"/>`; }
    return `<svg class="polar" viewBox="0 0 160 160" role="img" aria-label="Sky track: rises ${compass(p.aosAz)}, highest ${Math.round(p.maxEl)} degrees ${compass(p.tcaAz)}, sets ${compass(p.losAz)}">
      <circle cx="80" cy="80" r="70" class="pp-ring"/>
      <circle cx="80" cy="80" r="46.7" class="pp-ring"/>
      <circle cx="80" cy="80" r="23.3" class="pp-ring"/>
      <line x1="80" y1="10" x2="80" y2="150" class="pp-ring"/>
      <line x1="10" y1="80" x2="150" y2="80" class="pp-ring"/>
      <text x="80" y="8" class="pp-lbl">N</text><text x="155" y="83" class="pp-lbl">E</text>
      <text x="80" y="159" class="pp-lbl">S</text><text x="5" y="83" class="pp-lbl">W</text>
      <path d="${path}" class="pp-track"/>
      <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="4" class="pp-aos"/>
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" class="pp-los"/>
      <circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="2.5" class="pp-tca"/>
      ${liveDot}
    </svg>`;
  }

  function freqRows(sat, rr) {
    // rr: {aos, tca, los} range rates
    const cols = ['aos', 'tca', 'los'];
    if (sat.type === 'FM') {
      const up = cols.map(c => `<td>${mhz(txFreq(sat.up, rr[c]))}</td>`).join('');
      const dn = cols.map(c => `<td>${mhz(rxFreq(sat.down, rr[c]))}</td>`).join('');
      return `<tr><th scope="row">Transmit (up)<span class="sub">${mhz(sat.up)} FM${sat.tone ? `, ${sat.tone.toFixed(1)} Hz tone` : ', no tone'}</span></th>${up}</tr>
              <tr><th scope="row">Listen (down)<span class="sub">${mhz(sat.down)} FM</span></th>${dn}</tr>`;
    }
    if (sat.type === 'Linear') {
      const uc = (sat.upLo + sat.upHi) / 2, dc = (sat.downLo + sat.downHi) / 2;
      const up = cols.map(c => `<td>${mhz(txFreq(uc, rr[c]))}</td>`).join('');
      const dn = cols.map(c => `<td>${mhz(rxFreq(dc, rr[c]))}</td>`).join('');
      return `<tr><th scope="row">Transmit (up)<span class="sub">${mhz(sat.upLo)}-${mhz(sat.upHi)} ${sat.upMode}, center shown</span></th>${up}</tr>
              <tr><th scope="row">Listen (down)<span class="sub">${mhz(sat.downLo)}-${mhz(sat.downHi)} ${sat.downMode}, center shown</span></th>${dn}</tr>`;
    }
    return '';
  }

  function liveTxHtml(norad) {
    const list = txFor(norad);
    if (!list.length) return '<p class="muted small">No active transmitters listed in SatNOGS for this satellite.</p>';
    const f = v => (v ? mhz(v / 1e6) : '');
    const rows = list.map(t => {
      const up = t.ul ? (t.uh && t.uh !== t.ul ? `${f(t.ul)}-${f(t.uh)}` : f(t.ul)) : '';
      const dn = t.dl ? (t.dh && t.dh !== t.dl ? `${f(t.dl)}-${f(t.dh)}` : f(t.dl)) : '';
      return `<tr><td>${esc(t.d)}</td><td>${esc(t.m)}${t.inv ? ' (inv)' : ''}</td><td>${up || '-'}</td><td>${dn || '-'}</td></tr>`;
    }).join('');
    return `<div class="tablewrap"><table class="txtable"><thead><tr><th>Transmitter</th><th>Mode</th><th>Up MHz</th><th>Down MHz</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function sunNote(p, sat) {
    const all = p.sun.aos && p.sun.tca && p.sun.los;
    const none = !p.sun.aos && !p.sun.tca && !p.sun.los;
    const txt = all ? 'in sunlight the whole pass' : none ? 'in eclipse (Earth\'s shadow) the whole pass' : 'goes in or out of eclipse during the pass';
    const warn = sat.sunOnly && !all;
    return `<span class="${warn ? 'warn' : 'muted'}">Satellite is ${txt}.${warn ? ' This one needs sunlight, so expect it to be off for some or all of this pass.' : ''}</span>`;
  }

  function passHtml(p, idx) {
    const s = p.sat;
    const now = Date.now();
    const live = now >= p.aos && now <= p.los;
    const badge = s.type === 'FM' ? 'FM' : s.type === 'Linear' ? 'SSB/CW' : 'Other';
    const quality = p.maxEl >= 45 ? 'great' : p.maxEl >= 25 ? 'good' : 'low';
    const sunBad = s.sunOnly && !(p.sun.aos && p.sun.tca && p.sun.los);
    return `<details class="pass ${live ? 'is-live' : ''}" data-idx="${idx}" ${live ? 'open' : ''}>
      <summary>
        <span class="p-when"><strong>${fmtTime(new Date(p.aos))}</strong><span class="sub">${fmtDay(new Date(p.aos))} &middot; <span class="countdown" data-aos="${p.aos}" data-los="${p.los}">${live ? 'up now' : fmtIn(p.aos - now)}</span></span></span>
        <span class="p-sat"><strong>${esc(s.name)}</strong> <span class="badge b-${badge === 'FM' ? 'fm' : badge === 'Other' ? 'oth' : 'lin'}">${badge}</span>${sunBad ? ' <span class="badge b-warn" title="Needs sunlight">eclipse</span>' : ''}${amsatBadge(s)}</span>
        <span class="p-el q-${quality}"><strong>${Math.round(p.maxEl)}&deg;</strong><span class="sub">max el</span></span>
        <span class="p-dir">${compass(p.aosAz)} &rarr; ${compass(p.losAz)}<span class="sub">${fmtDur(p.los - p.aos)} long</span></span>
      </summary>
      <div class="p-body">
        <div class="p-plot">${polarSvg(p, live ? look(p.satrec, new Date(), makeObserver(state.loc)) : null)}
          <div class="legend"><span class="dot aos"></span>rise <span class="dot los"></span>set${live ? ' <span class="dot livec"></span>now' : ''}</div>
        </div>
        <div class="p-info">
          ${live ? `<p class="livebox" data-live="${idx}">Point at <strong class="lv-az">--</strong> azimuth, <strong class="lv-el">--</strong> up. <span class="lv-f"></span></p>` : ''}
          <div class="tablewrap"><table class="ptable">
            <thead><tr><th></th><th>Rise</th><th>Highest</th><th>Set</th></tr></thead>
            <tbody>
              <tr><th scope="row">Time</th><td>${fmtTimeSec(new Date(p.aos))}</td><td>${fmtTimeSec(new Date(p.tca))}</td><td>${fmtTimeSec(new Date(p.los))}</td></tr>
              <tr><th scope="row">Point at (az)</th><td>${Math.round(p.aosAz)}&deg; ${compass(p.aosAz)}</td><td>${Math.round(p.tcaAz)}&deg; ${compass(p.tcaAz)}</td><td>${Math.round(p.losAz)}&deg; ${compass(p.losAz)}</td></tr>
              <tr><th scope="row">Elevation</th><td>0&deg;</td><td>${Math.round(p.maxEl)}&deg;</td><td>0&deg;</td></tr>
              ${freqRows(s, p.rr)}
            </tbody>
          </table></div>
          <p class="small">${sunNote(p, s)}</p>
          ${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}
          <details class="livetx" open><summary>AMSAT live status</summary>${amsatHtml(s)}</details>
          <details class="livetx"><summary>Live transmitter list (SatNOGS)</summary>${liveTxHtml(s.norad)}</details>
        </div>
      </div>
    </details>`;
  }

  function renderStatus() {
    const el = $('#data-status');
    const tleTxt = state.tle ? `Orbits: CelesTrak, ${fmtAgo(state.tleAt)}${state.tleStale ? ' <span class="warn">(could not refresh, using saved copy)</span>' : ''}` : 'Orbits: not loaded yet';
    const txTxt = state.tx ? `Live frequencies: SatNOGS, ${fmtAgo(state.txAt)}` : 'Live frequencies: not loaded';
    const amTxt = state.amsat ? `AMSAT status: ${fmtAgo(state.amsatAt)}` : 'AMSAT status: not loaded';
    el.innerHTML = `${tleTxt} &middot; ${amTxt} &middot; ${txTxt} &middot; Curated frequencies: ${esc(FREQ_ASOF)}`;
    $('#sync-btn').disabled = state.syncing;
    $('#sync-btn').textContent = state.syncing ? 'Syncing...' : 'Sync now';
  }

  function renderLocation() {
    const box = $('#loc-current');
    if (state.loc) {
      box.innerHTML = `<strong>${esc(state.loc.label)}</strong><span class="sub">${state.loc.lat.toFixed(4)}, ${state.loc.lon.toFixed(4)} &middot; grid ${latLonToGrid(state.loc.lat, state.loc.lon)} &middot; saved in this browser only</span>`;
      box.hidden = false;
      $('#loc-actions').hidden = false;
      $('#loc-form').classList.add('collapsed');
    } else {
      box.hidden = true;
      $('#loc-actions').hidden = true;
      $('#loc-form').classList.remove('collapsed');
    }
  }

  function renderPasses() {
    const list = $('#passes');
    $('#ics-btn').disabled = !state.passes.length;
    if (!state.loc) { list.innerHTML = '<p class="empty">Put in your address (or grid square) above and the passes show up here.</p>'; return; }
    if (!state.tle) { list.innerHTML = '<p class="empty">Loading orbit data...</p>'; return; }
    if (!state.passes.length) { list.innerHTML = `<p class="empty">No passes above ${state.prefs.minEl}&deg; in the next ${state.prefs.hours} hours. Try a lower minimum elevation.</p>`; return; }
    // remember which were open
    const open = new Set([...list.querySelectorAll('details.pass[open]')].map(d => d.dataset.key));
    let html = ''; let lastDay = '';
    state.passes.forEach((p, i) => {
      const day = fmtDay(new Date(p.aos));
      if (day !== lastDay) { html += `<h3 class="dayhdr">${day}</h3>`; lastDay = day; }
      html += passHtml(p, i);
    });
    list.innerHTML = html;
    list.querySelectorAll('details.pass').forEach(d => {
      const p = state.passes[Number(d.dataset.idx)];
      d.dataset.key = `${p.sat.norad}-${p.aos}`;
      if (open.has(d.dataset.key)) d.open = true;
    });
    tick();
  }

  function renderAll() { renderLocation(); renderStatus(); renderPasses(); }

  // Updates countdowns and the live "point here" box every second.
  function tick() {
    const now = Date.now();
    document.querySelectorAll('.countdown').forEach(el => {
      const aos = Number(el.dataset.aos), los = Number(el.dataset.los);
      el.textContent = now < aos ? fmtIn(aos - now) : now <= los ? `up now, sets in ${fmtDur(los - now)}` : 'over';
    });
    if (!state.loc) return;
    const obs = makeObserver(state.loc);
    document.querySelectorAll('.livebox').forEach(box => {
      const p = state.passes[Number(box.dataset.live)];
      if (!p) return;
      const l = look(p.satrec, new Date(now), obs);
      if (!l || now > p.los) { box.textContent = 'Pass is over.'; return; }
      box.querySelector('.lv-az').textContent = `${Math.round(l.az)}\u00b0 ${compass(l.az)}`;
      box.querySelector('.lv-el').textContent = `${Math.max(0, Math.round(l.el))}\u00b0`;
      const rr = rangeRate(p.satrec, now, obs);
      const s = p.sat;
      let f = '';
      if (s.type === 'FM') f = `Transmit ${mhz(txFreq(s.up, rr))}, listen ${mhz(rxFreq(s.down, rr))}.`;
      else if (s.type === 'Linear') f = `Center: transmit ${mhz(txFreq((s.upLo + s.upHi) / 2, rr))}, listen ${mhz(rxFreq((s.downLo + s.downHi) / 2, rr))}.`;
      box.querySelector('.lv-f').textContent = f;
      const svgDot = box.closest('.p-body').querySelector('.pp-live');
      if (svgDot) {
        const r = 70 * (1 - Math.max(0, l.el) / 90);
        svgDot.setAttribute('cx', (80 + r * Math.sin(l.az * RAD)).toFixed(1));
        svgDot.setAttribute('cy', (80 - r * Math.cos(l.az * RAD)).toFixed(1));
      }
    });
    // A pass ended or started since the last full render: redraw.
    if (state.passes.some(p => (p.los < now && p.los > now - 1500) || (p.aos <= now && p.aos > now - 1500))) {
      computeAll(); renderPasses();
    }
  }

  // ---------------------------------------------------------------
  // Calendar export (.ics)
  // ---------------------------------------------------------------
  function icsDate(t) { return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }

  function buildIcs() {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KN0BLE//Satellite passes//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Satellite passes'];
    const stamp = icsDate(Date.now());
    for (const p of state.passes) {
      const s = p.sat;
      let freq = '';
      if (s.type === 'FM') freq = `Up ${mhz(s.up)} FM${s.tone ? ` ${s.tone} Hz` : ''}, down ${mhz(s.down)}`;
      else if (s.type === 'Linear') freq = `Up ${mhz(s.upLo)}-${mhz(s.upHi)} ${s.upMode}, down ${mhz(s.downLo)}-${mhz(s.downHi)} ${s.downMode}`;
      const desc = [
        `Rise ${fmtTimeSec(new Date(p.aos))} at ${Math.round(p.aosAz)} deg ${compass(p.aosAz)}`,
        `Highest ${Math.round(p.maxEl)} deg at ${fmtTimeSec(new Date(p.tca))}, az ${Math.round(p.tcaAz)} deg ${compass(p.tcaAz)}`,
        `Set ${fmtTimeSec(new Date(p.los))} at ${Math.round(p.losAz)} deg ${compass(p.losAz)}`,
        freq, s.note || '', 'https://kn0ble.com/space/',
      ].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT',
        `UID:${s.norad}-${p.aos}@kn0ble.com`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsDate(p.aos)}`,
        `DTEND:${icsDate(p.los)}`,
        `SUMMARY:${icsEscape(`${s.name} pass, max ${Math.round(p.maxEl)}\u00b0 (${compass(p.aosAz)} to ${compass(p.losAz)})`)}`,
        `DESCRIPTION:${icsEscape(desc)}`,
        'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(s.name + ' rises in 5 minutes')}`, 'END:VALARM',
        'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    // fold long lines per RFC 5545
    return lines.map(l => {
      if (l.length <= 74) return l;
      const parts = []; for (let i = 0; i < l.length; i += 73) parts.push((i ? ' ' : '') + l.slice(i, i + 73));
      return parts.join('\r\n');
    }).join('\r\n') + '\r\n';
  }

  function downloadIcs() {
    const blob = new Blob([buildIcs()], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `satellite-passes-${new Date().toISOString().slice(0, 10)}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------
  async function sync({ force = false } = {}) {
    if (state.syncing) return;
    state.syncing = true; renderStatus();
    const now = Date.now();
    const jobs = [];
    if (force || !state.tle || now - state.tleAt > TLE_MAX_AGE_MS) {
      jobs.push(fetchTles().then(map => {
        state.tle = map; state.tleAt = Date.now(); state.tleStale = false;
        store.set(LS.tle, { at: state.tleAt, text: tleToText(map) });
      }).catch(() => { state.tleStale = !!state.tle; }));
    }
    if (force || !state.tx || now - state.txAt > TX_MAX_AGE_MS) {
      jobs.push(fetchTransmitters().then(tx => {
        state.tx = tx; state.txAt = Date.now();
        store.set(LS.tx, { at: state.txAt, tx });
      }).catch(() => { /* keep old */ }));
    }
    if (force || !state.amsatCat || now - state.amsatCatAt > AMSAT_CAT_MAX_AGE_MS) {
      jobs.push(fetchAmsatCatalog().then(c => {
        state.amsatCat = c; state.amsatCatAt = Date.now();
        store.set(LS.amsatCat, { at: state.amsatCatAt, c });
      }).catch(() => { /* keep old */ }));
    }
    if (force || !state.amsat || now - state.amsatAt > AMSAT_MAX_AGE_MS) {
      jobs.push(fetchAmsatSummary().then(a => {
        state.amsat = a; state.amsatAt = Date.now();
        store.set(LS.amsat, { at: state.amsatAt, a });
      }).catch(() => { /* keep old */ }));
    }
    await Promise.all(jobs);
    state.syncing = false;
    computeAll();
    renderAll();
    if (!state.tle) $('#passes').innerHTML = '<p class="empty warn">Could not load orbit data from CelesTrak. Check your connection and press Sync now.</p>';
  }

  // ---------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------
  function init() {
    const savedTle = store.get(LS.tle);
    if (savedTle && savedTle.text) { state.tle = parseTle(savedTle.text); state.tleAt = savedTle.at || 0; }
    const savedAm = store.get(LS.amsat);
    if (savedAm && Array.isArray(savedAm.a)) { state.amsat = savedAm.a; state.amsatAt = savedAm.at || 0; }
    const savedCat = store.get(LS.amsatCat);
    if (savedCat && Array.isArray(savedCat.c)) { state.amsatCat = savedCat.c; state.amsatCatAt = savedCat.at || 0; }
    const savedTx = store.get(LS.tx);
    if (savedTx && Array.isArray(savedTx.tx)) { state.tx = savedTx.tx; state.txAt = savedTx.at || 0; }

    // URL overrides: ?grid=EL98gp or ?lat=..&lon=..
    const q = new URLSearchParams(location.search);
    if (q.get('grid')) { const g = gridToLatLon(q.get('grid')); if (g) state.loc = { ...g, label: `Grid ${q.get('grid').toUpperCase()}`, source: 'grid' }; }
    else if (q.get('lat') && q.get('lon')) {
      const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) state.loc = { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, source: 'coords' };
    }

    $('#min-el').value = String(state.prefs.minEl);
    $('#hours').value = String(state.prefs.hours);
    $('#show').value = state.prefs.show;
    $('#heard-only').checked = !!state.prefs.heardOnly;

    const savePrefs = () => {
      state.prefs = { minEl: Number($('#min-el').value), hours: Number($('#hours').value), show: $('#show').value, heardOnly: $('#heard-only').checked };
      store.set(LS.prefs, state.prefs);
      computeAll(); renderPasses();
    };
    ['#min-el', '#hours', '#show', '#heard-only'].forEach(id => $(id).addEventListener('change', savePrefs));

    $('#loc-form').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = $('#loc-msg');
      const btn = $('#loc-go');
      msg.textContent = 'Looking that up...'; msg.className = 'loc-msg';
      btn.disabled = true;
      try {
        const loc = await resolveLocation($('#loc-input').value);
        state.loc = loc; store.set(LS.loc, loc);
        msg.textContent = '';
        $('#loc-input').value = '';
        computeAll(); renderAll();
      } catch (err) {
        msg.textContent = err.message || 'Could not look that up.'; msg.className = 'loc-msg warn';
      } finally { btn.disabled = false; }
    });

    $('#loc-gps').addEventListener('click', () => {
      const msg = $('#loc-msg');
      if (!navigator.geolocation) { msg.textContent = 'This browser cannot share its location.'; return; }
      msg.textContent = 'Asking your device for its location...'; msg.className = 'loc-msg';
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lon, altitude } = pos.coords;
        state.loc = { lat, lon, altM: altitude || 0, label: 'My current location', source: 'gps' };
        store.set(LS.loc, state.loc); msg.textContent = '';
        computeAll(); renderAll();
      }, err => { msg.textContent = `Location not available (${err.message}).`; msg.className = 'loc-msg warn'; }, { enableHighAccuracy: false, timeout: 15000 });
    });

    $('#loc-change').addEventListener('click', () => {
      $('#loc-form').classList.remove('collapsed');
      $('#loc-input').focus();
    });

    $('#loc-forget').addEventListener('click', () => {
      store.del(LS.loc); state.loc = null; state.passes = []; renderAll();
    });

    $('#sync-btn').addEventListener('click', () => sync({ force: true }));
    $('#ics-btn').addEventListener('click', downloadIcs);

    computeAll();
    renderAll();
    sync();

    setInterval(tick, 1000);
    setInterval(() => { computeAll(); renderPasses(); }, RECALC_MS);
    setInterval(() => { sync(); renderStatus(); }, 10 * 60e3);   // sync() only fetches what is stale
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); } });
  }

  // Exposed for tests.
  window.KN0BLE_SPACE = { amsatFor, parseUtc, gridToLatLon, latLonToGrid, parseTle, findPasses, makeObserver, look, rxFreq, txFreq, sunlit, state, computeAll, buildIcs, refresh: () => { computeAll(); renderAll(); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
