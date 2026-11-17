/* kn0ble.com/space -- FT5DR satellite channel writer.
 *
 * Reads the radio's SD-card channel file (FT5D_MEMORY-CH/MEMORY.dat),
 * writes Doppler-stepped receive channels for the chosen satellites into
 * a RESERVED block of channels (plus one bank), and can clear that block
 * again. Nothing outside the reserved block, the chosen bank's slots and
 * the checksum is ever changed -- every export is verified byte-for-byte
 * against the original before it is offered for download.
 *
 * Runs entirely in the browser; the file is never uploaded.
 *
 * Format: FT-5D MEMORY.dat as documented by the open-source 5D Web
 * Programmer (Apache-2.0, Beaty Consultancy), and checked against a real
 * FT5DR file (Nov 2026):
 *   0x0000  bank membership, 24 banks x 100 slots x u16 BE
 *           ((memtype << 11) | index, 0xFFFF = empty)
 *   0x12C0  channel directory, 1 byte per channel (bit0 = in use)
 *   0x1800  900 channel records x 32 bytes
 *   0xAB19  checksum: 3 bytes BE = sum(file[0:0xAB19]) & 0xFFFFFF
 */
(() => {
  'use strict';

  const FILE_SIZE = 44160;
  const BANK0 = 0x0000, DIR0 = 0x12C0, REC0 = 0x1800, CK = 0xAB19;
  const NCHAN = 900, NBANK = 24, BANK_SLOTS = 100, RECLEN = 32;
  const C_KMS = 299792.458;

  const TONES = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5,
    107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7,
    159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8,
    196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1];
  const TONE_PARK = 12;          // radio stores 100.0 Hz when no tone is used
  const SQL_NAMES = { 0: 'off', 1: 'TONE', 2: 'TSQL', 3: 'DCS', 4: 'REV', 6: 'PR', 7: 'PAGER', 9: 'D-CD', 10: 'T-DCS', 11: 'D-CD-T' };

  // ------------------------------------------------------------------
  // Codec
  // ------------------------------------------------------------------
  function checksum(b) {
    let s = 0;
    for (let i = 0; i < CK; i++) s += b[i];
    return s & 0xFFFFFF;
  }
  const storedChecksum = b => (b[CK] << 16) | (b[CK + 1] << 8) | b[CK + 2];

  function bcdToKhz(b, o) {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const hi = b[o + i] >> 4, lo = b[o + i] & 15;
      if (hi > 9 || lo > 9) return null;
      v = v * 100 + hi * 10 + lo;
    }
    return v;
  }
  function khzToBcd(khz) {
    const s = String(Math.round(khz)).padStart(6, '0');
    if (s.length !== 6) throw new Error(`frequency out of range: ${khz} kHz`);
    return [0, 2, 4].map(i => (Number(s[i]) << 4) | Number(s[i + 1]));
  }

  function inUse(b, n) { return (b[DIR0 + n] & 1) === 1; }

  function decodeChannel(b, n) {
    const o = REC0 + n * RECLEN;
    const nameBytes = [];
    for (let i = 8; i < 24 && b[o + i] !== 0xFF; i++) nameBytes.push(b[o + i]);
    const khz = bcdToKhz(b, o + 2);
    return {
      n, num: n + 1,
      khz, mhz: khz == null ? null : khz / 1000,
      name: String.fromCharCode(...nameBytes).replace(/[^\x20-\x7e]/g, '?'),
      shiftDir: (b[o + 1] >> 4) & 3,
      sql: b[o + 5] & 15,
      tone: TONES[b[o + 27]] ?? null,
    };
  }

  function parse(buf) {
    const b = new Uint8Array(buf);
    const problems = [];
    if (b.length !== FILE_SIZE) problems.push(`File is ${b.length.toLocaleString()} bytes; an FT5D MEMORY.dat is exactly ${FILE_SIZE.toLocaleString()}. Make sure you picked FT5D_MEMORY-CH/MEMORY.dat (not BACKUP.dat).`);
    if (!problems.length) {
      const st = storedChecksum(b), calc = checksum(b);
      if (st !== calc) problems.push(`Checksum does not match (stored ${st.toString(16)}, computed ${calc.toString(16)}). The file may be damaged; write it to SD again from the radio.`);
    }
    if (problems.length) return { ok: false, problems };
    const channels = [];
    for (let n = 0; n < NCHAN; n++) if (inUse(b, n)) channels.push(decodeChannel(b, n));
    const bad = channels.filter(c => c.khz == null);
    if (bad.length) return { ok: false, problems: [`${bad.length} channel(s) have unreadable frequencies; this does not look like an FT5D file.`] };
    const banks = [];
    for (let k = 0; k < NBANK; k++) banks.push(bankEntries(b, k));
    return { ok: true, bytes: b, channels, banks };
  }

  function bankEntries(b, k) {
    const out = [];
    for (let s = 0; s < BANK_SLOTS; s++) {
      const o = BANK0 + (k * BANK_SLOTS + s) * 2;
      const v = (b[o] << 8) | b[o + 1];
      if (v !== 0xFFFF) out.push(v);
    }
    return out;
  }
  function writeBank(b, k, entries) {
    for (let s = 0; s < BANK_SLOTS; s++) {
      const o = BANK0 + (k * BANK_SLOTS + s) * 2;
      const v = s < entries.length ? entries[s] : 0xFFFF;
      b[o] = v >> 8; b[o + 1] = v & 0xFF;
    }
  }

  // Analog FM receive channel, in the layout the radio itself writes.
  function encodeChannel({ khz, name, toneHz = null, sql = 0, stepIdx = 0 }) {
    const r = new Uint8Array(RECLEN);
    const mhz = khz / 1000;
    r[0] = mhz >= 300 ? 3 : (mhz >= 137 ? 2 : 1);           // band type
    r[1] = stepIdx & 15;                                     // simplex, FM
    r.set(khzToBcd(khz), 2);
    r[5] = (sql & 15) | (3 << 6);                            // analog, high power
    const nm = name.replace(/[^\x20-\x7e]/g, '').slice(0, 16);
    for (let i = 0; i < 16; i++) r[8 + i] = i < nm.length ? nm.charCodeAt(i) : 0xFF;
    r.set(khzToBcd(mhz >= 300 ? 5000 : 600), 24);            // default shift amount (radio stores it on simplex too)
    r[27] = toneHz == null ? TONE_PARK : TONES.indexOf(toneHz);
    if (r[27] < 0) throw new Error(`unsupported tone ${toneHz}`);
    r[28] = 0;
    r[29] = 0x0D;
    r[30] = 0;
    r[31] = 0x18;
    return r;
  }

  function clearSlot(b, n) {
    b[DIR0 + n] = 0;
    b.fill(0xFF, REC0 + n * RECLEN, REC0 + (n + 1) * RECLEN);
  }

  // Build a new file. plan = { start (1-based), size, bank (1-based|0), channels: [...] }
  // channels empty -> just clears the block.
  function build(orig, plan) {
    const b = new Uint8Array(orig);           // copy
    const first = plan.start - 1, last = first + plan.size - 1;
    if (first < 0 || last >= NCHAN) throw new Error('Reserved block is outside channels 1-900.');
    if (plan.channels.length > plan.size) throw new Error(`${plan.channels.length} channels do not fit in a block of ${plan.size}.`);
    for (let n = first; n <= last; n++) clearSlot(b, n);
    plan.channels.forEach((ch, i) => {
      const n = first + i;
      b.set(encodeChannel(ch), REC0 + n * RECLEN);
      b[DIR0 + n] = 0x03;
    });
    // Banks: drop any entry pointing into the block, from every bank;
    // then add the new channels to the chosen bank.
    for (let k = 0; k < NBANK; k++) {
      const before = bankEntries(b, k);
      const kept = before.filter(v => !((v >> 11) === 0 && (v & 0x7FF) >= first && (v & 0x7FF) <= last));
      if (k === plan.bank - 1) plan.channels.forEach((_, i) => kept.push(first + i));
      if (kept.length > BANK_SLOTS) throw new Error(`Bank ${k + 1} would have more than ${BANK_SLOTS} channels.`);
      if (kept.length !== before.length || k === plan.bank - 1) writeBank(b, k, kept);
    }
    const ck = checksum(b);
    b[CK] = ck >> 16; b[CK + 1] = (ck >> 8) & 0xFF; b[CK + 2] = ck & 0xFF;
    verify(orig, b, plan);
    return b;
  }

  // Refuse to hand out a file unless everything outside the allowed
  // regions is byte-identical and the result parses back as planned.
  function verify(orig, out, plan) {
    const first = plan.start - 1, last = first + plan.size - 1;
    const allowed = i =>
      (i >= BANK0 && i < BANK0 + NBANK * BANK_SLOTS * 2) ||
      (i >= DIR0 + first && i <= DIR0 + last) ||
      (i >= REC0 + first * RECLEN && i < REC0 + (last + 1) * RECLEN) ||
      (i >= CK && i < CK + 3);
    if (out.length !== FILE_SIZE) throw new Error('internal: size changed');
    for (let i = 0; i < FILE_SIZE; i++) {
      if (out[i] !== orig[i] && !allowed(i)) throw new Error(`internal: byte 0x${i.toString(16)} outside the reserved block changed; refusing to export.`);
    }
    // Banks: entries outside the block must be untouched, in order.
    for (let k = 0; k < NBANK; k++) {
      const strip = arr => arr.filter(v => !((v >> 11) === 0 && (v & 0x7FF) >= first && (v & 0x7FF) <= last));
      const a = strip(bankEntries(orig, k)), z = strip(bankEntries(out, k));
      if (a.length !== z.length || a.some((v, i) => v !== z[i])) throw new Error(`internal: bank ${k + 1} lost or reordered your own channels; refusing to export.`);
    }
    const p = parse(out);
    if (!p.ok) throw new Error('internal: result does not re-read: ' + p.problems.join(' '));
    const inBlock = p.channels.filter(c => c.n >= first && c.n <= last);
    if (inBlock.length !== plan.channels.length) throw new Error('internal: channel count mismatch after write.');
    plan.channels.forEach((ch, i) => {
      const c = inBlock[i];
      if (c.n !== first + i || c.khz !== Math.round(ch.khz)) throw new Error(`internal: channel ${first + i + 1} read back wrong.`);
    });
    const outside = ch => ch.n < first || ch.n > last;
    const a = parse(orig).channels.filter(outside), z = p.channels.filter(outside);
    if (a.length !== z.length) throw new Error('internal: your own channels changed; refusing to export.');
  }

  // ------------------------------------------------------------------
  // Satellite channel plan
  // ------------------------------------------------------------------
  // Steps on the 70 cm side, in the order you click through them:
  // rise (satellite approaching, signal high) -> set (low).
  const STEPS_70CM = [10, 5, 0, -5, -10];

  function shortName(name) { return name.replace(/\s+/g, ''); }

  // FT5DR (receive radio): downlink channels.
  function rxChannelsFor(sat) {
    const name = shortName(sat.name);
    const downKhz = Math.round(sat.down * 1000);
    if (sat.down >= 300) {
      return STEPS_70CM.map(s => ({
        khz: downKhz + s, name: `${name} ${s > 0 ? '+' : ''}${s === 0 ? 'mid' : s}`.slice(0, 16),
        stepIdx: 0, label: s > 0 ? 'rise' : s === 0 ? 'overhead' : 'set', offset: s,
      }));
    }
    // 2 m downlink: Doppler is only about +/-3 kHz, one channel covers it.
    return [{ khz: downKhz, name: `${name} dn`.slice(0, 16), stepIdx: 0, label: 'whole pass', offset: 0 }];
  }

  // Alinco (transmit radio): uplink channels to enter by hand.
  function txChannelsFor(sat) {
    const upKhz = Math.round(sat.up * 1000);
    const rows = [];
    if (sat.norad === 27607) rows.push({ khz: upKhz, tone: 74.4, note: 'Arm the timer first: key up 2 s on this one' });
    if (sat.up >= 300) {
      // 70 cm uplink: you transmit LOW early (satellite hears you shifted up), HIGH late.
      STEPS_70CM.forEach(s => rows.push({ khz: upKhz - s, tone: sat.tone, note: s > 0 ? 'rise' : s === 0 ? 'overhead' : 'set' }));
    } else {
      rows.push({ khz: upKhz, tone: sat.tone, note: 'whole pass' });
    }
    return rows;
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mhzStr = khz => (khz / 1000).toFixed(3);
  const LS_PREFS = 'kn0ble.space.ft5d.v1';
  const LS_ORIG = 'kn0ble.space.ft5d.orig.v1';

  const ui = { file: null, fileName: '', parsed: null, out: null, prefs: null };

  function loadPrefs() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(LS_PREFS)); } catch (e) { /* ignore */ }
    return Object.assign({ start: 801, size: 100, bank: 24, birds: null }, p || {});
  }
  function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify(ui.prefs)); } catch (e) { /* ignore */ } }

  function fmSats() {
    const K = window.KN0BLE_SPACE;
    return (K && K.CURATED ? K.CURATED : []).filter(s => s.type === 'FM');
  }

  function amsatTag(sat) {
    const K = window.KN0BLE_SPACE;
    if (!K || !K.amsatFor) return '';
    const a = K.amsatFor(sat);
    if (!a || a.none || !a.latest) return '';
    const cls = { 'Heard': 'st-heard', 'Telemetry Only': 'st-tlm', 'Not Heard': 'st-not', 'Crew Active': 'st-crew' }[a.latest.report] || 'st-none';
    return ` <span class="badge ${cls}">${esc(a.latest.report)}</span>`;
  }

  function selectedSats() {
    return fmSats().filter(s => $(`#ft5d-bird-${s.norad}`) && $(`#ft5d-bird-${s.norad}`).checked);
  }

  function renderBirds() {
    const box = $('#ft5d-birds');
    const want = ui.prefs.birds ? new Set(ui.prefs.birds) : null;
    box.innerHTML = fmSats().map(s => {
      const checked = want ? want.has(s.norad) : true;
      const n = rxChannelsFor(s).length;
      return `<label class="bird"><input type="checkbox" id="ft5d-bird-${s.norad}" value="${s.norad}" ${checked ? 'checked' : ''}>
        <strong>${esc(s.name)}</strong>${amsatTag(s)} <span class="muted small">${n} ch, listen ${s.down.toFixed(3)}</span></label>`;
    }).join('');
    box.querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
      ui.prefs.birds = selectedSats().map(s => s.norad); savePrefs(); renderPlan();
    }));
  }

  function plan() {
    const channels = [];
    for (const s of selectedSats()) for (const c of rxChannelsFor(s)) channels.push({ ...c, sat: s });
    return { start: ui.prefs.start, size: ui.prefs.size, bank: ui.prefs.bank, channels };
  }

  function msg(html, kind = '') { const m = $('#ft5d-msg'); m.innerHTML = html; m.className = `ft5d-msg ${kind}`; }

  function renderFileInfo() {
    const box = $('#ft5d-file');
    if (!ui.parsed) { box.innerHTML = ''; return; }
    const p = ui.parsed;
    const usedBanks = p.banks.map((e, i) => e.length ? `${i + 1} (${e.length})` : null).filter(Boolean);
    box.innerHTML = `<p><strong>${esc(ui.fileName)}</strong>: checksum OK, ${p.channels.length} channels in use, banks in use: ${usedBanks.join(', ') || 'none'}.
      <button type="button" class="linkbtn" id="ft5d-dl-orig">Download an untouched copy</button></p>`;
    $('#ft5d-dl-orig').addEventListener('click', () => download(ui.file, `MEMORY-original-${stamp()}.dat`));
  }

  function renderPlan() {
    const p = ui.parsed;
    const pl = plan();
    const out = $('#ft5d-plan');
    $('#ft5d-build').disabled = true; $('#ft5d-clear').disabled = true;
    if (!p) { out.innerHTML = ''; return; }
    const first = pl.start - 1, last = first + pl.size - 1;
    const inBlock = p.channels.filter(c => c.n >= first && c.n <= last);
    const theirs = inBlock.filter(c => !isOurs(c));
    const bankOthers = (p.banks[pl.bank - 1] || []).filter(v => !((v >> 11) === 0 && (v & 0x7FF) >= first && (v & 0x7FF) <= last));
    const problems = [];
    if (pl.channels.length > pl.size) problems.push(`${pl.channels.length} channels will not fit in ${pl.size} slots. Make the block bigger or pick fewer birds.`);
    if (theirs.length) problems.push(`Channels ${pl.start}-${pl.start + pl.size - 1} already hold ${theirs.length} of your own channels (${theirs.slice(0, 4).map(c => `${c.num} "${esc(c.name)}"`).join(', ')}${theirs.length > 4 ? '...' : ''}). Pick an empty block so they are not overwritten.`);
    if (bankOthers.length) problems.push(`Bank ${pl.bank} already has ${bankOthers.length} of your own channels. Pick an empty bank so the satellite list stays separate.`);
    const rows = pl.channels.map((c, i) => `<tr><td>${pl.start + i}</td><td>${esc(c.name)}</td><td>${mhzStr(c.khz)}</td><td>${esc(c.label)}</td></tr>`).join('');
    out.innerHTML = `
      ${problems.length ? `<div class="warnbox">${problems.map(x => `<p>${x}</p>`).join('')}</div>` : ''}
      <p class="small">Writes <strong>${pl.channels.length}</strong> receive channels to <strong>${pl.start}-${pl.start + Math.max(pl.channels.length, 1) - 1}</strong> and puts them in <strong>bank ${pl.bank}</strong>.
      ${inBlock.length ? `Replaces the ${inBlock.length} satellite channel(s) already in that block.` : 'That block is empty now.'}
      Everything else in the radio stays exactly as it is.</p>
      <details class="livetx"><summary>Show the channels</summary><div class="tablewrap"><table class="txtable">
        <thead><tr><th>Ch</th><th>Name</th><th>MHz</th><th>Use at</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
    $('#ft5d-build').disabled = !!problems.length || !pl.channels.length;
    $('#ft5d-clear').disabled = !!theirs.length || !inBlock.length;
    renderAlinco();
  }

  // A channel in the block counts as "ours" if it looks like one we wrote.
  // Only exact names this tool writes (e.g. "SO-50 +10", "AO-91 dn"), so
  // hand-made channels like "SO-50 Up" are never treated as ours.
  function isOurs(c) {
    return fmSats().some(s => rxChannelsFor(s).some(x => x.name === c.name));
  }

  function renderAlinco() {
    const sats = selectedSats();
    const box = $('#ft5d-alinco');
    if (!sats.length) { box.innerHTML = ''; return; }
    const rows = [];
    for (const s of sats) for (const r of txChannelsFor(s)) {
      rows.push(`<tr><td>${esc(s.name)}</td><td>${mhzStr(r.khz)}</td><td>${r.tone ? r.tone.toFixed(1) + ' Hz' : 'none'}</td><td>${esc(r.note)}</td></tr>`);
    }
    box.innerHTML = `<div class="tablewrap"><table class="txtable"><thead><tr><th>Bird</th><th>Transmit MHz</th><th>Tone (TONE, not TSQL)</th><th>Use at</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function stamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`; }

  function download(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function rememberOriginal(bytes) {
    // Keep the most recent untouched file in this browser as a safety copy.
    try {
      let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      localStorage.setItem(LS_ORIG, JSON.stringify({ at: Date.now(), name: ui.fileName, b64: btoa(s) }));
    } catch (e) { /* storage full or blocked: the download button still works */ }
  }

  async function onFile(f) {
    ui.fileName = f.name; ui.out = null;
    const buf = await f.arrayBuffer();
    const p = parse(buf);
    if (!p.ok) {
      ui.parsed = null; ui.file = null;
      msg(p.problems.map(esc).join('<br>'), 'warn'); renderFileInfo(); renderPlan(); return;
    }
    ui.file = p.bytes; ui.parsed = p;
    rememberOriginal(p.bytes);
    msg('');
    renderFileInfo(); renderPlan();
  }

  function doBuild(clearOnly) {
    try {
      const pl = plan();
      if (clearOnly) pl.channels = [];
      const out = build(ui.file, pl);
      download(out, 'MEMORY.dat');
      msg(`${clearOnly ? `Cleared channels ${pl.start}-${pl.start + pl.size - 1}.` : `Wrote ${pl.channels.length} channels.`} Checked: only the reserved block, bank ${pl.bank} and the checksum changed.
        Now copy <strong>MEMORY.dat</strong> into <strong>FT5D_MEMORY-CH</strong> on the card (replace the old one), then do the radio steps below.`, 'ok');
    } catch (e) {
      msg(esc(e.message || String(e)), 'warn');
    }
  }

  function init() {
    if (!$('#ft5d')) return;
    ui.prefs = loadPrefs();
    $('#ft5d-start').value = ui.prefs.start;
    $('#ft5d-size').value = ui.prefs.size;
    $('#ft5d-bank').value = ui.prefs.bank;
    const onCfg = () => {
      ui.prefs.start = Math.min(900, Math.max(1, Number($('#ft5d-start').value) || 801));
      ui.prefs.size = Math.min(900 - ui.prefs.start + 1, Math.max(1, Number($('#ft5d-size').value) || 100));
      ui.prefs.bank = Math.min(24, Math.max(1, Number($('#ft5d-bank').value) || 24));
      savePrefs(); renderPlan();
    };
    ['#ft5d-start', '#ft5d-size', '#ft5d-bank'].forEach(id => $(id).addEventListener('change', onCfg));
    const input = $('#ft5d-input');
    input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
    const drop = $('#ft5d-drop');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
    $('#ft5d-build').addEventListener('click', () => doBuild(false));
    $('#ft5d-clear').addEventListener('click', () => doBuild(true));
    $('#ft5d-all').addEventListener('click', () => { fmSats().forEach(s => { $(`#ft5d-bird-${s.norad}`).checked = true; }); ui.prefs.birds = null; savePrefs(); renderPlan(); });
    $('#ft5d-heard').addEventListener('click', () => {
      const K = window.KN0BLE_SPACE;
      fmSats().forEach(s => {
        const a = K && K.amsatFor ? K.amsatFor(s) : null;
        const heard = a && !a.none && a.modes.some(m => (m.counts['Heard'] || 0) + (m.counts['Crew Active'] || 0) > 0);
        $(`#ft5d-bird-${s.norad}`).checked = !!heard;
      });
      ui.prefs.birds = selectedSats().map(s => s.norad); savePrefs(); renderPlan();
    });
    renderBirds(); renderPlan();
    // AMSAT tags arrive after the first sync; refresh the bird list once they do.
    setTimeout(renderBirds, 4000);
  }

  window.KN0BLE_FT5D = { parse, build, encodeChannel, decodeChannel, checksum, rxChannelsFor, txChannelsFor, FILE_SIZE };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
