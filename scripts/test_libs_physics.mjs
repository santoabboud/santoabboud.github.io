/**
 * Verification suite for src/lib/libs/{constants,physics}.js.
 * Run: node scripts/test_libs_physics.mjs
 *
 * Strategy: derived constants vs independently-known values; line-shape area
 * normalization by quadrature; pseudo-Voigt vs the exact convolution; analytic
 * limits (Voigt -> Gaussian/Lorentzian); physical sanity checks.
 */
import {
  KB_CM1_PER_K, SAHA_PREFACTOR_CM3_K32, EV_CM1, DOPPLER_FWHM_COEF,
} from '../src/lib/libs/constants.js';
import {
  boltzmannFactor, partitionFunction, sahaRatioNe, dopplerFWHM_nm,
  gaussian, lorentzian, pseudoVoigt, voigtReference, voigt,
} from '../src/lib/libs/physics.js';

let pass = 0, fail = 0;
const approx = (a, b, rel = 1e-9, abs = 0) =>
  Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));
function check(name, ok, got, want) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  got=${got} want=${want}`); }
}

// Numerical area of a single-arg profile f(x) over [-L, L].
function area(f, L = 200, n = 400001) {
  const dx = (2 * L) / (n - 1);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = -L + i * dx;
    s += ((i === 0 || i === n - 1) ? 0.5 : 1) * f(x);
  }
  return s * dx;
}

console.log('— derived constants (vs independently-known values) —');
check('KB_CM1_PER_K = 0.6950348 cm^-1/K', approx(KB_CM1_PER_K, 0.6950348, 1e-6),
  KB_CM1_PER_K, 0.6950348);
check('EV_CM1 = 8065.544 cm^-1/eV', approx(EV_CM1, 8065.544, 1e-5),
  EV_CM1, 8065.544);
check('Saha prefactor = 4.8293e15 cm^-3 K^-3/2',
  approx(SAHA_PREFACTOR_CM3_K32, 4.8293e15, 2e-4), SAHA_PREFACTOR_CM3_K32, 4.8293e15);
check('Doppler coef = 7.1625e-7', approx(DOPPLER_FWHM_COEF, 7.1625e-7, 1e-4),
  DOPPLER_FWHM_COEF, 7.1625e-7);

console.log('— physical sanity —');
// Fe at 500 nm, 10000 K: Doppler FWHM ~ 4.79 pm.
const dD = dopplerFWHM_nm(500, 10000, 55.845);
check('Doppler FWHM Fe@500nm,1e4K ~ 4.79e-3 nm', approx(dD, 4.79e-3, 5e-3),
  dD, 4.79e-3);
// Boltzmann factor at the Fe I 373 nm upper level (~26875 cm^-1) at 1 eV (~11605 K).
const bf = boltzmannFactor(26875, 11605);
check('0 < boltzmannFactor < 1', bf > 0 && bf < 1, bf, '(0,1)');
// Partition function low-T limit -> ground-state degeneracy.
const levelsH = [{ g: 2, E_cm1: 0 }, { g: 8, E_cm1: 82259 }];  // H I 1s, n=2
check('U_H(low T) -> g0 = 2', approx(partitionFunction(levelsH, 3000), 2, 1e-6),
  partitionFunction(levelsH, 3000), 2);
// Truncation drops levels at/above the lowered limit.
const lv = [{ g: 2, E_cm1: 0 }, { g: 4, E_cm1: 50000 }];
const uTrunc = partitionFunction(lv, 1e6, { limit_cm1: 40000 });
check('partition truncation excludes E>=limit', approx(uTrunc, 2, 1e-9), uTrunc, 2);
// Saha ratio is positive and increases with T.
const s1 = sahaRatioNe(2, 1, 63500, 8000);   // ~Ca I->II-ish chi placeholder
const s2 = sahaRatioNe(2, 1, 63500, 12000);
check('Saha ratio increases with T', s2 > s1 && s1 > 0, `${s1},${s2}`, 's2>s1>0');

console.log('— line shapes (area normalization) —');
check('Gaussian area = 1', approx(area((x) => gaussian(x, 0.4)), 1, 1e-4),
  area((x) => gaussian(x, 0.4)), 1);
check('Lorentzian area = 1', approx(area((x) => lorentzian(x, 0.4), 5000, 2000001), 1, 2e-3),
  area((x) => lorentzian(x, 0.4), 5000, 2000001), 1);
check('pseudoVoigt area = 1', approx(area((x) => pseudoVoigt(x, 0.3, 0.5)), 1, 1e-3),
  area((x) => pseudoVoigt(x, 0.3, 0.5)), 1);

console.log('— Voigt: exact profile, limits, and pseudo-Voigt accuracy —');
// Exact Voigt area = 1.
check('voigt area = 1', approx(area((x) => voigt(x, 0.3, 0.4)), 1, 2e-3),
  area((x) => voigt(x, 0.3, 0.4)), 1);
// sigma -> 0 limit: exact Voigt -> Lorentzian (compact-support integration ok).
const vl = voigt(0.25, 1e-6, 0.4), ll = lorentzian(0.25, 0.4);
check('voigt(fG->0) -> Lorentzian', approx(vl, ll, 1e-3), vl, ll);
// pseudo-Voigt analytic limits are EXACT (eta->0 Gaussian, eta->1 Lorentzian).
const pg = pseudoVoigt(0.25, 0.4, 1e-9), gg = gaussian(0.25, 0.4);
check('pseudoVoigt(fL->0) -> Gaussian', approx(pg, gg, 1e-6), pg, gg);
const pl = pseudoVoigt(0.25, 1e-9, 0.4), ll2 = lorentzian(0.25, 0.4);
check('pseudoVoigt(fG->0) -> Lorentzian', approx(pl, ll2, 1e-6), pl, ll2);
// pseudo-Voigt vs exact in the CORE (|x| <= FWHM): TCH is good to ~2% there.
let coreErr = 0, wingErr = 0;
for (const [fG, fL] of [[0.4, 0.1], [0.2, 0.4], [0.3, 0.3]]) {
  const f = Math.max(fG, fL);
  for (const x of [0, 0.25 * f, 0.5 * f, 1.0 * f]) {
    const e = Math.abs(pseudoVoigt(x, fG, fL) - voigt(x, fG, fL)) / voigt(x, fG, fL);
    coreErr = Math.max(coreErr, e);
  }
  for (const x of [2.5 * f, 4 * f]) {
    const e = Math.abs(pseudoVoigt(x, fG, fL) - voigt(x, fG, fL)) / voigt(x, fG, fL);
    wingErr = Math.max(wingErr, e);
  }
}
check('pseudoVoigt core error < 2.5%', coreErr < 0.025, coreErr.toFixed(4), '<0.025');
console.log(`  NOTE  pseudoVoigt far-wing (>2.5 FWHM) max error = ${(wingErr * 100).toFixed(1)}%`
  + ' — fast UI kernel; generator uses exact voigt()');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
