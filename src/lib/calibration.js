/**
 * Spectrometer calibration: least-squares polynomial fit  λ(px) = Σ C_k px^k.
 *
 * NUMERICS
 * The naive approach (normal equations on raw pixel monomials) is severely
 * ill-conditioned: with px up to ~2047 and a cubic fit, the Gram matrix
 * spans Σpx^6 ~ 1e20 and double precision loses most coefficient digits.
 * Here the fit is performed in a Chebyshev basis T_k(u) on u ∈ [-1, 1]
 * (u = affine map of the pixel range), where the Gram matrix is
 * well-conditioned for the orders this tool supports (1..6). The fitted
 * polynomial is then converted EXACTLY (closed-form basis change) to raw
 * monomial coefficients C_k for display; prediction always evaluates the
 * stable Chebyshev form.
 *
 * UNCERTAINTIES
 * Ordinary least squares with unweighted points:
 *   Cov(c) = s² (AᵀA)⁻¹,  s² = SSR / (N − p),  p = order + 1.
 * Raw-basis coefficient covariance follows by the linear basis change
 * C = J c  →  Cov(C) = J Cov(c) Jᵀ. σ values are null when N == p
 * (zero residual degrees of freedom — fit is exact, uncertainty undefined).
 *
 * Units: px dimensionless, λ in nm. R² is dimensionless. RMS residual in nm.
 *
 * Validated against numpy.polynomial.chebyshev.Chebyshev.fit().convert()
 * — see scripts/test_calibration.mjs (agreement < 1e-9 relative).
 */

/** Solve M x = v by Gaussian elimination with partial pivoting. */
function solve(M, v) {
  const n = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-300) return null; // singular
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[n] / A[i][i]);
}

/** Invert M via column-by-column solves (small, well-conditioned matrices). */
function invert(M) {
  const n = M.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = Array(n).fill(0);
    e[j] = 1;
    const x = solve(M, e);
    if (!x) return null;
    cols.push(x);
  }
  // cols[j] is column j of the inverse
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

/** Chebyshev values T_0..T_m at u. */
function chebVals(u, m) {
  const T = [1, u];
  for (let k = 2; k <= m; k++) T[k] = 2 * u * T[k - 1] - T[k - 2];
  return T.slice(0, m + 1);
}

/** Monomial coefficients (in u) of T_k, k = 0..m.  cheb[k][j] = coeff of u^j */
function chebMonomial(m) {
  const c = [[1], [0, 1]];
  for (let k = 2; k <= m; k++) {
    const prev = c[k - 1], prev2 = c[k - 2];
    const next = Array(k + 1).fill(0);
    for (let j = 0; j < prev.length; j++) next[j + 1] += 2 * prev[j];
    for (let j = 0; j < prev2.length; j++) next[j] -= prev2[j];
    c[k] = next;
  }
  return c.slice(0, m + 1);
}

/** Coefficients of (a x + b)^j for j = 0..m; pow[j][i] = coeff of x^i. */
function affinePowers(a, b, m) {
  const pow = [[1]];
  for (let j = 1; j <= m; j++) {
    const prev = pow[j - 1];
    const next = Array(j + 1).fill(0);
    for (let i = 0; i < prev.length; i++) {
      next[i] += b * prev[i];
      next[i + 1] += a * prev[i];
    }
    pow[j] = next;
  }
  return pow;
}

/**
 * @param {Array<{x:number,y:number}>} points  (x = pixel, y = λ [nm])
 * @param {number} order  polynomial order m (1..6)
 * @returns fit result object, or {error} on invalid input
 */
export function fitCalibration(points, order) {
  const N = points.length;
  const p = order + 1;
  if (order < 1 || order > 6) return { error: 'Order must be 1–6.' };
  if (N < p) return { error: `Need at least ${p} points for order ${order}.` };
  const xs = points.map((pt) => pt.x);
  const ys = points.map((pt) => pt.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  if (xmax === xmin) return { error: 'All pixel values are identical.' };

  // affine map px -> u in [-1, 1]:  u = a*px + b
  const a = 2 / (xmax - xmin);
  const b = -(xmax + xmin) / (xmax - xmin);

  // design matrix in Chebyshev basis; normal equations
  const G = Array.from({ length: p }, () => Array(p).fill(0));
  const rhs = Array(p).fill(0);
  const rows = [];
  for (let i = 0; i < N; i++) {
    const T = chebVals(a * xs[i] + b, order);
    rows.push(T);
    for (let j = 0; j < p; j++) {
      rhs[j] += ys[i] * T[j];
      for (let k = 0; k < p; k++) G[j][k] += T[j] * T[k];
    }
  }
  const c = solve(G, rhs);
  if (!c) return { error: 'Singular system (degenerate pixel values?).' };

  // residuals & quality
  let ssr = 0, sst = 0;
  const ymean = ys.reduce((s, y) => s + y, 0) / N;
  const residuals = [];
  for (let i = 0; i < N; i++) {
    const yhat = rows[i].reduce((s, T, j) => s + c[j] * T, 0);
    const r = ys[i] - yhat;
    residuals.push(r);
    ssr += r * r;
    sst += (ys[i] - ymean) ** 2;
  }
  const r2 = sst > 0 ? 1 - ssr / sst : 1;
  const dof = N - p;
  const s2 = dof > 0 ? ssr / dof : null;

  // covariance in Chebyshev basis
  const Ginv = invert(G);
  const covC = s2 !== null && Ginv ? Ginv.map((row) => row.map((v) => v * s2)) : null;

  // basis change to raw monomials in px:  C = J c
  // column k of J = monomial-in-px coefficients of T_k(a*px + b)
  const chebU = chebMonomial(order);
  const powX = affinePowers(a, b, order);
  const J = Array.from({ length: p }, () => Array(p).fill(0));
  for (let k = 0; k < p; k++)
    for (let j = 0; j < chebU[k].length; j++)
      for (let i = 0; i < powX[j].length; i++)
        J[i][k] += chebU[k][j] * powX[j][i];

  const coeffRaw = J.map((row) => row.reduce((s, v, k) => s + v * c[k], 0));
  let coeffSigma = null;
  if (covC) {
    coeffSigma = [];
    for (let i = 0; i < p; i++) {
      let v = 0;
      for (let k = 0; k < p; k++)
        for (let l = 0; l < p; l++) v += J[i][k] * covC[k][l] * J[i][l];
      coeffSigma.push(Math.sqrt(Math.max(v, 0)));
    }
  }

  const predict = (px) =>
    chebVals(a * px + b, order).reduce((s, T, j) => s + c[j] * T, 0);

  return {
    order, n: N, coeffRaw, coeffSigma, r2,
    rmsResidualNm: Math.sqrt(ssr / N),
    residuals, predict, domain: [xmin, xmax],
  };
}
