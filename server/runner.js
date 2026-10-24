// Real browser execution of DSL tests with Playwright. Infrastructure problems => "blocked", never "failed".
const path = require('path');
const fs = require('fs');
const pw = require('playwright');
const { describeStep, oracle } = require('./tests');

const ARTIFACTS = path.join(__dirname, '..', 'artifacts');
const STEP_TIMEOUT = 4000;
const SEVERITY_ORDER = ['R2', 'R1', 'R4', 'R5', 'R3'];
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);

// Prefer Playwright's bundled browser; for Chromium fall back to locally installed Edge/Chrome channels.
async function launch(browserName = 'chromium') {
  const name = String(browserName).toLowerCase();
  const type = { chromium: pw.chromium, firefox: pw.firefox, webkit: pw.webkit }[name] || pw.chromium;
  const attempts = type === pw.chromium ? [{}, { channel: 'msedge' }, { channel: 'chrome' }] : [{}];
  let last;
  for (const extra of attempts) {
    try {
      const browser = await type.launch({ headless: true, ...extra });
      browser.__label = `${type.name()}${extra.channel ? ` (${extra.channel})` : ''} ${browser.version()}`;
      return browser;
    } catch (e) { last = e; }
  }
  throw new Error(`Could not launch ${name}: ${last.message.split('\n')[0]}. Run "npx playwright install ${name}".`);
}

const num = (s) => {
  if (s == null) return NaN;
  const t = String(s).replace(/[^0-9.\-]/g, '');
  return t ? parseFloat(t) : NaN;
};

async function snapshot(page) {
  return page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    const lines = [...document.querySelectorAll('[data-testid^="line-"]')].map((el) => ({
      id: el.dataset.testid.slice(5),
      price: parseFloat(el.dataset.price),
      qty: el.querySelector('input')?.value ?? null,
    }));
    return { subtotal: txt('[data-testid="subtotal"]'), discount: txt('[data-testid="discount"]'), total: txt('[data-testid="total"]'),
      message: txt('[data-testid="message"]'), orderTotal: txt('[data-testid="order-total"]'), lines };
  }).then((s) => ({ ...s, n: { subtotal: num(s.subtotal), discount: num(s.discount), total: num(s.total), orderTotal: s.orderTotal ? num(s.orderTotal) : null } }));
}

async function perform(page, step) {
  const t = { timeout: STEP_TIMEOUT };
  const byId = (id) => page.getByTestId(id);
  switch (step.do) {
    case 'add': return byId(`add-${step.id}`).click(t);
    case 'remove': return byId(`remove-${step.id}`).click(t);
    case 'qty': {
      const box = byId(`qty-${step.id}`);
      await box.fill(String(step.value), t).catch(async (e) => {
        // number inputs refuse non-numeric text via fill(); type it like a user would instead
        if (!/Cannot type text into input\[type=number\]/.test(e.message)) throw e;
        await box.click(t); await page.keyboard.press('Control+A'); await page.keyboard.type(String(step.value));
      });
      return box.press('Tab', t); // blur => change event
    }
    case 'coupon': {
      await byId('coupon-input').fill(String(step.code ?? ''), t);
      return byId('apply-coupon').click(t);
    }
    case 'checkout': return byId('checkout').click(t);
    default: throw new Error('Unsupported action ' + step.do);
  }
}

