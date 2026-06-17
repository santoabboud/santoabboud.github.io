/**
 * Peak -> NIST line matching and transparent element identification.
 *
 * PEAK-CENTRIC: each detected peak is attributed to its dominant candidate line
 * (highest expected LTE strength) per element, so an element's match count is
 * bounded by the number of peaks and the Boltzmann plot uses one amplitude per
 * peak (no double-counting blended lines).
 *
 * Confidence is NOT a black box. Three independent sub-confidences in [0,1],
 * reported with the raw evidence:
 *   C_coinc  -- matched peaks exceed random coincidence (Poisson upper tail).
 *               Auto-penalizes line-rich elements that match by chance -- the
 *               main false-positive guard.
 *   C_strong -- the element's expected-strongest lines (high g_k A_ki, low E_k)
 *               are actually present.
 *   C_boltz  -- attributed-peak intensities follow a single-T Boltzmann law
 *               (R^2 of ln(I lambda / g_k A_ki) vs E_k).
 * confidence = prior * weightedGeoMean(C_coinc, C_strong, C_boltz): a weak
 * component drags the score down by design. A transparent RANKING score, not a
 * calibrated posterior; the full breakdown is always returned.
 *
 * Domain pre-selection / custom include-exclude act as the prior. Energies
 * cm^-1, wavelengths nm (air).
 */
import { boltzmannFactor } from './physics.js';
import { KB_CM1_PER_K } from './constants.js';

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
const romanToInt = (r) => ROMAN[r] || parseInt(r, 10) || 1;

/** Poisson survival P(X >= k | mu). */
function poissonSF(k, mu) {
  if (k <= 0) return 1;
  if (mu <= 0) return 0;
  let term = Math.exp(-mu), cdf = term;
  for (let j = 1; j < k; j++) { term *= mu / j; cdf += term; }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Ordinary least-squares y = a + b x; returns { slope, r2, n }. */
function linFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: NaN, r2: 0, n };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
  const dxx = n * sxx - sx * sx;
  const num = n * sxy - sx * sy;
  const r2 = (num * num) / (dxx * (n * syy - sy * sy) || 1);
  return { slope: num / dxx, r2, n };
}

/** Index the columnar match index (sorted by lam_air) for fast lookup. */
export function createMatcher(matchIndex) {
  const { species, lam_air, sp, Aki, Ek, gk } = matchIndex;
  const N = lam_air.length;
  const spElem = species.map((s) => s.split(' ')[0]);
  const spStage = species.map((s) => romanToInt(s.split(' ')[1] || 'I'));
  const lineElem = new Array(N), lineStage = new Int8Array(N);
  const byElement = new Map();
  for (let i = 0; i < N; i++) {
    const el = spElem[sp[i]];
    lineElem[i] = el; lineStage[i] = spStage[sp[i]];
    if (!byElement.has(el)) byElement.set(el, []);
    byElement.get(el).push({ lam: lam_air[i], Aki: Aki[i], Ek: Ek[i], gk: gk[i], stage: spStage[sp[i]] });
  }
  function lowerBound(x) { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (lam_air[m] < x) lo = m + 1; else hi = m; } return lo; }
  /** Candidate lines within +/- tol of lam, filtered by isActive(el,stage). */
  function candidates(lam, tol, isActive) {
    const out = [];
    for (let i = lowerBound(lam - tol); i < N && lam_air[i] <= lam + tol; i++) {
      if (isActive && !isActive(lineElem[i], lineStage[i])) continue;
      out.push({ element: lineElem[i], stage: lineStage[i], lam: lam_air[i], Aki: Aki[i], Ek: Ek[i], gk: gk[i], d: lam - lam_air[i] });
    }
    return out;
  }
  return { N, byElement, candidates, elements: [...byElement.keys()] };
}

/**
 * Identify elements from detected peaks (peak-centric). opts as documented in
 * the module header; key ones: sigmaCal_nm, nSigma, activeElements (Set),
 * activeStages, prior (Map el->[0,1]), Tnominal_K, weights{coinc,strong,boltz},
 * strongTopK, lamRange.
 *
 * Returns ranked [{ element, confidence, nPeaksMatched, nLinesInRange,
 *   muChance, pCoincidence, C_coinc, C_strong, C_boltz, boltzR2, fittedT_K,
 *   prior, peaks:[{peak, line}] }].
 */
