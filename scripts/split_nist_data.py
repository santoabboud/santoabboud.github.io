#!/usr/bin/env python3
"""
Split the legacy NIST ASD-derived line list (single ~13.8 MB JSON keyed by
species, e.g. "H", "Fe II") into per-element files for lazy loading, plus a
compact columnar index for the line finder, plus a manifest.

Input format  : { "<species>": [ {"wavelength": float_nm,
                                  "intensity_obs": str, "Aki": str}, ... ] }
Output:
  public/data/spectra/<Sym>.json   {"symbol","stages":{"<species>":[[lam_nm,
                                    intensity_str, Aki_str], ...]}}
  public/data/spectra/_finder.json columnar {"ions":[...], "l":[...], "i":[...],
                                    "n":[...]}  (l=lambda nm, i=ion index,
                                    n=intensity string)
  public/data/spectra/_manifest.json

Wavelengths are passed through UNCHANGED. Medium convention of the legacy
scrape is unverified (ASD default is air >= 200 nm / vacuum below); the
viewer labels this explicitly. The planned v2 scraper will store both and
add E_k, g_k for the LIBS simulator.

Usage: python3 scripts/split_nist_data.py <path-to-legacy-json>
"""
import hashlib
import json
import os
import re
import sys

def roman_to_int(s: str):
    """General Roman-numeral parser (subtractive notation). Returns None
    on invalid input. Covers arbitrary ionization stages (I..LIV+)."""
    vals = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    if not s or any(ch not in vals for ch in s):
        return None
    total = 0
    for k, ch in enumerate(s):
        v = vals[ch]
        if k + 1 < len(s) and vals[s[k + 1]] > v:
            total -= v
        else:
            total += v
    return total

def species_parts(key: str):
    parts = key.split()
    sym = parts[0]
    stage = roman_to_int(parts[1]) if len(parts) > 1 else 1
    return sym, stage

def main(src_path: str, out_dir: str = "public/data/spectra"):
    with open(src_path, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw)

    os.makedirs(out_dir, exist_ok=True)
    by_element = {}
    skipped = []
    for key, lines in data.items():
        sym, stage = species_parts(key)
        if not re.fullmatch(r"[A-Z][a-z]?", sym) or stage is None:
            skipped.append(key)
            continue
        by_element.setdefault(sym, {})[key] = lines

    finder_ions, finder_l, finder_i, finder_n = [], [], [], []
    manifest_elements = []
    total_lines = 0

    for sym in sorted(by_element):
        stages = {}
        n_el = 0
        for key in sorted(by_element[sym], key=lambda k: species_parts(k)[1]):
            rows = []
            for ln in by_element[sym][key]:
                lam = ln.get("wavelength")
                if lam is None:
                    continue
                rows.append([lam, str(ln.get("intensity_obs", "")),
                             str(ln.get("Aki", ""))])
            stages[key] = rows
            n_el += len(rows)
            ion_idx = len(finder_ions)
            finder_ions.append(key)
            for lam, inten, _aki in rows:
                finder_l.append(round(float(lam), 3))
                finder_i.append(ion_idx)
                finder_n.append(inten)
        total_lines += n_el
        path = os.path.join(out_dir, f"{sym}.json")
        with open(path, "w") as f:
            json.dump({"symbol": sym, "stages": stages}, f,
                      separators=(",", ":"))
        manifest_elements.append({
            "sym": sym,
            "stages": sorted(species_parts(k)[1] for k in stages),
            "lines": n_el,
            "bytes": os.path.getsize(path),
        })

    with open(os.path.join(out_dir, "_finder.json"), "w") as f:
        json.dump({"ions": finder_ions, "l": finder_l, "i": finder_i,
                   "n": finder_n}, f, separators=(",", ":"))

    manifest = {
        "source": "legacy NIST ASD-derived scrape (nist_atomic_data.json)",
        "source_sha256": sha,
        "medium_note": ("wavelengths passed through unchanged; legacy scrape "
                        "medium unverified (ASD default: air >=200 nm, "
                        "vacuum below)"),
        "elements": manifest_elements,
        "skipped_keys": skipped,
        "total_lines": total_lines,
    }
    with open(os.path.join(out_dir, "_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    print(f"elements: {len(manifest_elements)}  total lines: {total_lines}  "
          f"skipped keys: {skipped}")
    sizes = sorted(manifest_elements, key=lambda e: -e["bytes"])[:5]
    for e in sizes:
        print(f"  largest: {e['sym']:3s} {e['bytes']/1024:8.1f} KB "
              f"({e['lines']} lines)")
    fs = os.path.getsize(os.path.join(out_dir, "_finder.json"))
    print(f"finder index: {fs/1048576:.2f} MB   source sha256: {sha[:16]}…")

if __name__ == "__main__":
    main(sys.argv[1])
