/**
 * Verification for the Atomic Spectra Viewer's line libraries.
 * Run: node scripts/test_spectra_libraries.mjs   (needs public/data/spectra built)
 *
 * Checks the descriptor and every library's manifest against what is actually on
 * disk, then the physics: known lines have to land on their standard-air values,
 * which is also what catches an air/vacuum mix-up. Finally the sharded finder
 * index is checked against a brute-force scan of the element files, and the
 * shipped size against the budget, so a rebuild cannot quietly blow either.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(name, ok, info = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${info}`); }
}

const OUT = 'public/data/spectra';
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

/* Budget: keep a fresh clone small and the Pages upload quick. */
const MAX_TOTAL_MB = 20;
const MAX_ELEMENT_MB = 2;
const MAX_SHARD_KB = 150;
const MAX_FINDER_MB = 2.5;

/* Standard-air wavelengths (nm). A vacuum mix-up shows as +0.06 to +0.25 nm here. */
const REF = [
  ['Na', 'Na I', 588.995], ['Na', 'Na I', 589.592],
  ['H', 'H I', 656.279], ['H', 'H I', 486.135],
  ['He', 'He I', 587.562], ['He', 'He I', 447.148],
  ['Hg', 'Hg I', 546.074], ['Hg', 'Hg I', 435.833], ['Hg', 'Hg I', 404.656],
  ['Ar', 'Ar I', 811.531], ['Ar', 'Ar I', 763.511],
  ['Ne', 'Ne I', 640.225], ['Fe', 'Fe I', 371.994],
  ['Ca', 'Ca II', 393.366], ['Ca', 'Ca II', 396.847],
  ['Mg', 'Mg I', 285.213], ['O', 'O I', 777.194],
  ['Li', 'Li I', 670.776], ['K', 'K I', 766.490],
  ['Cu', 'Cu I', 324.754], ['Sr', 'Sr I', 460.733],
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** Mirrors the viewer's adapters: any library -> [{lam, ion}]. */
function rowsOf(lib, sym, data) {
  const out = [];
  if (lib.rowFormat === 'libs') {
    const ci = Object.fromEntries(data.columns.map((c, i) => [c, i]));
    for (const [stage, rows] of Object.entries(data.stages)) {
      const ion = `${sym} ${ROMAN[+stage] ?? `[${stage}]`}`;
      for (const r of rows) out.push({ lam: r[ci.lam_air], vac: r[ci.lam_vac], ion });
    }
  } else if (lib.rowFormat === 'v2') {
    for (const [ion, rows] of Object.entries(data.stages))
      for (const r of rows) out.push({ lam: r[0], vac: r[1], ion });
  } else {
    for (const [ion, rows] of Object.entries(data.stages))
      for (const r of rows) out.push({ lam: r[0], vac: null, ion });
  }
  return out;
}

const elementPath = (lib, sym) => join('public', lib.base.replace(/^\//, ''), `${sym}.json`);

/**
 * Mirrors the viewer's stage parsing, which differs by library on purpose.
 * The Handbook files carry both "Es I" and a bare "Es" key, so a stageless key
 * there is genuinely unassigned (stage 0). The legacy scrape's only stageless key
 * is "H", which holds all 86 hydrogen lines — hydrogen has no second emitting
 * stage, so that one really is neutral.
 */
const stageOfKey = (s, rowFormat) => {
  if (typeof s === 'number') return s;
  const p = String(s).split(' ');
  if (p.length > 1) return ROMAN.indexOf(p[1]) > 0 ? ROMAN.indexOf(p[1]) : 1;
  return rowFormat === 'v2' ? 0 : 1;
};

console.log('— descriptor —');
check('_libraries.json exists', existsSync(join(OUT, '_libraries.json')));
const desc = readJSON(join(OUT, '_libraries.json'));
check('declares a default library', !!desc.libraries.find((l) => l.id === desc.default),
  `default=${desc.default}`);
check('default is the ASD mirror', desc.default === 'asd', `got ${desc.default}`);
check('default view is the visible+near-IR window',
  desc.defaultView.min === 180 && desc.defaultView.max === 1100);
check('every library has an adapter this viewer implements',
  desc.libraries.every((l) => ['libs', 'v2', 'legacy'].includes(l.rowFormat)));

for (const lib of desc.libraries) {
  console.log(`\n— ${lib.id} —`);
  const mPath = join('public', lib.manifest.replace(/^\//, ''));
  check(`${lib.id}: manifest present`, existsSync(mPath), mPath);
  if (!existsSync(mPath)) continue;
  const man = readJSON(mPath);

  // every declared element resolves to a file, and its byte count is honest
  let missing = 0, wrongBytes = 0, biggest = 0, counted = 0;
  for (const el of man.elements) {
    const p = elementPath(lib, el.sym);
    if (!existsSync(p)) { missing++; continue; }
    const sz = statSync(p).size;
    biggest = Math.max(biggest, sz);
    if (Math.abs(sz - el.bytes) > 2) wrongBytes++;
    counted += el.lines;
  }
  check(`${lib.id}: all ${man.elements.length} declared elements exist`, missing === 0, `${missing} missing`);
  check(`${lib.id}: manifest byte counts match disk`, wrongBytes === 0, `${wrongBytes} wrong`);
  check(`${lib.id}: element line counts sum to total_lines`, counted === man.total_lines,
    `${counted} vs ${man.total_lines}`);
  check(`${lib.id}: largest element file under ${MAX_ELEMENT_MB} MB`,
    biggest <= MAX_ELEMENT_MB * 1048576, `${(biggest / 1048576).toFixed(2)} MB`);

  // stage groups have to cover every stage the data actually contains
  const stagesSeen = new Set();
  for (const el of man.elements) for (const s of el.stages) stagesSeen.add(stageOfKey(s, lib.rowFormat));
  const covered = [...stagesSeen].every((n) =>
    lib.stageGroups.some((g) => n >= g.min && (g.max == null || n <= g.max)));
  check(`${lib.id}: stage groups cover all ${stagesSeen.size} stages present`, covered,
    [...stagesSeen].sort((a, b) => a - b).join(','));
  check(`${lib.id}: opens on neutral + singly ionized only`,
    lib.stageGroups.filter((g) => g.on).every((g) => g.max != null && g.max <= 2),
    lib.stageGroups.filter((g) => g.on).map((g) => g.label).join(','));

  // sorted, finite wavelengths in every element file
  let unsorted = 0, bad = 0;
  for (const el of man.elements.slice(0, 25)) {
    const p = elementPath(lib, el.sym);
    if (!existsSync(p)) continue;
    const data = readJSON(p);
    for (const [ion, rows] of Object.entries(data.stages)) {
      let prev = -Infinity;
      for (const r of rows) {
        const lam = lib.rowFormat === 'legacy' || lib.rowFormat === 'v2' ? r[0]
          : r[data.columns.indexOf('lam_air')];
        if (!Number.isFinite(lam) || lam <= 0) bad++;
        if (lam < prev) unsorted++;
        prev = lam;
      }
      void ion;
    }
  }
  check(`${lib.id}: wavelengths finite and positive`, bad === 0, `${bad} bad`);
  check(`${lib.id}: wavelengths sorted within each species`, unsorted === 0, `${unsorted} out of order`);

  // finder shards: bounded, sorted, inside their own bucket, and complete
  const fDir = join('public', lib.finderBase.replace(/^\//, ''));
  check(`${lib.id}: finder directory exists`, existsSync(fDir), fDir);
  if (existsSync(fDir)) {
    const files = readdirSync(fDir).filter((f) => f.endsWith('.json'));
    let worst = 0, total = 0, outOfBucket = 0, notSorted = 0, indexed = 0;
    for (const f of files) {
      const sz = statSync(join(fDir, f)).size;
      worst = Math.max(worst, sz); total += sz;
      const sh = readJSON(join(fDir, f));
      const scale = 10 ** sh.dp;
      let acc = Math.round(sh.lo * scale), prev = -Infinity;
      for (const d of sh.d) {
        acc += d;
        const lam = acc / scale;
        if (lam < sh.lo || lam >= sh.lo + man.finder.width) outOfBucket++;
        if (lam < prev) notSorted++;
        prev = lam;
      }
      indexed += sh.d.length;
    }
    check(`${lib.id}: shard count matches manifest`, files.length === man.finder.shards.length,
      `${files.length} vs ${man.finder.shards.length}`);
    check(`${lib.id}: every indexed line sits in its own shard`, outOfBucket === 0, `${outOfBucket} stray`);
    check(`${lib.id}: shards are wavelength-sorted`, notSorted === 0, `${notSorted} out of order`);
    check(`${lib.id}: index covers every line`, indexed === man.total_lines,
      `${indexed} vs ${man.total_lines}`);
    check(`${lib.id}: worst shard under ${MAX_SHARD_KB} KB`, worst <= MAX_SHARD_KB * 1024,
      `${(worst / 1024).toFixed(0)} KB`);
    check(`${lib.id}: finder total under ${MAX_FINDER_MB} MB`, total <= MAX_FINDER_MB * 1048576,
      `${(total / 1048576).toFixed(2)} MB`);
  }
}

/* Physics: reference lines land on standard air, in the two NIST libraries.
 * Tolerances differ by library on purpose. ASD lists every fine-structure
 * component, so it hits the catalogue value to a picometre. The Handbook carries
 * a curated subset — for H-alpha it lists 656.2711 / 656.27248 / 656.28518 and
 * not ASD's 656.2787 — so the nearest listed component can sit tens of pm away.
 * Both tolerances stay far below the 60-250 pm a vacuum mix-up would produce,
 * which is what this check is really for. */
console.log('\n— reference wavelengths (standard air) —');
for (const [id, tolPm] of [['asd', 5], ['handbook', 30]]) {
  const lib = desc.libraries.find((l) => l.id === id);
  if (!lib) continue;
  const tol = tolPm / 1000;
  let worst = 0, worstName = '', tested = 0, missed = 0;
  for (const [sym, ion, expected] of REF) {
    const p = elementPath(lib, sym);
    if (!existsSync(p)) continue;
    const rows = rowsOf(lib, sym, readJSON(p)).filter((r) => r.ion === ion);
    if (!rows.length) continue;
    let best = Infinity;
    for (const r of rows) best = Math.min(best, Math.abs(r.lam - expected));
    tested++;
    if (best > tol) { missed++; if (best > worst) { worst = best; worstName = `${ion} ${expected}`; } }
  }
  check(`${id}: reference lines match standard air within ${tolPm} pm`, missed === 0,
    `${missed}/${tested} off, worst ${worstName} by ${(worst * 1000).toFixed(1)} pm`);
  check(`${id}: enough reference lines were actually found`, tested >= 15, `only ${tested}`);
  // A vacuum mix-up would blow past this; catching it is the point of the block above.
  check(`${id}: no reference line is off by a vacuum-shift`, worst < 0.05,
    `worst ${(worst * 1000).toFixed(1)} pm`);
}

/* The ASD library must carry a genuine vacuum column, not a copy of air. */
{
  const lib = desc.libraries.find((l) => l.id === 'asd');
  const rows = rowsOf(lib, 'Na', readJSON(elementPath(lib, 'Na'))).filter((r) => r.ion === 'Na I');
  const d2 = rows.reduce((b, r) => (Math.abs(r.lam - 588.995) < Math.abs(b.lam - 588.995) ? r : b));
  check('asd: Na D2 vacuum value is ~0.163 nm above air',
    Math.abs((d2.vac - d2.lam) - 0.1633) < 0.01, `Δ=${(d2.vac - d2.lam).toFixed(4)} nm`);
}

/* The whole point of the rebuild: the elements that were nearly empty are not. */
console.log('\n— coverage regression —');
{
  const asd = desc.libraries.find((l) => l.id === 'asd');
  for (const [sym, atLeast] of [['Gd', 900], ['Yb', 650], ['Tb', 600], ['Pr', 1000], ['Nd', 700], ['Hf', 4500]]) {
    const n = rowsOf(asd, sym, readJSON(elementPath(asd, sym))).length;
    check(`asd: ${sym} carries at least ${atLeast} lines`, n >= atLeast, `got ${n}`);
  }
  // The viewer must not inherit the LIBS tool's 180-1100 nm matching window.
  const ne = rowsOf(asd, 'Ne', readJSON(elementPath(asd, 'Ne')));
  check('asd: reaches past 1100 nm (He-Ne 1152.27 nm Ne I line is present)',
    ne.some((r) => Math.abs(r.lam - 1152.275) < 0.01), 'near-IR window missing');
  check('asd: reaches into the vacuum UV below 180 nm',
    ne.some((r) => r.lam < 180), 'deep-UV window missing');
}

/* Two bugs found in review; both are invisible until someone toggles the medium. */
console.log('\n— air/vacuum handling —');
{
  const asd = desc.libraries.find((l) => l.id === 'asd');

  // applyMedium re-sorts because the two orderings genuinely differ at the 185 nm
  // no-conversion boundary. If this ever stops being true the sort is still correct,
  // but the comment explaining it would be wrong — so assert the premise directly.
  let inversions = 0, checkedEls = 0;
  for (const el of readJSON(join('public', asd.manifest.replace(/^\//, ''))).elements) {
    const rows = rowsOf(asd, el.sym, readJSON(elementPath(asd, el.sym)));
    const byStage = new Map();
    for (const r of rows) {
      if (!byStage.has(r.ion)) byStage.set(r.ion, []);
      byStage.get(r.ion).push(r);
    }
    for (const list of byStage.values()) {
      const air = [...list].sort((a, b) => a.lam - b.lam);
      for (let k = 1; k < air.length; k++) if (air[k].vac < air[k - 1].vac) inversions++;
    }
    checkedEls++;
  }
  check('asd: air and vacuum orderings really do differ (so applyMedium must re-sort)',
    inversions > 0, `${inversions} inversions across ${checkedEls} elements`);

  // Every row where the two columns are equal is an unconverted vacuum wavelength.
  // That equality — not a wavelength threshold — is what the tooltip tags as "vac".
  let equalPairs = 0, equalAbove = 0;
  for (const el of readJSON(join('public', asd.manifest.replace(/^\//, ''))).elements.slice(0, 30)) {
    for (const r of rowsOf(asd, el.sym, readJSON(elementPath(asd, el.sym)))) {
      if (r.vac === r.lam) { equalPairs++; if (r.lam > 185) equalAbove++; }
    }
  }
  check('asd: unconverted rows exist and all sit below the 185 nm switch',
    equalPairs > 0 && equalAbove === 0, `${equalPairs} equal, ${equalAbove} above 185 nm`);
}

/* Finder agrees with a brute-force scan of the element files. */
console.log('\n— finder vs brute force —');
{
  const lib = desc.libraries.find((l) => l.id === 'asd');
  const man = readJSON(join('public', lib.manifest.replace(/^\//, '')));
  const target = 587.562, tol = 0.25;                    // He I, a crowded neighbourhood
  const brute = new Set();
  for (const el of man.elements) {
    const p = elementPath(lib, el.sym);
    if (!existsSync(p)) continue;
    for (const r of rowsOf(lib, el.sym, readJSON(p)))
      if (Math.abs(r.lam - target) <= tol) brute.add(`${r.ion}@${r.lam.toFixed(3)}`);
  }
  const width = man.finder.width;
  const found = new Set();
  for (let lo = Math.floor((target - tol) / width) * width; lo <= Math.floor((target + tol) / width) * width; lo += width) {
    const p = join('public', lib.finderBase.replace(/^\//, ''), `${lo}.json`);
    if (!existsSync(p)) continue;
    const sh = readJSON(p);
    const scale = 10 ** sh.dp;
    let acc = Math.round(sh.lo * scale);
    for (let k = 0; k < sh.d.length; k++) {
      acc += sh.d[k];
      const lam = acc / scale;
      if (Math.abs(lam - target) <= tol) found.add(`${sh.sp[sh.s[k]]}@${lam.toFixed(3)}`);
    }
  }
  check('asd: sharded finder returns exactly the brute-force set',
    brute.size === found.size && [...brute].every((x) => found.has(x)),
    `brute ${brute.size}, finder ${found.size}`);
  check('asd: the search neighbourhood is not empty', brute.size > 0, `${brute.size}`);
}

/* Size budget for the directory as a whole. */
console.log('\n— size budget —');
{
  const size = (d) => readdirSync(d).reduce((t, f) => {
    const p = join(d, f);
    return t + (statSync(p).isDirectory() ? size(p) : statSync(p).size);
  }, 0);
  const total = size(OUT);
  check(`public/data/spectra under ${MAX_TOTAL_MB} MB`, total <= MAX_TOTAL_MB * 1048576,
    `${(total / 1048576).toFixed(2)} MB`);
  check('the superseded monolithic finder is gone', !existsSync(join(OUT, '_finder.json')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
