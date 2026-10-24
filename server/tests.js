// Paradox QA test model: requirements, deterministic templates, oracle, and adaptive follow-up rules.
// Tests are data (a small step DSL) — never executable code — so LLM-proposed tests can be validated safely.

const DEFAULT_REQUIREMENTS = [
  { id: 'R1', text: 'Discounts must remain within the permitted range (0–100% of subtotal).', keys: ['discount', 'range', '100%'] },
  { id: 'R2', text: 'Checkout totals must never be negative.', keys: ['negative', 'never be negative', 'checkout total'] },
  { id: 'R3', text: 'Changing cart contents must update the total correctly.', keys: ['cart', 'update', 'correctly', 'contents'] },
  { id: 'R4', text: 'Each coupon code can be applied at most once per order.', keys: ['coupon', 'once', 'duplicate', 'twice'] },
  { id: 'R5', text: 'Invalid input (unknown coupons, empty codes, negative quantities) must be rejected.', keys: ['invalid', 'reject', 'empty', 'validate'] },
];

// Business-rule knowledge the oracle needs (what the shop *should* do).
const SPEC = {
  coupons: { SAVE10: { type: 'percent', value: 10 }, SAVE50: { type: 'percent', value: 50 }, FLAT20: { type: 'fixed', value: 20 } },
};

const ACTIONS = ['add', 'qty', 'remove', 'coupon', 'checkout'];
const EXPECT_KINDS = ['couponRejected', 'discountUnchanged', 'qtyNotNegative', 'orderNotNegative'];

// Map user-entered requirement lines onto the requirement ids the checks understand.
function resolveRequirements(text) {
  const lines = String(text || '').split(/\n+/).map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
  if (!lines.length) return DEFAULT_REQUIREMENTS.map(({ id, text }) => ({ id, text, source: 'default' }));
  const out = DEFAULT_REQUIREMENTS.map(({ id, text }) => ({ id, text, source: 'default' }));
  for (const line of lines) {
    const l = line.toLowerCase();
    let best = null, score = 0;
    for (const r of DEFAULT_REQUIREMENTS) {
      const s = r.keys.filter((k) => l.includes(k)).length;
      if (s > score) { best = r; score = s; }
    }
    if (best) {
      const o = out.find((x) => x.id === best.id);
      o.text = line; o.source = 'user';
    } else {
      out.push({ id: 'U' + (out.length + 1), text: line, source: 'user', unmapped: true });
    }
  }
  return out;
}

const T = (id, name, category, requirement, steps, extra = {}) => ({ id, name, category, requirement, steps, ...extra });

// Initial deterministic test plan (round 0).
function initialTests() {
  return [
    T('T01', 'Normal: add two different items', 'normal', 'R3', [{ do: 'add', id: 'mug' }, { do: 'add', id: 'tee' }]),
    T('T02', 'Normal: apply SAVE10 to a single item', 'normal', 'R1', [{ do: 'add', id: 'tee' }, { do: 'coupon', code: 'SAVE10' }]),
    T('T03', 'Boundary: FLAT20 on an $8.50 cart (coupon > subtotal)', 'boundary', 'R2', [{ do: 'add', id: 'cap' }, { do: 'coupon', code: 'FLAT20' }]),
    T('T04', 'Invalid: unknown coupon code "BOGUS99"', 'invalid', 'R5', [{ do: 'add', id: 'mug' }, { do: 'coupon', code: 'BOGUS99', expect: [{ kind: 'couponRejected', req: 'R5' }] }]),
    T('T05', 'Empty: apply an empty coupon code', 'empty', 'R5', [{ do: 'add', id: 'mug' }, { do: 'coupon', code: '', expect: [{ kind: 'couponRejected', req: 'R5' }] }]),
    T('T06', 'State: increase then decrease quantity', 'state', 'R3', [{ do: 'add', id: 'mug' }, { do: 'qty', id: 'mug', value: '3' }, { do: 'qty', id: 'mug', value: '1' }]),
    T('T07', 'Repeat: apply SAVE50 twice', 'repeated', 'R4', [{ do: 'add', id: 'tee' }, { do: 'coupon', code: 'SAVE50' }, { do: 'coupon', code: 'SAVE50', expect: [{ kind: 'discountUnchanged', req: 'R4' }] }], { bugKey: 'percent-coupon-stacking' }),
    T('T08', 'Invalid: set quantity to -1', 'invalid', 'R5', [{ do: 'add', id: 'mug' }, { do: 'qty', id: 'mug', value: '-1', expect: [{ kind: 'qtyNotNegative', id: 'mug', req: 'R5' }] }], { bugKey: 'negative-quantity' }),
    T('T09', 'Sequence: FLAT20 → remove the larger item', 'sequence', 'R2', [{ do: 'add', id: 'mug' }, { do: 'add', id: 'tee' }, { do: 'coupon', code: 'FLAT20' }, { do: 'remove', id: 'tee' }], { bugKey: 'stale-fixed-discount' }),
    T('T10', 'Boundary: set quantity to 0 removes the item', 'boundary', 'R3', [{ do: 'add', id: 'mug' }, { do: 'add', id: 'cap' }, { do: 'qty', id: 'mug', value: '0' }]),
  ];
}