function check(step, before, after, expected) {
  const v = [];
  const a = after.n;
  for (const e of step.expect || []) {
    if (e.kind === 'couponRejected') {
      const rejected = /invalid|enter|already|not/i.test(after.message || '') && a.discount === before.n.discount;
      if (!rejected) v.push({ req: e.req, assertion: 'Coupon must be rejected', expected: 'Rejection message, discount unchanged', actual: `Message "${after.message}", discount ${after.discount}` });
    }
    if (e.kind === 'discountUnchanged' && a.discount !== before.n.discount)
      v.push({ req: e.req, assertion: 'Re-applying a coupon must not change the discount', expected: `Discount stays ${before.discount}`, actual: `Discount changed to ${after.discount}` });
    if (e.kind === 'qtyNotNegative') {
      const line = after.lines.find((l) => l.id === e.id);
      if (line && !(parseInt(line.qty, 10) >= 0))
        v.push({ req: e.req, assertion: 'Quantity must be rejected unless it is a non-negative integer', expected: 'Quantity ≥ 0 (invalid value rejected)', actual: `Quantity accepted as "${line.qty}"` });
    }
    if (e.kind === 'orderNotNegative' && a.orderTotal != null && a.orderTotal < 0)
      v.push({ req: e.req, assertion: 'An order must never be placed with a negative charge', expected: 'Checkout blocked or charge ≥ $0.00', actual: `Order placed, charged ${after.orderTotal}` });
  }
  if (a.subtotal >= 0 && (a.discount < 0 || a.discount > a.subtotal + 0.005))
    v.push({ req: 'R1', assertion: 'Discount must be between 0% and 100% of subtotal', expected: `Discount ≤ ${after.subtotal} (100%)`, actual: `Discount ${after.discount} (${a.subtotal ? Math.round((a.discount / a.subtotal) * 100) : '∞'}% of subtotal)` });
  if (a.total < 0)
    v.push({ req: 'R2', assertion: 'Total must never be negative', expected: 'Total ≥ $0.00', actual: `Total ${after.total}` });
  const lineSum = after.lines.reduce((s, l) => s + l.price * (parseInt(l.qty, 10) || 0), 0);
  if (Math.abs(lineSum - a.subtotal) > 0.005)
    v.push({ req: 'R3', assertion: 'Subtotal must equal the sum of cart lines', expected: `Subtotal ${money(lineSum)}`, actual: `Subtotal ${after.subtotal}` });
  if (Math.abs(a.subtotal - a.discount - a.total) > 0.005)
    v.push({ req: 'R3', assertion: 'Total must equal subtotal − discount', expected: `Total ${money(a.subtotal - a.discount)}`, actual: `Total ${after.total}` });
  if (Math.abs(expected.total - a.total) > 0.005)
    v.push({ req: 'R3', assertion: 'Total must match the business rules for the current cart', expected: `Total ${money(expected.total)} (subtotal ${money(expected.subtotal)}, discount ${money(expected.discount)})`, actual: `Total ${after.total} (subtotal ${after.subtotal}, discount ${after.discount})` });
  return v;
}

// Runs one test in a fresh browser context (clean state). Returns a structured result.
async function runTest(browser, url, test, runId, opts = {}) {
  const started = Date.now();
  const logs = [];
  const res = { status: 'running', violations: [], observations: [], logs, screenshot: null, error: null };
  let ctx;
  try {
    ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await ctx.newPage();
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => logs.push(`[network] ${r.method()} ${r.url()} failed: ${r.failure()?.errorText}`));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.getByTestId('total').waitFor({ timeout: 6000 });
    } catch (e) {
      throw Object.assign(new Error('Target not reachable or no recognizable cart UI (missing [data-testid=total]): ' + e.message.split('\n')[0]), { infra: true });
    }
    const prices = await page.$$eval('[data-testid^="product-"]', (els) => Object.fromEntries(els.map((e) => [e.dataset.id, parseFloat(e.dataset.price)])));
    let before = await snapshot(page);
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i];
      try { await perform(page, step); }
      catch (e) { throw Object.assign(new Error(`Step ${i + 1} (${describeStep(step)}) could not be executed: ${e.message.split('\n')[0]}`), { infra: true }); }
      await page.waitForTimeout(60);
      const after = await snapshot(page);
      const expected = oracle(test.steps.slice(0, i + 1), prices);
      res.observations.push({ step: i + 1, action: describeStep(step), subtotal: after.subtotal, discount: after.discount, total: after.total, message: after.message, orderTotal: after.orderTotal });
      for (const x of check(step, before, after, expected))
        if (!res.violations.some((y) => y.assertion === x.assertion)) res.violations.push({ ...x, step: i + 1 });
      before = after;
    }
    // Primary violation: the test's target requirement first, then by severity, then earliest step.
    const rank = (v) => (v.req === test.requirement ? 0 : 1) * 10 + (SEVERITY_ORDER.indexOf(v.req) + 1);
    res.violations.sort((a, b) => rank(a) - rank(b) || a.step - b.step);
    if (res.violations.length) res.failedAtStep = res.violations[0].step;
    res.status = res.violations.length ? 'failed' : 'passed';
    if (res.status === 'failed' || opts.alwaysScreenshot) {
      const dir = path.join(ARTIFACTS, runId);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${test.id}${opts.suffix || ''}.png`;
      await page.screenshot({ path: path.join(dir, name), fullPage: true });
      res.screenshot = `/artifacts/${runId}/${name}`;
    }
  } catch (e) {
    res.status = 'blocked';
    res.error = e.message;
    res.violations = [];
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
  res.durationMs = Date.now() - started;
  return res;
}

module.exports = { launch, runTest, ARTIFACTS };
