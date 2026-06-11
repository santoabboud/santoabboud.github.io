#!/usr/bin/env python3
"""Reference fits via numpy for validating src/lib/calibration.js.

NOTE the numpy footgun this file once contained: ABCPolyBase.convert()
called WITHOUT kind= keeps the same series kind (Chebyshev), merely
re-mapping the domain — it does NOT yield power-series coefficients.
Raw monomial coefficients require convert(kind=Polynomial).
"""
import json
import numpy as np
from numpy.polynomial import chebyshev as C
from numpy.polynomial import Polynomial as P

rng = np.random.default_rng(42)
cases = []

def make_case(name, x, y, order, with_sigma=True):
    p = order + 1
    ser = C.Chebyshev.fit(x, y, order)        # scaled-domain fit (stable)

    raw_c = ser.convert(kind=P).coef          # power-series coefficients
    raw = np.zeros(p); raw[:len(raw_c)] = raw_c

    yhat = ser(x)
    ssr = float(np.sum((y - yhat) ** 2))
    sst = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1 - ssr / sst if sst > 0 else 1.0

    sigma = None
    n = len(x)
    if with_sigma and n > p:
        d0, d1 = ser.domain
        u = (2 * x - d0 - d1) / (d1 - d0)     # same affine map as the JS code
        A = C.chebvander(u, order)
        G = A.T @ A
        s2 = ssr / (n - p)
        covc = s2 * np.linalg.inv(G)
        # J: column k = power-series coefficients of T_k(u(x))
        J = np.zeros((p, p))
        for k in range(p):
            e = np.zeros(p); e[k] = 1.0
            coef = C.Chebyshev(e, domain=ser.domain).convert(kind=P).coef
            J[:len(coef), k] = coef
        # internal consistency: basis change must reproduce the raw coeffs
        assert np.allclose(J @ ser.coef, raw, rtol=1e-10, atol=1e-10), \
            "reference self-check failed: J @ c != raw"
        covR = J @ covc @ J.T
        sigma = list(np.sqrt(np.clip(np.diag(covR), 0, None)))

    cases.append(dict(name=name, x=list(map(float, x)), y=list(map(float, y)),
                      order=order, ref_coeffs=list(map(float, raw)),
                      ref_r2=float(r2), sigma_ref=sigma))

# case 1: realistic cubic + noise, 24 points over a 2048-px detector
x = np.linspace(0, 2047, 24)
truth = lambda px: 350 + 0.19 * px - 3e-6 * px**2 + 8e-11 * px**3
y = truth(x) + rng.normal(0, 0.02, x.size)
make_case('cubic_2048px_noisy', x, y, 3)

# case 2: quadratic, few points, small pixel range
x2 = np.array([100., 320., 700., 1010., 1500.])
y2 = 400 + 0.21 * x2 - 5e-6 * x2**2 + rng.normal(0, 0.05, x2.size)
make_case('quadratic_5pts', x2, y2, 2)

# case 3: 5th-order stress test on a 4096-px detector
x3 = np.linspace(0, 4095, 40)
y3 = (300 + 0.1*x3 - 2e-6*x3**2 + 5e-10*x3**3 - 8e-14*x3**4 + 6e-18*x3**5
      + rng.normal(0, 0.01, x3.size))
make_case('quintic_4096px', x3, y3, 5)

json.dump(cases, open('scripts/calib_cases.json', 'w'))
print(f"wrote {len(cases)} reference cases (internal J-consistency asserts passed)")