// Domain-specific adaptive rules: keyed on the failing test, each with the reason it was selected.
const FOLLOW_UP_RULES = {
  T07: [
    { name: 'Repeat: apply SAVE50 three times', category: 'repeated', requirement: 'R1', bugKey: 'percent-coupon-stacking',
      steps: [{ do: 'add', id: 'tee' }, { do: 'coupon', code: 'SAVE50' }, { do: 'coupon', code: 'SAVE50' }, { do: 'coupon', code: 'SAVE50' }],
      why: 'The second SAVE50 increased the discount instead of being rejected. Escalating to a third application checks whether stacking is unbounded and can push the discount beyond 100%.' },
    { name: 'Repeat: apply FLAT20 twice', category: 'repeated', requirement: 'R4', bugKey: 'percent-coupon-stacking',
      steps: [{ do: 'add', id: 'tee' }, { do: 'coupon', code: 'FLAT20' }, { do: 'coupon', code: 'FLAT20', expect: [{ kind: 'discountUnchanged', req: 'R4' }] }],
      why: 'Duplicate-coupon guard failed for a percent coupon. Repeating a fixed coupon isolates whether the guard is missing for every coupon type or only for percentage coupons.' },
  ],
  T08: [
    { name: 'Sequence: quantity -1 → place order', category: 'sequence', requirement: 'R2', bugKey: 'negative-quantity',
      steps: [{ do: 'add', id: 'mug' }, { do: 'qty', id: 'mug', value: '-1' }, { do: 'checkout', expect: [{ kind: 'orderNotNegative', req: 'R2' }] }],
      why: 'A negative quantity was accepted. Checking whether the invalid cart state propagates into a placed order with a negative charge.' },
    { name: 'Invalid: quantity = "abc"', category: 'invalid', requirement: 'R5',
      steps: [{ do: 'add', id: 'mug' }, { do: 'qty', id: 'mug', value: 'abc', expect: [{ kind: 'qtyNotNegative', id: 'mug', req: 'R5' }] }],
      why: 'Quantity validation is incomplete. Probing a non-numeric value maps the extent of the validation gap.' },
  ],
  T09: [
    { name: 'Boundary: FLAT20 applied directly to a $12 cart', category: 'boundary', requirement: 'R2',
      steps: [{ do: 'add', id: 'mug' }, { do: 'coupon', code: 'FLAT20' }],
      why: 'Total went negative after removing an item post-coupon. Applying FLAT20 directly to the same reduced cart isolates whether the cap is wrong at apply time or only when the cart changes afterwards.' },
    { name: 'Sequence: FLAT20 → set larger item quantity to 0', category: 'state', requirement: 'R2', bugKey: 'stale-fixed-discount',
      steps: [{ do: 'add', id: 'mug' }, { do: 'add', id: 'tee' }, { do: 'coupon', code: 'FLAT20' }, { do: 'qty', id: 'tee', value: '0' }],
      why: 'Same state transition (cart shrinks after a fixed coupon) through a different path — quantity edit instead of remove — to confirm the defect is in recomputation, not the remove button.' },
  ],
};

