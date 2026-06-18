/**
 * Spectrum preprocessing + peak detection for LIBS analysis.
 *
 *  - snipBaseline: SNIP (Statistics-sensitive Non-linear Iterative Peak-
 *    Clipping; Ryan 1988 / Morhac) with the log-log-sqrt (LLS) operator --
 *    the standard plasma-continuum estimator, robust to large dynamic range.
 *  - estimateNoiseMAD: robust sigma from the MAD of first differences
 *    (baseline-trend-insensitive; differences inflate variance by 2).
 *  - savitzkyGolay: shape-preserving smoothing for detection (reflective edges).
 *  - detectPeaks: maxima of the smoothed, baseline-subtracted signal above
 *    k*sigma, with parabolic sub-pixel centroids, FWHM, SNR, and a centroid
 *    uncertainty (feeds the matching tolerance sqrt(sigma_cal^2 + sigma_cen^2)).
 *
 * All routines are pure functions over numeric arrays (run in a Web Worker).
 */

function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/* ---------------- baseline (SNIP) ---------------- */

const llsFwd = (y) => Math.log(Math.log(Math.sqrt(Math.max(y, 0) + 1) + 1) + 1);
const llsInv = (v) => { const t = Math.exp(Math.exp(v) - 1) - 1; return t * t - 1; };

/**
 * SNIP baseline. `iterations` = maximum clipping half-window in samples (larger
 * -> follows only broader structure). Returns a Float64Array baseline.
 */
export function snipBaseline(y, iterations = 40, { lls = true } = {}) {
  const N = y.length;
  let v = new Float64Array(N);
  for (let i = 0; i < N; i++) v[i] = lls ? llsFwd(y[i]) : y[i];
  let w = new Float64Array(N);
  for (let p = 1; p <= iterations; p++) {
    for (let i = 0; i < N; i++) {
      if (i >= p && i < N - p) {
        const avg = 0.5 * (v[i - p] + v[i + p]);
        w[i] = avg < v[i] ? avg : v[i];   // clip toward the lower envelope
      } else w[i] = v[i];
    }
    [v, w] = [w, v];
  }
  const base = new Float64Array(N);
  for (let i = 0; i < N; i++) base[i] = lls ? llsInv(v[i]) : v[i];
  return base;
}

/* Symmetric positive-definite pentadiagonal solve via banded LDL^T (Cholesky).
   Bands: u0 = diag, u1[i] = A[i][i+1], u2[i] = A[i][i+2]. O(n). */
function cholPentaSolve(u0, u1, u2, b) {
  const n = b.length;
  const p0 = new Float64Array(n), p1 = new Float64Array(n), p2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    p2[i] = i >= 2 ? u2[i - 2] / p0[i - 2] : 0;
    p1[i] = i >= 1 ? (u1[i - 1] - p2[i] * p1[i - 1]) / p0[i - 1] : 0;  // l1[i-1], not l2
    p0[i] = Math.sqrt(Math.max(u0[i] - p1[i] * p1[i] - p2[i] * p2[i], 1e-12));
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    if (i >= 1) s -= p1[i] * y[i - 1];
    if (i >= 2) s -= p2[i] * y[i - 2];
    y[i] = s / p0[i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    if (i + 1 < n) s -= p1[i + 1] * x[i + 1];
    if (i + 2 < n) s -= p2[i + 2] * x[i + 2];
    x[i] = s / p0[i];
  }
  return x;
}

/**
 * Asymmetric Least Squares baseline (Eilers & Boelens 2005): minimize
 * sum w_i (y_i - z_i)^2 + lambda sum (D2 z)_i^2, with weights p above the
 * baseline and (1-p) below, iterated. lambda sets smoothness; p the asymmetry.
 * The penalty matrix D2^T D2 is pentadiagonal -> O(n) banded solve.
 */
