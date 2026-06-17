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

/**
 * Detect emission peaks. opts:
 *   baselineIter, sgWindow, sgOrder, k (sigma threshold), minDistanceNm.
 * Returns { peaks:[{lambda, amplitude, snr, fwhm_nm, sigmaCentroid_nm, index}],
 *           baseline, corrected, sigma }.
 */
export function detectPeaks(lambda, intensity, opts = {}) {
  const { baselineIter = 40, sgWindow = 5, sgOrder = 2, k = 5, minDistanceNm = 0 } = opts;
  const baseline = snipBaseline(intensity, baselineIter);
  const corrected = new Float64Array(intensity.length);
  for (let i = 0; i < intensity.length; i++) corrected[i] = intensity[i] - baseline[i];
  const sigma = estimateNoiseMAD(corrected) || 1e-12;
  const sm = savitzkyGolay(corrected, sgWindow, sgOrder);
  const thr = k * sigma;

  let peaks = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (corrected[i] <= thr) continue;
    if (!(sm[i] >= sm[i - 1] && sm[i] > sm[i + 1])) continue;
    const amp = corrected[i];
    const center = refineCentroid(corrected, lambda, i, amp);
    const fwhm = fwhmAround(corrected, lambda, i, amp / 2);
    const snr = amp / sigma;
    // Centroid uncertainty: Gaussian-peak Cramer-Rao scaling sigma_w/SNR,
    // sigma_w = FWHM/2.355. Approximate; combined with sigma_cal at match time.
    const sigmaCentroid = snr > 0 ? (fwhm / 2.3548) / snr : dx;
    peaks.push({ index: i, lambda: center, amplitude: amp, snr, fwhm_nm: fwhm, sigmaCentroid_nm: sigmaCentroid });
  }

  if (minDistanceNm > 0 && peaks.length > 1) {
    const kept = [];
    for (const p of [...peaks].sort((a, b) => b.amplitude - a.amplitude)) {
      if (kept.every((q) => Math.abs(q.lambda - p.lambda) >= minDistanceNm)) kept.push(p);
    }
    peaks = kept.sort((a, b) => a.lambda - b.lambda);
  }
  return { peaks, baseline, corrected, sigma };
}
