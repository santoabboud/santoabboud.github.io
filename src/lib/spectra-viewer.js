/**
 * Atomic Spectra Viewer — vanilla-JS module.
 *
 * Data: per-element JSON at  <base>/<Sym>.json
 *         {"symbol","stages":{"Fe I":[[lam_nm, intensity_str, Aki_str],…]}}
 *       columnar finder index at <base>/_finder.json  {ions,l,i,n}
 *       manifest at <base>/_manifest.json (sizes, line counts, provenance).
 *
 * Display physics / caveats (also stated in the page UI):
 *  - Wavelengths are passed through from the legacy NIST ASD scrape
 *    unchanged; the scrape's air/vacuum convention is unverified (ASD
 *    default: air ≥ 200 nm, vacuum below). The v2 dataset will store both.
 *  - "Intensity" is the ASD relative observed intensity: per-species,
 *    source-condition-dependent, NOT comparable across species. Stick
 *    heights are therefore log-normalized PER ELEMENT BAND to the maximum
 *    visible parsed intensity in that band.
 *  - Intensity strings are preserved verbatim (qualifiers like "w", "bl",
 *    parentheses survive); only a leading numeric is parsed for heights.
 *  - Line color comes from the same CIE-CMF mapping as the site's design
 *    tokens (src/lib/wavelength-color.js); out-of-visible lines render as
 *    dimmed boundary hues with a visibility floor.
 */
import { wavelengthToColor } from './wavelength-color.js';

/* Periodic-table layout — carried over verbatim from the v1 site. */
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

