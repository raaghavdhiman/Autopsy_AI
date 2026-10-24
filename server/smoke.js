// End-to-end smoke test: drives the dashboard UI itself (Start run → Paradox → Bug drawer → ProofFix).
// Requires `npm start` to be running.
const path = require('path');
const { launch } = require('./runner');

const DASH = process.env.DASHBOARD_URL || 'http://localhost:4000';
const OUT = path.join(__dirname, '..', 'artifacts', 'smoke');

(async () => {
  const browser = await launch('chromium');
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const step = (m) => console.log('•', m);
  try {
    await page.goto(DASH);
    await page.locator('.top .b.passed', { hasText: 'LIVE' }).waitFor({ timeout: 8000 });
    step('Dashboard loaded in LIVE mode');

    await page.locator('nav a', { hasText: 'Start Testing' }).click();
    await page.fill('#u', process.env.SAMPLE_APP_URL || 'http://localhost:4100');
    await page.fill('#ob', 'Discounts must remain within the permitted range.\nCheckout totals must never be negative.\nChanging cart contents must update the total correctly.');
    await page.click('#go');
    step('Clicked "Initialize QA Agent"');
    await page.locator('h1', { hasText: 'Paradox QA' }).waitFor({ timeout: 180000 });
    const cx = await page.locator('h2:has-text("Counterexample Results") + .grid > .pn').count();
    const shots = await page.locator('img[alt="Failure screenshot"]').count();
    const why = await page.locator('.tl .mu.sm', { hasText: 'Why:' }).count();
    step(`Paradox QA: ${cx} counterexamples, ${shots} screenshots, ${why} adaptive "Why" entries`);
    await page.screenshot({ path: path.join(OUT, '1-paradox.png'), fullPage: true });

    await page.click('button:has-text("Generate Next Test")');
    await page.locator('button:has-text("Generate Next Test"):not([disabled])').waitFor({ timeout: 60000 });
    step('Generate Next Test executed: ' + (await page.locator('.toast').last().textContent().catch(() => '(no toast)')));

    await page.locator('nav a', { hasText: 'Bug Reports' }).click();
    const bugs = await page.locator('tr.c').count();
    step(`Bug Reports: ${bugs} bugs`);
    await page.locator('tr.c').first().click();
    await page.locator('.dr img[alt="Failure screenshot"]').waitFor({ timeout: 8000 });
    step('Bug drawer shows a real screenshot');
    await page.screenshot({ path: path.join(OUT, '2-bug.png') });
    await page.click('.dr button:has-text("Investigate in ProofFix")');

    await page.locator('button:has-text("Analyze Bug")').click();
    await page.locator('h2', { hasText: 'Recommended Fix' }).waitFor({ timeout: 120000 });
    const alts = await page.locator('h2:has-text("Alternative Fixes") + .grid > .pn').count();
    const src = await page.locator('h2', { hasText: 'Relevant Source' }).count();
    const label = await page.locator('main .demo').first().textContent();
    step(`ProofFix: ${label}; primary fix + ${alts} alternatives; source panel: ${src ? 'yes' : 'no'}`);
    await page.screenshot({ path: path.join(OUT, '3-prooffix.png'), fullPage: true });

    await page.locator('nav a', { hasText: 'Regression Tests' }).click();
    await page.click('#rb');
    await page.locator('#rb:not([disabled])').waitFor({ timeout: 120000 });
    step('Regression: ' + (await page.locator('main .row b').first().textContent().catch(() => '?')));

    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    if (!cx || !shots || !why || !bugs || !src) throw new Error('Expected counterexamples, screenshots, adaptive reasons, bugs, and source-aware analysis');
    console.log('SMOKE PASSED — screenshots in', OUT);
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
    console.error('SMOKE FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
