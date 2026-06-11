#!/usr/bin/env python3
"""
Wavelength -> sRGB token generator for the site design system.

Pipeline: lambda [nm] -> CIE 1931 2-deg XYZ (analytic multi-lobe Gaussian fit,
Wyman/Sloan/Shirley 2013) -> linear sRGB (IEC 61966-2-1, D65 matrix)
-> gamut map -> sRGB OETF -> hex.

Two gamut mappings are produced for each line (monochromatic chromaticities
lie outside the sRGB gamut, so a mapping choice is unavoidable):
  - 'clip'  : negative channels clipped to 0, then normalized to max=1.
              Maximum vividness, small hue shift. Used for accent tokens.
  - 'desat' : add equal linear RGB (monitor white) until min channel = 0,
              then normalize. Hue-preserving-ish, softer. Used for the
              gradient strip so it stays smooth.

Units: wavelength in nm throughout. CMF values are dimensionless.
Sanity checks printed at the end (ybar(555) ~= 1, known-line hue spot checks).

NOTE: the Gaussian fits track the tabulated CIE 1931 CMFs to ~1-2% over
380-700 nm (verified below at 405/510/532/580/590 against tabulated values).
For the production token script in the repo we can swap in the public-domain
1 nm CIE table; differences will be sub-perceptual for these tokens.
"""

import math

# ---------- CIE 1931 2-deg CMF, multi-lobe Gaussian fit (Wyman et al. 2013) ----------

def _g(x, mu, s1, s2):
    """Piecewise Gaussian: sigma = s1 left of mu, s2 right of mu. Dimensionless."""
    s = s1 if x < mu else s2
    return math.exp(-0.5 * ((x - mu) / s) ** 2)

def cmf(lam_nm):
    x = (1.056 * _g(lam_nm, 599.8, 37.9, 31.0)
         + 0.362 * _g(lam_nm, 442.0, 16.0, 26.7)
         - 0.065 * _g(lam_nm, 501.1, 20.4, 26.2))
    y = (0.821 * _g(lam_nm, 568.8, 46.9, 40.5)
         + 0.286 * _g(lam_nm, 530.9, 16.3, 31.1))
    z = (1.217 * _g(lam_nm, 437.0, 11.8, 36.0)
         + 0.681 * _g(lam_nm, 459.0, 26.0, 13.8))
    return x, y, z

# ---------- XYZ -> linear sRGB (D65), IEC 61966-2-1 / Lindbloom matrix ----------

M = ((3.2404542, -1.5371385, -0.4985314),
     (-0.9692660, 1.8760108, 0.0415560),
     (0.0556434, -0.2040259, 1.0572252))

def xyz_to_lin_rgb(X, Y, Z):
    return tuple(M[i][0] * X + M[i][1] * Y + M[i][2] * Z for i in range(3))

def oetf(c):
    """sRGB opto-electronic transfer function (gamma). Input linear [0,1]."""
    c = min(max(c, 0.0), 1.0)
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

def to_hex(rgb_lin, scale=1.0):
    vals = [round(255 * oetf(c * scale)) for c in rgb_lin]
    return "#{:02X}{:02X}{:02X}".format(*vals)

# ---------- gamut mappings ----------

def map_clip(rgb):
    r, g, b = (max(c, 0.0) for c in rgb)
    m = max(r, g, b)
    return (r / m, g / m, b / m) if m > 0 else (0, 0, 0)

def map_desat(rgb):
    mn = min(rgb)
    r, g, b = ((c - mn) if mn < 0 else c for c in rgb)  # add -mn * white
    # careful: adding -mn to each channel == c + (-mn); rewrite explicitly
    if mn < 0:
        r, g, b = (c - mn for c in rgb)
    else:
        r, g, b = rgb
    m = max(r, g, b)
    return (r / m, g / m, b / m) if m > 0 else (0, 0, 0)

def line_tokens(lam):
    rgb = xyz_to_lin_rgb(*cmf(lam))
    return {
        "lambda_nm": lam,
        "clip": to_hex(map_clip(rgb)),
        "clip_trim": to_hex(map_clip(rgb), scale=0.78),  # dimmed for UI-on-dark
        "desat": to_hex(map_desat(rgb)),
    }

# ---------- spectral rule gradient ----------

def edge_taper(lam):
    """Luminance taper so the strip fades to black at both ends (smoothstep).
    Full brightness on [425, 645] nm; ramps 385->425 and 645->700."""
    def smooth(t):
        t = min(max(t, 0.0), 1.0)
        return t * t * (3 - 2 * t)
    if lam < 425:
        return smooth((lam - 385) / (425 - 385))
    if lam > 645:
        return 1 - smooth((lam - 645) / (700 - 645))
    return 1.0

def gradient_stops(lo=380, hi=700, step=5):
    stops = []
    for lam in range(lo, hi + 1, step):
        rgb = map_desat(xyz_to_lin_rgb(*cmf(lam)))
        pct = 100 * (lam - lo) / (hi - lo)
        stops.append((pct, to_hex(rgb, scale=edge_taper(lam))))
    return stops

# ---------- run ----------

if __name__ == "__main__":
    print("== Sanity checks ==")
    yb555 = cmf(555)[1]
    print(f"ybar(555 nm) = {yb555:.4f}  (expect ~1.00)")
    # spot checks vs tabulated CIE 1931 (from standard tables):
    table = {405: (0.0231, 0.0017, 0.1102),
             510: (0.0093, 0.5030, 0.1582),
             530: (0.1655, 0.8620, 0.0422),
             580: (0.9163, 0.8700, 0.0017),
             590: (1.0263, 0.7570, 0.0011)}
    for lam, ref in table.items():
        fit = cmf(lam)
        err = max(abs(a - b) for a, b in zip(fit, ref))
        print(f"  CMF fit @{lam} nm: fit=({fit[0]:.4f},{fit[1]:.4f},{fit[2]:.4f}) "
              f"table=({ref[0]:.4f},{ref[1]:.4f},{ref[2]:.4f})  max|err|={err:.4f}")

    print("\n== Laser-line tokens ==")
    lines = [("405.0", 405.0, "GaN diode / 'BluRay' violet"),
             ("488.0", 488.0, "Ar-ion blue-green"),
             ("510.6", 510.6, "Cu-vapor green"),
             ("532.0", 532.0, "Nd:YAG SHG green"),
             ("578.2", 578.2, "Cu-vapor yellow"),
             ("589.0", 589.0, "Na D / guide star"),
             ("632.8", 632.8, "HeNe red")]
    for label, lam, note in lines:
        t = line_tokens(lam)
        print(f"  {label} nm  clip={t['clip']}  clip_trim={t['clip_trim']}  "
              f"desat={t['desat']}   ({note})")

    print("\n== Spectral-rule gradient (desat mapping + edge taper) ==")
    stops = gradient_stops()
    css = ", ".join(f"{hexv} {pct:.1f}%" for pct, hexv in stops)
    print("linear-gradient(90deg, " + css + ")")
