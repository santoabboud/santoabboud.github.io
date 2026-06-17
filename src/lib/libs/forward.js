/**
 * LTE forward model: composition + (T_e, n_e) + instrument -> synthetic spectrum.
 *
 * Pipeline per element:
 *   1. U_z(T)  partition functions from scraped levels (truncated at the
 *      Debye-lowered ionization limit).
 *   2. Saha ionization balance -> fraction of the element in each stage.
 *   3. Boltzmann -> per-line relative integrated intensity.
 *   4. Place an area-normalized profile (Voigt: instrument+Doppler Gaussian (x)
 *      Stark Lorentzian) at each line and sum onto the wavelength grid.
 *
 * Intensities are RELATIVE (the common instrument/geometry constant F and the
 * absolute atom density are folded into `abundance`); this is what Boltzmann/
 * Saha plots and CF-LIBS use. Profile rendering uses the fast pseudo-Voigt
 * (area-exact; ~1% core); line AREAS are profile-independent so diagnostics are
 * unaffected. Energies cm^-1, wavelengths nm, T in K, n_e in cm^-3.
 */
import {
  boltzmannFactor, partitionFunction, sahaRatioNe, dopplerFWHM_nm,
  gaussianQuadrature, pseudoVoigt,
} from './physics.js';

/**
 * Standard atomic weights [u], for Doppler widths. RECALLED — flagged for
 * verification; only matters at high resolution (Doppler << instrument for the
 * 0.4 nm profile). Unknown elements fall back to ~2.0*Z via the caller.
 */
export const ATOMIC_MASS_AMU = {
  H: 1.008, He: 4.0026, Li: 6.94, Be: 9.0122, B: 10.81, C: 12.011, N: 14.007,
  O: 15.999, F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305, Al: 26.982,
  Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.95, K: 39.098, Ca: 40.078,
  Ti: 47.867, V: 50.942, Cr: 51.996, Mn: 54.938, Fe: 55.845, Co: 58.933,
  Ni: 58.693, Cu: 63.546, Zn: 65.38, W: 183.84, Pb: 207.2,
};

/** Partition function U_z(T) from a v2 levels-stage object. */
export function partitionFromLevels(stageLevels, T_K, depression_cm1 = 0) {
  return partitionFunction(
    stageLevels.levels.map(([E_cm1, g]) => ({ g, E_cm1 })),
    T_K,
    { limit_cm1: stageLevels.ion_energy_cm1 ?? Infinity, dLimit_cm1: depression_cm1 });
}

/**
 * Saha ionization balance for one element across the stages present in its
 * levels data. Returns { frac:{stage:fraction}, U:{stage:U}, stages:[...] }.
 * Chaining stops across any missing (non-contiguous) stage.
 */
export function ionizationFractions(levelsData, T_K, ne_cm3, depression_cm1 = 0) {
  const stages = Object.keys(levelsData.stages).map(Number).sort((a, b) => a - b);
  const U = {}, rel = {};
  for (const s of stages) U[s] = partitionFromLevels(levelsData.stages[String(s)], T_K, depression_cm1);
  rel[stages[0]] = 1;
  for (let i = 0; i < stages.length - 1; i++) {
    const z = stages[i], zp = stages[i + 1];
    const chi_z = levelsData.stages[String(z)].ion_energy_cm1;
    if (zp !== z + 1 || !chi_z) { rel[zp] = 0; continue; } // can't Saha across a gap
    rel[zp] = rel[z] * sahaRatioNe(U[z], U[zp], chi_z, T_K, depression_cm1) / ne_cm3;
  }
  const tot = Object.values(rel).reduce((a, b) => a + b, 0) || 1;
  const frac = {};
  for (const s of stages) frac[s] = (rel[s] || 0) / tot;
  return { frac, U, stages };
}

/**
 * Per-line relative integrated intensities for one element.
 * linesData/levelsData are the v2 per-element objects. Returns an array of
 * { lam, lam_air, lam_vac, I, Ek, gk, Aki, stage }. Lines lacking A_ki/E_k/g_k
 * are skipped (no LTE intensity without the constants).
 */
export function elementLineIntensities(linesData, levelsData, abundance, T_K, ne_cm3,
  { medium = 'air', depression_cm1 = 0 } = {}) {
  const { frac, U, stages } = ionizationFractions(levelsData, T_K, ne_cm3, depression_cm1);
  const out = [];
  for (const s of stages) {
    const rows = linesData.stages[String(s)];
    if (!rows) continue;
    const Us = U[s] || 1, fr = frac[s] || 0;
    if (fr <= 0) continue;
    for (const [lam_air, lam_vac, Aki, Ek, gk] of rows) {
      if (Aki == null || Ek == null || gk == null) continue;
      const lam = medium === 'vac' ? lam_vac : lam_air;
      const I = abundance * fr * (gk * Aki / lam) * boltzmannFactor(Ek, T_K) / Us;
      out.push({ lam, lam_air, lam_vac, I, Ek, gk, Aki, stage: s });
    }
  }
  return out;
}

/**
 * Render a list of {lam, I, ...} lines onto a wavelength grid as summed Voigt
 * profiles. opts:
 *   grid: {min, max, n}  OR  lambdas:[...]
 *   instrumentFWHM_nm: Gaussian instrument FWHM
 *   T_K, mass_amu: for Doppler Gaussian (added in quadrature to instrument)
 *   starkFWHM_nm: function(lam, line)->Lorentzian FWHM  (default 0)
 *   windowFWHM: profile evaluated within +/- windowFWHM * totalFWHM (default 12)
 * Returns { lambda:Float64Array, intensity:Float64Array }.
 */
export function synthesizeSpectrum(lines, opts) {
  const {
    grid, lambdas, instrumentFWHM_nm = 0.1, T_K = 10000, mass_amu = 50,
    starkFWHM_nm = () => 0, windowFWHM = 12,
  } = opts;
  let lam;
  if (lambdas) lam = Float64Array.from(lambdas);
  else {
    const { min, max, n } = grid;
    lam = new Float64Array(n);
    const d = (max - min) / (n - 1);
    for (let i = 0; i < n; i++) lam[i] = min + i * d;
  }
  const I = new Float64Array(lam.length);
  const lo = lam[0], hi = lam[lam.length - 1];
  const dl = (hi - lo) / (lam.length - 1);
  for (const line of lines) {
    if (line.lam < lo || line.lam > hi) continue;
    const fD = dopplerFWHM_nm(line.lam, T_K, mass_amu);
    const fG = gaussianQuadrature(instrumentFWHM_nm, fD);
    const fL = starkFWHM_nm(line.lam, line);
    const fTot = Math.max(fG, fL);
    const win = windowFWHM * fTot;
    let i0 = Math.max(0, Math.floor((line.lam - win - lo) / dl));
    let i1 = Math.min(lam.length - 1, Math.ceil((line.lam + win - lo) / dl));
    for (let i = i0; i <= i1; i++) {
      I[i] += line.I * pseudoVoigt(lam[i] - line.lam, fG, fL);
    }
  }
  return { lambda: lam, intensity: I };
}
