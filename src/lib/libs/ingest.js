/**
 * Spectrometer CSV ingest. Turns arbitrary captured text into
 *   { lambda_nm: Float64Array, intensity: Float64Array, unit, meta, warnings }
 * fully client-side (the user's spectra never leave the browser).
 *
 * Handles: metadata-header blocks (Ocean Optics ">>>>>Begin Spectral Data<<<<<",
 * key:value preamble), delimiter auto-detect (comma/tab/semicolon/whitespace),
 * descending order, and wavelength-unit detection (nm / Angstrom / cm^-1
 * wavenumber). Ambiguous units are FLAGGED in `warnings` (and reported in the
 * returned `unit` + `unitConfidence`) rather than silently guessed -- the UI
 * lets the user override.
 */

const NUM_RE = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

function splitCells(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(';')) return line.split(';');
  if (line.includes(',')) return line.split(',');
  return line.trim().split(/\s+/);
}

function numericCells(line) {
  const cells = splitCells(line).map((c) => c.trim());
  const nums = cells.map((c) => {
    const m = c.match(/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/);
    return m ? parseFloat(c) : NaN;
  });
  return nums;
}

/** Detect wavelength unit from header text + the value range. */
function detectUnit(headerText, lam) {
  const h = headerText.toLowerCase();
  if (/\bcm-?1\b|cm\^-1|wavenumber|kayser/.test(h)) return ['cm-1', 'header'];
  if (/(angstrom|\bÅ\b|\bA\b\s*\)|\[a\])/.test(h)) return ['angstrom', 'header'];
  if (/\bnm\b|nanomet/.test(h)) return ['nm', 'header'];
  // Range/ordering heuristics on a robust span.
  const sorted = [...lam].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  if (hi <= 1300 && lo >= 100) return ['nm', 'range'];
  if (hi <= 13000 && lo >= 1000) return ['angstrom', 'range'];
  if (lo >= 3000 && hi <= 60000) return ['cm-1', 'range'];
  return ['nm', 'assumed'];
}

function toNm(value, unit) {
  if (unit === 'nm') return value;
  if (unit === 'angstrom') return value / 10;
  if (unit === 'cm-1') return 1e7 / value;     // wavenumber [cm^-1] -> nm (vac)
  return value;
}

/**
 * Parse spectrometer text. opts: { wavelengthCol, intensityCol, unit } to
 * override auto-detection.
 */
export function parseSpectrumCSV(text, opts = {}) {
  const warnings = [];
  const meta = {};
  const lines = text.split(/\r\n|\r|\n/);

  // Separate a metadata preamble from the numeric data region: the data region
  // is the longest run of lines that each parse to >= 2 numeric cells.
  const isData = lines.map((l) => {
    const n = numericCells(l).filter((x) => Number.isFinite(x));
    return n.length >= 2;
  });
  let start = 0, bestStart = 0, bestLen = 0, run = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isData[i]) { if (run === 0) start = i; run++; if (run > bestLen) { bestLen = run; bestStart = start; } }
    else run = 0;
  }
  if (bestLen < 2) { warnings.push('No two-column numeric data found.'); return { lambda_nm: new Float64Array(), intensity: new Float64Array(), unit: null, meta, warnings }; }

  // Preamble metadata: key:value lines before the data region.
  const headerLines = lines.slice(0, bestStart);
  for (const l of headerLines) {
    const m = l.match(/^\s*([A-Za-z][^:]{0,40}):\s*(.+?)\s*$/);
    if (m) meta[m[1].trim()] = m[2].trim();
  }
  const headerText = headerLines.join('\n');

  // Determine columns from the first data row.
  const first = numericCells(lines[bestStart]);
  const wlCol = opts.wavelengthCol ?? 0;
  const inCol = opts.intensityCol ?? (first.length > 1 ? 1 : 0);

  const rawLam = [], rawInt = [];
  for (let i = bestStart; i < bestStart + bestLen; i++) {
    const n = numericCells(lines[i]);
    if (!Number.isFinite(n[wlCol]) || !Number.isFinite(n[inCol])) continue;
    rawLam.push(n[wlCol]); rawInt.push(n[inCol]);
  }

  // Unit.
  let [unit, how] = opts.unit ? [opts.unit, 'override'] : detectUnit(headerText, rawLam);
  if (how === 'assumed') warnings.push('Could not confidently determine wavelength unit; assuming nm. Override if wrong.');
  if (how === 'range' && unit !== 'nm') warnings.push(`Wavelength unit inferred as ${unit} from value range; verify.`);

  // Convert to nm and sort ascending.
  const idx = rawLam.map((_, i) => i).sort((a, b) => toNm(rawLam[a], unit) - toNm(rawLam[b], unit));
  const lambda_nm = new Float64Array(idx.length);
  const intensity = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    lambda_nm[k] = toNm(rawLam[idx[k]], unit);
    intensity[k] = rawInt[idx[k]];
  }
  if (idx.length && idx[0] !== 0) warnings.push('Input was not in ascending wavelength order; reordered.');

  return { lambda_nm, intensity, unit, unitConfidence: how, meta, warnings, nPoints: lambda_nm.length };
}
