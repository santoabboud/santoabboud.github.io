/**
 * Plasma diagnostics + calibration-free LIBS (CF-LIBS).
 *
 * Builds on the LTE relations in physics.js/forward.js and the clean
 * (isolated) matched lines selected by matcher.js.
 *
 *  - boltzmannTemperature: T_e from a single species' Boltzmann plot
 *    ln(I lambda / g_k A_ki) = -E_k/(k_B T) + q, with slope uncertainty.
 *  - cfLibs (Ciucci 1999 one-point method): per-species intercepts q_{E,z} ->
 *    n_{E,z} = U_{E,z}(T) exp(q_{E,z}); sum stages; close (sum=1) -> relative
 *    number concentrations. Assumptions (stoichiometric ablation, optical
 *    thinness, LTE, single T) are returned for the user to weigh.
 *  - nElectronFromStarkLinear / fromHbeta: n_e from Stark widths. The width
 *    parameters are reference-dependent (Griem/Konjevic) and are passed in /
 *    flagged -- NOT hardcoded from memory.
 *
 * Energies cm^-1, wavelengths nm, T in K, n_e in cm^-3. Line records:
 * { Ek, gk, Aki, lam, I } where I is the integrated (or peak) intensity.
 */
import { KB_CM1_PER_K } from './constants.js';
import { partitionFromLevels } from './forward.js';

/** Boltzmann plot of one species. Returns { T_K, sigmaT_K, r2, intercept, n }. */
export function boltzmannTemperature(lines) {
  const xs = [], ys = [];
  for (const L of lines) {
    if (L.Aki == null || L.Ek == null || L.gk == null || !(L.gk * L.Aki > 0) || !(L.I > 0)) continue;
    xs.push(L.Ek); ys.push(Math.log(L.I * L.lam / (L.gk * L.Aki)));
  }
  const n = xs.length;
  if (n < 2) return { T_K: NaN, sigmaT_K: NaN, r2: 0, intercept: NaN, n };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
  const dxx = n * sxx - sx * sx;
  const slope = (n * sxy - sx * sy) / dxx;
  const intercept = (sy - slope * sx) / n;
  const r2 = ((n * sxy - sx * sy) ** 2) / (dxx * (n * syy - sy * sy) || 1);
  // slope standard error -> T uncertainty (T = -1/(kB slope), dT/T = dSlope/slope)
  const resid = syy - 2 * slope * sxy - 2 * intercept * sy + slope * slope * sxx
    + 2 * slope * intercept * sx + n * intercept * intercept;
  const seSlope = n > 2 ? Math.sqrt((resid / (n - 2)) * n / dxx) : NaN;
  const T_K = slope < 0 ? -1 / (KB_CM1_PER_K * slope) : NaN;
  const sigmaT_K = Number.isFinite(seSlope) && slope < 0 ? Math.abs(T_K * seSlope / slope) : NaN;
  return { T_K, sigmaT_K, r2, intercept, n };
}

/**
 * CF-LIBS relative composition. Input:
 *   species: [{ element, stage, lines:[{Ek,gk,Aki,lam,I}] }]   (clean lines)
 *   levelsByElement: { El: <v2 levels json> }                  (for U_z(T))
 *   opts: { T_K (else fit from the richest species), depression_cm1 }
 * Returns { T_K, concentrations:{El:frac}, perSpecies:[...], assumptions:[...] }.
 */
export function cfLibs(species, levelsByElement, opts = {}) {
  const { depression_cm1 = 0 } = opts;
  // 1. Temperature: use the species with the most usable lines if not given.
  let T_K = opts.T_K;
  if (!T_K) {
    let best = null;
    for (const s of species) {
      const bt = boltzmannTemperature(s.lines);
      if (bt.n >= 3 && bt.T_K > 3000 && bt.T_K < 60000 && (!best || bt.n > best.n)) best = bt;
    }
    T_K = best ? best.T_K : 10000;
  }
  // 2. Per-species number density (relative): n_{E,z} = U_{E,z}(T) exp(q),
  //    q = mean over lines of [ ln(I lam/(gA)) + E_k/(kB T) ].
  const perSpecies = [];
  const nByElement = new Map();
  for (const s of species) {
    let sumQ = 0, m = 0;
    for (const L of s.lines) {
      if (L.Aki == null || L.Ek == null || L.gk == null || !(L.gk * L.Aki > 0) || !(L.I > 0)) continue;
      sumQ += Math.log(L.I * L.lam / (L.gk * L.Aki)) + L.Ek / (KB_CM1_PER_K * T_K);
      m++;
    }
    if (!m) continue;
    const q = sumQ / m;
    const lv = levelsByElement[s.element];
    const stageObj = lv && lv.stages[String(s.stage)];
    const U = stageObj ? partitionFromLevels(stageObj, T_K, depression_cm1) : 1;
    const n_rel = U * Math.exp(q);
    perSpecies.push({ species: `${s.element} ${s.stage}`, element: s.element, stage: s.stage, q, U, n_rel, nLines: m });
    nByElement.set(s.element, (nByElement.get(s.element) || 0) + n_rel);
  }
  // 3. Close to relative concentrations.
  const total = [...nByElement.values()].reduce((a, b) => a + b, 0) || 1;
  const concentrations = {};
  for (const [el, n] of nByElement) concentrations[el] = n / total;

  return {
    T_K, concentrations, perSpecies,
    assumptions: [
      'LTE at a single electron temperature (McWhirter gate applies).',
      'Optically thin emission (no self-absorption correction here).',
      'Stoichiometric ablation: vapor composition = bulk composition.',
      'Relative spectral response eta(lambda) flat unless intensities were '
      + 'pre-corrected (T_e and concentrations are biased otherwise).',
      'Stages without observed lines are omitted (not Saha-filled in v1).',
    ],
  };
}

/**
 * n_e from a non-hydrogenic line's linear Stark width:
 *   Delta_lambda_FWHM = 2 w_s (n_e / n_ref),  n_ref = 1e16 cm^-3.
 * w_s = electron-impact Stark HWHM [nm] at n_ref and the relevant T, from
 * Griem/Konjevic tables -- PASSED IN, never assumed. Returns n_e [cm^-3].
 */
export function nElectronFromStarkLinear(deltaFWHM_nm, ws_nm_at_1e16) {
  if (!(ws_nm_at_1e16 > 0)) return NaN;
  return 1e16 * deltaFWHM_nm / (2 * ws_nm_at_1e16);
}
