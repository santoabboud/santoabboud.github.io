/**
 * Verification for ingest.js + preprocess.js.
 * Run: node scripts/test_libs_ingest.mjs   (needs public/data/libs/Na built)
 *
 * Closed loop: forward-model a Na spectrum -> add baseline + noise -> serialize
 * as an Ocean-Optics-style CSV -> ingest -> detect peaks -> recover the D
 * doublet centroids. Plus unit/order detection, SNIP, MAD, SG unit checks.
 */
import { readFileSync } from 'node:fs';
import { parseSpectrumCSV } from '../src/lib/libs/ingest.js';
import {
  snipBaseline, estimateNoiseMAD, savitzkyGolay, detectPeaks,
} from '../src/lib/libs/preprocess.js';
import { elementLineIntensities, synthesizeSpectrum } from '../src/lib/libs/forward.js';

let pass = 0, fail = 0;
const approx = (a, b, abs) => Math.abs(a - b) <= abs;
function check(name, ok, got, want) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  got=${got} want=${want}`); }
}
// deterministic PRNG + Gaussian
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rng = mulberry32(12345);
const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

console.log('— ingest: Ocean-Optics-style header + tab data —');
const oo = ['SpectraSuite Data File', 'Date: 2026-06-16',
  'Integration Time (sec): 0.05', 'Number of Pixels in Spectrum: 5',
  '>>>>>Begin Spectral Data<<<<<',
  '400.00\t1010', '400.50\t1230', '401.00\t1990', '401.50\t1240', '402.00\t1005'].join('\n');
const p1 = parseSpectrumCSV(oo);
check('parsed 5 points', p1.nPoints === 5, p1.nPoints, 5);
check('unit nm', p1.unit === 'nm', p1.unit, 'nm');
check('metadata captured', p1.meta['Integration Time (sec)'] === '0.05', p1.meta['Integration Time (sec)'], '0.05');
check('lambda ascending from 400', approx(p1.lambda_nm[0], 400, 1e-9), p1.lambda_nm[0], 400);

console.log('— ingest: Angstrom + descending order —');
const ang = 'wavelength(A),counts\n6560,5\n6550,7\n6540,9\n6530,4\n6520,3';
const p2 = parseSpectrumCSV(ang);
check('detects angstrom -> nm (654 nm)', approx(p2.lambda_nm[p2.nPoints - 1], 656, 0.5), p2.lambda_nm[p2.nPoints - 1], 656);
check('reordered ascending', p2.lambda_nm[0] < p2.lambda_nm[p2.nPoints - 1], `${p2.lambda_nm[0]}..`, 'asc');

console.log('— SNIP baseline + MAD noise —');
const N = 600, lamA = new Float64Array(N), trueBase = new Float64Array(N), sig = new Float64Array(N);
for (let i = 0; i < N; i++) {
  lamA[i] = 400 + i * 0.01;                       // 400-406 nm, 10 pm/px
  trueBase[i] = 800 + 200 * Math.exp(-((i - 300) ** 2) / (2 * 150 ** 2)); // broad bump
  sig[i] = trueBase[i];
}
for (const [c, amp] of [[150, 500], [300, 900], [450, 300]]) {  // 3 narrow peaks
  for (let i = 0; i < N; i++) sig[i] += amp * Math.exp(-((i - c) ** 2) / (2 * 3 ** 2));
}
// Clipping window must match the line width (sigma=3 px -> ~20), NOT the broad
// continuum scale; too-wide a window erodes the continuum itself.
const base = snipBaseline(sig, 20);
let baseErr = 0;
for (const i of [50, 250, 380, 550]) baseErr = Math.max(baseErr, Math.abs(base[i] - trueBase[i]) / trueBase[i]);
check('SNIP recovers continuum in peak-free regions (<3%)', baseErr < 0.03, (baseErr * 100).toFixed(2) + '%', '<3%');

const noise = new Float64Array(2000);
for (let i = 0; i < noise.length; i++) noise[i] = 100 + 7 * gauss();
const sEst = estimateNoiseMAD(noise);
check('MAD noise recovers sigma=7 (+/-15%)', approx(sEst, 7, 7 * 0.15), sEst.toFixed(3), 7);

console.log('— SG smoothing preserves a peak —');
const peak = new Float64Array(N);
for (let i = 0; i < N; i++) peak[i] = 1000 * Math.exp(-((i - 300) ** 2) / (2 * 5 ** 2)) + 5 * gauss();
const sm = savitzkyGolay(peak, 7, 2);
check('SG preserves peak amplitude (<5%)', approx(sm[300], 1000, 60), sm[300].toFixed(0), 1000);

console.log('— closed loop: synth Na -> baseline+noise -> ingest -> recover D doublet —');
const Na_lines = JSON.parse(readFileSync('public/data/libs/lines/Na.json', 'utf8'));
const Na_lv = JSON.parse(readFileSync('public/data/libs/levels/Na.json', 'utf8'));
const NaI = elementLineIntensities(Na_lines, Na_lv, 1e6, 8000, 1e16).filter((l) => l.stage === 1);
const spec = synthesizeSpectrum(NaI, { grid: { min: 585, max: 593, n: 1601 }, instrumentFWHM_nm: 0.08, T_K: 8000, mass_amu: 22.99 });
// scale to realistic counts, add sloped baseline + noise, serialize CSV
const peakMax = Math.max(...spec.intensity);
const rows = ['>>>>>Begin Spectral Data<<<<<'];
for (let i = 0; i < spec.lambda.length; i++) {
  const cnt = 600 + 0.8 * i + (spec.intensity[i] / peakMax) * 4000 + 25 * gauss();
  rows.push(`${spec.lambda[i].toFixed(3)}\t${cnt.toFixed(1)}`);
}
const ing = parseSpectrumCSV(rows.join('\n'));
const det = detectPeaks(ing.lambda_nm, ing.intensity, { baselineIter: 80, k: 6, minDistanceNm: 0.1 });
const near = (l0) => det.peaks.find((p) => Math.abs(p.lambda - l0) < 0.05);
const d2 = near(588.995), d1 = near(589.592);
check('recovered Na D2 centroid (<15 pm)', d2 && approx(d2.lambda, 588.995, 0.015), d2 && d2.lambda.toFixed(4), 588.995);
check('recovered Na D1 centroid (<15 pm)', d1 && approx(d1.lambda, 589.592, 0.015), d1 && d1.lambda.toFixed(4), 589.592);
check('both D lines have strong SNR (>10)', d2 && d1 && d2.snr > 10 && d1.snr > 10, d2 && d1 && `${d2.snr.toFixed(0)},${d1.snr.toFixed(0)}`, '>10');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
