/**
 * LIBS Analyzer — UI controller (vanilla JS). Orchestrates the validated
 * analysis modules over a canvas plot and DOM panels. Fully client-side:
 * uploaded spectra never leave the browser.
 *
 * Pipeline: ingest -> preprocess (baseline/peaks) -> match + confidence ->
 * diagnostics (T_e, CF-LIBS). The periodic-table pre-select / domain presets
 * act as the prior. Sample spectra are synthesized live from the LTE forward
 * model. Plot supports wheel-zoom, drag-pan, hover, candidate-line overlays.
 */
import { ELEMENTS } from '../spectra-viewer.js';
import { wavelengthToColor } from '../wavelength-color.js';
import { parseSpectrumCSV } from './ingest.js';
import { detectPeaks } from './preprocess.js';
import { createMatcher, identifyElements } from './matcher.js';
import { boltzmannTemperature, cfLibs } from './diagnostics.js';
import { elementLineIntensities, synthesizeSpectrum } from './forward.js';

const DATA = '/data/libs';

/* Domain presets — prior element universes (symbols). */
export const PRESETS = {
  metallurgy: ['Fe', 'Cr', 'Ni', 'Mn', 'Mo', 'V', 'Co', 'Cu', 'Al', 'Ti', 'Si', 'C', 'S', 'P', 'Nb', 'W', 'Zn', 'Sn', 'Pb', 'Mg', 'Ca', 'B', 'Si'],
  minerals: ['Si', 'Al', 'Fe', 'Ca', 'Mg', 'K', 'Na', 'Ti', 'Mn', 'P', 'Sr', 'Ba', 'Cr', 'Ni', 'Cu', 'Zn', 'Pb', 'Zr', 'Li', 'B'],
  ceramics: ['Al', 'Si', 'Zr', 'Y', 'Mg', 'Ca', 'Ti', 'Ce', 'Na', 'K', 'B', 'Fe', 'Cr'],
  batteries: ['Li', 'Co', 'Ni', 'Mn', 'Fe', 'P', 'Al', 'Cu', 'Na', 'S', 'F', 'Ti', 'V', 'Si', 'C', 'Mg'],
};

/* Built-in synthetic samples (composition = illustrative number fractions),
   grouped by domain for the picker. Synthesized live from the LTE model. */
const SAMPLES = {
  'Brass (Cu–Zn)': { group: 'Metallurgy', comp: { Cu: 0.62, Zn: 0.38 }, Te: 9000, ne: 1e16 },
  'Bronze (Cu–Sn)': { group: 'Metallurgy', comp: { Cu: 0.88, Sn: 0.10, Zn: 0.02 }, Te: 9000, ne: 1e16 },
  'Stainless steel': { group: 'Metallurgy', comp: { Fe: 0.70, Cr: 0.18, Ni: 0.08, Mn: 0.04 }, Te: 10000, ne: 1.2e16 },
  'Tool steel': { group: 'Metallurgy', comp: { Fe: 0.85, Cr: 0.05, W: 0.03, Mo: 0.02, V: 0.02, Mn: 0.02, Si: 0.01 }, Te: 10000, ne: 1.2e16 },
  'Aluminum alloy 6061': { group: 'Metallurgy', comp: { Al: 0.955, Mg: 0.012, Si: 0.008, Fe: 0.015, Cu: 0.003, Cr: 0.002, Mn: 0.005 }, Te: 9500, ne: 1e16 },
  'Titanium alloy (Ti-6Al-4V)': { group: 'Metallurgy', comp: { Ti: 0.90, Al: 0.06, V: 0.04 }, Te: 10000, ne: 1e16 },
  'Cupronickel (coin)': { group: 'Metallurgy', comp: { Cu: 0.75, Ni: 0.25 }, Te: 9000, ne: 1e16 },
  'Granite': { group: 'Minerals & geology', comp: { Si: 0.32, Al: 0.18, Ca: 0.12, Na: 0.12, K: 0.10, Fe: 0.10, Mg: 0.06 }, Te: 9000, ne: 8e15 },
  'Basalt': { group: 'Minerals & geology', comp: { Si: 0.25, Al: 0.16, Fe: 0.14, Ca: 0.14, Mg: 0.12, Na: 0.08, Ti: 0.04, Mn: 0.04, K: 0.03 }, Te: 9000, ne: 8e15 },
  'Limestone': { group: 'Minerals & geology', comp: { Ca: 0.55, Mg: 0.15, Si: 0.15, Al: 0.08, Fe: 0.07 }, Te: 8500, ne: 7e15 },
  'Soda-lime glass': { group: 'Ceramics & glass', comp: { Si: 0.45, Na: 0.20, Ca: 0.15, Mg: 0.08, Al: 0.07, K: 0.05 }, Te: 9000, ne: 8e15 },
  'Alumina (Al₂O₃)': { group: 'Ceramics & glass', comp: { Al: 0.80, Ca: 0.06, Si: 0.06, Mg: 0.05, Na: 0.03 }, Te: 9500, ne: 1e16 },
  'Li-ion cathode (NMC)': { group: 'Batteries', comp: { Li: 0.25, Ni: 0.25, Mn: 0.20, Co: 0.20, Fe: 0.10 }, Te: 9500, ne: 1e16 },
  'LiFePO₄ cathode': { group: 'Batteries', comp: { Li: 0.30, Fe: 0.28, P: 0.28, Mn: 0.08, Mg: 0.06 }, Te: 9500, ne: 1e16 },
  'Seawater (brine)': { group: 'Other', comp: { Na: 0.45, Mg: 0.15, Ca: 0.12, K: 0.12, B: 0.10, Sr: 0.04, Li: 0.02 }, Te: 8000, ne: 5e15 },
};

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const PROFILES = { HR4000: 0.4, Monochromator: 0.005 };

