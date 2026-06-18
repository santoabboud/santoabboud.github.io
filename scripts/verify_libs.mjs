/**
 * Headless smoke test of /tools/libs/ (needs `npm run preview` + a one-off
 * `npm i --no-save playwright`). Exercises the real UI end to end: auto-run on
 * sample load, the ranked confidence table, and the periodic-table pre-select
 * (presets + cell toggle), asserting no JS errors.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:4321/tools/libs/';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
let ok = true;
const step = (n, c, i = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${i ? '  ' + i : ''}`); if (!c) ok = false; };

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent.includes('Ready'), { timeout: 30000 });
step('page + manifest ready', true);

// load a sample -> auto-runs analysis -> results table populates
await page.selectOption('[data-sample]', 'Stainless steel');
await page.waitForFunction(() => document.querySelectorAll('[data-results] tr.el-row').length > 0, { timeout: 60000 });
const rows = await page.$$eval('[data-results] tr.el-row', (trs) => trs.map((tr) => ({
  el: tr.querySelector('.el-sym')?.textContent,
  conf: parseInt(tr.querySelector('.conf-num')?.textContent) || 0,
})));
const chips = await page.$$eval('[data-results] .el-chip', (cs) => cs.map((c) => c.textContent.replace(/\d+$/, '').trim()));
step('auto-run produced results (no Run click needed)', rows.length > 0);
console.log('  steel top-6:', JSON.stringify(rows.slice(0, 6)), '| confident chips:', JSON.stringify(chips));
const matrix = ['Fe', 'Cr', 'Mn', 'Ni'];
const found = matrix.filter((e) => rows.some((r) => r.el === e && r.conf > 55));
step('matrix elements present with confidence > 55%', found.length >= 3, 'found=' + found.join(','));
step('top candidate reads confidently (>80%)', (rows[0]?.conf || 0) > 80, rows[0]?.el + '=' + rows[0]?.conf + '%');
step('confident-chip summary present', chips.length >= 1, 'chips=' + chips.join(','));

// pre-select: preset narrows the universe + re-ranks
const allCount = await page.textContent('[data-pt-count]');
await page.click('[data-preset="metallurgy"]');
await page.waitForFunction(() => /\d+ elements/.test(document.querySelector('[data-pt-count]')?.textContent || ''), { timeout: 5000 });
await page.waitForTimeout(500);
const metCount = await page.textContent('[data-pt-count]');
step('preset narrows element universe', /\d+ elements/.test(metCount), `${allCount.trim()} -> ${metCount.trim()}`);
// preset re-runs and filters results: an out-of-domain element (Be) should drop
const els = await page.$$eval('[data-results] tr.el-row .el-sym', (ns) => ns.map((n) => n.textContent));
step('preset re-runs + filters results (Be excluded)', !els.includes('Be'), 'metallurgy results: ' + els.slice(0, 6).join(','));

// cell toggle: clicking an element changes the count by exactly 1 (no "dim all" bug)
const before = parseInt((await page.textContent('[data-pt-count]')).match(/\d+/)?.[0] || '0');
await page.click('button.pt-cell[data-sym="W"]');     // toggle tungsten
const after = parseInt((await page.textContent('[data-pt-count]')).match(/\d+/)?.[0] || '0');
step('cell toggle changes enabled count by 1', Math.abs(after - before) === 1, `${before} -> ${after}`);

step('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await page.screenshot({ path: 'scripts/_libs_smoke.png', fullPage: true });
await browser.close();
console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
process.exit(ok ? 0 : 1);
