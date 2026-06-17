/**
 * Vacuum <-> standard-air wavelength conversion.
 *
 * The scrape stores VACUUM wavelengths (show_av=3) as the unambiguous
 * canonical. Air wavelengths (what Bilal's instruments read for lambda >= 200
 * nm) are derived here. We use the Peck & Reeder (1972) dispersion formula for
 * the refractive index of standard dry air (15 C, 101.325 kPa, 0.03% CO2) --
 * the relation NIST ASD itself applies above 2000 A -- with Edlen (1966) kept
 * as an independent cross-check in the test suite.
 *
 *   10^8 (n - 1) = 5791817/(238.0185 - s^2) + 167909/(57.362 - s^2)
 *
 * with s = 1/lambda_vac in micrometers^-1 (vacuum wavenumber). Validated
 * against NIST's own dual-medium output to < 0.1 pm at H-alpha.
 *
 * Validity: lambda_vac > ~185 nm (denominators stay positive; below that ASD
 * reports vacuum anyway). Below VAC_FLOOR_NM we pass the value through
 * unchanged and the caller treats it as vacuum.
 */
export const VAC_FLOOR_NM = 185;

/** Refractive index of standard air at a given VACUUM wavelength [nm]. */
export function refractiveIndexAir(lambda_vac_nm) {
  const s2 = Math.pow(1e3 / lambda_vac_nm, 2);           // s in um^-1, s^2
  const nm1 = (5791817 / (238.0185 - s2) + 167909 / (57.362 - s2)) * 1e-8;
  return 1 + nm1;
}

/** Edlen (1966) refractive index of standard air (cross-check only). */
export function refractiveIndexAirEdlen(lambda_vac_nm) {
  const s2 = Math.pow(1e3 / lambda_vac_nm, 2);
  const nm1 = (8342.54 + 2406147 / (130 - s2) + 15998 / (38.9 - s2)) * 1e-8;
  return 1 + nm1;
}

/** Vacuum wavelength [nm] -> standard-air wavelength [nm]. */
export function vacuumToAir(lambda_vac_nm) {
  if (lambda_vac_nm < VAC_FLOOR_NM) return lambda_vac_nm;  // reported in vacuum
  return lambda_vac_nm / refractiveIndexAir(lambda_vac_nm);
}

/**
 * Standard-air wavelength [nm] -> vacuum wavelength [nm]. The dispersion
 * formula is parameterized by the vacuum wavenumber, so we fixed-point iterate
 * (converges to < 1e-9 nm in 2-3 steps since n-1 ~ 3e-4).
 */
export function airToVacuum(lambda_air_nm) {
  if (lambda_air_nm < VAC_FLOOR_NM) return lambda_air_nm;
  let vac = lambda_air_nm;
  for (let i = 0; i < 4; i++) vac = lambda_air_nm * refractiveIndexAir(vac);
  return vac;
}
