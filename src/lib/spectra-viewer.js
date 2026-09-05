/**
 * Atomic Spectra Viewer — vanilla-JS module.
 *
 * Data: a descriptor at <base>/_libraries.json listing the available line libraries,
 *       each with its own _manifest.json, per-element JSON, and a wavelength-sharded
 *       finder index at <lib>/_finder/<lo>.json.
 *
 * Three row formats are read (see scripts/build_spectra_libraries.mjs):
 *   'libs'   [lam_air, lam_vac, Aki, Ek, gk, Ei, gi, int, acc, src]  — the NIST ASD mirror
 *   'v2'     [lam_air, lam_vac, int, Aki, flags]                     — NIST Handbook
 *   'legacy' [lam, intensity, Aki]                                   — the original scrape
 * All three are adapted into one internal row so the canvas code stays format-agnostic.
 *
 * Display physics / caveats (also stated in the page UI):
 *  - Air and vacuum wavelengths are both carried where the source provides them, and the
 *    axis follows the medium toggle. NIST does not convert below ~185 nm (the Handbook
 *    switches at 200 nm), so below that both columns hold the vacuum value; the UI says so
 *    instead of silently mixing conventions. The legacy library's convention was never
 *    verified, so it offers no toggle.
 *  - "Intensity" is a relative observed intensity: per-species, source-condition-dependent,
 *    NOT comparable across species, and in the Handbook renormalised to 1000 per spectrum.
 *    Stick heights are therefore log-normalized PER ELEMENT BAND.
 *  - Intensity strings are preserved verbatim (qualifiers like "w", "bl", parentheses
 *    survive); only a leading numeric is parsed for heights.
 *  - Line color comes from the same CIE-CMF mapping as the site's design tokens
 *    (src/lib/wavelength-color.js); out-of-visible lines render as dimmed boundary hues.
 */
import { wavelengthToColor } from './wavelength-color.js';

/* Periodic-table layout — carried over from the v1 site, extended with the
   heavy actinides that the ASD mirror covers but the original scrape did not. */
