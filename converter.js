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

  const api = { parseCSV, ommRowToTLE, convertCSVtoTLE, checksum, formatEpoch, formatExp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CSVtoTLE = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
