/**
 * Verification for src/lib/libs/wavelength.js.
 * Run: node scripts/test_libs_wavelength.mjs
 *
 * Anchor: NIST ASD reports the same H-alpha fine-structure component as
 *   vacuum 656.4522552 nm  and  air 656.270970 nm
 * (both straight from ASD v5.12 — not recalled). The converter must reproduce
 * the air value from the vacuum value to sub-pm.
 */
import {
  vacuumToAir, airToVacuum, refractiveIndexAir, refractiveIndexAirEdlen,
  VAC_FLOOR_NM,
} from '../src/lib/libs/wavelength.js';

let pass = 0, fail = 0;
function check(name, ok, got, want) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  got=${got} want=${want}`); }
}
const close = (a, b, tol) => Math.abs(a - b) <= tol;

const VAC_HA = 656.4522552, AIR_HA = 656.270970;   // NIST ASD v5.12 dual output

console.log('— vacuum -> air against NIST dual-medium output —');
const air = vacuumToAir(VAC_HA);
check('vacuumToAir(656.4522552) = 656.270970 (<0.5 pm)', close(air, AIR_HA, 5e-4),
  air.toFixed(6), AIR_HA);

console.log('— air -> vacuum (inverse) —');
const vac = airToVacuum(AIR_HA);
check('airToVacuum(656.270970) = 656.4522552 (<0.5 pm)', close(vac, VAC_HA, 5e-4),
  vac.toFixed(6), VAC_HA);

console.log('— round-trip identity —');
let maxRT = 0;
for (const l of [200, 300, 393.366, 500, 656.45, 766.5, 1000, 1100]) {
  maxRT = Math.max(maxRT, Math.abs(airToVacuum(vacuumToAir(l)) - l));
}
check('round-trip vac->air->vac identity (<1e-7 nm)', maxRT < 1e-7, maxRT, '<1e-7');

console.log('— refractive index magnitude + Peck-Reeder vs Edlen agreement —');
const n500 = refractiveIndexAir(500);
check('n(500nm) - 1 in [2.7e-4, 2.8e-4]', (n500 - 1) > 2.7e-4 && (n500 - 1) < 2.8e-4,
  (n500 - 1).toExponential(4), '~2.78e-4');
let maxPRvE = 0;
for (const l of [200, 300, 500, 700, 1000]) {
  const dShift = Math.abs((l / refractiveIndexAir(l)) - (l / refractiveIndexAirEdlen(l)));
  maxPRvE = Math.max(maxPRvE, dShift);
}
check('Peck-Reeder vs Edlen air shift agree (<1 pm, 200-1000nm)', maxPRvE < 1e-3,
  (maxPRvE * 1e3).toFixed(3) + ' pm', '<1 pm');

console.log('— below validity floor: pass-through (treated as vacuum) —');
check('vacuumToAir(180) == 180', vacuumToAir(180) === 180, vacuumToAir(180), 180);
check('VAC_FLOOR_NM = 185', VAC_FLOOR_NM === 185, VAC_FLOOR_NM, 185);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