export const ELEMENTS = [
  { s: 'H', n: 'Hydrogen', r: 1, c: 1 }, { s: 'He', n: 'Helium', r: 1, c: 18 },
  { s: 'Li', n: 'Lithium', r: 2, c: 1 }, { s: 'Be', n: 'Beryllium', r: 2, c: 2 },
  { s: 'B', n: 'Boron', r: 2, c: 13 }, { s: 'C', n: 'Carbon', r: 2, c: 14 },
  { s: 'N', n: 'Nitrogen', r: 2, c: 15 }, { s: 'O', n: 'Oxygen', r: 2, c: 16 },
  { s: 'F', n: 'Fluorine', r: 2, c: 17 }, { s: 'Ne', n: 'Neon', r: 2, c: 18 },
  { s: 'Na', n: 'Sodium', r: 3, c: 1 }, { s: 'Mg', n: 'Magnesium', r: 3, c: 2 },
  { s: 'Al', n: 'Aluminium', r: 3, c: 13 }, { s: 'Si', n: 'Silicon', r: 3, c: 14 },
  { s: 'P', n: 'Phosphorus', r: 3, c: 15 }, { s: 'S', n: 'Sulfur', r: 3, c: 16 },
  { s: 'Cl', n: 'Chlorine', r: 3, c: 17 }, { s: 'Ar', n: 'Argon', r: 3, c: 18 },
  { s: 'K', n: 'Potassium', r: 4, c: 1 }, { s: 'Ca', n: 'Calcium', r: 4, c: 2 },
  { s: 'Sc', n: 'Scandium', r: 4, c: 3 }, { s: 'Ti', n: 'Titanium', r: 4, c: 4 },
  { s: 'V', n: 'Vanadium', r: 4, c: 5 }, { s: 'Cr', n: 'Chromium', r: 4, c: 6 },
  { s: 'Mn', n: 'Manganese', r: 4, c: 7 }, { s: 'Fe', n: 'Iron', r: 4, c: 8 },
  { s: 'Co', n: 'Cobalt', r: 4, c: 9 }, { s: 'Ni', n: 'Nickel', r: 4, c: 10 },
  { s: 'Cu', n: 'Copper', r: 4, c: 11 }, { s: 'Zn', n: 'Zinc', r: 4, c: 12 },
  { s: 'Ga', n: 'Gallium', r: 4, c: 13 }, { s: 'Ge', n: 'Germanium', r: 4, c: 14 },
  { s: 'As', n: 'Arsenic', r: 4, c: 15 }, { s: 'Se', n: 'Selenium', r: 4, c: 16 },
  { s: 'Br', n: 'Bromine', r: 4, c: 17 }, { s: 'Kr', n: 'Krypton', r: 4, c: 18 },
  { s: 'Rb', n: 'Rubidium', r: 5, c: 1 }, { s: 'Sr', n: 'Strontium', r: 5, c: 2 },
  { s: 'Y', n: 'Yttrium', r: 5, c: 3 }, { s: 'Zr', n: 'Zirconium', r: 5, c: 4 },
  { s: 'Nb', n: 'Niobium', r: 5, c: 5 }, { s: 'Mo', n: 'Molybdenum', r: 5, c: 6 },
  { s: 'Tc', n: 'Technetium', r: 5, c: 7 }, { s: 'Ru', n: 'Ruthenium', r: 5, c: 8 },
  { s: 'Rh', n: 'Rhodium', r: 5, c: 9 }, { s: 'Pd', n: 'Palladium', r: 5, c: 10 },
  { s: 'Ag', n: 'Silver', r: 5, c: 11 }, { s: 'Cd', n: 'Cadmium', r: 5, c: 12 },
  { s: 'In', n: 'Indium', r: 5, c: 13 }, { s: 'Sn', n: 'Tin', r: 5, c: 14 },
  { s: 'Sb', n: 'Antimony', r: 5, c: 15 }, { s: 'Te', n: 'Tellurium', r: 5, c: 16 },
  { s: 'I', n: 'Iodine', r: 5, c: 17 }, { s: 'Xe', n: 'Xenon', r: 5, c: 18 },
  { s: 'Cs', n: 'Caesium', r: 6, c: 1 }, { s: 'Ba', n: 'Barium', r: 6, c: 2 },
  { s: 'La', n: 'Lanthanum', r: 9, c: 3 }, { s: 'Ce', n: 'Cerium', r: 9, c: 4 },
  { s: 'Pr', n: 'Praseodymium', r: 9, c: 5 }, { s: 'Nd', n: 'Neodymium', r: 9, c: 6 },
  { s: 'Pm', n: 'Promethium', r: 9, c: 7 }, { s: 'Sm', n: 'Samarium', r: 9, c: 8 },
  { s: 'Eu', n: 'Europium', r: 9, c: 9 }, { s: 'Gd', n: 'Gadolinium', r: 9, c: 10 },
  { s: 'Tb', n: 'Terbium', r: 9, c: 11 }, { s: 'Dy', n: 'Dysprosium', r: 9, c: 12 },
  { s: 'Ho', n: 'Holmium', r: 9, c: 13 }, { s: 'Er', n: 'Erbium', r: 9, c: 14 },
  { s: 'Tm', n: 'Thulium', r: 9, c: 15 }, { s: 'Yb', n: 'Ytterbium', r: 9, c: 16 },
  { s: 'Lu', n: 'Lutetium', r: 9, c: 17 }, { s: 'Hf', n: 'Hafnium', r: 6, c: 4 },
  { s: 'Ta', n: 'Tantalum', r: 6, c: 5 }, { s: 'W', n: 'Tungsten', r: 6, c: 6 },
  { s: 'Re', n: 'Rhenium', r: 6, c: 7 }, { s: 'Os', n: 'Osmium', r: 6, c: 8 },
  { s: 'Ir', n: 'Iridium', r: 6, c: 9 }, { s: 'Pt', n: 'Platinum', r: 6, c: 10 },
  { s: 'Au', n: 'Gold', r: 6, c: 11 }, { s: 'Hg', n: 'Mercury', r: 6, c: 12 },
  { s: 'Tl', n: 'Thallium', r: 6, c: 13 }, { s: 'Pb', n: 'Lead', r: 6, c: 14 },
  { s: 'Bi', n: 'Bismuth', r: 6, c: 15 }, { s: 'Po', n: 'Polonium', r: 6, c: 16 },
  { s: 'At', n: 'Astatine', r: 6, c: 17 }, { s: 'Rn', n: 'Radon', r: 6, c: 18 },
  { s: 'Fr', n: 'Francium', r: 7, c: 1 }, { s: 'Ra', n: 'Radium', r: 7, c: 2 },
  { s: 'Ac', n: 'Actinium', r: 10, c: 3 }, { s: 'Th', n: 'Thorium', r: 10, c: 4 },
  { s: 'Pa', n: 'Protactinium', r: 10, c: 5 }, { s: 'U', n: 'Uranium', r: 10, c: 6 },
  { s: 'Np', n: 'Neptunium', r: 10, c: 7 }, { s: 'Pu', n: 'Plutonium', r: 10, c: 8 },
  { s: 'Am', n: 'Americium', r: 10, c: 9 }, { s: 'Cm', n: 'Curium', r: 10, c: 10 },
  { s: 'Bk', n: 'Berkelium', r: 10, c: 11 }, { s: 'Cf', n: 'Californium', r: 10, c: 12 },
  { s: 'Es', n: 'Einsteinium', r: 10, c: 13 },
];