export function alsBaseline(y, { lambda = 1e5, p = 0.01, iters = 10 } = {}) {
  const n = y.length;
  const d0 = new Float64Array(n), d1 = new Float64Array(n), d2 = new Float64Array(n);
  for (let k = 0; k < n - 2; k++) {                  // accumulate D2^T D2 bands
    const idx = [k, k + 1, k + 2], val = [1, -2, 1];
    for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) {
      const i = idx[a], j = idx[c], v = val[a] * val[c];
      if (j === i) d0[i] += v; else if (j === i + 1) d1[i] += v; else if (j === i + 2) d2[i] += v;
    }
  }
  const w = new Float64Array(n).fill(1);
  let z = new Float64Array(n);
  const u0 = new Float64Array(n), u1 = new Float64Array(n), u2 = new Float64Array(n), b = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) { u0[i] = w[i] + lambda * d0[i]; u1[i] = lambda * d1[i]; u2[i] = lambda * d2[i]; b[i] = w[i] * y[i]; }
    z = cholPentaSolve(u0, u1, u2, b);
    for (let i = 0; i < n; i++) w[i] = y[i] > z[i] ? p : (1 - p);
  }
  return z;
}

/** Iterative-polynomial baseline: fit a low-order polynomial, clip points above
 *  it (peaks), refit; converges to the continuum. x = wavelength axis. */
export function polynomialBaseline(x, y, { order = 5, iters = 8 } = {}) {
  const n = y.length, m = order + 1;
  const x0 = x[0], x1 = x[n - 1], mid = (x0 + x1) / 2, half = (x1 - x0) / 2 || 1;
  const xn = new Float64Array(n);
  for (let i = 0; i < n; i++) xn[i] = (x[i] - mid) / half;     // normalize for conditioning
  const fit = (yy) => {
    const ps = new Float64Array(2 * order + 1);
    for (let i = 0; i < n; i++) { let xp = 1; for (let p = 0; p <= 2 * order; p++) { ps[p] += xp; xp *= xn[i]; } }
    const A = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) => ps[a + b]));
    const rhs = new Array(m).fill(0);
    for (let i = 0; i < n; i++) { let xp = 1; for (let a = 0; a < m; a++) { rhs[a] += xp * yy[i]; xp *= xn[i]; } }
    const c = solveSym(A, rhs);
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) { let xp = 1, s = 0; for (let a = 0; a < m; a++) { s += c[a] * xp; xp *= xn[i]; } z[i] = s; }
    return z;
  };
  let yy = Float64Array.from(y), z = Float64Array.from(y);
  for (let it = 0; it < iters; it++) { z = fit(yy); for (let i = 0; i < n; i++) if (yy[i] > z[i]) yy[i] = z[i]; }
  return z;
}

/** Dispatch baseline by method name. */
export function computeBaseline(lambda, y, o = {}) {
  switch (o.baseline) {
    case 'none': return new Float64Array(y.length);
    case 'als': return alsBaseline(y, { lambda: o.alsLambda, p: o.alsP, iters: o.alsIters });
    case 'poly': return polynomialBaseline(lambda, y, { order: o.polyOrder });
    case 'snip': default: return snipBaseline(y, o.baselineIter ?? 40);
  }
}

/* ---------------- noise ---------------- */

/** Robust noise sigma from the MAD of first differences. */
export function estimateNoiseMAD(y) {
  const d = new Float64Array(Math.max(0, y.length - 1));
  for (let i = 1; i < y.length; i++) d[i - 1] = y[i] - y[i - 1];
  const med = median(d);
  const ad = Array.from(d, (x) => Math.abs(x - med));
  return 1.4826 * median(ad) / Math.SQRT2;
}

/* ---------------- Savitzky-Golay ---------------- */

function solveSym(A, b) {            // Gaussian elimination, small dense system
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((bi, i) => bi / A[i][i]);
}

