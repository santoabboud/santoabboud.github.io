/**
 * LTE plasma physics for the LIBS forward model and CF-LIBS inversion.
 *
 * Conventions:
 *  - Energies in cm^-1 (NIST ASD native), temperatures in K, wavelengths in nm.
 *  - All line shapes are AREA-NORMALIZED to 1 (so line "intensity" multiplies
 *    a unit-area profile -> integrated intensity is the prefactor).
 *  - Relative line intensities omit the common instrument/geometry constant F
 *    and the absolute number density n_z; these cancel in Boltzmann/Saha plots.
 *
 * Assumptions (see project notes): single-temperature LTE (McWhirter gate),
 * optically thin baseline. Everything here is the forward kinematics of those
 * assumptions; validity flags live with the callers.
 */
import {
  KB_CM1_PER_K, SAHA_PREFACTOR_CM3_K32, DOPPLER_FWHM_COEF,
  GAUSS_FWHM_PER_SIGMA,
} from './constants.js';

/* ------------------------------------------------------------------ */
/* Populations: Boltzmann, partition functions, Saha                   */
/* ------------------------------------------------------------------ */

/** Boltzmann factor exp(-E/(k_B T)) with E in cm^-1, T in K. */
export function boltzmannFactor(E_cm1, T_K) {
  return Math.exp(-E_cm1 / (KB_CM1_PER_K * T_K));
}

/**
 * Partition function U_z(T) = sum_j g_j exp(-E_j/(k_B T)) over the bound levels
 * of a species. levels: [{ g, E_cm1 }, ...].
 *
 * If `limit_cm1` is given, the sum is truncated at the (optionally Debye-
 * lowered) ionization limit: levels with E_j >= limit_cm1 - dLimit_cm1 are
 * dropped (they are autoionizing / unbound under continuum lowering). This is
 * the standard truncation; the dropped tail is logged by the caller.
 */
export function partitionFunction(levels, T_K, { limit_cm1 = Infinity, dLimit_cm1 = 0 } = {}) {
  const cutoff = limit_cm1 - dLimit_cm1;
  let U = 0;
  for (const { g, E_cm1 } of levels) {
    if (!(g > 0) || !Number.isFinite(E_cm1)) continue;
    if (E_cm1 >= cutoff) continue;
    U += g * boltzmannFactor(E_cm1, T_K);
  }
  return U;
}

/**
 * Saha ionization balance: returns n_{z+1} * n_e / n_z  [cm^-3].
 *   n_{z+1} n_e / n_z = 2 (U_{z+1}/U_z) (2 pi m_e k_B T/h^2)^{3/2}
 *                        exp(-(chi_z - dChi)/(k_B T))
 * chi_z = ionization energy of stage z [cm^-1]; dChi = ionization-potential
 * depression [cm^-1] (0 by default).
 */
export function sahaRatioNe(U_lower, U_upper, chi_cm1, T_K, dChi_cm1 = 0) {
  return SAHA_PREFACTOR_CM3_K32 * Math.pow(T_K, 1.5) * (U_upper / U_lower)
    * boltzmannFactor(chi_cm1 - dChi_cm1, T_K);
}

/**
 * Relative integrated intensity of a line (per n_z, per instrument constant F):
 *   I_ki / (F n_z) = (g_k A_ki / lambda) exp(-E_k/(k_B T)) / U_z(T).
 * Wavelength enters because intensity is photon-energy-weighted (h c/lambda).
 * Pass U_z = 1 to get the un-normalized population-weighted emissivity.
 */
export function relativeLineIntensity({ g_k, A_ki, lambda_nm, E_k_cm1 }, T_K, U_z = 1) {
  return (g_k * A_ki / lambda_nm) * boltzmannFactor(E_k_cm1, T_K) / U_z;
}

/* ------------------------------------------------------------------ */
/* Line widths                                                         */
/* ------------------------------------------------------------------ */

/** Thermal Doppler FWHM [nm]. mass_amu = atomic mass in u. */
export function dopplerFWHM_nm(lambda_nm, T_K, mass_amu) {
  return DOPPLER_FWHM_COEF * Math.sqrt(T_K / mass_amu) * lambda_nm;
}

