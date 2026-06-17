/**
 * Headless-browser smoke test of /tools/libs/ (not part of npm test; needs
 * `npm run preview` running and a one-off `npm i --no-save playwright`).
 * Drives the real UI: load page -> synthesize a sample -> run analysis ->
 * verify the results table populates, with no console/page errors.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:4321/tools/libs/';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

let ok = true;
function step(name, cond, info = '') { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!cond) ok = false; }

await page.goto(URL, { waitUntil: 'networkidle' });

// manifest loaded
await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('Ready'), { timeout: 30000 });
step('page loads, dataset manifest ready', true);

// load a synthetic sample
await page.selectOption('[data-sample]', 'Stainless steel');
await page.waitForFunction(() => /peaks/.test(document.querySelector('[data-status]')?.textContent || ''), { timeout: 30000 });
const peakStatus = await page.textContent('[data-status]');
step('sample synthesized + peaks detected', /peaks/.test(peakStatus), peakStatus.trim());

// run analysis
await page.click('[data-run]');
await page.waitForFunction(() => document.querySelectorAll('[data-results] tbody tr').length > 0, { timeout: 45000 });
const rows = await page.$$eval('[data-results] tbody tr', (trs) => trs.slice(0, 6).map((tr) => {
  const td = tr.querySelectorAll('td');
  return { el: td[1]?.textContent, conf: td[2]?.textContent?.trim() };
}));
step('analysis produced a ranked element table', rows.length > 0);
console.log('  top results:', JSON.stringify(rows));
// stainless steel = Fe/Cr/Ni/Mn; Fe should appear near the top
const top = rows.map((r) => r.el);
step('Fe (matrix element) identified in top results', top.includes('Fe'), 'top=' + top.join(','));

// diagnostics panel rendered
const diag = await page.textContent('[data-diagnostics]');
step('diagnostics panel populated', !!diag && diag.length > 20);

// no runtime errors
step('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: 'scripts/_libs_smoke.png', fullPage: true });
console.log('  screenshot -> scripts/_libs_smoke.png');
await browser.close();
console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
process.exit(ok ? 0 : 1);