/** Savitzky-Golay smoothing coefficients for half-window m, polynomial order. */
export function sgCoeffs(m, order) {
  const n = order + 1;
  // Normal-equations matrix M[a][b] = sum_j j^(a+b); solve M c = e0.
  const M = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => {
    let s = 0; for (let j = -m; j <= m; j++) s += Math.pow(j, a + b); return s;
  }));
  const e0 = new Array(n).fill(0); e0[0] = 1;
  const c = solveSym(M, e0);
  // weight_j = sum_k c_k * j^k
  const w = new Float64Array(2 * m + 1);
  for (let j = -m; j <= m; j++) {
    let s = 0; for (let k = 0; k < n; k++) s += c[k] * Math.pow(j, k);
    w[j + m] = s;
  }
  return w;
}

/** Savitzky-Golay smooth with reflective edges. */
export function savitzkyGolay(y, halfWindow = 5, order = 2) {
  const N = y.length;
  if (halfWindow < 1 || 2 * halfWindow + 1 > N) return Float64Array.from(y);
  const w = sgCoeffs(halfWindow, order);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = -halfWindow; j <= halfWindow; j++) {
      let idx = i + j;
      if (idx < 0) idx = -idx; else if (idx >= N) idx = 2 * N - 2 - idx;  // reflect
      s += w[j + halfWindow] * y[idx];
    }
    out[i] = s;
  }
  return out;
}

/* ---------------- peak detection ---------------- */

/**
 * Robust Gaussian centroid: weighted log-parabola (Caruana) fit over the
 * contiguous window where corrected > frac*amp. Weighting by intensity
 * downweights noisy low points. Returns the sub-sample wavelength of the
 * parabola vertex; falls back to 3-point parabola for very narrow peaks.
 */
function refineCentroid(corr, lambda, i, amp, frac = 0.4) {
  let l = i, r = i;
  const t = frac * amp;
  while (l > 0 && corr[l - 1] > t) l--;
  while (r < corr.length - 1 && corr[r + 1] > t) r++;
  if (r - l < 2) {                                   // too narrow: 3-point parabola
    const y0 = corr[i - 1], y1 = corr[i], y2 = corr[i + 1];
    const den = y0 - 2 * y1 + y2;
    const dx = 0.5 * (lambda[i + 1] - lambda[i - 1]);
    return lambda[i] + (den !== 0 ? 0.5 * (y0 - y2) / den : 0) * dx;
  }
  let Sw = 0, Sx = 0, Sxx = 0, Sx3 = 0, Sx4 = 0, Sy = 0, Sxy = 0, Sxxy = 0;
  for (let j = l; j <= r; j++) {
    const c = corr[j];
    if (c <= 0) continue;
    const x = lambda[j] - lambda[i], w = c, y = Math.log(c);
    Sw += w; Sx += w * x; Sxx += w * x * x; Sx3 += w * x * x * x; Sx4 += w * x * x * x * x;
    Sy += w * y; Sxy += w * x * y; Sxxy += w * x * x * y;
  }
  const [, b, cc] = solveSym([[Sw, Sx, Sxx], [Sx, Sxx, Sx3], [Sxx, Sx3, Sx4]], [Sy, Sxy, Sxxy]);
  return cc < 0 ? lambda[i] - b / (2 * cc) : lambda[i];   // vertex of ln-parabola
}

function fwhmAround(corr, lambda, i, halfMax) {
  // walk outward to the half-maximum crossings; linear-interpolate crossing nm.
  let l = i, r = i;
  while (l > 0 && corr[l] > halfMax) l--;
  while (r < corr.length - 1 && corr[r] > halfMax) r++;
  const interp = (a, b) => {
    const ya = corr[a], yb = corr[b];
    if (ya === yb) return lambda[a];
    const f = (halfMax - ya) / (yb - ya);
    return lambda[a] + f * (lambda[b] - lambda[a]);
  };
  const lo = l < i ? interp(l, l + 1) : lambda[i];
  const hi = r > i ? interp(r, r - 1) : lambda[i];
  return Math.max(hi - lo, 0);
}

