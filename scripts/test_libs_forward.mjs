/**
 * Verification for src/lib/libs/forward.js (LTE forward model).
 * Run: node scripts/test_libs_forward.mjs   (needs public/data/libs built)
 *
 * Acceptance tests (from the roadmap):
 *  - Boltzmann-plot inversion of synthetic intensities recovers the input T_e.
 *  - Na D2:D1 integrated-intensity ratio = 2.0 (statistical-weight ratio).
 *  - Partition function -> ground-state g at low T; Saha fractions normalize.
 */
import { readFileSync } from 'node:fs';
import { KB_CM1_PER_K } from '../src/lib/libs/constants.js';
import {
  partitionFromLevels, ionizationFractions, elementLineIntensities,
  synthesizeSpectrum,
} from '../src/lib/libs/forward.js';

const load = (kind, sym) =>
  JSON.parse(readFileSync(`public/data/libs/${kind}/${sym}.json`, 'utf8'));

let pass = 0, fail = 0;
const approx = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
function check(name, ok, got, want) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  got=${got} want=${want}`); }
}

const Na_lines = load('lines', 'Na'), Na_lv = load('levels', 'Na');
const Fe_lines = load('lines', 'Fe'), Fe_lv = load('levels', 'Fe');

console.log('— partition function limits —');
const U_Na_lowT = partitionFromLevels(Na_lv.stages['1'], 1500);
check('U(Na I, 1500K) -> ground g=2', approx(U_Na_lowT, 2, 1e-3), U_Na_lowT.toFixed(5), 2);

console.log('— Na D2:D1 integrated-intensity ratio = 2.0 —');
const NaI = elementLineIntensities(Na_lines, Na_lv, 1, 8000, 1e16)
  .filter((l) => l.stage === 1);
const D2 = NaI.find((l) => Math.abs(l.lam - 588.995) < 0.01);
const D1 = NaI.find((l) => Math.abs(l.lam - 589.592) < 0.01);
const ratio = D2.I / D1.I;
check('I(D2)/I(D1) ~ 2.0', approx(ratio, 2.0, 0.02), ratio.toFixed(4), 2.0);

console.log('— Boltzmann-plot inversion recovers T_e (Fe I, noiseless) —');
for (const Te of [8000, 12000, 15000]) {
  const FeI = elementLineIntensities(Fe_lines, Fe_lv, 1, Te, 1e16)
    .filter((l) => l.stage === 1 && l.Ek > 0 && l.I > 0);
  // y = ln(I*lam/(gk*Aki)) = const - Ek/(kB T); slope vs Ek -> T.
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const l of FeI) {
    const x = l.Ek, y = Math.log(l.I * l.lam / (l.gk * l.Aki));
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const Te_rec = -1 / (KB_CM1_PER_K * slope);
  check(`recover T_e=${Te}K from ${n} Fe I lines (<0.5%)`,
    approx(Te_rec, Te, 5e-3), Te_rec.toFixed(1), Te);
}

console.log('— Saha ionization fractions —');
const { frac } = ionizationFractions(Fe_lv, 10000, 1e16);
const sum = Object.values(frac).reduce((a, b) => a + b, 0);
check('Fe stage fractions sum to 1', approx(sum, 1, 1e-9), sum, 1);
check('Fe I and Fe II both populated at 1e4K,1e16',
  frac[1] > 0 && frac[2] > 0 && frac[1] < 1, `I=${frac[1].toFixed(3)},II=${frac[2].toFixed(3)}`, '0<..<1');

console.log('— synthesize spectrum: Na D doublet renders two peaks ~2:1 —');
const spec = synthesizeSpectrum(NaI, {
  grid: { min: 588, max: 591, n: 3001 }, instrumentFWHM_nm: 0.05,
  T_K: 8000, mass_amu: 22.99,
});
const peakNear = (l0) => {
  let best = 0;
  for (let i = 0; i < spec.lambda.length; i++)
    if (Math.abs(spec.lambda[i] - l0) < 0.1) best = Math.max(best, spec.intensity[i]);
  return best;
};
const pr = peakNear(588.995) / peakNear(589.592);
check('rendered D2/D1 peak ratio ~2 (equal widths)', approx(pr, 2.0, 0.05),
  pr.toFixed(3), 2.0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