const parseIntensity = (s) => {
  const m = /^[\s(\[]*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(s);
  return m ? parseFloat(m[1]) : NaN;
};

const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function initSpectraViewer(root, { dataBase = '/data/spectra' } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const ptEl = $('[data-pt]');
  const canvas = $('[data-canvas]');
  const wrap = canvas.parentElement;
  const tooltip = $('[data-tooltip]');
  const statusEl = $('[data-status]');
  const chipsEl = $('[data-selected]');
  const findRes = $('[data-find-results]');

  const state = {
    sel: [],                 // selected symbols, max 3 (FIFO eviction)
    cache: new Map(),        // sym -> {rows, total}
    view: { min: 180, max: 1100 },
    stages: { 1: true, 2: true, 3: true, ge4: false },
    buckets: [],             // per band: Map(px -> row) from last draw, for hover
    manifest: null,
    finder: null,
    drag: null,
    raf: 0,
  };
  const MAX_SEL = 3;
  const PAD_L = 46, PAD_R = 12, BAND_H = 130, AXIS_H = 34;
  const SPAN_MIN = 0.5, SPAN_MAX = 50000, LAM_LO = 50, LAM_HI = 80000;

  const setStatus = (msg) => { statusEl.textContent = msg; };

  /* ---------------- data ---------------- */
  fetch(`${dataBase}/_manifest.json`)
    .then((r) => r.json())
    .then((m) => { state.manifest = m; setStatus(`Index ready — ${m.total_lines.toLocaleString()} lines, ${m.elements.length} elements. Pick an element.`); })
    .catch(() => setStatus('Could not load data manifest.'));

  async function ensureElement(sym) {
    if (state.cache.has(sym)) return state.cache.get(sym);
    const info = state.manifest?.elements.find((e) => e.sym === sym);
    setStatus(`Loading ${sym}${info ? ` (${(info.bytes / 1024).toFixed(0)} KB)` : ''}…`);
    const r = await fetch(`${dataBase}/${sym}.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${sym}.json`);
    const data = await r.json();
    const rows = [];
    for (const [ion, list] of Object.entries(data.stages)) {
      const parts = ion.split(' ');
      const stage = parts.length > 1 ? romanToInt(parts[1]) ?? 1 : 1;
      for (const [lam, intStr, aki] of list)
        rows.push({ lam, int: parseIntensity(intStr), intStr, aki, stage, ion });
    }
    rows.sort((a, b) => a.lam - b.lam);
    const entry = { rows, total: rows.length };
    state.cache.set(sym, entry);
    return entry;
  }

  async function ensureFinder() {
    if (state.finder) return state.finder;
    setStatus('Loading line index (~2.3 MB, one time)…');
    const r = await fetch(`${dataBase}/_finder.json`);
    state.finder = await r.json();
    setStatus('Line index loaded.');
    return state.finder;
  }

  /* ---------------- selection UI ---------------- */
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
      btn.setAttribute('aria-pressed', state.sel.includes(btn.dataset.sym)));
  }

  async function toggle(sym) {
    const i = state.sel.indexOf(sym);
    if (i >= 0) state.sel.splice(i, 1);
    else {
      try { await ensureElement(sym); } catch (e) { setStatus(`Failed to load ${sym}: ${e.message}`); return; }
      state.sel.push(sym);
      if (state.sel.length > MAX_SEL) state.sel.shift(); // FIFO
    }
    renderChips();
    requestDraw();
    updateStatusCounts();
  }

  // periodic table
  for (const el of ELEMENTS) {
    const b = document.createElement('button');
    b.dataset.sym = el.s;
    b.className = 'pt-cell';
    b.title = el.n;
    b.textContent = el.s;
    b.style.gridRow = el.r;
    b.style.gridColumn = el.c;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => toggle(el.s);
    ptEl.appendChild(b);
  }

  // stage filter checkboxes
  root.querySelectorAll('[data-stage]').forEach((cb) => {
    cb.onchange = () => {
      state.stages[cb.dataset.stage] = cb.checked;
      requestDraw();
      updateStatusCounts();
    };
  });
  $('[data-reset]').onclick = () => { state.view = { min: 180, max: 1100 }; requestDraw(); };

  const stageOK = (st) => (st >= 4 ? state.stages.ge4 : state.stages[st]);

  function visibleRows(sym) {
    const { rows } = state.cache.get(sym);
    // binary search for view window in λ-sorted rows
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; rows[m].lam < state.view.min ? (lo = m + 1) : (hi = m); }
    const out = [];
    for (let k = lo; k < rows.length && rows[k].lam <= state.view.max; k++)
      if (stageOK(rows[k].stage)) out.push(rows[k]);
    return out;
  }

  function updateStatusCounts() {
    if (!state.sel.length) return;
    const parts = state.sel.map((sym) => {
      const vis = visibleRows(sym).length;
      return `${sym}: ${vis.toLocaleString()} in view / ${state.cache.get(sym).total.toLocaleString()} total`;
    });
    setStatus(parts.join('   ·   '));
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

    // vertical grid + axis
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
    ctx.fillText('nm', Wc - 4, Hc - AXIS_H + 20);
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
      // pixel-bucket: keep highest parsed intensity per px column
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
      // band frame + label
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
  canvas.addEventListener('dblclick', () => { state.view = { min: 180, max: 1100 }; requestDraw(); updateStatusCounts(); });

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
    // hover tooltip: nearest bucketed line within 8 px in the hovered band
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
    tooltip.innerHTML =
      `<b>${best.ion}</b> · λ = ${best.lam.toFixed(4)} nm` +
      `<br>Int: ${best.intStr || '—'}${best.aki ? ` · A<sub>ki</sub> = ${best.aki} s⁻¹` : ''}`;
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
    let idx;
    try { idx = await ensureFinder(); } catch { findRes.innerHTML = '<p class="note">Failed to load line index.</p>'; return; }
    const hits = [];
    for (let i = 0; i < idx.l.length; i++) {
      const d = idx.l[i] - lam;
      if (d >= -tol && d <= tol) hits.push({ d: Math.abs(d), lam: idx.l[i], ion: idx.ions[idx.i[i]], int: idx.n[i] });
    }
    hits.sort((a, b) => a.d - b.d);
    const shown = hits.slice(0, 200);
    const head = `<p class="note">${hits.length.toLocaleString()} match${hits.length === 1 ? '' : 'es'} within ±${tol} nm${hits.length > 200 ? ' — showing nearest 200' : ''}.</p>`;
    findRes.innerHTML = head + (shown.length
      ? `<table class="sv-findtable"><tr><th>Species</th><th>λ [nm]</th><th>Δλ [nm]</th><th>Rel. int.</th></tr>` +
        shown.map((h) => `<tr data-lam="${h.lam}" data-ion="${h.ion}" tabindex="0"><td>${h.ion}</td><td>${h.lam.toFixed(3)}</td><td>${(h.lam - lam).toFixed(3)}</td><td>${h.int || '—'}</td></tr>`).join('') +
        `</table>`
      : '');
    findRes.querySelectorAll('tr[data-lam]').forEach((tr) => {
      const go = async () => {
        const sym = tr.dataset.ion.split(' ')[0];
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

  requestDraw();
}
