#!/usr/bin/env python3
"""
Scrape the NIST Atomic Spectra Database (ASD) *Lines* database.

Endpoint and every query parameter below were validated against the live ASD
form on 2026-06-16 (ASD v5.12). The form's CGI is /cgi-bin/ASD/lines1.pl and
accepts GET parameters; `format=3` yields a tab-delimited table; `remove_js=on`
strips the HTML wrapper; `ids_out=on` adds `element`/`sp_num` species columns so
a single multi-stage query is unambiguously labelled per row.

Wavelength medium: we request `show_av=3` (VACUUM for ALL wavelengths) as the
single, unambiguous canonical. Air wavelengths (the ASD default for 200-2000 nm)
are DERIVED downstream from the vacuum values via the Edlen/Ciddor dispersion
relation -- never mixed inside one column. (The naive `show_av=2` mislabels a
mixed vacuum/air column as "vac" when a query spans the 2000 A boundary.)

Energies are requested in cm^-1 (`en_unit=0`), the canonical unit for Boltzmann
factors exp(-E_k hc / k_B T). All transition data needed by the LTE forward
model and CF-LIBS is captured: A_ki, f_ik, log(gf), g_i, g_k, E_i, E_k,
accuracy code, observed+Ritz wavelengths with uncertainties, and references.

Tiers:
  --tier libs  (default) : stages I-IV, 180-1100 nm  -> the LIBS app dataset
  --tier full            : all stages, no wavelength limit -> full archive

Politeness: one request per element, THROTTLE_S between requests, retry with
backoff, raw responses cached to disk so re-runs never re-fetch. Resumable.

Usage:
  python3 scripts/scrape_nist_lines.py [--tier libs|full] [--only Fe,Ca,...]
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://physics.nist.gov/cgi-bin/ASD/lines1.pl"
# Identify the scraper honestly with a research contact, per NIST etiquette.
USER_AGENT = ("Mozilla/5.0 (research; santoabboud.github.io LIBS dataset build; "
              "contact babboud@atomicsemi.com)")
ASD_VERSION = "5.12"            # current ASD release as of the query date
THROTTLE_S = 3.0               # delay between successful requests (politeness)
RETRIES = 4                    # attempts per element on transient failure
BACKOFF_S = 8.0               # base backoff, multiplied by attempt index
TIMEOUT_S = 600              # heavy elements (Fe) can take >60 s server-side

# Z, symbol for Z = 1..99. ASD data thins out past U(92); empty returns are
# recorded as 0-line results, not errors.
ELEMENTS = [
    "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al",
    "Si", "P", "S", "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe",
    "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr",
    "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
    "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm",
    "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W",
    "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn",
    "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf",
    "Es",
]

# Base parameters common to every query (validated field set).
BASE_PARAMS = {
    "output_type": "0",      # search by wavelength
    "limits_type": "0",
    "unit": "1",             # nm
    "de": "0",
    "format": "3",           # tab-delimited
    "remove_js": "on",       # strip HTML wrapper -> clean machine output
    "line_out": "0",         # all lines (observed + Ritz)
    "show_av": "3",          # VACUUM for all wavelengths (canonical)
    "en_unit": "0",          # energies in cm^-1
    "output": "0",           # entire result, no pagination
    "bibrefs": "1",
    "show_obs_wl": "1",
    "show_calc_wl": "1",     # Ritz
    "unc_out": "1",          # wavelength + energy uncertainties
    "order_out": "0",        # order by wavelength
    "A_out": "0",            # Aki (not gA)
    "f_out": "on",           # oscillator strength f_ik
    "loggf_out": "on",       # log(gf)
    "intens_out": "on",      # relative intensity
    "allowed_out": "1",      # E1
    "forbid_out": "1",       # M1, E2, ...
    "conf_out": "on",
    "term_out": "on",
    "enrg_out": "on",        # E_i, E_k
    "J_out": "on",
    "g_out": "on",           # g_i, g_k
    "ids_out": "on",         # element + sp_num species columns
    "submit": "Retrieve Data",
}

TIERS = {
    "libs": {"spectra_stages": "I-IV", "low_w": "180", "upp_w": "1100"},
    "full": {"spectra_stages": "", "low_w": "", "upp_w": ""},  # all stages/wl
}

# A successful Lines query always emits the Aki column (we request A_out=0).
# NOTE: NIST OMITS the element/sp_num columns when the result is a SINGLE
# species (e.g. "H I-IV" -> only H I has lines). So we must NOT key on those;
# the parser recovers species from the ID_i prefix (Z, ion) when absent.
HEADER_SENTINEL = "Aki(s^-1)"              # marks a real data table
SOFTWARE_ERROR = "Software error"          # perl crash (missing/invalid param)
INPUT_ERROR = "Input Error"               # form-validation rejection


def build_url(symbol, tier):
    cfg = TIERS[tier]
    params = dict(BASE_PARAMS)
    stages = cfg["spectra_stages"]
    params["spectra"] = f"{symbol} {stages}".strip() if stages else symbol
    if cfg["low_w"]:
        params["low_w"] = cfg["low_w"]
    if cfg["upp_w"]:
        params["upp_w"] = cfg["upp_w"]
    return ENDPOINT + "?" + urllib.parse.urlencode(params)


def classify(text):
    """Return ('ok', nlines) | ('empty', 0) | ('error', msg)."""
    if HEADER_SENTINEL in text:
        # Real data table. Data rows = lines after the header (blanks ignored).
        n = sum(1 for ln in text.splitlines()[1:] if ln.strip())
        return ("ok", n)
    if SOFTWARE_ERROR in text:
        return ("error", "ASD software error (parameter rejected)")
    if INPUT_ERROR in text:
        m = re.search(r"Error Message:\s*</[^>]+>\s*([^<]+)", text)
        return ("error", "Input Error: " + (m.group(1).strip() if m else "?"))
    # ASD returns a short plaintext notice when a spectrum has no matching lines.
    if "No lines" in text or "no lines" in text or len(text.strip()) < 400:
        return ("empty", 0)
    return ("error", "unrecognized response")


def fetch(symbol, tier):
    url = build_url(symbol, tier)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            kind, info = classify(text)
            if kind == "error":
                last = info
                time.sleep(BACKOFF_S * attempt)
                continue
            return text, kind, info
        except Exception as e:  # noqa: BLE001 - log and back off on any net error
            last = f"{type(e).__name__}: {e}"
            time.sleep(BACKOFF_S * attempt)
    return None, "error", last or "exhausted retries"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=list(TIERS), default="libs")
    ap.add_argument("--only", default="", help="comma list of symbols to fetch")
    ap.add_argument("--cache", default="scripts/_nist_cache")
    args = ap.parse_args()

    cache_dir = os.path.join(args.cache, f"lines_{args.tier}")
    os.makedirs(cache_dir, exist_ok=True)
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    todo = [s for s in ELEMENTS if not only or s in only]

    manifest_path = os.path.join(cache_dir, "_scrape_manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f).get("elements", {})

    print(f"[scrape] tier={args.tier}  elements={len(todo)}  cache={cache_dir}",
          flush=True)
    t_start = time.time()
    done = 0
    for symbol in todo:
        path = os.path.join(cache_dir, f"{symbol}.tsv")
        # Resume: skip elements already cached with a recorded status.
        if os.path.exists(path) and symbol in manifest:
            done += 1
            print(f"  [skip] {symbol:3s} cached "
                  f"({manifest[symbol].get('lines', '?')} lines)", flush=True)
            continue
        t0 = time.time()
        text, kind, info = fetch(symbol, args.tier)
        dt = time.time() - t0
        if text is None:
            manifest[symbol] = {"status": "error", "detail": info}
            print(f"  [ERR ] {symbol:3s} {info}  ({dt:.1f}s)", flush=True)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
            manifest[symbol] = {
                "status": kind, "lines": info, "bytes": len(text),
                "sha256": sha,
            }
            print(f"  [ {kind[:3]}] {symbol:3s} {info:6} lines  "
                  f"{len(text)/1024:8.1f} KB  ({dt:.1f}s)", flush=True)
        # Persist manifest incrementally so an interruption loses nothing.
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({
                "source": "NIST ASD Lines (lines1.pl)",
                "asd_version": ASD_VERSION,
                "tier": args.tier,
                "params": {**BASE_PARAMS, **TIERS[args.tier]},
                "wavelength_medium": "vacuum (show_av=3); air derived downstream",
                "energy_unit": "cm-1",
                "citation": ("Kramida, A., Ralchenko, Yu., Reader, J. and NIST "
                             "ASD Team (2024). NIST ASD v5.12, DOI "
                             "10.18434/T4W30F, https://physics.nist.gov/asd"),
                "elements": manifest,
            }, f, indent=1)
        done += 1
        time.sleep(THROTTLE_S)

    ok = sum(1 for v in manifest.values() if v.get("status") == "ok")
    empty = sum(1 for v in manifest.values() if v.get("status") == "empty")
    err = sum(1 for v in manifest.values() if v.get("status") == "error")
    total_lines = sum(v.get("lines", 0) for v in manifest.values())
    print(f"\n[done] {done} processed in {(time.time()-t_start)/60:.1f} min  "
          f"ok={ok} empty={empty} err={err}  total_lines={total_lines:,}",
          flush=True)
    if err:
        bad = [s for s, v in manifest.items() if v.get("status") == "error"]
        print(f"[done] errored (re-run to retry): {bad}", flush=True)


if __name__ == "__main__":
    main()