// Generic mutation operators used when no domain rule applies (or for follow-ups of follow-ups).
function genericFollowUps(test, result) {
  const out = [];
  const req = result.violations[0]?.req;
  const hasCheckout = test.steps.some((s) => s.do === 'checkout');
  if (!hasCheckout && (req === 'R1' || req === 'R2' || req === 'R3' || req === 'R4')) {
    out.push({ name: test.name.replace(/^[^:]+:/, 'Sequence:') + ' → place order', category: 'sequence', requirement: 'R2', bugKey: test.bugKey,
      steps: [...test.steps.map(stripExpect), { do: 'checkout', expect: [{ kind: 'orderNotNegative', req: 'R2' }] }],
      why: `"${test.name}" violated ${req}. Appending checkout tests whether the invalid pricing state can be finalized into an order.` });
  }
  if (test.steps.length >= 3) {
    for (let i = 0; i < test.steps.length - 1; i++) {
      const steps = test.steps.filter((_, k) => k !== i).map(stripExpect);
      if (!steps.some((s) => s.do !== 'checkout')) continue;
      out.push({ name: `Minimize: ${test.id} without step ${i + 1}`, category: 'sequence', requirement: test.requirement, bugKey: test.bugKey, minimizes: test.id,
        steps, why: `Searching for a shorter reproduction of ${test.id}: dropping step ${i + 1} (${describeStep(test.steps[i])}) checks whether it is necessary for the failure.` });
      break; // one minimization attempt per failure keeps the budget bounded
    }
  }
  return out;
}

const stripExpect = ({ expect, ...s }) => s;

function describeStep(s) {
  switch (s.do) {
    case 'add': return `Add "${s.id}" to cart`;
    case 'qty': return `Set "${s.id}" quantity to ${JSON.stringify(s.value)}`;
    case 'remove': return `Remove "${s.id}" from cart`;
    case 'coupon': return s.code ? `Apply coupon ${s.code}` : 'Apply an empty coupon code';
    case 'checkout': return 'Click "Place order"';
    default: return s.do;
  }
}

// Reference model of *correct* behaviour, used to compute expected values.
function oracle(steps, prices) {
  const items = {}; const codes = []; let order = null;
  const sub = () => Object.entries(items).reduce((s, [id, q]) => s + (prices[id] || 0) * q, 0);
  const disc = () => {
    const s = sub(); let pct = 0, fixed = 0;
    for (const c of codes) { const k = SPEC.coupons[c]; if (k.type === 'percent') pct += k.value; else fixed += k.value; }
    return Math.min(s, Math.max(0, (s * pct) / 100 + fixed));
  };
  for (const st of steps) {
    if (st.do === 'add') items[st.id] = (items[st.id] || 0) + 1;
    else if (st.do === 'remove') delete items[st.id];
    else if (st.do === 'qty') { const q = parseInt(st.value, 10); if (q === 0) delete items[st.id]; else if (q > 0) items[st.id] = q; }
    else if (st.do === 'coupon') { const c = String(st.code || '').trim().toUpperCase(); if (SPEC.coupons[c] && !codes.includes(c)) codes.push(c); }
    else if (st.do === 'checkout') { if (Object.keys(items).length) order = { total: r2(sub() - disc()) }; }
  }
  return { subtotal: r2(sub()), discount: r2(disc()), total: r2(sub() - disc()), order };
}
const r2 = (n) => Math.round(n * 100) / 100;

// Validate a test proposed by an LLM (or anyone) before it can reach the browser.
function validateTest(t) {
  if (!t || typeof t.name !== 'string' || !Array.isArray(t.steps) || !t.steps.length || t.steps.length > 8) return null;
  const steps = [];
  for (const s of t.steps) {
    if (!s || !ACTIONS.includes(s.do)) return null;
    const clean = { do: s.do };
    if (['add', 'qty', 'remove'].includes(s.do)) { if (!/^[a-z0-9-]{1,20}$/.test(s.id || '')) return null; clean.id = s.id; }
    if (s.do === 'qty') clean.value = String(s.value ?? '').slice(0, 10);
    if (s.do === 'coupon') clean.code = String(s.code ?? '').slice(0, 20);
    if (Array.isArray(s.expect)) clean.expect = s.expect.filter((e) => e && EXPECT_KINDS.includes(e.kind)).map((e) => ({ kind: e.kind, req: String(e.req || 'R5'), ...(e.id ? { id: String(e.id) } : {}) }));
    steps.push(clean);
  }
  const cats = ['normal', 'boundary', 'invalid', 'empty', 'repeated', 'sequence', 'state'];
  return { name: t.name.slice(0, 80), category: cats.includes(t.category) ? t.category : 'sequence', requirement: /^R[1-5]$/.test(t.requirement) ? t.requirement : 'R3', steps };
}

module.exports = { DEFAULT_REQUIREMENTS, SPEC, ACTIONS, resolveRequirements, initialTests, FOLLOW_UP_RULES, genericFollowUps, describeStep, oracle, validateTest };
