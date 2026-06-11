/**
 * Wavelength [nm] -> CSS color, for rendering spectral lines.
 *
 * Pipeline: CIE 1931 2° CMFs (Wyman/Sloan/Shirley 2013 multi-lobe Gaussian
 * fits, verified against tabulated values to |err| <= 0.007) -> linear sRGB
 * (IEC 61966-2-1 D65 matrix) -> clip-to-gamut -> luminance shaping at the
 * spectrum edges -> sRGB OETF.
 *
 * Same math as scripts/wavelength_tokens.py (the design-token generator);
 * keep the two in sync.
 *
 * Outside the CMF-supported range the function returns dimmed boundary
 * colors (deep violet below 380 nm, deep red above 700 nm) with a fixed
 * brightness floor so far-UV / IR lines remain visible against the plate.
 */

function gpw(x, mu, s1, s2) {
  const s = x < mu ? s1 : s2;
  const t = (x - mu) / s;
  return Math.exp(-0.5 * t * t);
}

function cmf(l) {
  const x =
    1.056 * gpw(l, 599.8, 37.9, 31.0) +
    0.362 * gpw(l, 442.0, 16.0, 26.7) -
    0.065 * gpw(l, 501.1, 20.4, 26.2);
  const y = 0.821 * gpw(l, 568.8, 46.9, 40.5) + 0.286 * gpw(l, 530.9, 16.3, 31.1);
  const z = 1.217 * gpw(l, 437.0, 11.8, 36.0) + 0.681 * gpw(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

function oetf(c) {
  c = Math.min(Math.max(c, 0), 1);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** λ[nm] -> 'rgb(r,g,b)'.  scale ∈ (0,1] dims the result (default 1). */
export function wavelengthToColor(lamNm, scale = 1) {
  // out-of-CMF handling with a visibility floor
  if (lamNm < 380) {
    const f = Math.max(0.3, (lamNm - 170) / (380 - 170));
    return rgbCss([0.486, 0, 1], f * scale); // pegged to the 405 nm violet hue
  }
  if (lamNm > 700) {
    const f = Math.max(0.25, 1 - (lamNm - 700) / 600);
    return rgbCss([1, 0.05, 0.05], f * scale);
  }
  const [X, Y, Z] = cmf(lamNm);
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  const m = Math.max(r, g, b);
  if (m > 0) { r /= m; g /= m; b /= m; }
  // gentle edge taper inside the visible band
  let taper = 1;
  if (lamNm < 420) taper = 0.45 + 0.55 * (lamNm - 380) / 40;
  if (lamNm > 660) taper = 0.45 + 0.55 * (700 - lamNm) / 40;
  return rgbCss([r, g, b], taper * scale);
}

function rgbCss(lin, scale) {
  const v = lin.map((c) => Math.round(255 * oetf(c * scale)));
  return `rgb(${v[0]},${v[1]},${v[2]})`;
}