/** Topographic prominence of a local max at index i in array y. */
function prominence(y, i) {
  const amp = y[i], n = y.length;
  let l = i, lmin = Infinity;
  while (l > 0 && y[l - 1] < amp) { l--; if (y[l] < lmin) lmin = y[l]; }
  let r = i, rmin = Infinity;
  while (r < n - 1 && y[r + 1] < amp) { r++; if (y[r] < rmin) rmin = y[r]; }
  if (lmin === Infinity) lmin = y[Math.max(i - 1, 0)];
  if (rmin === Infinity) rmin = y[Math.min(i + 1, n - 1)];
  return amp - Math.max(lmin, rmin);
}

/**
 * Detect emission peaks with a configurable, OceanView/AvaSoft-style parameter
 * set. opts:
 *   baseline: 'snip' (default) | 'als' | 'poly' | 'none'
 *     baselineIter (snip) · alsLambda, alsP, alsIters · polyOrder
 *   smooth (default true), sgWindow, sgOrder         — Savitzky-Golay for detection
 *   thresholdMode: 'snr' (default) | 'absolute' | 'prominence'
 *   threshold: k*sigma if snr; counts if absolute; counts if prominence
 *              (alias: opts.k for back-compat with snr mode)
 *   minDistanceNm, minWidthNm (FWHM), maxWidthNm     — peak filters
 * Returns { peaks:[{lambda, amplitude, prominence, snr, fwhm_nm,
 *           sigmaCentroid_nm, index}], baseline, corrected, sigma, params }.
 */
export function detectPeaks(lambda, intensity, opts = {}) {
  const {
    baseline = 'snip', baselineIter = 40, alsLambda = 1e5, alsP = 0.01, alsIters = 10, polyOrder = 5,
    smooth = true, sgWindow = 5, sgOrder = 2,
    thresholdMode = 'snr', minDistanceNm = 0, minWidthNm = 0, maxWidthNm = Infinity,
  } = opts;
  const threshold = opts.threshold ?? opts.k ?? 5;
  const base = computeBaseline(lambda, intensity,
    { baseline, baselineIter, alsLambda, alsP, alsIters, polyOrder });
  const corrected = new Float64Array(intensity.length);
  for (let i = 0; i < intensity.length; i++) corrected[i] = intensity[i] - base[i];
  const sigma = estimateNoiseMAD(corrected) || 1e-12;
  const sm = smooth ? savitzkyGolay(corrected, sgWindow, sgOrder) : corrected;
  const ampThr = thresholdMode === 'snr' ? threshold * sigma
    : thresholdMode === 'absolute' ? threshold : 0;   // prominence handled per-peak
  const dxTyp = (lambda[lambda.length - 1] - lambda[0]) / (lambda.length - 1 || 1);

  let peaks = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (!(sm[i] >= sm[i - 1] && sm[i] > sm[i + 1])) continue;   // smoothed local max
    const amp = corrected[i];
    if (amp <= ampThr) continue;                               // snr / absolute gate
    const prom = prominence(corrected, i);
    if (thresholdMode === 'prominence' && prom < threshold) continue;
    const fwhm = fwhmAround(corrected, lambda, i, amp / 2);
    if (fwhm < minWidthNm || fwhm > maxWidthNm) continue;       // width gate
    const center = refineCentroid(corrected, lambda, i, amp);
    const snr = amp / sigma;
    const sigmaCentroid = snr > 0 ? (fwhm / 2.3548) / snr : dxTyp;
    peaks.push({ index: i, lambda: center, amplitude: amp, prominence: prom, snr, fwhm_nm: fwhm, sigmaCentroid_nm: sigmaCentroid });
  }

  if (minDistanceNm > 0 && peaks.length > 1) {
    const kept = [];
    for (const p of [...peaks].sort((a, b) => b.amplitude - a.amplitude)) {
      if (kept.every((q) => Math.abs(q.lambda - p.lambda) >= minDistanceNm)) kept.push(p);
    }
    peaks = kept.sort((a, b) => a.lambda - b.lambda);
  }
  return { peaks, baseline: base, corrected, sigma, params: { baseline, thresholdMode, threshold } };
}
