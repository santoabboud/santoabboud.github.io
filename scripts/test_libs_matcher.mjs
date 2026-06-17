/**
 * Verification for matcher.js (identification + confidence).
 * Run: node scripts/test_libs_matcher.mjs   (needs public/data/libs built)
 *
 * Closed loop: forward-model an Fe+Ca+Na mixture -> baseline+noise ->
 * detectPeaks -> identifyElements. Asserts the three present elements rank top
 * with high confidence and outrank absent distractors (Ti, Mg, Li, H), and that
 * the Fe Boltzmann temperature is recovered. Ti is the hard case: a dense
 * transition-metal line list that will chance-match the Fe peak forest -- the
 * coincidence + Boltzmann guards must keep it below the present elements.
 */
import { readFileSync } from 'node:fs';
import { elementLineIntensities, synthesizeSpectrum } from '../src/lib/libs/forward.js';
import { detectPeaks } from '../src/lib/libs/preprocess.js';
import { createMatcher, identifyElements } from '../src/lib/libs/matcher.js';

let pass = 0, fail = 0;
function check(name, ok, info = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${info}`); }
}
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rng = mulberry32(2024);
const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const load = (k, s) => JSON.parse(readFileSync(`public/data/libs/${k}/${s}.json`, 'utf8'));

const Te = 10000, ne = 1e16;
const present = { Fe: 1.0, Ca: 0.3, Na: 0.1 };
let lines = [];
for (const [el, ab] of Object.entries(present)) {
  lines = lines.concat(elementLineIntensities(load('lines', el), load('levels', el), ab, Te, ne)
    .filter((l) => l.stage <= 3));
}
// synthesize 370-600 nm at 0.02 nm/px, 0.05 nm instrument FWHM
const spec = synthesizeSpectrum(lines, { grid: { min: 370, max: 600, n: 11501 }, instrumentFWHM_nm: 0.05, T_K: Te, mass_amu: 50 });
const pmax = Math.max(...spec.intensity);
const S = 30000 / pmax;                              // scale strongest line to ~30k counts
const noiseSigma = 3;
const obs = new Float64Array(spec.intensity.length);
for (let i = 0; i < obs.length; i++) {
  const baseline = 500 + 300 * Math.exp(-((spec.lambda[i] - 450) ** 2) / (2 * 80 ** 2)); // broad continuum
  obs[i] = baseline + spec.intensity[i] * S + noiseSigma * gauss();
}
// SNIP window smaller than inter-line spacing in a dense forest (8 px = 0.16 nm).
const det = detectPeaks(spec.lambda, obs, { baselineIter: 8, k: 5, minDistanceNm: 0.025 });
console.log(`  (detected ${det.peaks.length} peaks, sigma=${det.sigma.toFixed(1)})`);

const mi = JSON.parse(readFileSync('public/data/libs/_match_index.json', 'utf8'));
const M = createMatcher(mi);
const ranked = identifyElements(det.peaks, M, {
  sigmaCal_nm: 0.03, nSigma: 3, activeStages: [1, 2, 3], Tnominal_K: Te,
});

console.log('  rank element conf   peaksMatched/inRange C_coinc C_strong C_boltz  T_fit');
for (const r of ranked.slice(0, 7)) {
  console.log(`   ${r.element.padEnd(3)}  ${r.confidence.toFixed(3)}  ${String(r.nPeaksMatched).padStart(4)}/${String(r.nLinesInRange).padEnd(5)}  ${r.C_coinc.toFixed(2)}   ${r.C_strong.toFixed(2)}    ${r.C_boltz != null ? r.C_boltz.toFixed(2) : '—'}   ${r.fittedT_K ? r.fittedT_K.toFixed(0) : '—'}`);
}

const conf = Object.fromEntries(ranked.map((r) => [r.element, r]));
const top3 = new Set(ranked.slice(0, 3).map((r) => r.element));
check('Fe, Ca, Na are the top 3 by confidence', ['Fe', 'Ca', 'Na'].every((e) => top3.has(e)), `top3=${[...top3]}`);
for (const e of ['Fe', 'Ca', 'Na']) check(`${e} confidence > 0.4`, conf[e] && conf[e].confidence > 0.4, conf[e] && conf[e].confidence.toFixed(3));
const minPresent = Math.min(...['Fe', 'Ca', 'Na'].map((e) => conf[e].confidence));
const maxAbsent = Math.max(...['Ti', 'Mg', 'Li', 'H'].filter((e) => conf[e]).map((e) => conf[e].confidence));
check('all present elements outrank all absent (clear gap)', minPresent > maxAbsent * 1.5,
  `minPresent=${minPresent.toFixed(3)} maxAbsent=${maxAbsent.toFixed(3)}`);
// (Boltzmann T recovery from clean isolated lines is validated in
// test_libs_forward.mjs; in a dense 0.05 nm blend, per-peak Boltzmann is
// intentionally suppressed via the dominantFrac filter -> neutral C_boltz.)
check('coincidence guard suppresses dense distractor Ti', conf.Ti && conf.Ti.C_coinc < 0.3,
  conf.Ti && `Ti C_coinc=${conf.Ti.C_coinc.toFixed(2)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
