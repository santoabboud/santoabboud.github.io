/**
 * Build the Atomic Spectra Viewer's line libraries.
 *
 * Input  : LIBSlines/  — local mirror of the upstream databases (gitignored, ~3.5 GB)
 *          public/data/libs/ — the NIST ASD 5.12 mirror already shipped for the LIBS tool
 *          public/data/spectra/*.json — the original scrape, moved to legacy/ on first run
 * Output : public/data/spectra/<lib>/…  plus  public/data/spectra/_libraries.json
 *
 * Run with:  node scripts/build_spectra_libraries.mjs
 * Nothing here runs at request time; the output is committed and served statically.
 *
 * Wavelengths: every library that can, stores air AND vacuum per line. NIST does not
 * convert below ~185 nm (the Handbook switches at 50000 cm^-1 ≈ 200 nm), so down there
 * both columns hold the vacuum value and the viewer says so rather than pretending.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const MIRROR = process.env.LIBSLINES_ROOT ?? join(ROOT, 'LIBSlines');
const OUT = join(ROOT, 'public', 'data', 'spectra');
const LIBSDATA = join(ROOT, 'public', 'data', 'libs');

const SHARD_NM = 25;          // finder shard width
const FINDER_DP = 3;          // wavelength precision kept in the finder index

const log = (...a) => console.log(...a);
const nf = (n) => n.toLocaleString('en-US');
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

/* ---------------------------------------------------------------- helpers */

/** RFC4180 CSV -> array of objects. Kurucz/NIST labels do contain commas in quotes. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])));
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const roman = (n) => ROMAN[n] ?? `[${n}]`;

function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
  return statSync(path).size;
}

/**
 * Finder index, sharded by wavelength so a search fetches ~30 KB not ~2.3 MB.
 * Columnar and delta-coded within each shard: lam = lo + cumsum(d)/10^dp.
 */
function writeFinder(dir, lines) {
  rmSync(dir, { recursive: true, force: true });
  const scale = 10 ** FINDER_DP;
  const byShard = new Map();
  for (const ln of lines) {
    // Bucket on the rounded wavelength, not the raw one: a line at 199.9998 rounds
    // to 200.000 at 3 dp, and bucketing it by the raw value would decode outside
    // its own shard and be missed by a search of the 200 nm bucket.
    const lam = Math.round(ln.lam * scale) / scale;
    const lo = Math.floor(lam / SHARD_NM) * SHARD_NM;
    if (!byShard.has(lo)) byShard.set(lo, []);
    byShard.get(lo).push({ ...ln, lam });
  }
  const shards = [];
  let total = 0, worst = 0;
  for (const [lo, group] of [...byShard.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.lam - b.lam);
    const species = [];
    const index = new Map();
    const d = [], s = [], iv = [];
    let prev = Math.round(lo * scale);
    for (const ln of group) {
      const t = Math.round(ln.lam * scale);
      d.push(t - prev); prev = t;
      let k = index.get(ln.ion);
      if (k === undefined) { k = species.length; species.push(ln.ion); index.set(ln.ion, k); }
      s.push(k);
      // intensity compressed to one log-scaled byte; 0 means "not given"
      iv.push(Number.isFinite(ln.int) && ln.int > 0
        ? Math.max(1, Math.min(255, Math.round(32 * Math.log10(1 + ln.int))))
        : 0);
    }
    const bytes = writeJSON(join(dir, `${lo}.json`), { lo, dp: FINDER_DP, sp: species, d, s, i: iv });
    total += bytes; worst = Math.max(worst, bytes);
    shards.push(lo);
  }
  return { shards, width: SHARD_NM, dp: FINDER_DP, bytes: total, worst };
}

/* ------------------------------------------------------- legacy relocation */

/** The original scrape keeps its data verbatim; it only moves into legacy/. */
function relocateLegacy() {
  const dest = join(OUT, 'legacy');
  if (existsSync(join(dest, '_manifest.json'))) return dest;
  mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const f of readdirSync(OUT)) {
    if (!f.endsWith('.json')) continue;
    if (f === '_libraries.json') continue;
    const src = join(OUT, f);
    if (statSync(src).isDirectory()) continue;
    if (f === '_finder.json') { rmSync(src); continue; }  // superseded by sharded index
    renameSync(src, join(dest, f));
    moved++;
  }
  log(`  legacy: moved ${moved} files into legacy/`);
  return dest;
}

/* ------------------------------------------------------------- library: legacy */

