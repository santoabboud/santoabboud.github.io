#!/usr/bin/env python3
"""
Assemble the v2 LIBS dataset from the raw NIST scrapes.

Inputs (raw, gitignored):
  scripts/_nist_cache/lines_libs/<Sym>.tsv     (scrape_nist_lines.py)
  scripts/_nist_cache/levels/<Sym>_<stage>.tsv (scrape_nist_levels.py)

Outputs (committed, served by the app):
  public/data/libs/lines/<Sym>.json   per-element lines with full constants
  public/data/libs/levels/<Sym>.json  per-stage levels + ionization energy
  public/data/libs/_match_index.json   columnar all-species index for matching
  public/data/libs/_manifest.json      provenance, counts, element/stage index

Wavelengths: scrape is VACUUM; air is derived via Peck & Reeder (1972) -- the
SAME formula validated to <0.1 pm against NIST's air column in
test_libs_wavelength.mjs. Below 185 nm air == vacuum (ASD reports vacuum).

Energies in cm^-1. Theoretical/predicted values carry [..]/(..) brackets and
'+x' offsets in ASD; these are stripped, and energies with undefined absolute
offset ('+x','?') are set null (line still matchable, just not Boltzmann-usable).
"""
import json
import os
import re
import sys

# Canonical symbol -> atomic number (Z = index + 1). The scrape manifest's key
# order is NOT atomic-number order, so Z must come from here, never from
# enumeration of the manifest.
_SYMBOLS = [
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
ELEMENT_Z = {s: i + 1 for i, s in enumerate(_SYMBOLS)}

LINES_DIR = "scripts/_nist_cache/lines_libs"
LEVELS_DIR = "scripts/_nist_cache/levels"
OUT = "public/data/libs"
ASD_VERSION = "5.12"
VAC_FLOOR_NM = 185.0
_NUM = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def n_air(lam_vac_nm):
    """Peck & Reeder (1972) refractive index of standard air."""
    s2 = (1e3 / lam_vac_nm) ** 2
    return 1 + (5791817 / (238.0185 - s2) + 167909 / (57.362 - s2)) * 1e-8


def vac_to_air(lam_vac_nm):
    if lam_vac_nm < VAC_FLOOR_NM:
        return lam_vac_nm
    return lam_vac_nm / n_air(lam_vac_nm)


def num(s):
    """Leading numeric value, ignoring quotes/brackets/parens. None if absent
    or if the value carries an undefined absolute offset ('+x', '?')."""
    if s is None:
        return None
    s = s.strip().strip('"').strip()
    if not s or "+x" in s or "?" in s:
        return None
    s = s.translate(str.maketrans("", "", "[]()"))
    m = _NUM.match(s.strip())
    return float(m.group(0)) if m else None


def col_index(header):
    return {name: i for i, name in enumerate(header)}


def parse_lines_file(sym):
    """Yield dicts per line from a lines TSV (both header layouts)."""
    path = os.path.join(LINES_DIR, f"{sym}.tsv")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        c = col_index(header)
        has_sp = "sp_num" in c
        for line in f:
            if not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            cell = lambda name: p[c[name]] if name in c and c[name] < len(p) else ""
            # ionization stage
            if has_sp:
                try:
                    stage = int(cell("sp_num").strip('"'))
                except ValueError:
                    continue
            else:
                idi = cell("ID_i").strip('"')
                try:
                    stage = int(idi.split(".")[0][3:6])
                except (ValueError, IndexError):
                    continue
            obs = num(cell("obs_wl_vac(nm)"))
            ritz = num(cell("ritz_wl_vac(nm)"))
            lam_vac = obs if obs is not None else ritz
            if lam_vac is None:
                continue
            yield {
                "stage": stage,
                "lam_vac": lam_vac,
                "src": 0 if obs is not None else 1,   # 0=observed, 1=Ritz
                "Aki": num(cell("Aki(s^-1)")),
                "Ek": num(cell("Ek(cm-1)")),
                "Ei": num(cell("Ei(cm-1)")),
                "gk": num(cell("g_k")),
                "gi": num(cell("g_i")),
                "intens": cell("intens").strip('"').strip(),
                "acc": cell("Acc").strip('"').strip(),
            }


def parse_levels_file(sym, stage):
    """Return (levels[[E_cm1, g]], ion_energy_cm1) for one species."""
    path = os.path.join(LEVELS_DIR, f"{sym}_{stage}.tsv")
    if not os.path.exists(path):
        return None, None
    levels, chi = [], None
    with open(path, encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        c = col_index(header)
        ei = c.get("Level (cm-1)")
        gi = c.get("g")
        ti = c.get("Term")
        for line in f:
            if not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            term = p[ti].strip('"') if ti is not None and ti < len(p) else ""
            E = num(p[ei]) if ei is not None and ei < len(p) else None
            if term == "Limit":
                # ASD may list several limits (to excited ionic cores), energy-
                # ordered. The PRINCIPAL ionization energy is the lowest = first.
                if E is not None and chi is None:
                    chi = E
                continue
            g = num(p[gi]) if gi is not None and gi < len(p) else None
            if E is not None and g:
                levels.append([E, int(g)])
    return levels, chi


def main():
    only = set(sys.argv[1:])  # optional symbol filter for quick tests
    lines_manifest = os.path.join(LINES_DIR, "_scrape_manifest.json")
    elements = list(json.load(open(lines_manifest))["elements"].keys())
    if only:
        elements = [e for e in elements if e in only]

    os.makedirs(os.path.join(OUT, "lines"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "levels"), exist_ok=True)

    # global match index (columnar)
    mi = {"species": [], "lam_air": [], "sp": [], "Aki": [], "Ek": [],
          "gk": [], "int": []}
    sp_index = {}
    manifest_elems = []
    total_lines = total_levels = 0

    # Iterate in canonical atomic-number order with Z from the authoritative map.
    for sym in sorted(elements, key=lambda s: ELEMENT_Z.get(s, 999)):
        Z = ELEMENT_Z[sym]
        # ---- lines ----
        by_stage = {}
        for r in parse_lines_file(sym):
            lam_air = round(vac_to_air(r["lam_vac"]), 6)
            row = [lam_air, round(r["lam_vac"], 6), r["Aki"], r["Ek"],
                   int(r["gk"]) if r["gk"] else None, r["Ei"],
                   int(r["gi"]) if r["gi"] else None, r["intens"], r["acc"],
                   r["src"]]
            by_stage.setdefault(r["stage"], []).append(row)
            sp = f"{sym} {to_roman(r['stage'])}"
            if sp not in sp_index:
                sp_index[sp] = len(mi["species"])
                mi["species"].append(sp)
            mi["lam_air"].append(lam_air)
            mi["sp"].append(sp_index[sp])
            mi["Aki"].append(r["Aki"])
            mi["Ek"].append(r["Ek"])
            mi["gk"].append(int(r["gk"]) if r["gk"] else None)
            mi["int"].append(r["intens"])
        for st in by_stage:
            by_stage[st].sort(key=lambda x: x[0])
        nlines = sum(len(v) for v in by_stage.values())
        total_lines += nlines
        with open(os.path.join(OUT, "lines", f"{sym}.json"), "w") as f:
            json.dump({"symbol": sym, "Z": Z, "asd_version": ASD_VERSION,
                       "columns": ["lam_air", "lam_vac", "Aki", "Ek", "gk",
                                   "Ei", "gi", "int", "acc", "src"],
                       "stages": {str(s): by_stage[s] for s in sorted(by_stage)}},
                      f, separators=(",", ":"))

        # ---- levels ----
        lv_stages = {}
        for st in sorted(by_stage):
            levels, chi = parse_levels_file(sym, st)
            if levels is None:
                continue
            lv_stages[str(st)] = {"ion_energy_cm1": chi, "levels": levels}
            total_levels += len(levels)
        if lv_stages:
            with open(os.path.join(OUT, "levels", f"{sym}.json"), "w") as f:
                json.dump({"symbol": sym, "stages": lv_stages},
                          f, separators=(",", ":"))

        manifest_elems.append({
            "sym": sym, "Z": Z,
            "stages": sorted(by_stage),
            "lines": nlines,
            "has_levels": bool(lv_stages),
        })
        print(f"  {sym:3s} Z={Z:3d}  lines={nlines:5d}  "
              f"levels_stages={len(lv_stages)}", flush=True)

    # Sort the columnar match index globally by air wavelength so the matcher
    # can binary-search candidate lines for each detected peak.
    order = sorted(range(len(mi["lam_air"])), key=lambda i: mi["lam_air"][i])
    for key in ("lam_air", "sp", "Aki", "Ek", "gk", "int"):
        mi[key] = [mi[key][i] for i in order]
    with open(os.path.join(OUT, "_match_index.json"), "w") as f:
        json.dump(mi, f, separators=(",", ":"))
    with open(os.path.join(OUT, "_manifest.json"), "w") as f:
        json.dump({
            "source": "NIST ASD v5.12 (lines1.pl + energy1.pl)",
            "asd_version": ASD_VERSION,
            "wavelength": "air derived from vacuum via Peck & Reeder (1972)",
            "energy_unit": "cm-1",
            "line_columns": ["lam_air", "lam_vac", "Aki", "Ek", "gk", "Ei",
                             "gi", "int", "acc", "src(0=obs,1=Ritz)"],
            "citation": ("Kramida, A., Ralchenko, Yu., Reader, J. and NIST ASD "
                         "Team (2024). NIST ASD v5.12, DOI 10.18434/T4W30F."),
            "elements": manifest_elems,
            "total_lines": total_lines,
            "total_levels": total_levels,
            "n_species_indexed": len(mi["species"]),
        }, f, indent=1)
    print(f"\n[done] elements={len(manifest_elems)} lines={total_lines:,} "
          f"levels={total_levels:,} species_indexed={len(mi['species'])}")


_ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
def to_roman(n):
    return _ROMAN[n] if n < len(_ROMAN) else str(n)


if __name__ == "__main__":
    main()
