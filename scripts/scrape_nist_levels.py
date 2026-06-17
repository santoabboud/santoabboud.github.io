#!/usr/bin/env python3
"""
Scrape the NIST ASD *Levels* database (energy1.pl) for every (element, ion
stage) that the Lines scrape found to have lines. Provides, per species:
  - all bound energy levels with statistical weight g and energy E (cm^-1),
  - the ionization LIMIT row -> ionization energy chi_z (cm^-1) for Saha.

These feed the LTE forward model and CF-LIBS:
  U_z(T) = sum_j g_j exp(-E_j / k_B T), truncated at the (Debye-lowered) limit,
  and the Saha balance which needs chi_z.

Endpoint/params validated against the live form 2026-06-16 (ASD v5.12).
Output columns (format=3, units=0): Configuration, Term, J, g, Prefix,
Level(cm-1), Suffix, Uncertainty(cm-1), Reference. A row whose Term == "Limit"
carries chi_z in the Level column.

Politeness: per-species query, throttled, cached, resumable. Run AFTER the
lines scrape completes (do not run both concurrently against NIST).

Usage: python3 scripts/scrape_nist_levels.py [--max-stage 4] [--only Fe,Ca]
"""
import argparse
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://physics.nist.gov/cgi-bin/ASD/energy1.pl"
USER_AGENT = ("Mozilla/5.0 (research; santoabboud.github.io LIBS dataset build; "
              "contact babboud@atomicsemi.com)")
ASD_VERSION = "5.12"
THROTTLE_S = 3.0
RETRIES = 4
BACKOFF_S = 8.0
TIMEOUT_S = 300
LINES_CACHE = "scripts/_nist_cache/lines_libs"
OUT_DIR = "scripts/_nist_cache/levels"

BASE_PARAMS = {
    "units": "0",            # cm^-1
    "format": "3",           # tab-delimited
    "output": "0",           # entirety
    "multiplet_ordered": "0",
    "conf_out": "on",
    "term_out": "on",
    "level_out": "on",
    "unc_out": "on",
    "j_out": "on",
    "g_out": "on",           # statistical weight g directly
    "biblio": "on",
    "temp": "",              # blank -> no NIST-side partition column; we sum
    "de": "0",
    "submit": "Retrieve Data",
}

HEADER_SENTINEL = "Level (cm-1)"
ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]


def int_to_roman(n):
    if n < len(ROMAN):
        return ROMAN[n]
    # general fallback (subtractive); LIBS only needs up to ~V
    table = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"),
             (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"),
             (5, "V"), (4, "IV"), (1, "I")]
    out = ""
    for v, s in table:
        while n >= v:
            out += s
            n -= v
    return out


def stages_present(symbol, max_stage):
    """Distinct ionization stages (1=I,...) with lines, from the lines TSV.
    Handles both header layouts (multi-species has element/sp_num; single
    species recovers the stage from the ID_i prefix ZZZIII...)."""
    path = os.path.join(LINES_CACHE, f"{symbol}.tsv")
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        cols = {name: i for i, name in enumerate(header)}
        sp_i = cols.get("sp_num")
        id_i = cols.get("ID_i")
        stages = set()
        for line in f:
            if not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            try:
                if sp_i is not None:
                    st = int(parts[sp_i])
                elif id_i is not None:
                    # ID_i like "026003.000033" -> Z=026, ion=003
                    tok = parts[id_i].strip('"').split(".")[0]
                    st = int(tok[3:6])
                else:
                    continue
            except (ValueError, IndexError):
                continue
            if 1 <= st <= max_stage:
                stages.add(st)
    return stages


def classify(text):
    if HEADER_SENTINEL in text:
        n = sum(1 for ln in text.splitlines()[1:] if ln.strip())
        return ("ok", n)
    if "Software error" in text:
        return ("error", "ASD software error")
    if "Input Error" in text:
        return ("error", "Input Error")
    if len(text.strip()) < 400:
        return ("empty", 0)
    return ("error", "unrecognized response")


def fetch(spectrum):
    params = dict(BASE_PARAMS, spectrum=spectrum)
    url = ENDPOINT + "?" + urllib.parse.urlencode(params)
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
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            time.sleep(BACKOFF_S * attempt)
    return None, "error", last or "exhausted retries"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-stage", type=int, default=4)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    lines_manifest = os.path.join(LINES_CACHE, "_scrape_manifest.json")
    if not os.path.exists(lines_manifest):
        raise SystemExit("Run scrape_nist_lines.py first (no lines manifest).")
    with open(lines_manifest) as f:
        elements = list(json.load(f).get("elements", {}).keys())
    if only:
        elements = [e for e in elements if e in only]

    # Build the species work-list from stages that actually have lines.
    species = []
    for sym in elements:
        for st in sorted(stages_present(sym, args.max_stage)):
            species.append((sym, st))
    print(f"[levels] {len(species)} species from {len(elements)} elements",
          flush=True)

    manifest_path = os.path.join(OUT_DIR, "_levels_manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f).get("species", {})

    t_start = time.time()
    for sym, st in species:
        key = f"{sym} {int_to_roman(st)}"
        path = os.path.join(OUT_DIR, f"{sym}_{st}.tsv")
        if os.path.exists(path) and key in manifest:
            print(f"  [skip] {key:8s} ({manifest[key].get('levels','?')})",
                  flush=True)
            continue
        t0 = time.time()
        text, kind, info = fetch(key)
        dt = time.time() - t0
        if text is None:
            manifest[key] = {"status": "error", "detail": info}
            print(f"  [ERR ] {key:8s} {info} ({dt:.1f}s)", flush=True)
        else:
            chi = None
            if kind == "ok":
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                for ln in text.splitlines():
                    if '"Limit"' in ln:
                        cells = [c.strip('"') for c in ln.split("\t")]
                        for c in cells:
                            try:
                                chi = float(c.replace(" ", ""))
                                break
                            except ValueError:
                                continue
                        break
            manifest[key] = {
                "status": kind, "levels": info,
                "ion_energy_cm1": chi,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
            print(f"  [ {kind[:3]}] {key:8s} {info:5} levels  "
                  f"chi={chi}  ({dt:.1f}s)", flush=True)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({
                "source": "NIST ASD Levels (energy1.pl)",
                "asd_version": ASD_VERSION,
                "energy_unit": "cm-1",
                "note": ("'Limit' row gives ionization energy chi_z; sum g*exp"
                         "(-E/kT) over levels below the (Debye-lowered) limit."),
                "citation": ("Kramida, A., Ralchenko, Yu., Reader, J. and NIST "
                             "ASD Team (2024). NIST ASD v5.12, DOI "
                             "10.18434/T4W30F."),
                "species": manifest,
            }, f, indent=1)
        time.sleep(THROTTLE_S)

    ok = sum(1 for v in manifest.values() if v.get("status") == "ok")
    err = sum(1 for v in manifest.values() if v.get("status") == "error")
    print(f"\n[done] {(time.time()-t_start)/60:.1f} min  ok={ok} err={err}",
          flush=True)


if __name__ == "__main__":
    main()