function buildLegacy() {
  const dir = relocateLegacy();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const elements = [];
  const all = [];
  const stageSet = new Set();
  let lines = 0;

  for (const f of files) {
    const sym = f.replace('.json', '');
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    let n = 0;
    const stages = [];
    for (const [ion, rows] of Object.entries(data.stages)) {
      stageSet.add(ion);
      stages.push(ion);
      n += rows.length;
      for (const [lam, intStr] of rows) {
        all.push({ lam, ion, int: parseIntensity(intStr) });
      }
    }
    lines += n;
    elements.push({ sym, lines: n, stages, bytes: statSync(join(dir, f)).size });
  }

  const finder = writeFinder(join(dir, '_finder'), all);
  const manifest = {
    id: 'legacy',
    label: 'Legacy ASD scrape',
    source: 'NIST Atomic Spectra Database (earlier scrape of this site)',
    citation: 'Kramida, A., Ralchenko, Yu., Reader, J. and NIST ASD Team, NIST Atomic Spectra Database. DOI 10.18434/T4W30F',
    licence: 'NIST ASD is a work of the U.S. Government, not subject to copyright in the United States. Citation requested.',
    medium: 'unverified',
    medium_note: 'Carried over unchanged from the original scrape; its air/vacuum convention was never verified. Use the ASD library for wavelengths you intend to rely on.',
    row_format: 'legacy',
    total_lines: lines,
    elements,
    finder,
  };
  writeJSON(join(dir, '_manifest.json'), manifest);
  log(`  legacy    ${nf(lines)} lines, ${elements.length} elements, ${stageSet.size} species, finder ${mb(finder.bytes)} in ${finder.shards.length} shards (worst ${(finder.worst / 1024).toFixed(0)} KB)`);
  return manifest;
}

