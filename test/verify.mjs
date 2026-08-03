/*
 * Verification tests for converter.js
 * Run:  node test/verify.mjs
 *
 * These are self-contained (no network). They pin the byte-exact conversion
 * against a real CelesTrak record (ISS) and exercise every edge-case formatter.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const C = require(join(here, '..', 'converter.js'));

let pass = 0, fail = 0;
function eq(name, got, exp) {
  if (got === exp) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n  got: [${got}]\n  exp: [${exp}]`); }
}

// --- Golden record: ISS, straight from CelesTrak (CSV -> TLE must be byte-exact) ---
const issCSV =
`OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT
ISS (ZARYA),1998-067A,2026-08-01T11:23:00.596544,15.49301455,.00072105,51.6315,75.9770,0.6648,359.4349,0,U,25544,999,57877,.16079419E-3,.8515E-4,0`;
const iss = C.convertCSVtoTLE(issCSV).text.trimEnd().split('\n');
eq('ISS name',  iss[0], 'ISS (ZARYA)');
eq('ISS line1', iss[1], '1 25544U 98067A   26213.47431246  .00008515  00000+0  16079-3 0  9999');
eq('ISS line2', iss[2], '2 25544  51.6315  75.9770 0007210   0.6648 359.4349 15.49301455578770');

// --- Checksum algorithm ---
eq('checksum L1', String(C.checksum('1 25544U 98067A   26213.47431246  .00008515  00000+0  16079-3 0  999')), '9');
eq('checksum L2', String(C.checksum('2 25544  51.6315  75.9770 0007210   0.6648 359.4349 15.4930145557877')), '0');

// --- Exponential (BSTAR / nddot) assumed-decimal field ---
eq('exp pos',    C.formatExp(0.00016079419), ' 16079-3');
eq('exp neg',    C.formatExp(-0.00016079419), '-16079-3');
eq('exp zero',   C.formatExp(0),              ' 00000+0');
eq('exp neg sm', C.formatExp(-1.234e-5),      '-12340-4');
eq('exp near1',  C.formatExp(0.99999),        ' 99999+0');

// --- Epoch: 2-digit year window + day-of-year with fraction ---
const e1 = C.formatEpoch('2026-08-01T11:23:00.596544');
eq('epoch yy',  e1.yy,  '26');
eq('epoch day', e1.day, '213.47431246');
eq('epoch 1999 yy', C.formatEpoch('1999-01-01T00:00:00').yy, '99');  // pre-2000 window
eq('epoch leap', C.formatEpoch('2024-03-01T00:00:00').day, '061.00000000'); // 2024 is leap: Mar 1 = DOY 61

// --- Whole-file convert reports a count ---
eq('count', String(C.convertCSVtoTLE(issCSV).count), '1');

// === Reverse direction: TLE -> CSV ==========================================
const issTLE =
`ISS (ZARYA)
1 25544U 98067A   26213.47431246  .00008515  00000+0  16079-3 0  9999
2 25544  51.6315  75.9770 0007210   0.6648 359.4349 15.49301455578770`;

// Round-trip must be byte-exact: TLE -> CSV -> TLE reproduces the input TLE.
const rtCSV = C.convertTLEtoCSV(issTLE);
eq('reverse count', String(rtCSV.count), '1');
const rtTLE = C.convertCSVtoTLE(rtCSV.text).text.trimEnd().split('\n');
eq('roundtrip name',  rtTLE[0], 'ISS (ZARYA)');
eq('roundtrip line1', rtTLE[1], '1 25544U 98067A   26213.47431246  .00008515  00000+0  16079-3 0  9999');
eq('roundtrip line2', rtTLE[2], '2 25544  51.6315  75.9770 0007210   0.6648 359.4349 15.49301455578770');

// Individual reverse-field checks
eq('rev epoch',   C.parseEpoch('26', '213.47431246'), '2026-08-01T11:23:00.596544');
eq('rev epoch99', C.parseEpoch('99', '001.00000000'), '1999-01-01T00:00:00.000000'); // pre-2000 window
eq('rev epochLeap', C.parseEpoch('24', '061.00000000'), '2024-03-01T00:00:00.000000'); // leap year
eq('rev satnum',  C.parseSatNum('25544'), '25544');
eq('rev intldes', C.parseIntlDes('98067A  '), '1998-067A');
eq('rev exp pos', C.expFieldToCSV(' 16079-3'), '.16079E-3');
eq('rev exp neg', C.expFieldToCSV('-16079-3'), '-.16079E-3');
eq('rev exp zero', C.expFieldToCSV(' 00000+0'), '0');

// 2-line input (no name line) still parses.
const twoLine = C.convertTLEtoCSV(issTLE.split('\n').slice(1).join('\n'));
eq('2-line count', String(twoLine.count), '1');

// Alpha-5 catalog number round-trips through both directions.
eq('alpha5 fwd', C.parseSatNum('T1234'), String((('ABCDEFGHJKLMNPQRSTUVWXYZ'.indexOf('T') + 10) * 10000) + 1234));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