/** Add Gaussian FWHMs in quadrature (Doppler (+) instrument). */
export function gaussianQuadrature(...fwhms) {
  return Math.sqrt(fwhms.reduce((s, f) => s + f * f, 0));
}

/**
 * McWhirter lower bound on n_e [cm^-3] for LTE validity (NECESSARY, not
 * sufficient): n_e >= 1.6e12 * sqrt(T) * (dE)^3, T in K, dE = largest relevant
 * energy gap in eV. Coefficient recalled from Griem; flagged for verification.
 */
export function mcWhirterNe(T_K, dE_eV) {
  return 1.6e12 * Math.sqrt(T_K) * Math.pow(dE_eV, 3);
}

/* ------------------------------------------------------------------ */
/* Line-shape profiles (all area-normalized to 1)                      */
/* ------------------------------------------------------------------ */

/** Normalized Gaussian of given FWHM, evaluated at offset x (same units). */
export function gaussian(x, fwhm) {
  const c = 4 * Math.LN2 / (fwhm * fwhm);
  return Math.sqrt(c / Math.PI) * Math.exp(-c * x * x);
}

/** Normalized Lorentzian of given FWHM. */
export function lorentzian(x, fwhm) {
  const hwhm = fwhm / 2;
  return (hwhm / Math.PI) / (x * x + hwhm * hwhm);
}

/**
 * Pseudo-Voigt (Thompson-Cox-Hastings 1987): a fast, area-normalized
 * approximation to the true Voigt (Gaussian (x) Lorentzian), accurate to ~1%.
 * fG, fL = Gaussian and Lorentzian FWHM. Used for the live overlay and as the
 * fitting kernel; the exact convolution `voigtReference` validates it.
 */
export function pseudoVoigt(x, fG, fL) {
  // Total FWHM via the Olivero-Longbothum 5th-order polynomial.
  const fG5 = fG ** 5;
  const f = Math.pow(
    fG5 + 2.69269 * fG ** 4 * fL + 2.42843 * fG ** 3 * fL ** 2
    + 4.47163 * fG ** 2 * fL ** 3 + 0.07842 * fG * fL ** 4 + fL ** 5, 0.2);
  const r = fL / f;
  const eta = 1.36603 * r - 0.47719 * r * r + 0.11116 * r * r * r;
  return eta * lorentzian(x, f) + (1 - eta) * gaussian(x, f);
}

/**
 * Accurate Voigt = Gaussian (FWHM fG) (x) Lorentzian (FWHM fL), evaluated at
 * offset x. This is the canonical profile for the synthetic-spectrum generator
 * (accuracy over speed) and the validation oracle for the fast `pseudoVoigt`.
 *
 * Method: integrate G(u) L(x-u) du over the GAUSSIAN's compact support
 * (+/- 8 sigma; G(8 sigma)/G(0) ~ 1e-14). This is accurate for all x and for
 * all physical fL > 0 -- including the sigma -> 0 limit, where the window
 * collapses and the result -> L(x) correctly (far Voigt wings are Lorentzian).
 * The only degenerate case it does NOT resolve is fL -> 0 (a pure Gaussian);
 * that limit is unphysical here (Stark + natural widths are always > 0) and is
 * served exactly by `gaussian()` directly.
 */
export function voigtReference(x, fG, fL, { ppSigma = 40 } = {}) {
  const sigma = fG / GAUSS_FWHM_PER_SIGMA;
  if (sigma <= 0) return lorentzian(x, fL);
  const half = 8 * sigma;
  const du = sigma / ppSigma;                // points per sigma
  const n = Math.max(201, Math.ceil((2 * half) / du) | 1);  // odd, includes 0
  const step = (2 * half) / (n - 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const u = -half + i * step;
    const w = (i === 0 || i === n - 1) ? 0.5 : 1; // trapezoid
    acc += w * gaussian(u, fG) * lorentzian(x - u, fL);
  }
  return acc * step;
}

/** Canonical accurate Voigt (alias of voigtReference) used by the generator. */
export const voigt = voigtReference;
