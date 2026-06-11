/** Validation of src/lib/calibration.js against an independent reference
 *  (numpy, via scripts/ref_calibration.py) and against analytic limits. */
import { fitCalibration } from '../src/lib/calibration.js';
import { readFileSync } from 'node:fs';

const cases = JSON.parse(readFileSync(new URL('./calib_cases.json', import.meta.url)));
let fail = 0;
for (const tc of cases) {
  const pts = tc.x.map((x, i) => ({ x, y: tc.y[i] }));
  const fit = fitCalibration(pts, tc.order);
  if (fit.error) { console.log('FAIL', tc.name, fit.error); fail++; continue; }
  const relErr = fit.coeffRaw.map((c, i) =>
    Math.abs(c - tc.ref_coeffs[i]) / Math.max(Math.abs(tc.ref_coeffs[i]), 1e-30));
  const maxRel = Math.max(...relErr);
  const r2err = Math.abs(fit.r2 - tc.ref_r2);
  const ok = maxRel < 1e-9 && r2err < 1e-12;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tc.name.padEnd(28)} max|ΔC|/|C| = ${maxRel.toExponential(2)}  |ΔR²| = ${r2err.toExponential(2)}`);
  if (!ok) fail++;
  if (tc.sigma_ref) {
    const sigErr = fit.coeffSigma.map((s, i) =>
      Math.abs(s - tc.sigma_ref[i]) / Math.max(tc.sigma_ref[i], 1e-30));
    const m = Math.max(...sigErr);
    const sok = m < 1e-7;
    console.log(`${sok ? 'PASS' : 'FAIL'}   └ σ(C) vs reference        max rel = ${m.toExponential(2)}`);
    if (!sok) fail++;
  }
}
// analytic limit: noise-free exact-dof fit must reproduce inputs exactly
const tru = [350, 0.19, -3e-6, 8e-11];
const xs = [0, 600, 1300, 2047];
const ys = xs.map(x => tru[0] + tru[1]*x + tru[2]*x*x + tru[3]*x*x*x);
const f = fitCalibration(xs.map((x,i)=>({x, y:ys[i]})), 3);
const exact = f.coeffRaw.every((c,i)=>Math.abs(c-tru[i])/Math.abs(tru[i]) < 1e-9);
console.log(`${exact?'PASS':'FAIL'} analytic limit: N=p noise-free recovers truth (σ correctly null: ${f.coeffSigma===null})`);
if (!exact || f.coeffSigma !== null) fail++;
process.exit(fail ? 1 : 0);
