/**
 * Verification for diagnostics.js (T_e + CF-LIBS).
 * Run: node scripts/test_libs_diagnostics.mjs   (needs public/data/libs built)
 *
 * Closed loop: forward-model a KNOWN composition (Fe:Ca:Na number fractions)
 * -> take each species' clean strongest lines as "measured" integrated
 * intensities -> CF-LIBS must recover the input composition and temperature.
 * This isolates the inversion algorithm from peak-detection/blending effects.
 */
import { readFileSync } from 'node:fs';
import { elementLineIntensities } from '../src/lib/libs/forward.js';
import { boltzmannTemperature, cfLibs, nElectronFromStarkLinear } from '../src/lib/libs/diagnostics.js';

let pass = 0, fail = 0;
const approx = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);
function check(name, ok, got, want) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  got=${got} want=${want}`); }
}
const load = (k, s) => JSON.parse(readFileSync(`public/data/libs/${k}/${s}.json`, 'utf8'));

const Te = 10000, ne = 1e16;
const trueFrac = { Fe: 0.6, Ca: 0.3, Na: 0.1 };
const levelsByElement = {};
const species = [];   // {element, stage, lines:[{Ek,gk,Aki,lam,I}]}
for (const [el, ab] of Object.entries(trueFrac)) {
  levelsByElement[el] = load('levels', el);
  const all = elementLineIntensities(load('lines', el), levelsByElement[el], ab, Te, ne);
  // group by stage, keep the strongest ~10 clean lines per species
  const byStage = new Map();
  for (const l of all) {
    if (l.stage > 3 || l.Ek == null || l.gk == null || !(l.Aki > 0)) continue;
    if (!byStage.has(l.stage)) byStage.set(l.stage, []);
    byStage.get(l.stage).push({ Ek: l.Ek, gk: l.gk, Aki: l.Aki, lam: l.lam, I: l.I });
  }
  for (const [stage, lines] of byStage) {
    lines.sort((a, b) => b.I - a.I);
    const clean = lines.slice(0, 10);
    if (clean.length >= 2) species.push({ element: el, stage, lines: clean });
  }
}

console.log('— Boltzmann temperature (Fe I) —');
const feI = species.find((s) => s.element === 'Fe' && s.stage === 1);
const bt = boltzmannTemperature(feI.lines);
check('Fe I Boltzmann T ~ 10000 K (<3%)', approx(bt.T_K, Te, 0.03), bt.T_K.toFixed(0), Te);
check('Fe I Boltzmann R^2 > 0.99', bt.r2 > 0.99, bt.r2.toFixed(4), '>0.99');

console.log('— CF-LIBS composition recovery (T fitted from data) —');
const r = cfLibs(species, levelsByElement);
check('CF-LIBS fitted T ~ 10000 K (<5%)', approx(r.T_K, Te, 0.05), r.T_K.toFixed(0), Te);
console.log(`  recovered: Fe=${r.concentrations.Fe?.toFixed(3)} Ca=${r.concentrations.Ca?.toFixed(3)} Na=${r.concentrations.Na?.toFixed(3)}  (true 0.6/0.3/0.1)`);
for (const [el, f] of Object.entries(trueFrac)) {
  check(`recover ${el} fraction ${f} (<20% rel)`, approx(r.concentrations[el], f, 0.20),
    r.concentrations[el]?.toFixed(3), f);
}
const sum = Object.values(r.concentrations).reduce((a, b) => a + b, 0);
check('concentrations close to 1', approx(sum, 1, 1e-6), sum.toFixed(4), 1);

console.log('— n_e from linear Stark width (parameterized) —');
// Delta = 2 * ws * (ne/1e16); ws=0.05 nm @1e16 -> Delta at 5e16 should give 5e16
const ne_rec = nElectronFromStarkLinear(2 * 0.05 * 5, 0.05);
check('Stark n_e inversion consistent', approx(ne_rec, 5e16, 1e-9), ne_rec.toExponential(2), 5e16);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
