# Migration notes — v1 (single index.html) → v2 (Astro)

Audit trail of every content change. Original: repo state at fresh-root
cutover (single-commit history, index.html @ 1508 lines).

## Articles — copy-edit log (user to review for technical accuracy)
**USB2000 firmware update**
1. "pull the the lid up" → "pull the lid up" (typo).
2. Arduino sketch: removed one of two consecutive `#include <SPI.h>` lines
   (duplicate include; functionally inert). Code otherwise verbatim.
3. Added FIG. 01–09 captions (additive; none existed).
4. Heading hierarchy normalized to h2/h3 under the page h1; original mixed
   h4/h5. Disclaimer paragraph → CAUTION-style callout (presentation only).
5. ASCII "..." → typographic "…" where the original used trailing ellipses
   (author's style preserved, glyph normalized).
6. Samtec connector sentence lightly re-flowed ("avail." → "available").
7. All 9 image URLs verified byte-identical to v1 by diff (one transcription
   error caught and fixed during migration). Images remain hotlinked until
   originals arrive — see usb2000-firmware/IMAGES_TODO.md.

**Frankenscope**
1. Added FIG. 01–04 captions (additive).
2. Added spec-table summarizing components (additive; prose retained).
3. "sub nanosecond pulsewidth" → "sub-nanosecond-pulsewidth" (hyphenation).
4. laserscience.berlin link preserved.

## Structural decisions
- 12 projects → `draft: true` (hidden from build, listings, RSS, sitemap);
  original preview sentences preserved in each entry body.
- Categories: "Battery work" → "Batteries"; new "Simulation & Software";
  ICCD teardown + sCMOS servicing moved Night Vision → Cameras.
- All `date:` values are 2026-06-10 migration placeholders, not original
  publication dates. RSS/sort order is meaningless until backfilled.

## Dropped / relocated assets
- flowers.jpg/png, sand.png: **dropped** (decorative backgrounds; carried
  GPS EXIF; 11 MB).
- arc1.jpg, weak_arc.png: unreferenced in v1; EXIF-stripped → `_staging/`
  (gitignored; in the tarball, not the repo).
- 4 Frankenscope photos + profile: EXIF/GPS-stripped, orientation-baked,
  resized ≤1600 px (18.5 MB → 1.36 MB), relocated into content folders.
- style.css (dead file, never linked), Tailwind Play CDN, D3 v7: removed.
  Line coloring now uses src/lib/wavelength-color.js (same CIE math as the
  design tokens).

## Tools
- Spectra viewer: 13.8 MB runtime monolith → 94 per-element files,
  lazy-loaded (largest: Fe, 469 KB); 143,786/143,786 lines preserved
  (split verified, zero skips); intensity strings preserved verbatim;
  added ionization-stage filters (default I–III), line finder (2.3 MB
  on-demand index), explicit medium/intensity caveats. Source monolith
  sha256 recorded in public/data/spectra/_manifest.json.
- Calibration: raw-monomial normal equations (ill-conditioned, Σpx⁶ ≈ 10²⁰;
  hardcoded-cubic R²) → scaled Chebyshev basis, generic order 1–6,
  coefficient 1σ uncertainties, residual plots. Validated against numpy
  to <10⁻⁹ relative (scripts/test_calibration.mjs).

## S2 (2026-06-16) — project-card preview restyle
- Project-card preview band changed from a 16:9 box (`aspect-ratio:16/9` +
  object-fit:cover) to a short fixed-height banner (120px, flex-centered):
  - photos still fill via object-fit:cover (now a wide banner crop);
  - category glyphs now render whole and centered (height:74%, width:auto),
    no longer cropped by the band.
- Card chrome lightened: border-radius 10→8px, hover lift 3→2px, pad 14→13px.
- src/styles/global.css ONLY; no markup/component change. Affects every
  ProjectCard (homepage featured grid, /projects, category pages) uniformly.
- Rationale: reduce overall card height ("not such a tall preview"); flatter,
  cleaner proportions inspired by edgetrace.ai, kept entirely within Datasheet
  v1 (no palette/type change). See edgetrace_design_language_instruction_set.md.
- OPEN TRADEOFF (pending user pref): portrait source photos (e.g. Frankenscope
  cover) are center-cropped to the banner. Alternatives if undesired:
  object-fit:contain on a matched panel, or text-forward cards (drop the index
  photo, keep it on the article page).
