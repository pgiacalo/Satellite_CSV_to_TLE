/*
 * converter.js — CelesTrak OMM CSV  ->  NORAD two-line element set (TLE)
 *
 * Pure, dependency-free. Works both in the browser (attaches window.CSVtoTLE)
 * and in Node (module.exports) so the same code path is unit-tested.
 *
 * Input  : CelesTrak "GP" data in CSV / OMM format, e.g.
 *          https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv
 * Output : Standard 3-line TLE text (name line + line 1 + line 2), NORAD compatible.
 */
(function (global) {
  'use strict';

  // ---- CSV parsing (RFC-4180-ish: handles quoted fields & embedded commas) ----
  function parseCSV(text) {
    // Strip a UTF-8 BOM if present and normalise line endings.
    text = text.replace(/^﻿/, '');
    const rows = [];
    let field = '';
    let record = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        record.push(field); field = '';
      } else if (c === '\r') {
        // swallow; handled by the \n that (usually) follows
      } else if (c === '\n') {
        record.push(field); field = '';
        rows.push(record); record = [];
      } else {
        field += c;
      }
    }
    // flush trailing field/record if the file didn't end with a newline
    if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record); }

    // drop fully-empty rows (e.g. trailing blank line)
    const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ''));
    if (nonEmpty.length === 0) return { header: [], rows: [] };

    const header = nonEmpty[0].map(h => h.trim());
    const body = nonEmpty.slice(1).map(r => {
      const obj = {};
      header.forEach((h, idx) => { obj[h.toUpperCase()] = (r[idx] !== undefined ? r[idx].trim() : ''); });
      return obj;
    });
    return { header, rows: body };
  }

  // ---- formatting helpers -----------------------------------------------------

  // Fixed-width, right-justified decimal (used for angles & mean motion).
  function fixed(value, width, decimals) {
    let s = Number(value).toFixed(decimals);
    if (s.length > width) {
      // Shouldn't happen for valid orbital elements; guard against overflow.
      throw new Error('Value ' + value + ' does not fit in field width ' + width);
    }
    return s.padStart(width, ' ');
  }

  // ndot/2 field, cols 34-43 (10 chars): sign + ".dddddddd" (leading 0 dropped).
  function formatNdot(value) {
    const sign = value < 0 ? '-' : ' ';
    const a = Math.abs(Number(value)).toFixed(8); // "0.00008515"
    return sign + a.substring(1);                 // drop the leading "0"
  }

  // Assumed-decimal exponential field, 8 chars (used for BSTAR & nddot/6).
  // e.g. 0.00016079419 -> " 16079-3" ,  0 -> " 00000+0"
  function formatExp(value) {
    value = Number(value);
    if (!isFinite(value) || value === 0) return ' 00000+0';
    const sign = value < 0 ? '-' : ' ';
    let v = Math.abs(value);
    let exp = 0;
    while (v >= 1)   { v /= 10; exp++; }
    while (v < 0.1)  { v *= 10; exp--; }
    let mant = Math.round(v * 1e5);     // 5 significant digits
    if (mant >= 100000) { mant = Math.round(mant / 10); exp++; } // rounding carry
    const mantStr = String(mant).padStart(5, '0');
    const expSign = exp < 0 ? '-' : '+';
    const expDigit = String(Math.min(9, Math.abs(exp)));
    return sign + mantStr + expSign + expDigit;
  }

  // Eccentricity, cols 27-33 (7 chars): 7 assumed-decimal digits, e.g. 0.00072105 -> "0007210".
  // CelesTrak *truncates* the full-precision value to 7 digits (it does not round), so we do too
  // — this reproduces its published TLEs byte-for-byte. A tiny epsilon guards against a value
  // like 0.0007210 arriving as 0.00072099999999 from CSV float parsing.
  function formatEccentricity(value) {
    let n = Math.trunc(Number(value) * 1e7 + 1e-6);
    if (n < 0) n = 0;
    if (n > 9999999) n = 9999999;
    return String(n).padStart(7, '0');
  }

  // 5-digit satellite number, with Alpha-5 support for catalog numbers > 99999.
  const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // omits I and O
  function formatSatNum(id) {
    const n = parseInt(String(id).trim(), 10);
    if (isNaN(n)) return String(id).trim().padStart(5, ' ').slice(0, 5);
    if (n <= 99999) return String(n).padStart(5, '0');
    const high = Math.floor(n / 10000);
    const low = n % 10000;
    const idx = high - 10;
    if (idx < 0 || idx >= ALPHA5.length) return String(n).slice(-5); // out of Alpha-5 range
    return ALPHA5[idx] + String(low).padStart(4, '0');
  }

  // International designator from OBJECT_ID "1998-067A" -> "98067A  " (8 chars).
  function formatIntlDes(objectId) {
    const s = String(objectId || '').trim();
    const m = s.match(/^(\d{4})-(\d{1,3})([A-Za-z]{0,3})$/);
    if (!m) return '        '; // unknown / not a launch designator -> blanks
    const yy = m[1].slice(2);
    const launch = m[2].padStart(3, '0');
    const piece = (m[3] || '').toUpperCase().padEnd(3, ' ');
    return yy + launch + piece;
  }

  const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0); }

  // EPOCH "2026-08-01T11:23:00.596544" -> { yy:"26", day:"213.47431246" }
  function formatEpoch(epoch) {
    const m = String(epoch).trim().match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    if (!m) throw new Error('Unrecognised EPOCH format: ' + epoch);
    const year = +m[1], month = +m[2], dom = +m[3];
    const hour = +m[4], min = +m[5], sec = +m[6];
    const frac = m[7] ? parseFloat('0.' + m[7]) : 0;

    let doy = DAYS_BEFORE_MONTH[month - 1] + dom;
    if (month > 2 && isLeap(year)) doy += 1;

    const dayFraction = (hour * 3600 + min * 60 + sec + frac) / 86400;
    const dayFloat = doy + dayFraction;

    const yy = String(year % 100).padStart(2, '0');
    const day = dayFloat.toFixed(8).padStart(12, '0'); // "213.47431246"
    return { yy, day };
  }

  // TLE checksum: sum of digits (mod 10); minus signs count as 1, all else 0.
  function checksum(line) {
    let sum = 0;
    for (let i = 0; i < 68 && i < line.length; i++) {
      const c = line[i];
      if (c >= '0' && c <= '9') sum += (c.charCodeAt(0) - 48);
      else if (c === '-') sum += 1;
    }
    return sum % 10;
  }

  function num(row, key, fallback) {
    const v = row[key];
    if (v === undefined || v === '') return fallback;
    return v;
  }

  // ---- one OMM record -> {name, line1, line2} --------------------------------
  function ommRowToTLE(row) {
    // Required orbital fields
    const required = ['EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
                      'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID'];
    for (const k of required) {
      if (row[k] === undefined || row[k] === '') {
        throw new Error('Missing required column "' + k + '"');
      }
    }

    const name = (row['OBJECT_NAME'] || row['OBJECT_ID'] || ('CATALOG ' + row['NORAD_CAT_ID'])).trim();

    const satNum = formatSatNum(row['NORAD_CAT_ID']);
    const classification = (num(row, 'CLASSIFICATION_TYPE', 'U') || 'U').charAt(0);
    const intlDes = formatIntlDes(row['OBJECT_ID']);
    const ep = formatEpoch(row['EPOCH']);
    const ndot = formatNdot(num(row, 'MEAN_MOTION_DOT', 0));
    const nddot = formatExp(num(row, 'MEAN_MOTION_DDOT', 0));
    const bstar = formatExp(num(row, 'BSTAR', 0));
    const ephemType = String(parseInt(num(row, 'EPHEMERIS_TYPE', 0), 10) || 0).slice(0, 1);
    const elSet = String(parseInt(num(row, 'ELEMENT_SET_NO', 0), 10) || 0).padStart(4, ' ').slice(-4);

    // Line 1
    let line1 = '1 ' + satNum + classification + ' ' + intlDes + ' ' +
                ep.yy + ep.day + ' ' + ndot + ' ' + nddot + ' ' + bstar + ' ' +
                ephemType + ' ' + elSet;
    line1 += String(checksum(line1));

    // Line 2
    const incl = fixed(row['INCLINATION'], 8, 4);
    const raan = fixed(row['RA_OF_ASC_NODE'], 8, 4);
    const ecc = formatEccentricity(row['ECCENTRICITY']);
    const argp = fixed(row['ARG_OF_PERICENTER'], 8, 4);
    const ma = fixed(row['MEAN_ANOMALY'], 8, 4);
    const mm = fixed(row['MEAN_MOTION'], 11, 8);
    const rev = String(parseInt(num(row, 'REV_AT_EPOCH', 0), 10) || 0).padStart(5, ' ').slice(-5);

    let line2 = '2 ' + satNum + ' ' + incl + ' ' + raan + ' ' + ecc + ' ' +
                argp + ' ' + ma + ' ' + mm + rev;
    line2 += String(checksum(line2));

    return { name, line1, line2 };
  }

  // ---- whole CSV -> TLE text --------------------------------------------------
  function convertCSVtoTLE(text) {
    const { header, rows } = parseCSV(text);
    if (rows.length === 0) throw new Error('No data rows found in CSV.');
    if (header.map(h => h.toUpperCase()).indexOf('NORAD_CAT_ID') === -1) {
      throw new Error('This does not look like a CelesTrak OMM CSV ' +
                      '(no NORAD_CAT_ID column found).');
    }

    const out = [];
    const errors = [];
    rows.forEach((row, i) => {
      try {
        const tle = ommRowToTLE(row);
        out.push(tle.name);
        out.push(tle.line1);
        out.push(tle.line2);
      } catch (e) {
        errors.push('Row ' + (i + 1) + ': ' + e.message);
      }
    });

    if (out.length === 0) {
      throw new Error('Could not convert any rows.\n' + errors.join('\n'));
    }
    return { text: out.join('\n') + '\n', count: out.length / 3, errors };
  }

  // ===========================================================================
  //  Reverse direction:  NORAD TLE  ->  CelesTrak OMM CSV
  //
  //  A TLE holds less precision than the original OMM CSV in a few fields
  //  (eccentricity is 7 digits, BSTAR / nddot are 5 significant figures). This
  //  converter never *adds* precision — it emits exactly what the TLE encodes,
  //  so the round-trip  TLE -> CSV -> TLE  is byte-for-byte identical.
  // ===========================================================================

  // 2-digit TLE year -> full year. Window: 57-99 => 1900s, 00-56 => 2000s
  // (the convention NORAD/CelesTrak use for both epoch and launch year).
  function fullYear(yy) {
    const n = parseInt(yy, 10);
    return n >= 57 ? 1900 + n : 2000 + n;
  }

  // Inverse of formatSatNum: Alpha-5 (or plain 5-digit) field -> catalog number.
  function parseSatNum(field) {
    const s = String(field).trim();
    if (/^\d+$/.test(s)) return String(parseInt(s, 10));
    const c = s.charAt(0).toUpperCase();
    const idx = ALPHA5.indexOf(c);
    if (idx < 0) return s; // not Alpha-5 — return as-is
    const high = idx + 10;
    const low = parseInt(s.slice(1), 10) || 0;
    return String(high * 10000 + low);
  }

  // Inverse of formatIntlDes: "98067A  " -> "1998-067A". Blank field -> "".
  function parseIntlDes(field) {
    const s = String(field);
    const m = s.match(/^(\d{2})(\d{3})([A-Za-z ]{0,3})$/);
    if (!m) return '';
    const year = fullYear(m[1]);
    const launch = String(parseInt(m[2], 10)).padStart(3, '0');
    const piece = m[3].trim().toUpperCase();
    return year + '-' + launch + piece;
  }

  const CUM_DAYS = {
    common: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    leap:   [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  };

  // Inverse of formatEpoch: (yy, "213.47431246") -> "2026-08-01T11:23:00.596544".
  // The 8-decimal day fraction is expanded to microseconds — finer than the TLE's
  // own resolution — so re-encoding reproduces the same 12-char day string.
  function parseEpoch(yy, dayStr) {
    const year = fullYear(yy);
    const dayFloat = parseFloat(dayStr);
    if (!isFinite(dayFloat)) throw new Error('Unrecognised epoch day: ' + dayStr);
    const doy = Math.floor(dayFloat);
    const dayFrac = dayFloat - doy;

    const months = isLeap(year) ? CUM_DAYS.leap : CUM_DAYS.common;
    let month = 0, dom = doy;
    while (month < 12 && dom > months[month]) { dom -= months[month]; month++; }

    // Expand the day fraction to whole microseconds, decomposing from the total
    // so any rounding carry rolls cleanly up through seconds/minutes/hours.
    let totalMicros = Math.round(dayFrac * 86400 * 1e6);
    const micros = totalMicros % 1000000; totalMicros = (totalMicros - micros) / 1000000;
    const ss = totalMicros % 60; totalMicros = (totalMicros - ss) / 60;
    const mm = totalMicros % 60; const hh = (totalMicros - mm) / 60;

    const p2 = n => String(n).padStart(2, '0');
    return year + '-' + p2(month + 1) + '-' + p2(dom) + 'T' +
           p2(hh) + ':' + p2(mm) + ':' + p2(ss) + '.' +
           String(micros).padStart(6, '0');
  }

  // Inverse of formatExp: assumed-decimal exponential field -> CSV E-notation.
  // " 16079-3" -> ".16079E-3" ,  "-16079-3" -> "-.16079E-3" ,  " 00000+0" -> "0".
  function expFieldToCSV(field) {
    const f = String(field).trim();
    const m = f.match(/^([+-]?)(\d{5})([+-]\d)$/);
    if (!m) { const v = Number(f); return isFinite(v) && v !== 0 ? f : '0'; }
    if (m[2] === '00000') return '0';
    return (m[1] === '-' ? '-' : '') + '.' + m[2] + 'E' + m[3];
  }

  // ndot field ("  .00008515" / " -.00008515") -> CSV decimal, "0" when zero.
  function ndotFieldToCSV(field) {
    const s = String(field).trim();
    const v = Number(s);
    if (!isFinite(v) || v === 0) return '0';
    return s;
  }

  // Split raw TLE text into {name, line1, line2} records. Handles 3-line
  // (name + L1 + L2) and 2-line (L1 + L2) input, blank lines, and CR/LF.
  function parseTLE(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const records = [];
    const errors = [];
    let name = null, line1 = null;
    lines.forEach(raw => {
      const line = raw.replace(/\s+$/, '');
      if (line.trim() === '') return;
      if (/^1 /.test(line) && line.length >= 69) {
        line1 = line;
      } else if (/^2 /.test(line) && line.length >= 69) {
        if (line1) { records.push({ name: name, line1: line1, line2: line }); }
        else { errors.push('Found a line 2 with no preceding line 1: ' + line.slice(0, 20) + '…'); }
        name = null; line1 = null;
      } else {
        // Anything else is treated as a name line for the pair that follows.
        name = line.trim();
        line1 = null;
      }
    });
    return { records, errors };
  }

  // Standard CelesTrak OMM/GP CSV column order.
  const OMM_COLUMNS = [
    'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY',
    'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY',
    'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO',
    'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'
  ];

  // ---- one {name, line1, line2} -> OMM row object ----------------------------
  function tleRecordToOMM(rec) {
    const l1 = rec.line1, l2 = rec.line2;
    if (!l1 || l1.charAt(0) !== '1') throw new Error('Missing or malformed line 1');
    if (!l2 || l2.charAt(0) !== '2') throw new Error('Missing or malformed line 2');

    const noradId = parseSatNum(l1.slice(2, 7));
    const row = {
      OBJECT_NAME: rec.name != null ? rec.name : '',
      OBJECT_ID: parseIntlDes(l1.slice(9, 17)),
      EPOCH: parseEpoch(l1.slice(18, 20), l1.slice(20, 32).trim()),
      MEAN_MOTION: l2.slice(52, 63).trim(),
      ECCENTRICITY: '.' + l2.slice(26, 33),
      INCLINATION: l2.slice(8, 16).trim(),
      RA_OF_ASC_NODE: l2.slice(17, 25).trim(),
      ARG_OF_PERICENTER: l2.slice(34, 42).trim(),
      MEAN_ANOMALY: l2.slice(43, 51).trim(),
      EPHEMERIS_TYPE: String(parseInt(l1.slice(62, 63), 10) || 0),
      CLASSIFICATION_TYPE: (l1.slice(7, 8).trim() || 'U'),
      NORAD_CAT_ID: noradId,
      ELEMENT_SET_NO: String(parseInt(l1.slice(64, 68), 10) || 0),
      REV_AT_EPOCH: String(parseInt(l2.slice(63, 68), 10) || 0),
      BSTAR: expFieldToCSV(l1.slice(53, 61)),
      MEAN_MOTION_DOT: ndotFieldToCSV(l1.slice(33, 43)),
      MEAN_MOTION_DDOT: expFieldToCSV(l1.slice(44, 52))
    };
    return row;
  }

  // Minimal RFC-4180 field quoting (only when a comma/quote/newline is present).
  function csvField(v) {
    v = v == null ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // ---- whole TLE text -> CSV text --------------------------------------------
  function convertTLEtoCSV(text) {
    const { records, errors } = parseTLE(text);
    if (records.length === 0) {
      throw new Error('No TLE records found. Expected pairs of lines starting ' +
                      'with "1 " and "2 " (optionally preceded by a name line).');
    }
    const out = [OMM_COLUMNS.join(',')];
    records.forEach((rec, i) => {
      try {
        const row = tleRecordToOMM(rec);
        out.push(OMM_COLUMNS.map(c => csvField(row[c])).join(','));
      } catch (e) {
        errors.push('Record ' + (i + 1) + (rec.name ? ' (' + rec.name + ')' : '') + ': ' + e.message);
      }
    });
    if (out.length === 1) {
      throw new Error('Could not convert any records.\n' + errors.join('\n'));
    }
    return { text: out.join('\n') + '\n', count: out.length - 1, errors };
  }

  const api = { parseCSV, ommRowToTLE, convertCSVtoTLE, checksum, formatEpoch, formatExp,
                parseTLE, tleRecordToOMM, convertTLEtoCSV, parseEpoch, parseSatNum,
                parseIntlDes, expFieldToCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CSVtoTLE = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
