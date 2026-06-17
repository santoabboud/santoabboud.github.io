/**
 * Physical constants for the LIBS LTE model.
 *
 * The four SI base constants below are EXACT by the 2019 SI redefinition;
 * m_e and u are CODATA 2018. Every other quantity is COMPUTED from these
 * (never hardcoded) so the module is self-verifying: the test suite checks the
 * derived values against independently-known numbers. Units are carried in
 * every identifier.
 */
export const H_J_S = 6.62607015e-34;          // Planck constant [J s]   (exact)
export const C_M_S = 2.99792458e8;            // speed of light  [m/s]   (exact)
export const C_CM_S = C_M_S * 100;            // speed of light  [cm/s]
export const KB_J_K = 1.380649e-23;           // Boltzmann       [J/K]   (exact)
export const E_C = 1.602176634e-19;           // elementary charge [C]   (exact)
export const ME_KG = 9.1093837015e-31;        // electron mass   [kg]    (CODATA 2018)
export const U_KG = 1.66053906660e-27;        // atomic mass unit[kg]    (CODATA 2018)

/** 1 eV expressed in cm^-1  (= e/(h c)); ~8065.544 cm^-1/eV. */
export const EV_CM1 = E_C / (H_J_S * C_CM_S);

/**
 * Boltzmann constant in cm^-1 per K, k_B/(h c). Lets us write Boltzmann
 * factors directly in the NIST energy unit: exp(-E[cm^-1] / (KB_CM1_PER_K * T)).
 * Value ~0.6950348 cm^-1/K.
 */
export const KB_CM1_PER_K = KB_J_K / (H_J_S * C_CM_S);

/**
 * Saha prefactor 2 (2 pi m_e k_B / h^2)^{3/2}, in cm^-3 K^{-3/2}.
 * The leading 2 is the free-electron spin degeneracy. Value ~4.8293e15.
 * (2 pi m_e k_B / h^2)^{3/2} alone = 2.4146e15 cm^-3 K^{-3/2} in SI->cgs.
 */
export const SAHA_PREFACTOR_CM3_K32 =
  2 * Math.pow(2 * Math.PI * ME_KG * KB_J_K / (H_J_S * H_J_S), 1.5) * 1e-6;

/**
 * Doppler FWHM coefficient: Delta_lambda_D / lambda = COEF * sqrt(T[K]/M[amu]),
 * COEF = sqrt(8 ln2 k_B / (u c^2)) ~ 7.1625e-7. (Thermal Gaussian broadening.)
 */
export const DOPPLER_FWHM_COEF =
  Math.sqrt(8 * Math.LN2 * KB_J_K / (U_KG * C_M_S * C_M_S));

/** FWHM = GAUSS_FWHM_PER_SIGMA * sigma for a Gaussian. (= 2 sqrt(2 ln2)) */
export const GAUSS_FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