export function identifyElements(peaks, matcher, opts = {}) {
  const {
    sigmaCal_nm = 0.05, nSigma = 3, activeElements = null, activeStages = [1, 2, 3],
    prior = null, Tnominal_K = 11600, weights = {}, strongTopK = 12, lamRange = null,
  } = opts;
  const w = { coinc: 1, strong: 1, boltz: 1, ...weights };
  const isActive = (el, st) => (!activeElements || activeElements.has(el)) && activeStages.includes(st);
  const lamMin = lamRange ? lamRange[0] : Math.min(...peaks.map((p) => p.lambda));
  const lamMax = lamRange ? lamRange[1] : Math.max(...peaks.map((p) => p.lambda));
  const W = Math.max(lamMax - lamMin, 1e-6);
  const tolTyp = nSigma * sigmaCal_nm;
  const strength = (L) => L.gk * L.Aki * boltzmannFactor(L.Ek, Tnominal_K);

  // Peak-centric attribution: for each peak, the best (strongest expected)
  // candidate line per element. Build element -> [{peak, line}] (one per peak).
  const perElem = new Map();   // el -> Map(peakRef -> bestLine)
  for (const peak of peaks) {
    const tol = nSigma * Math.sqrt(sigmaCal_nm ** 2 + (peak.sigmaCentroid_nm || 0) ** 2);
    const cands = matcher.candidates(peak.lambda, tol, isActive);
    const bestPerElem = new Map();
    let totalS = 0;
    for (const c of cands) {
      const hasConst = c.Aki != null && c.Ek != null && c.gk != null;
      const s = hasConst ? strength(c) : 0;
      totalS += s;
      const cur = bestPerElem.get(c.element);
      if (!cur || s > cur.s || (s === cur.s && Math.abs(c.d) < Math.abs(cur.line.d))) bestPerElem.set(c.element, { line: c, s });
    }
    for (const [el, { line, s }] of bestPerElem) {
      if (!perElem.has(el)) perElem.set(el, []);
      // dominantFrac: how much of this peak's expected strength this line is.
      // ~1 for an isolated line; small in a blend. Only "clean" peaks are used
      // for the Boltzmann plot (you never Boltzmann-fit a blend).
      perElem.get(el).push({ peak, line, dominantFrac: totalS > 0 ? s / totalS : 0 });
    }
  }

  const els = activeElements ? [...activeElements] : matcher.elements;
  const out = [];
  for (const el of els) {
    const lines = (matcher.byElement.get(el) || []).filter(
      (L) => activeStages.includes(L.stage) && L.lam >= lamMin - tolTyp && L.lam <= lamMax + tolTyp);
    if (!lines.length) continue;
    const nLines = lines.length;
    const hits = perElem.get(el) || [];
    const k = hits.length;                              // distinct peaks matched (<= nPeaks)

    // Expected-strongest lines (the ones we'd actually detect if present).
    const withConst = lines.filter((L) => L.Aki != null && L.Ek != null && L.gk != null && L.gk * L.Aki > 0);
    const top = withConst.map((L) => ({ L, s: strength(L) })).sort((a, b) => b.s - a.s).slice(0, strongTopK);
    const present = (L) => {
      for (const h of hits) if (Math.abs(h.line.lam - L.lam) < tolTyp + 1e-9) return true;
      return false;
    };

    // C_coinc: do the element's STRONG lines appear more than by chance? Using
    // strong lines (not the whole catalog) is the correct baseline -- a weak-
    // line-heavy catalog must not inflate the chance expectation. A present
    // element's strong lines are highly surprising vs a per-line chance ~2%.
    const pChanceLine = Math.min(1, 2 * tolTyp * (peaks.length / W));
    const kStrong = top.reduce((n, { L }) => n + (present(L) ? 1 : 0), 0);
    const muStrong = top.length * pChanceLine;
    const C_coinc = top.length ? 1 - poissonSF(kStrong, muStrong) : 0;

    // C_strong: intensity-weighted recall of the strongest lines.
    let sTot = 0, sMatched = 0;
    for (const { L, s } of top) { sTot += s; if (present(L)) sMatched += s; }
    const C_strong = sTot > 0 ? sMatched / sTot : 0;

    // C_boltz: one amplitude per matched peak vs its attributed line
    // Clean-line Boltzmann plot -> T_e DIAGNOSTIC only (needs isolated peaks).
    const xs = [], ys = [];
    for (const h of hits) {
      if (h.dominantFrac < 0.6) continue;
      const L = h.line, I = h.peak.amplitude;
      if (L.Aki == null || L.Ek == null || L.gk == null || !(L.gk * L.Aki > 0) || !(I > 0)) continue;
      xs.push(L.Ek); ys.push(Math.log(I * L.lam / (L.gk * L.Aki)));
    }
    const fit = linFit(xs, ys);
    const fittedT = fit.slope < 0 ? -1 / (KB_CM1_PER_K * fit.slope) : NaN;
    const physicalT = fittedT > 3000 && fittedT < 60000;
    const C_boltz = (fit.n >= 3 && physicalT) ? Math.max(0, Math.min(1, fit.r2)) : null;

    const pr = prior && prior.has(el) ? prior.get(el) : 1;
    // Confidence rests on the two ACTIVE-SET-INDEPENDENT components: coincidence
    // (more than chance) and strong-line presence. The clean-line Boltzmann is
    // reported as a T_e diagnostic only -- it is too fragile at instrument
    // resolution to score, and (via line isolation) would otherwise make the
    // confidence depend on which other elements are pre-selected.
    const comps = [[C_coinc, w.coinc], [C_strong, w.strong]];
    const wsum = comps.reduce((s, c) => s + c[1], 0);
    const gm = Math.pow(comps.reduce((p, [v, wt]) => p * Math.pow(Math.max(v, 1e-6), wt), 1), 1 / wsum);
    // Corroboration: confidence needs several confirmed strong lines; a single
    // chance-aligned line stays low. Saturates toward 1 as lines accumulate.
    const evidence = kStrong / (kStrong + 1);
    const confidence = pr * evidence * gm;

    out.push({
      element: el, confidence, nPeaksMatched: k, nLinesInRange: nLines,
      nStrongPresent: kStrong, nStrong: top.length, muStrongChance: muStrong,
      C_coinc, C_strong, C_boltz, evidence,
      boltzR2: fit.n >= 3 ? fit.r2 : null, fittedT_K: physicalT ? fittedT : null,
      prior: pr, peaks: hits,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