const parseIntensity = (s) => {
  const m = /^[\s([]*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(String(s ?? ''));
  return m ? parseFloat(m[1]) : NaN;
};

/* ---------------------------------------------------------------- library: asd */

/**
 * The full NIST ASD 5.12 mirror: stages I-V over 100-5000 nm.
 *
 * The LIBS tool ships its own copy of this same mirror under public/data/libs,
 * but that one is cut to 180-1100 nm for peak matching. Reusing it here would
 * silently hide 59,584 lines — everything in the vacuum UV and everything past
 * 1100 nm, which is where the near-IR laser lines live — so the viewer gets the
 * whole thing rather than a window it would then have to apologise for.
 */
function buildASD() {
  const srcDir = join(MIRROR, 'nist_asd', 'normalized', 'libs', 'lines');
  const dir = join(OUT, 'asd');

  if (!existsSync(srcDir)) {
    const prior = join(dir, '_manifest.json');
    if (existsSync(prior)) {
      const m = JSON.parse(readFileSync(prior, 'utf8'));
      log(`  asd       kept as built (${nf(m.total_lines)} lines) — mirror not present, nothing to rebuild from`);
      return m;
    }
    log('  asd       SKIPPED (mirror not present and nothing built earlier)');
    return null;
  }

  rmSync(dir, { recursive: true, force: true });
  const all = [];
  const elements = [];
  let lines = 0;
  const speciesSet = new Set();

  for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const sym = f.replace('.json', '');
    const data = JSON.parse(readFileSync(join(srcDir, f), 'utf8'));
    const ci = Object.fromEntries(data.columns.map((c, i) => [c, i]));
    const out = {};
    let n = 0;
    const stages = [];
    for (const [stage, rows] of Object.entries(data.stages)) {
      if (!rows.length) continue;
      const sorted = [...rows].sort((a, b) => a[ci.lam_air] - b[ci.lam_air]);
      out[stage] = sorted;
      speciesSet.add(`${sym} ${roman(+stage)}`);
      stages.push(+stage);
      n += sorted.length;
      for (const r of sorted) {
        all.push({ lam: r[ci.lam_air], ion: `${sym} ${roman(+stage)}`, int: parseIntensity(r[ci.int]) });
      }
    }
    if (!n) continue;
    const bytes = writeJSON(join(dir, `${sym}.json`), { symbol: sym, columns: data.columns, stages: out });
    lines += n;
    elements.push({ sym, lines: n, stages, bytes });
  }

  const finder = writeFinder(join(dir, '_finder'), all);
  const manifest = {
    id: 'asd',
    label: 'NIST ASD 5.12',
    source: 'NIST Atomic Spectra Database v5.12 (data update November 2024), stages I-V, 100-5000 nm',
    citation: 'Kramida, A., Ralchenko, Yu., Reader, J. and NIST ASD Team (2024). NIST Atomic Spectra Database (ver. 5.12). National Institute of Standards and Technology, Gaithersburg, MD. DOI 10.18434/T4W30F',
    licence: 'NIST ASD is a work of the U.S. Government (17 U.S.C. 105), not subject to copyright in the United States. NIST asks that the database be cited.',
    medium: 'air-vac',
    medium_note: 'Air wavelengths derived from the vacuum values via Peck & Reeder (1972). Following NIST, no conversion is applied below 185 nm — there both columns hold the vacuum wavelength, and the viewer tags those lines vac whatever the toggle says.',
    vac_below_nm: 185,
    row_format: 'libs',
    total_lines: lines,
    elements,
    finder,
  };
  writeJSON(join(dir, '_manifest.json'), manifest);
  const bytes = elements.reduce((t, e) => t + e.bytes, 0);
  log(`  asd       ${nf(lines)} lines, ${elements.length} elements, ${speciesSet.size} species, ${mb(bytes)} + finder ${mb(finder.bytes)} in ${finder.shards.length} shards (worst ${(finder.worst / 1024).toFixed(0)} KB)`);
  return manifest;
}

/* ----------------------------------------------------------- library: handbook */

/**
 * NIST Handbook of Basic Atomic Spectroscopic Data (SRD 108) — the curated strong-line
 * tables. Small, hand-picked, and the least cluttered way to identify a discharge.
 * Rows: [lam_air, lam_vac, intensity, Aki, flags]; flags bit0 = persistent line.
 */
function buildHandbook() {
  const csv = join(MIRROR, 'nist_handbook', 'normalized', 'handbook_lines.csv');
  const dir = join(OUT, 'handbook');

  // The mirror is gitignored, so a fresh clone will not have it. Keep the library
  // that is already committed rather than quietly dropping it from the descriptor.
  if (!existsSync(csv)) {
    const prior = join(dir, '_manifest.json');
    if (existsSync(prior)) {
      const m = JSON.parse(readFileSync(prior, 'utf8'));
      log(`  handbook  kept as built (${nf(m.total_lines)} lines) — mirror not present, nothing to rebuild from`);
      return m;
    }
    log('  handbook  SKIPPED (mirror not present and nothing built earlier)');
    return null;
  }

  const rows = parseCSV(readFileSync(csv, 'utf8'));
  rmSync(dir, { recursive: true, force: true });

  const bySym = new Map();
  for (const r of rows) {
    const sym = r.symbol;
    if (!sym) continue;
    const stage = parseInt(r.stage, 10);
    const ion = r.spectrum && /\s/.test(r.spectrum) ? r.spectrum
      : Number.isFinite(stage) ? `${sym} ${roman(stage)}` : sym;
    const air = parseFloat(r.lam_air_nm);
    const vac = parseFloat(r.lam_vac_nm);
    if (!Number.isFinite(air)) continue;
    const aki = parseFloat(r.Aki_s1);
    const flags = (r.in_persistent_table === '1' ? 1 : 0);
    if (!bySym.has(sym)) bySym.set(sym, new Map());
    const stages = bySym.get(sym);
    if (!stages.has(ion)) stages.set(ion, []);
    stages.get(ion).push([
      air,
      Number.isFinite(vac) ? vac : air,
      r.intensity ?? '',
      Number.isFinite(aki) ? aki : null,
      flags,
    ]);
  }

  const elements = [];
  const all = [];
  let lines = 0, persistent = 0;
  const speciesSet = new Set();

  for (const [sym, stages] of [...bySym.entries()].sort()) {
    const out = {};
    let n = 0;
    const stageList = [];
    for (const [ion, list] of [...stages.entries()].sort()) {
      list.sort((a, b) => a[0] - b[0]);
      out[ion] = list;
      speciesSet.add(ion);
      stageList.push(ion);
      n += list.length;
      for (const r of list) {
        all.push({ lam: r[0], ion, int: parseIntensity(r[2]) });
        if (r[4] & 1) persistent++;
      }
    }
    const bytes = writeJSON(join(dir, `${sym}.json`), {
      symbol: sym,
      columns: ['lam_air', 'lam_vac', 'int', 'Aki', 'flags'],
      stages: out,
    });
    lines += n;
    elements.push({ sym, lines: n, stages: stageList, bytes });
  }

  const finder = writeFinder(join(dir, '_finder'), all);
  const manifest = {
    id: 'handbook',
    label: 'NIST Handbook (strong lines)',
    source: 'NIST Handbook of Basic Atomic Spectroscopic Data (NIST SRD 108)',
    citation: 'Kramida, A., Ralchenko, Yu. (2024). NIST Handbook of Basic Atomic Spectroscopic Data (SRD 108). National Institute of Standards and Technology, Gaithersburg, MD.',
    licence: 'U.S. Government work (NIST SRD 108). NIST web content is public information that may be distributed or copied; attribution requested.',
    medium: 'air-vac',
    medium_note: 'The Handbook lists vacuum wavelengths above 50000 cm^-1 (below about 200 nm) and air wavelengths below it; both columns are carried per line.',
    vac_below_nm: 200,
    row_format: 'v2',
    total_lines: lines,
    persistent_lines: persistent,
    elements,
    finder,
  };
  writeJSON(join(dir, '_manifest.json'), manifest);
  const bytes = elements.reduce((t, e) => t + e.bytes, 0);
  log(`  handbook  ${nf(lines)} lines (${nf(persistent)} persistent), ${elements.length} elements, ${speciesSet.size} species, ${mb(bytes)} + finder ${mb(finder.bytes)}`);
  return manifest;
}

/* --------------------------------------------------------------------- main */

log('Building spectra libraries…');
if (!existsSync(MIRROR)) log(`  note: ${MIRROR} not found — only libraries that need it are skipped`);

const built = [buildASD(), buildHandbook(), buildLegacy()].filter(Boolean);

const DESCRIPTIONS = {
  asd: 'Every observed and Ritz line NIST publishes for stages I–V, from 100 nm out to 5 µm, with transition probabilities. The default, and the one to trust for wavelengths.',
  handbook: 'NIST’s curated strong-line tables — a few hundred lines per element instead of thousands. Best for working out what a discharge is made of.',
  legacy: 'The site’s original scrape. Kept only because it reaches ionization stages VI and above, which the ASD mirror does not cover.',
};

// Stage groupings offered per library. `max` is inclusive; null means "everything above".
// Stage 0 is the Handbook's handful of lines that NIST leaves without an ionization
// stage at all (Es, Os, Po); they get their own box rather than being called neutral.
const STAGE_GROUPS = {
  asd: [
    { key: '1', label: 'I', min: 1, max: 1, on: true },
    { key: '2', label: 'II', min: 2, max: 2, on: true },
    { key: '3', label: 'III', min: 3, max: 3, on: false },
    { key: '4', label: 'IV', min: 4, max: 4, on: false },
    { key: '5', label: 'V', min: 5, max: 5, on: false },
  ],
  handbook: [
    { key: '1', label: 'I', min: 1, max: 1, on: true },
    { key: '2', label: 'II', min: 2, max: 2, on: true },
    { key: '0', label: 'unassigned', min: 0, max: 0, on: true },
  ],
  legacy: [
    { key: '1', label: 'I', min: 1, max: 1, on: true },
    { key: '2', label: 'II', min: 2, max: 2, on: true },
    { key: '3', label: 'III', min: 3, max: 3, on: false },
    { key: '4', label: 'IV–V', min: 4, max: 5, on: false },
    { key: '6', label: '≥VI', min: 6, max: null, on: false },
  ],
};

const libraries = built.map((m) => ({
  id: m.id,
  label: m.label,
  description: DESCRIPTIONS[m.id],
  base: m.base ?? `/data/spectra/${m.id}`,
  manifest: `/data/spectra/${m.id}/_manifest.json`,
  finderBase: `/data/spectra/${m.id}/_finder`,
  rowFormat: m.row_format,
  medium: m.medium,
  vacBelowNm: m.vac_below_nm ?? null,
  stageGroups: STAGE_GROUPS[m.id],
  totalLines: m.total_lines,
  elements: m.elements.length,
  hasPersistent: m.id === 'handbook',
  hasObservedFlag: m.id === 'asd',
}));

writeJSON(join(OUT, '_libraries.json'), {
  default: 'asd',
  defaultView: { min: 180, max: 1100 },
  libraries,
});

const total = (function size(d) {
  let t = 0;
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    t += statSync(p).isDirectory() ? size(p) : statSync(p).size;
  }
  return t;
})(OUT);

log(`\nWrote ${libraries.length} libraries. public/data/spectra is now ${mb(total)}.`);
for (const l of libraries) log(`  ${l.id.padEnd(9)} ${nf(l.totalLines).padStart(9)} lines  ${l.elements} elements`);