function romanToInt(str) {
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  if (!str || [...str].some((ch) => !(ch in v))) return null;
  let t = 0;
  for (let k = 0; k < str.length; k++) {
    const x = v[str[k]];
    t += k + 1 < str.length && v[str[k + 1]] > x ? -x : x;
  }
  return t;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

const parseIntensity = (s) => {
  const m = /^[\s(\[]*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(String(s ?? ''));
  return m ? parseFloat(m[1]) : NaN;
};

const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

/* --------------------------------------------------------- row adapters */

/** Each adapter turns one library's stored rows into the viewer's internal row shape. */
const ADAPTERS = {
  /* NIST ASD mirror: columns declared in the file, stage keys are numbers. */
  libs(data, sym) {
    const ci = Object.fromEntries(data.columns.map((c, i) => [c, i]));
    const out = [];
    for (const [stage, rows] of Object.entries(data.stages)) {
      const st = parseInt(stage, 10) || 1;
      const ion = `${sym} ${ROMAN[st] ?? `[${st}]`}`;
      for (const r of rows) {
        const intStr = r[ci.int] ?? '';
        out.push({
          air: r[ci.lam_air], vac: r[ci.lam_vac] ?? r[ci.lam_air],
          int: parseIntensity(intStr), intStr,
          aki: r[ci.Aki] ?? null, ritz: r[ci.src] === 1,
          persistent: false, stage: st, ion,
        });
      }
    }
    return out;
  },

  /* NIST Handbook build: [lam_air, lam_vac, int, Aki, flags]. */
  v2(data) {
    const out = [];
    for (const [ion, rows] of Object.entries(data.stages)) {
      const parts = ion.split(' ');
      // A key with no roman numeral (Es, Os, Po) is a line NIST left without an
      // ionization stage. Stage 0 keeps it out of the "neutral" bucket.
      const st = parts.length > 1 ? romanToInt(parts[1]) ?? 1 : 0;
      for (const r of rows) {
        out.push({
          air: r[0], vac: r[1] ?? r[0],
          int: parseIntensity(r[2]), intStr: r[2] ?? '',
          aki: r[3] ?? null, ritz: false,
          persistent: !!(r[4] & 1), stage: st, ion,
        });
      }
    }
    return out;
  },

  /* Original scrape: [lam, intensity, Aki], stage keys like "Fe II". */
  legacy(data) {
    const out = [];
    for (const [ion, rows] of Object.entries(data.stages)) {
      const parts = ion.split(' ');
      const st = parts.length > 1 ? romanToInt(parts[1]) ?? 1 : 1;
      for (const [lam, intStr, aki] of rows) {
        out.push({
          air: lam, vac: null,
          int: parseIntensity(intStr), intStr: intStr ?? '',
          aki: aki || null, ritz: false, persistent: false, stage: st, ion,
        });
      }
    }
    return out;
  },
};

export function initSpectraViewer(root, { librariesUrl = '/data/spectra/_libraries.json' } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const ptEl = $('[data-pt]');
  const canvas = $('[data-canvas]');
  const wrap = canvas.parentElement;
  const tooltip = $('[data-tooltip]');
  const statusEl = $('[data-status]');
  const chipsEl = $('[data-selected]');
  const findRes = $('[data-find-results]');
  const libSel = $('[data-lib]');
  const stagesEl = $('[data-stages]');
  const filtersEl = $('[data-filters]');
  const caveatEl = $('[data-caveat]');
  const resetBtn = $('[data-reset]');

  const state = {
    sel: [],                 // selected symbols, max 3 (FIFO eviction)
    cache: new Map(),        // "lib:sym" -> {rows, total}
    view: { min: 180, max: 1100 },
    defaultView: { min: 180, max: 1100 },
    stages: new Set(),       // enabled stage-group keys for the active library
    medium: 'air',
    observedOnly: false,
    persistentOnly: false,
    buckets: [],
    desc: null,              // _libraries.json
    lib: null,               // active library id
    manifests: new Map(),    // lib id -> manifest
    shards: new Map(),       // "lib:lo" -> decoded shard
    drag: null,
    raf: 0,
  };
  const MAX_SEL = 3, MAX_CACHE = 12;
  const PAD_L = 46, PAD_R = 12, BAND_H = 130, AXIS_H = 34;
  const SPAN_MIN = 0.5, SPAN_MAX = 50000, LAM_LO = 50, LAM_HI = 80000;

  const setStatus = (msg) => { statusEl.textContent = msg; };
  const activeLib = () => state.desc?.libraries.find((l) => l.id === state.lib) ?? null;
  const manifest = () => state.manifests.get(state.lib) ?? null;

  /* ---------------- data ---------------- */

  async function ensureManifest(id) {
    if (state.manifests.has(id)) return state.manifests.get(id);
    const lib = state.desc.libraries.find((l) => l.id === id);
    const r = await fetch(lib.manifest);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${id} manifest`);
    const m = await r.json();
    state.manifests.set(id, m);
    return m;
  }

  async function ensureElement(sym) {
    const key = `${state.lib}:${sym}`;
    if (state.cache.has(key)) return state.cache.get(key);
    const lib = activeLib();
    const m = await ensureManifest(state.lib);
    const info = m.elements.find((e) => e.sym === sym);
    setStatus(`Loading ${sym} from ${lib.label}${info ? ` (${fmtBytes(info.bytes)})` : ''}…`);
    const r = await fetch(`${lib.base}/${sym}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${sym}.json`);
    const rows = ADAPTERS[lib.rowFormat](await r.json(), sym);
    applyMedium(rows);                       // sorts as well
    const entry = { rows, total: rows.length };
    state.cache.set(key, entry);
    // Walk past entries that are currently on screen rather than stopping at one,
    // otherwise a long-held selection at the head of the Map pins the cache open.
    const pinned = new Set(state.sel.map((s) => `${state.lib}:${s}`)).add(key);
    for (const k of [...state.cache.keys()]) {
      if (state.cache.size <= MAX_CACHE) break;
      if (!pinned.has(k)) state.cache.delete(k);
    }
    return entry;
  }

  /**
   * What medium a given line is actually in. Where NIST applied no conversion the
   * two columns hold the same number, so that row is vacuum no matter what the
   * toggle says — test the row itself rather than a wavelength threshold, which
   * mislabels the lines sitting either side of the switch. The legacy scrape's
   * convention was never verified, so it gets no label at all.
   */
  function mediumTagFor(row) {
    const lib = activeLib();
    if (lib.medium !== 'air-vac') return '';
    if (row.vac != null && row.vac === row.air) return 'vac';
    return state.medium === 'vac' ? 'vac' : 'air';
  }

  /**
   * Display wavelength follows the medium toggle, then re-sort: air and vacuum do
   * NOT order identically. At NIST's 185 nm no-conversion boundary a converted air
   * value can sit below an unconverted one whose vacuum value is higher, which
   * inverts a handful of pairs — enough to break the binary search in visibleRows.
   */
  function applyMedium(rows) {
    const useVac = state.medium === 'vac';
    for (const r of rows) r.lam = useVac && r.vac != null ? r.vac : r.air;
    rows.sort((a, b) => a.lam - b.lam);
  }

  function remapMedium() {
    for (const entry of state.cache.values()) applyMedium(entry.rows);
  }

  /* ---------------- finder shards ---------------- */

  async function loadShard(lo) {
    const key = `${state.lib}:${lo}`;
    if (state.shards.has(key)) return state.shards.get(key);
    const lib = activeLib();
    const r = await fetch(`${lib.finderBase}/${lo}.json`);
    if (!r.ok) { state.shards.set(key, null); return null; }
    const raw = await r.json();
    const scale = 10 ** raw.dp;
    const out = [];
    let acc = Math.round(raw.lo * scale);
    for (let k = 0; k < raw.d.length; k++) {
      acc += raw.d[k];
      out.push({ lam: acc / scale, ion: raw.sp[raw.s[k]], i: raw.i[k] });
    }
    state.shards.set(key, out);
    return out;
  }

  /* ---------------- UI: library, stages, filters ---------------- */

  function renderLibrarySelect() {
    libSel.innerHTML = '';
    for (const l of state.desc.libraries) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = l.label;
      o.selected = l.id === state.lib;
      libSel.appendChild(o);
    }
  }

  function renderStages() {
    const lib = activeLib();
    stagesEl.innerHTML = '';
    if (!lib.stageGroups?.length) { stagesEl.hidden = true; return; }
    stagesEl.hidden = false;
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.textContent = 'STAGES:';
    stagesEl.appendChild(lbl);
    for (const g of lib.stageGroups) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.stages.has(g.key);
      cb.dataset.stage = g.key;
      cb.onchange = () => {
        cb.checked ? state.stages.add(g.key) : state.stages.delete(g.key);
        requestDraw(); updateStatusCounts();
      };
      l.appendChild(cb);
      l.appendChild(document.createTextNode(` ${g.label}`));
      stagesEl.appendChild(l);
    }
  }

  function renderFilters() {
    const lib = activeLib();
    filtersEl.innerHTML = '';

    if (lib.medium === 'air-vac') {
      const wrapEl = document.createElement('span');
      wrapEl.className = 'sv-seg';
      wrapEl.append('λ in ');
      for (const [val, label] of [['air', 'air'], ['vac', 'vacuum']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sv-segbtn';
        b.textContent = label;
        b.dataset.medium = val;
        b.setAttribute('aria-pressed', String(state.medium === val));
        b.onclick = () => {
          if (state.medium === val) return;
          state.medium = val;
          remapMedium();
          // Flip the pair in place; re-rendering the row would destroy the button
          // the user just activated and drop focus to <body>.
          for (const btn of filtersEl.querySelectorAll('[data-medium]'))
            btn.setAttribute('aria-pressed', String(btn.dataset.medium === val));
          requestDraw(); updateStatusCounts();
        };
        wrapEl.appendChild(b);
      }
      filtersEl.appendChild(wrapEl);
    }

    if (lib.hasObservedFlag) {
      filtersEl.appendChild(checkbox('Observed only', state.observedOnly, (v) => {
        state.observedOnly = v; requestDraw(); updateStatusCounts();
      }, 'Hide Ritz lines — wavelengths calculated from energy levels rather than measured directly.'));
    }
    if (lib.hasPersistent) {
      filtersEl.appendChild(checkbox('Persistent only', state.persistentOnly, (v) => {
        state.persistentOnly = v; requestDraw(); updateStatusCounts();
      }, 'Show only the lines NIST marks as persistent — the last to survive as a source weakens.'));
    }
  }

  function checkbox(label, checked, onChange, title) {
    const l = document.createElement('label');
    if (title) l.title = title;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.onchange = () => onChange(cb.checked);
    l.appendChild(cb);
    l.appendChild(document.createTextNode(` ${label}`));
    return l;
  }

  function renderCaveat() {
    if (!caveatEl) return;
    const lib = activeLib();
    const m = manifest();
    const bits = [];
    if (m?.medium_note) bits.push(m.medium_note);
    bits.push('Relative intensities are per-species and source-condition-dependent: stick heights are log-normalized <em>within each element band</em> and are <em>not</em> comparable across species.');
    caveatEl.innerHTML =
      `<span class="lbl">${lib.label.toUpperCase()}</span> ${lib.description} ${bits.join(' ')} ` +
      `<a href="${lib.manifest}">Data manifest</a>${m?.citation ? ` · ${m.citation}` : ''}`;
  }

  function renderPeriodicTable() {
    const m = manifest();
    const avail = new Set(m ? m.elements.map((e) => e.sym) : []);
    ptEl.innerHTML = '';
    for (const el of ELEMENTS) {
      const b = document.createElement('button');
      b.dataset.sym = el.s;
      b.className = 'pt-cell';
      b.textContent = el.s;
      b.style.gridRow = el.r;
      b.style.gridColumn = el.c;
      const has = avail.has(el.s);
      b.title = has ? el.n : `${el.n} — not in this library`;
      if (!has) { b.dataset.avail = 'no'; b.disabled = true; }
      b.setAttribute('aria-pressed', String(state.sel.includes(el.s)));
      b.onclick = () => toggle(el.s);
      ptEl.appendChild(b);
    }
  }

  async function switchLibrary(id) {
    if (id === state.lib) return;
    state.lib = id;
    setStatus(`Loading ${activeLib().label}…`);
    let m;
    try { m = await ensureManifest(id); }
    catch (e) { setStatus(`Could not load ${id}: ${e.message}`); return; }

    // reset per-library UI state
    const lib = activeLib();
    state.stages = new Set((lib.stageGroups ?? []).filter((g) => g.on).map((g) => g.key));
    if (lib.medium !== 'air-vac') state.medium = 'air';
    state.observedOnly = false;
    state.persistentOnly = false;
    state.shards.clear();
    state.buckets = [];
    // Cached rows were mapped under whatever medium was active when they loaded.
    // Without this, leaving and re-entering an air/vac library plots vacuum
    // wavelengths while every label still says air.
    remapMedium();

    // drop selections this library does not carry, then reload the rest
    const avail = new Set(m.elements.map((e) => e.sym));
    const dropped = state.sel.filter((s) => !avail.has(s));
    state.sel = state.sel.filter((s) => avail.has(s));
    for (const s of state.sel) { try { await ensureElement(s); } catch { /* reported below */ } }

    renderStages(); renderFilters(); renderCaveat(); renderPeriodicTable(); renderChips();
    findRes.innerHTML = '';
    requestDraw(); updateStatusCounts();   // reports the library summary when nothing is selected
    if (dropped.length) {
      setStatus(`${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} not in ${lib.label} — removed from the plot.`);
    }
  }

  /* ---------------- selection ---------------- */

  function renderChips() {
    chipsEl.innerHTML = '';
    for (const sym of state.sel) {
      const b = document.createElement('button');
      b.className = 'sv-chip';
      b.innerHTML = `${sym} <span aria-hidden="true">✕</span>`;
      b.setAttribute('aria-label', `Remove ${sym}`);
      b.onclick = () => toggle(sym);
      chipsEl.appendChild(b);
    }
    ptEl.querySelectorAll('button[data-sym]').forEach((btn) =>
      btn.setAttribute('aria-pressed', String(state.sel.includes(btn.dataset.sym))));
  }

  async function toggle(sym) {
    const i = state.sel.indexOf(sym);
    if (i >= 0) state.sel.splice(i, 1);
    else {
      try { await ensureElement(sym); } catch (e) { setStatus(`Failed to load ${sym}: ${e.message}`); return; }
      state.sel.push(sym);
      if (state.sel.length > MAX_SEL) state.sel.shift();
    }
    renderChips();
    requestDraw();
    updateStatusCounts();
  }

  /* ---------------- filtering ---------------- */

  function stageOK(st) {
    const groups = activeLib()?.stageGroups ?? [];
    for (const g of groups) {
      if (st >= g.min && (g.max == null || st <= g.max)) return state.stages.has(g.key);
    }
    return false;
  }

  const rowOK = (r) =>
    stageOK(r.stage) &&
    !(state.observedOnly && r.ritz) &&
    !(state.persistentOnly && !r.persistent);

  function visibleRows(sym) {
    const entry = state.cache.get(`${state.lib}:${sym}`);
    if (!entry) return [];
    const { rows } = entry;
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; rows[m].lam < state.view.min ? (lo = m + 1) : (hi = m); }
    const out = [];
    for (let k = lo; k < rows.length && rows[k].lam <= state.view.max; k++)
      if (rowOK(rows[k])) out.push(rows[k]);
    return out;
  }

  function updateStatusCounts() {
    if (!state.sel.length) {
      const lib = activeLib(), m = manifest();
      if (lib && m) setStatus(`${lib.label} — ${m.total_lines.toLocaleString()} lines across ${m.elements.length} elements. Pick an element.`);
      return;
    }
    const parts = state.sel.map((sym) => {
      const entry = state.cache.get(`${state.lib}:${sym}`);
      const vis = visibleRows(sym).length;
      return `${sym}: ${vis.toLocaleString()} in view / ${(entry?.total ?? 0).toLocaleString()} total`;
    });
    const medium = activeLib()?.medium === 'air-vac'
      ? `   ·   λ in ${state.medium === 'vac' ? 'vacuum' : 'air'}` : '';
    setStatus(parts.join('   ·   ') + medium);
  }

  /* ---------------- drawing ---------------- */
  function requestDraw() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => { state.raf = 0; draw(); });
  }

  function niceStep(span) {
    const raw = span / 8;
    const mag = 10 ** Math.floor(Math.log10(raw));
    for (const f of [1, 2, 5, 10]) if (raw <= f * mag) return f * mag;
    return 10 * mag;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const Wc = wrap.clientWidth;
    const bands = Math.max(state.sel.length, 1);
    const Hc = bands * BAND_H + AXIS_H;
    canvas.style.height = `${Hc}px`;
    canvas.width = Math.round(Wc * dpr);
    canvas.height = Math.round(Hc * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const plate = css('--rulebg') || '#0E0B06';
    const paper = css('--bg') || '#E7DCC2';
    ctx.fillStyle = plate;
    ctx.fillRect(0, 0, Wc, Hc);

    const { min, max } = state.view;
    const span = max - min;
    const W = Wc - PAD_L - PAD_R;
    const xOf = (lam) => PAD_L + ((lam - min) / span) * W;

    const step = niceStep(span);
    const t0 = Math.ceil(min / step) * step;
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = 'center';
    for (let t = t0; t <= max + 1e-9; t += step) {
      const x = xOf(t);
      ctx.globalAlpha = 0.14; ctx.strokeStyle = paper;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, Hc - AXIS_H + 6); ctx.stroke();
      ctx.globalAlpha = 0.75; ctx.fillStyle = paper;
      const lbl = step < 1 ? t.toFixed(1) : Math.round(t).toString();
      ctx.fillText(lbl, x, Hc - AXIS_H + 20);
    }
    ctx.globalAlpha = 0.75; ctx.fillStyle = paper;
    ctx.textAlign = 'right';
    const axisUnit = activeLib()?.medium === 'air-vac'
      ? (state.medium === 'vac' ? 'nm (vac)' : 'nm (air)') : 'nm';
    ctx.fillText(axisUnit, Wc - 4, Hc - AXIS_H + 20);
    ctx.globalAlpha = 1;

    state.buckets = [];
    if (!state.sel.length) {
      ctx.fillStyle = paper; ctx.globalAlpha = 0.55;
      ctx.textAlign = 'center';
      ctx.font = "13px 'JetBrains Mono', monospace";
      ctx.fillText('Select an element from the periodic table above.', Wc / 2, BAND_H / 2);
      ctx.globalAlpha = 1;
      return;
    }

    state.sel.forEach((sym, k) => {
      const top = k * BAND_H, base = top + BAND_H - 18, Hmax = BAND_H - 36;
      const rows = visibleRows(sym);
      const bucket = new Map();
      let iMax = 0;
      for (const rrow of rows) if (rrow.int > iMax) iMax = rrow.int;
      for (const rrow of rows) {
        const px = Math.round(xOf(rrow.lam));
        const cur = bucket.get(px);
        if (!cur || (rrow.int || 0) > (cur.int || 0)) bucket.set(px, rrow);
      }
      state.buckets[k] = bucket;
      const logMax = Math.log10(1 + (iMax > 0 ? iMax : 1));
      for (const [px, rrow] of bucket) {
        let h, alpha = 1;
        if (Number.isFinite(rrow.int) && iMax > 0) {
          h = (0.14 + 0.86 * (Math.log10(1 + rrow.int) / logMax)) * Hmax;
        } else { h = 0.12 * Hmax; alpha = 0.55; }
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = wavelengthToColor(rrow.lam);
        ctx.beginPath(); ctx.moveTo(px + 0.5, base); ctx.lineTo(px + 0.5, base - h); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = paper; ctx.globalAlpha = 0.25;
      ctx.beginPath(); ctx.moveTo(PAD_L, base + 0.5); ctx.lineTo(Wc - PAD_R, base + 0.5); ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.fillStyle = paper;
      ctx.textAlign = 'left';
      ctx.font = "600 13px 'JetBrains Mono', monospace";
      ctx.fillText(sym, 8, top + 22);
      ctx.globalAlpha = 1;
    });
  }

  /* ---------------- zoom / pan / hover ---------------- */
  const lamAt = (clientX) => {
    const r = canvas.getBoundingClientRect();
    const px = clientX - r.left;
    return state.view.min + ((px - PAD_L) / (r.width - PAD_L - PAD_R)) * (state.view.max - state.view.min);
  };

  const resetView = () => {
    state.view = { ...state.defaultView };
    requestDraw(); updateStatusCounts();
  };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { min, max } = state.view;
    const span = max - min;
    const f = Math.exp(e.deltaY * 0.0012);
    let span2 = Math.min(Math.max(span * f, SPAN_MIN), SPAN_MAX);
    const anchor = lamAt(e.clientX);
    let min2 = anchor - ((anchor - min) * span2) / span;
    min2 = Math.min(Math.max(min2, LAM_LO), LAM_HI - span2);
    state.view = { min: min2, max: min2 + span2 };
    requestDraw(); updateStatusCounts();
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    state.drag = { x: e.clientX, view: { ...state.view } };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointerup', (e) => {
    state.drag = null; canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('dblclick', resetView);

  canvas.addEventListener('pointermove', (e) => {
    if (state.drag) {
      const r = canvas.getBoundingClientRect();
      const span = state.drag.view.max - state.drag.view.min;
      const dLam = (-(e.clientX - state.drag.x) / (r.width - PAD_L - PAD_R)) * span;
      let min2 = Math.min(Math.max(state.drag.view.min + dLam, LAM_LO), LAM_HI - span);
      state.view = { min: min2, max: min2 + span };
      requestDraw(); updateStatusCounts();
      tooltip.style.display = 'none';
      return;
    }
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const k = Math.floor(y / BAND_H);
    const bucket = state.buckets[k];
    if (!bucket || !state.sel[k]) { tooltip.style.display = 'none'; return; }
    let best = null, bestD = 9;
    const px0 = Math.round(x);
    for (let d = 0; d <= 8; d++) {
      for (const px of d === 0 ? [px0] : [px0 - d, px0 + d]) {
        const row = bucket.get(px);
        if (row && d < bestD) { best = row; bestD = d; }
      }
      if (best) break;
    }
    if (!best) { tooltip.style.display = 'none'; return; }
    const mediumTag = mediumTagFor(best);
    const tags = [];
    if (best.ritz) tags.push('Ritz');
    if (best.persistent) tags.push('persistent');
    tooltip.innerHTML =
      `<b>${best.ion}</b> · λ = ${best.lam.toFixed(4)} nm` +
      (mediumTag ? ` <span class="sv-tag">${mediumTag}</span>` : '') +
      `<br>Int: ${best.intStr || '—'}${best.aki ? ` · A<sub>ki</sub> = ${Number(best.aki).toExponential(2)} s⁻¹` : ''}` +
      (tags.length ? `<br><span class="sv-tag">${tags.join('</span> <span class="sv-tag">')}</span>` : '');
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.min(x + 14, r.width - 230)}px`;
    tooltip.style.top = `${y + 14}px`;
  });
  canvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });
  canvas.style.cursor = 'grab';
  new ResizeObserver(requestDraw).observe(wrap);

  /* ---------------- finder ---------------- */
  async function runFinder() {
    const lam = parseFloat($('[data-find-input]').value);
    const tol = Math.abs(parseFloat($('[data-find-tol]').value)) || 0.1;
    if (!Number.isFinite(lam)) { findRes.innerHTML = '<p class="note">Enter a wavelength in nm.</p>'; return; }
    const lib = activeLib();
    const m = manifest();
    if (!lib || !m) { findRes.innerHTML = '<p class="note">The line library has not finished loading — reload the page and try again.</p>'; return; }
    const width = m.finder.width;
    const first = Math.floor((lam - tol) / width) * width;
    const last = Math.floor((lam + tol) / width) * width;
    // Intersect against the shard list rather than stepping the number line: a huge
    // tolerance would otherwise walk millions of nonexistent buckets before starting.
    const wanted = m.finder.shards.filter((lo) => lo >= first && lo <= last);
    if (!wanted.length) { findRes.innerHTML = `<p class="note">No lines indexed near ${lam} nm in ${lib.label}.</p>`; return; }

    setStatus(`Searching ${lib.label} near ${lam} nm…`);
    let shards;
    try { shards = await Promise.all(wanted.map(loadShard)); }
    catch { findRes.innerHTML = '<p class="note">Failed to load the line index.</p>'; return; }

    const hits = [];
    for (const sh of shards) {
      if (!sh) continue;
      for (const e of sh) {
        const d = e.lam - lam;
        if (d < -tol) continue;
        if (d > tol) break;                       // shards are λ-sorted
        hits.push({ d: Math.abs(d), lam: e.lam, ion: e.ion, i: e.i });
      }
    }
    hits.sort((a, b) => a.d - b.d);
    const shown = hits.slice(0, 200);
    // The index is built on air wavelengths, so say so while the plot is in vacuum.
    const vacNote = state.medium === 'vac'
      ? ' The index searches air wavelengths, so this is an air λ while the plot is in vacuum.' : '';
    const head = `<p class="note">${hits.length.toLocaleString()} match${hits.length === 1 ? '' : 'es'} within ±${tol} nm in ${lib.label}${hits.length > 200 ? ' — showing nearest 200' : ''}.${vacNote}</p>`;
    findRes.innerHTML = head + (shown.length
      ? `<table class="sv-findtable"><tr><th>Species</th><th>λ [nm]</th><th>Δλ [nm]</th><th>Rel. int.</th></tr>` +
        shown.map((h) => `<tr data-lam="${h.lam}" data-ion="${h.ion}" tabindex="0"><td>${h.ion}</td><td>${h.lam.toFixed(3)}</td><td>${(h.lam - lam).toFixed(3)}</td><td>${h.i ? '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(h.i / 32))] : '—'}</td></tr>`).join('') +
        `</table>`
      : '');
    setStatus(`${hits.length.toLocaleString()} match${hits.length === 1 ? '' : 'es'} in ${lib.label}.`);
    findRes.querySelectorAll('tr[data-lam]').forEach((tr) => {
      const go = async () => {
        const parts = tr.dataset.ion.split(' ');
        const sym = parts[0];
        // Turn on the hit's ionization stage if it is filtered out, otherwise we
        // navigate the user to a band with nothing drawn in it.
        const st = parts.length > 1 ? romanToInt(parts[1]) ?? 1 : 0;
        const group = (activeLib()?.stageGroups ?? [])
          .find((g) => st >= g.min && (g.max == null || st <= g.max));
        if (group && !state.stages.has(group.key)) {
          state.stages.add(group.key);
          renderStages();
        }
        if (!state.sel.includes(sym)) await toggle(sym);
        const c = parseFloat(tr.dataset.lam);
        state.view = { min: c - 2.5, max: c + 2.5 };
        requestDraw(); updateStatusCounts();
        canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
      tr.onclick = go;
      tr.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    });
  }
  $('[data-find-btn]').onclick = runFinder;
  $('[data-find-input]').addEventListener('keydown', (e) => { if (e.key === 'Enter') runFinder(); });
  resetBtn.onclick = resetView;
  libSel.onchange = () => switchLibrary(libSel.value);

  /* ---------------- boot ---------------- */
  (async function boot() {
    try {
      const r = await fetch(librariesUrl);
      state.desc = await r.json();
    } catch {
      setStatus('Could not load the library index.');
      return;
    }
    state.defaultView = { ...state.desc.defaultView };
    state.view = { ...state.desc.defaultView };
    resetBtn.textContent = `RESET VIEW (${state.defaultView.min}–${state.defaultView.max} nm)`;
    state.lib = state.desc.default;
    renderLibrarySelect();
    const lib = activeLib();
    state.stages = new Set((lib.stageGroups ?? []).filter((g) => g.on).map((g) => g.key));
    let m;
    try { m = await ensureManifest(state.lib); }
    catch (e) { setStatus(`Could not load ${state.lib}: ${e.message}`); return; }
    renderStages(); renderFilters(); renderCaveat(); renderPeriodicTable();
    setStatus(`${lib.label} — ${m.total_lines.toLocaleString()} lines across ${m.elements.length} elements. Pick an element.`);
    requestDraw();
  })();
}