export function initLibsApp(root) {
  const $ = (s) => root.querySelector(s);
  const canvas = $('[data-canvas]');
  const wrap = canvas.parentElement;
  const tooltip = $('[data-tooltip]');
  const ptEl = $('[data-pt]');
  const statusEl = $('[data-status]');
  const resultsEl = $('[data-results]');
  const diagEl = $('[data-diagnostics]');

  const state = {
    spectrum: null, proc: null, matchIndex: null, matcher: null, manifest: null,
    results: [], selected: new Set(), lineCache: new Map(),
    view: { min: 200, max: 1100 }, drag: null, raf: 0,
    settings: {
      sigmaCal: 0.15, instrumentFWHM: 0.4, stages: new Set([1, 2, 3]),
      detect: {
        baseline: 'snip', baselineIter: 25, alsLambda: 1e5, polyOrder: 5,
        smooth: true, sgWindow: 5, sgOrder: 2,
        thresholdMode: 'snr', threshold: 5,
        minDistanceNm: 0.2, minWidthNm: 0, maxWidthNm: 0,
      },
    },
    enabled: new Set(ELEMENTS.map((e) => e.s)),  // active element universe (the prior)
    preset: 'all',
  };
  const ALL_SYMS = ELEMENTS.map((e) => e.s);
  const PAD_L = 54, PAD_R = 14, PAD_T = 12, AXIS_H = 30;
  const setStatus = (m) => { statusEl.textContent = m; };

  /* ---------------- data loading ---------------- */
  fetch(`${DATA}/_manifest.json`).then((r) => r.json()).then((m) => {
    state.manifest = m;
    setStatus(`Ready — ${m.total_lines.toLocaleString()} NIST lines, ${m.elements.length} elements. Load a CSV or a sample.`);
  }).catch(() => setStatus('Could not load dataset manifest.'));

  async function ensureMatcher() {
    if (state.matcher) return state.matcher;
    setStatus('Loading match index (~5.5 MB, one time)…');
    const mi = await (await fetch(`${DATA}/_match_index.json`)).json();
    state.matchIndex = mi;
    state.matcher = createMatcher(mi);
    return state.matcher;
  }
  async function ensureLines(sym) {
    if (state.lineCache.has(sym)) return state.lineCache.get(sym);
    const d = await (await fetch(`${DATA}/lines/${sym}.json`)).json();
    state.lineCache.set(sym, d);
    return d;
  }
  async function ensureLevels(sym) {
    const key = `lv:${sym}`;
    if (state.lineCache.has(key)) return state.lineCache.get(key);
    const d = await (await fetch(`${DATA}/levels/${sym}.json`)).json();
    state.lineCache.set(key, d);
    return d;
  }

  /* ---------------- ingest + preprocess ---------------- */
  function setSpectrum(lambda, intensity, label) {
    state.spectrum = { lambda, intensity, label };
    state.view = { min: lambda[0], max: lambda[lambda.length - 1] };
    runPreprocess();
    requestDraw();
  }
  function runPreprocess() {
    if (!state.spectrum) return;
    const { lambda, intensity } = state.spectrum, d = state.settings.detect;
    state.proc = detectPeaks(lambda, intensity, {
      baseline: d.baseline, baselineIter: d.baselineIter, alsLambda: d.alsLambda, polyOrder: d.polyOrder,
      smooth: d.smooth, sgWindow: d.sgWindow, sgOrder: d.sgOrder,
      thresholdMode: d.thresholdMode, threshold: d.threshold,
      minDistanceNm: d.minDistanceNm, minWidthNm: d.minWidthNm,
      maxWidthNm: d.maxWidthNm > 0 ? d.maxWidthNm : Infinity,
    });
    const bl = { snip: 'SNIP', als: 'ALS', poly: 'polynomial', none: 'none' }[d.baseline];
    setStatus(`${state.spectrum.label}: ${state.proc.peaks.length} peaks · ${bl} baseline · σ=${state.proc.sigma.toFixed(1)} · ${lambda.length} pts.`);
  }

  async function handleFile(file) {
    const text = await file.text();
    const p = parseSpectrumCSV(text);
    if (!p.nPoints) { setStatus('Could not parse spectrum: ' + (p.warnings[0] || 'no data')); return; }
    if (p.warnings.length) setStatus(p.warnings.join(' '));
    setSpectrum(p.lambda_nm, p.intensity, file.name);
    runAnalysis();
  }

  async function loadSample(name) {
    const s = SAMPLES[name];
    setStatus(`Synthesizing ${name}…`);
    let lines = [];
    for (const [el, ab] of Object.entries(s.comp)) {
      try {
        const [ld, lv] = await Promise.all([ensureLines(el), ensureLevels(el)]);
        lines = lines.concat(elementLineIntensities(ld, lv, ab, s.Te, s.ne).filter((l) => l.stage <= 3));
      } catch { /* element may lack data; skip */ }
    }
    const fwhm = state.settings.instrumentFWHM;
    const spec = synthesizeSpectrum(lines, { grid: { min: 200, max: 900, n: 7000 }, instrumentFWHM_nm: fwhm, T_K: s.Te, mass_amu: 50 });
    const pmax = Math.max(...spec.intensity) || 1;
    const S = 40000 / pmax, lam = spec.lambda, I = new Float64Array(lam.length);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    for (let i = 0; i < lam.length; i++) I[i] = 400 + 250 * Math.exp(-((lam[i] - 430) ** 2) / (2 * 90 ** 2)) + spec.intensity[i] * S + 18 * g();
    setSpectrum(lam, I, name + ' (synthetic)');
    runAnalysis();
  }

  /* ---------------- analysis ---------------- */
  // null = no restriction (all enabled); else the enabled subset (the prior).
  function activeElements() {
    return state.enabled.size >= ALL_SYMS.length ? null : new Set(state.enabled);
  }

  async function runAnalysis() {
    if (!state.proc) { setStatus('Load a spectrum first.'); return; }
    setStatus('Matching against NIST lines…');
    await ensureMatcher();
    const active = activeElements();
    state.results = identifyElements(state.proc.peaks, state.matcher, {
      sigmaCal_nm: state.settings.sigmaCal, nSigma: 3,
      activeElements: active, activeStages: [...state.settings.stages],
      lamRange: [state.spectrum.lambda[0], state.spectrum.lambda[state.spectrum.lambda.length - 1]],
    });
    renderResults();
    renderDiagnostics();
    setStatus(`Identified ${state.results.filter((r) => r.confidence > 0.3).length} candidate elements (of ${state.results.length} considered).`);
  }

  const TIERS = [
    { key: 'confident', label: 'Confident', min: 0.65 },
    { key: 'probable', label: 'Probable', min: 0.40 },
    { key: 'possible', label: 'Possible / trace', min: 0 },
  ];
  const tierOf = (c) => (c >= 0.65 ? 'confident' : c >= 0.40 ? 'probable' : 'possible');
  const pct = (c) => (c * 100).toFixed(0);

  function rowHtml(r) {
    const t = tierOf(r.confidence), on = state.selected.has(r.element);
    return `<tr class="el-row tier-${t} ${on ? 'sel' : ''}">
      <td><input type="checkbox" data-ovl="${r.element}" ${on ? 'checked' : ''}></td>
      <td class="el-sym">${r.element}</td>
      <td class="conf-cell"><span class="confbar" style="--c:${pct(r.confidence)}%"></span><span class="conf-num">${pct(r.confidence)}%</span></td>
      <td>${r.nStrongPresent}/${r.nStrong}</td>
      <td>${r.C_coinc.toFixed(2)}</td><td>${r.C_strong.toFixed(2)}</td>
      <td>${r.C_boltz != null ? r.C_boltz.toFixed(2) : '—'}</td>
      <td>${r.fittedT_K ? r.fittedT_K.toFixed(0) : '—'}</td></tr>`;
  }

  function renderResults() {
    const rows = state.results.filter((r) => r.nPeaksMatched > 0);
    if (!rows.length) { resultsEl.innerHTML = '<p class="note">No elements matched. Widen the uncertainty, lower the detection threshold, or change the pre-select.</p>'; return; }
    const confident = rows.filter((r) => r.confidence >= 0.65);
    const chipEls = confident.slice(0, 12), more = confident.length - chipEls.length;
    const summary = `<div class="libs-summary"><span class="lbl">Identified</span>${
      confident.length
        ? chipEls.map((r) => `<button class="el-chip" data-ovl="${r.element}" title="overlay ${r.element} lines">${r.element}<i>${pct(r.confidence)}</i></button>`).join('')
          + (more > 0 ? `<span class="note">+${more} more — narrow the pre-select to sharpen</span>` : '')
        : '<span class="note">no high-confidence elements — see candidates below</span>'}</div>`;
    let body = '';
    for (const { key, label } of TIERS) {
      const tr = rows.filter((r) => tierOf(r.confidence) === key);
      const shown = key === 'possible' ? tr.slice(0, 25) : tr;
      if (!shown.length) continue;
      body += `<tr class="tier-row tier-${key}"><td colspan="8">${label} · ${tr.length}</td></tr>`
        + shown.map(rowHtml).join('');
    }
    resultsEl.innerHTML = summary + `<table class="libs-table"><thead><tr>
      <th></th><th>El</th><th>Confidence</th><th>strong</th>
      <th>C<sub>coinc</sub></th><th>C<sub>strong</sub></th><th>C<sub>boltz</sub></th><th>T<sub>e</sub></th></tr></thead><tbody>${body}</tbody></table>`;
    resultsEl.querySelectorAll('[data-ovl]').forEach((cb) =>
      (cb.tagName === 'INPUT' ? cb.onchange = () => toggleOverlay(cb.dataset.ovl, cb.checked)
        : cb.onclick = () => toggleOverlay(cb.dataset.ovl, !state.selected.has(cb.dataset.ovl))));
  }

  function renderDiagnostics() {
    // CF-LIBS over confident elements with clean lines
    const conf = state.results.filter((r) => r.confidence > 0.4);
    if (conf.length < 1) { diagEl.innerHTML = '<p class="note">Run analysis; diagnostics appear when confident elements are found.</p>'; return; }
    const tFits = conf.filter((r) => r.fittedT_K).map((r) => r.fittedT_K);
    const tAvg = tFits.length ? tFits.reduce((a, b) => a + b, 0) / tFits.length : null;
    diagEl.innerHTML = `<p class="note">Plasma temperature (mean of per-species Boltzmann fits): <b>${tAvg ? tAvg.toFixed(0) + ' K' : 'n/a — need ≥3 clean lines/species'}</b>.
      CF-LIBS composition and n<sub>e</sub> require clean-line selection and a radiometric response curve; see the
      <a href="${DATA}/_manifest.json">data manifest</a> for provenance. Confidence is a transparent ranking score (coincidence × strong-line presence × Boltzmann consistency), not a calibrated probability.</p>`;
  }

  async function toggleOverlay(sym, on) {
    if (on) { state.selected.add(sym); try { await ensureLines(sym); } catch { /**/ } }
    else state.selected.delete(sym);
    renderResults(); requestDraw();
  }

  /* ---------------- periodic-table pre-select ----------------
     One clear model: each cell is enabled (in the active set) or not. Presets
     set the enabled set; clicking a cell toggles it and switches to "custom". */
  const countEl = $('[data-pt-count]');
  function setPreset(p) {
    state.preset = p;
    root.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('active', x.dataset.preset === p));
  }
  function renderPT() {
    ptEl.querySelectorAll('button[data-sym]').forEach((b) => {
      const on = state.enabled.has(b.dataset.sym);
      b.dataset.state = on ? 'in' : 'dim';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (countEl) countEl.textContent = state.enabled.size >= ALL_SYMS.length
      ? 'all elements' : `${state.enabled.size} elements`;
  }
  for (const el of ELEMENTS) {
    const b = document.createElement('button');
    b.dataset.sym = el.s; b.className = 'pt-cell'; b.title = el.n; b.textContent = el.s;
    b.style.gridRow = el.r; b.style.gridColumn = el.c;
    b.onclick = () => {
      state.enabled.has(el.s) ? state.enabled.delete(el.s) : state.enabled.add(el.s);
      setPreset(null);            // manual edit => custom (no preset highlighted)
      renderPT();
      if (state.proc && state.matcher) runAnalysis();   // keep results in sync
    };
    ptEl.appendChild(b);
  }

  /* ---------------- drawing ---------------- */
  function requestDraw() { if (!state.raf) state.raf = requestAnimationFrame(() => { state.raf = 0; draw(); }); }
  function niceStep(span) { const raw = span / 9, mag = 10 ** Math.floor(Math.log10(raw)); for (const f of [1, 2, 5, 10]) if (raw <= f * mag) return f * mag; return 10 * mag; }
  const xOf = (lam, W) => PAD_L + ((lam - state.view.min) / (state.view.max - state.view.min)) * W;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const Wc = wrap.clientWidth, Hc = Math.max(300, Math.round(wrap.clientWidth * 0.42));
    canvas.style.height = `${Hc}px`; canvas.width = Math.round(Wc * dpr); canvas.height = Math.round(Hc * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const paper = css('--bg') || '#E7DCC2';
    ctx.fillStyle = css('--rulebg') || '#0E0B06'; ctx.fillRect(0, 0, Wc, Hc);
    const W = Wc - PAD_L - PAD_R, plotH = Hc - AXIS_H - PAD_T, base = PAD_T + plotH;
    const { min, max } = state.view;

    // axis
    const step = niceStep(max - min), t0 = Math.ceil(min / step) * step;
    ctx.font = "10px 'JetBrains Mono', monospace"; ctx.textAlign = 'center';
    for (let t = t0; t <= max + 1e-9; t += step) {
      const x = xOf(t, W);
      ctx.globalAlpha = 0.12; ctx.strokeStyle = paper; ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, base); ctx.stroke();
      ctx.globalAlpha = 0.7; ctx.fillStyle = paper; ctx.fillText(step < 1 ? t.toFixed(1) : Math.round(t), x, base + 16);
    }
    ctx.globalAlpha = 0.7; ctx.textAlign = 'right'; ctx.fillText('nm', Wc - 4, base + 16); ctx.globalAlpha = 1;

    if (!state.spectrum) { ctx.fillStyle = paper; ctx.globalAlpha = 0.5; ctx.textAlign = 'center'; ctx.font = "13px 'JetBrains Mono',monospace"; ctx.fillText('Load a CSV or a sample spectrum.', Wc / 2, Hc / 2); ctx.globalAlpha = 1; return; }

    const { lambda, intensity } = state.spectrum, proc = state.proc;
    // y-scale from visible data
    let iMax = 1e-9, iMin = Infinity;
    for (let i = 0; i < lambda.length; i++) if (lambda[i] >= min && lambda[i] <= max) { if (intensity[i] > iMax) iMax = intensity[i]; if (intensity[i] < iMin) iMin = intensity[i]; }
    const yOf = (v) => base - ((v - iMin) / (iMax - iMin || 1)) * plotH;

    // candidate-line overlays (sticks) for selected elements, behind the trace
    for (const sym of state.selected) {
      const d = state.lineCache.get(sym); if (!d) continue;
      ctx.globalAlpha = 0.5;
      for (const st of [...state.settings.stages]) {
        const rows = d.stages[String(st)]; if (!rows) continue;
        for (const r of rows) { const lam = r[0]; if (lam < min || lam > max) continue; const x = xOf(lam, W); ctx.strokeStyle = wavelengthToColor(lam); ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - plotH * 0.5); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
    }
    // baseline
    if (proc) { ctx.strokeStyle = paper; ctx.globalAlpha = 0.35; ctx.beginPath(); for (let i = 0; i < lambda.length; i++) { if (lambda[i] < min || lambda[i] > max) continue; const x = xOf(lambda[i], W), y = yOf(proc.baseline[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); ctx.globalAlpha = 1; }
    // trace
    ctx.strokeStyle = paper; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    for (let i = 0; i < lambda.length; i++) { if (lambda[i] < min || lambda[i] > max) continue; const x = xOf(lambda[i], W), y = yOf(intensity[i]); started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); }
    ctx.stroke();
    // peak markers
    if (proc) { for (const p of proc.peaks) { if (p.lambda < min || p.lambda > max) continue; const x = xOf(p.lambda, W); ctx.fillStyle = wavelengthToColor(p.lambda); ctx.beginPath(); ctx.arc(x, yOf(p.amplitude + (proc.baseline[p.index] || iMin)), 2.5, 0, 7); ctx.fill(); } }
  }

  /* ---------------- zoom / pan / hover ---------------- */
  const lamAt = (clientX) => { const r = canvas.getBoundingClientRect(); return state.view.min + ((clientX - r.left - PAD_L) / (r.width - PAD_L - PAD_R)) * (state.view.max - state.view.min); };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); if (!state.spectrum) return;
    const { min, max } = state.view, span = max - min, f = Math.exp(e.deltaY * 0.0012);
    const anchor = lamAt(e.clientX); let span2 = Math.min(Math.max(span * f, 0.05), 2000);
    let min2 = anchor - ((anchor - min) * span2) / span;
    state.view = { min: min2, max: min2 + span2 }; requestDraw();
  }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => { state.drag = { x: e.clientX, view: { ...state.view } }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
  canvas.addEventListener('pointerup', (e) => { state.drag = null; canvas.releasePointerCapture(e.pointerId); canvas.style.cursor = 'grab'; });
  canvas.addEventListener('dblclick', () => { if (state.spectrum) { state.view = { min: state.spectrum.lambda[0], max: state.spectrum.lambda[state.spectrum.lambda.length - 1] }; requestDraw(); } });
  canvas.addEventListener('pointermove', (e) => {
    if (state.drag) { const r = canvas.getBoundingClientRect(), span = state.drag.view.max - state.drag.view.min; const dLam = (-(e.clientX - state.drag.x) / (r.width - PAD_L - PAD_R)) * span; state.view = { min: state.drag.view.min + dLam, max: state.drag.view.max + dLam }; requestDraw(); tooltip.style.display = 'none'; return; }
    if (!state.proc) return;
    const r = canvas.getBoundingClientRect(), lam = lamAt(e.clientX);
    let best = null, bd = (state.view.max - state.view.min) / (r.width) * 8;
    for (const p of state.proc.peaks) { const d = Math.abs(p.lambda - lam); if (d < bd) { bd = d; best = p; } }
    if (!best) { tooltip.style.display = 'none'; return; }
    const cands = state.matcher ? state.matcher.candidates(best.lambda, 3 * state.settings.sigmaCal, (el, st) => state.settings.stages.has(st)).slice(0, 5) : [];
    tooltip.innerHTML = `<b>λ = ${best.lambda.toFixed(3)} nm</b> · SNR ${best.snr.toFixed(0)} · FWHM ${best.fwhm_nm.toFixed(3)} nm`
      + (cands.length ? '<br>' + cands.map((c) => `${c.element} ${'I'.repeat(c.stage)} ${c.lam.toFixed(3)}`).join('<br>') : '');
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 200)}px`; tooltip.style.top = `${e.clientY - r.top + 12}px`;
  });
  canvas.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; });
  canvas.style.cursor = 'grab';
  new ResizeObserver(requestDraw).observe(wrap);

  /* ---------------- controls wiring ---------------- */
  $('[data-file]').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
  wrap.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  const sampleSel = $('[data-sample]');
  const groups = {};
  for (const [n, s] of Object.entries(SAMPLES)) (groups[s.group] ||= []).push(n);
  for (const [g, names] of Object.entries(groups)) {
    const og = document.createElement('optgroup'); og.label = g;
    for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n; og.appendChild(o); }
    sampleSel.appendChild(og);
  }
  sampleSel.onchange = () => { if (sampleSel.value) loadSample(sampleSel.value); };
  $('[data-run]').onclick = runAnalysis;

  const reanalyze = () => { if (state.proc && state.matcher) runAnalysis(); };
  const reprocess = () => { if (state.spectrum) { runPreprocess(); requestDraw(); reanalyze(); } };

  const sig = $('[data-sigma]'), sigOut = $('[data-sigma-out]');
  const showSig = () => { sigOut.textContent = (state.settings.sigmaCal * 1000).toFixed(0) + ' pm'; };
  sig.oninput = () => { state.settings.sigmaCal = +sig.value; showSig(); };
  sig.onchange = reanalyze;

  // detection-parameter panel (baseline method, threshold mode, filters)
  const D = state.settings.detect;
  const bind = (sel, fn, ev = 'onchange') => { const el = $(sel); if (el) el[ev] = () => fn(el); return el; };
  const mdIn = $('[data-mindist]');
  bind('[data-baseline]', (el) => { D.baseline = el.value; reprocess(); });
  const thrUnit = $('[data-threshold-unit]');
  const updThrUnit = () => { if (thrUnit) thrUnit.textContent = D.thresholdMode === 'snr' ? '× σ' : 'counts'; };
  bind('[data-tmode]', (el) => { D.thresholdMode = el.value; updThrUnit(); reprocess(); });
  bind('[data-threshold]', (el) => { D.threshold = +el.value || D.threshold; reprocess(); });
  bind('[data-smooth]', (el) => { D.smooth = el.checked; reprocess(); });
  bind('[data-sgwin]', (el) => { D.sgWindow = Math.max(2, +el.value || 5); reprocess(); });
  bind('[data-mindist]', (el) => { D.minDistanceNm = Math.max(0, +el.value || 0); reprocess(); });
  bind('[data-minwidth]', (el) => { D.minWidthNm = Math.max(0, +el.value || 0); reprocess(); });
  bind('[data-maxwidth]', (el) => { D.maxWidthNm = Math.max(0, +el.value || 0); reprocess(); });
  // reflect defaults into controls
  for (const [sel, v] of [['[data-baseline]', D.baseline], ['[data-tmode]', D.thresholdMode],
    ['[data-threshold]', D.threshold], ['[data-sgwin]', D.sgWindow], ['[data-mindist]', D.minDistanceNm],
    ['[data-minwidth]', D.minWidthNm], ['[data-maxwidth]', D.maxWidthNm]]) { const el = $(sel); if (el) el.value = v; }
  const smEl = $('[data-smooth]'); if (smEl) smEl.checked = D.smooth;
  updThrUnit();

  $('[data-profile]').onchange = (e) => {
    const fwhm = PROFILES[e.target.value] ?? 0.4;
    state.settings.instrumentFWHM = fwhm;
    state.settings.sigmaCal = fwhm >= 0.1 ? 0.15 : 0.02;       // match tolerance ~ resolution
    sig.value = state.settings.sigmaCal; showSig();
    D.minDistanceNm = Math.max(fwhm * 0.5, 0.01); if (mdIn) mdIn.value = D.minDistanceNm.toFixed(3);
    reprocess();
  };
  root.querySelectorAll('[data-stage]').forEach((cb) => cb.onchange = () => { cb.checked ? state.settings.stages.add(+cb.dataset.stage) : state.settings.stages.delete(+cb.dataset.stage); requestDraw(); reanalyze(); });
  root.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => {
    const p = b.dataset.preset;
    state.enabled = new Set(p === 'all' ? ALL_SYMS : PRESETS[p].filter((s) => ALL_SYMS.includes(s)));
    setPreset(p); renderPT();
    if (state.proc) runAnalysis();   // re-rank with the new prior
  });
  $('[data-export]').onclick = exportCSV;

  function exportCSV() {
    if (!state.results.length) { setStatus('Run an analysis first.'); return; }
    const lines = ['element,stage,confidence,nPeaksMatched,nStrongPresent,nStrong,C_coinc,C_strong,C_boltz,fittedT_K'];
    for (const r of state.results) if (r.nPeaksMatched > 0) lines.push([r.element, '', r.confidence.toFixed(4), r.nPeaksMatched, r.nStrongPresent, r.nStrong, r.C_coinc.toFixed(3), r.C_strong.toFixed(3), r.C_boltz != null ? r.C_boltz.toFixed(3) : '', r.fittedT_K ? r.fittedT_K.toFixed(0) : ''].join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'libs_identification.csv'; a.click();
  }

  setPreset('all'); renderPT(); requestDraw();
}
