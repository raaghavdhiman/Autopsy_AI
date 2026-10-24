// ProofFix: source-aware bug diagnosis and fix RECOMMENDATIONS. Read-only — never writes, patches, or commits.
const fs = require('fs');
const path = require('path');
const llm = require('./llm');

const SOURCE_DIR = path.resolve(process.env.PROOFGRAPH_SOURCE_DIR || path.join(__dirname, '..', 'sample-app', 'public'));

function loadSources() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); }
      else if (/\.(js|ts|jsx|tsx|html)$/.test(e.name) && fs.statSync(p).size < 60000) {
        files.push({ file: path.relative(path.join(SOURCE_DIR, '..'), p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') });
      }
    }
  };
  try { walk(SOURCE_DIR); } catch {}
  return files;
}

// Locate top-level `function name(...) { ... }` blocks with real line numbers.
function functions(files) {
  const out = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/^\s*(?:async\s+)?function\s+(\w+)\s*\(/);
      if (!m) return;
      let depth = 0, end = i, started = false;
      for (let k = i; k < lines.length; k++) {
        for (const ch of lines[k]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
        if (started && depth <= 0) { end = k; break; }
      }
      out.push({ file: f.file, name: m[1], start: i + 1, end: end + 1, code: lines.slice(i, end + 1).map((x, j) => `${String(i + 1 + j).padStart(3)}  ${x}`).join('\n') });
    });
  }
  return out;
}

// Observed facts come straight from execution evidence — no AI involved.
function facts(bug) {
  return [
    `Requirement violated: ${bug.requirement}`,
    `Failing assertion: ${bug.assertion}`,
    `Expected: ${bug.expected}`,
    `Actual: ${bug.actual}`,
    `Reproducibility: ${bug.reproducibility}`,
    ...bug.observations.map((o) => `After step ${o.step} (${o.action}): subtotal ${o.subtotal}, discount ${o.discount}, total ${o.total}${o.message ? `, message "${o.message}"` : ''}`),
  ];
}

// Deterministic demo-mode knowledge for the planted bug classes. Code locations are resolved from the real source.
const PLAYBOOK = {
  'percent-coupon-stacking': {
    fns: ['applyCoupon', 'discountAmount'],
    rootCause: 'applyCoupon() only checks state.coupons for duplicates inside the `coupon.type === "fixed"` branch, so percentage codes are pushed again on every apply. discountAmount() then sums every entry, letting SAVE50 + SAVE50 reach 100% (and beyond on a third apply).',
    evidence: ['Second SAVE50 changed the displayed discount instead of producing a rejection message.', 'Duplicate guard `state.coupons.includes(code)` appears only in the fixed-coupon branch.', 'discountAmount() accumulates `percent += c.value` per entry with no upper bound.'],
    altExplanations: ['The UI could be double-submitting the form (ruled out: each apply was a single click and the discount grew by exactly one coupon value).'],
    confidence: 0.85,
    uncertainty: 'Business may intentionally allow stacking *different* codes; the fix below only prevents re-applying the same code, plus a hard cap.',
    primary: { title: 'Reject duplicate codes for every coupon type', file: 'applyCoupon', complexity: 'Low', maintainability: 'High',
      approach: 'Move the `state.coupons.includes(code)` guard above the type-specific branch so it applies to all coupons.',
      why: 'The violation is caused by the missing duplicate check for percentage coupons; a single guard ahead of the branch removes the path that adds the same code twice.',
      snippet: `   const coupon = COUPONS[code];
   if (!coupon) { ... }
+  if (state.coupons.includes(code)) {
+    state.message = 'Coupon already applied.';
+    return false;
+  }
   if (coupon.type === 'fixed') {
-    if (state.coupons.includes(code)) {
-      state.message = 'Coupon already applied.';
-      return false;
-    }
     state.fixedDiscount = Math.min(coupon.value, subtotal());`,
      sideEffects: ['Stacking different percentage codes (SAVE10 + SAVE50) is still allowed — confirm this is intended.'],
      tests: ['SAVE50 applied twice → second apply rejected, discount stays 50%', 'SAVE50 ×3 → discount never exceeds 100%', 'FLAT20 twice still rejected (no regression)'] },
    alternatives: [
      { title: 'Clamp the computed discount in discountAmount()', file: 'discountAmount', how: 'Return `Math.min(subtotal, computed)` so the discount can never exceed 100% regardless of what is in state.coupons.',
        pros: ['Enforces R1/R2 for every current and future coupon path', 'One-line change'], cons: ['Still lets the same code be applied repeatedly (R4 still violated)', 'Masks the underlying state bug'],
        complexity: 'Low', maintainability: 'Medium', sideEffects: ['Customers could still see duplicated codes in state'], preferableWhen: 'As a defence-in-depth invariant alongside the primary fix, or as an emergency hotfix.',
        tests: ['Any coupon combination → discount ≤ subtotal', 'Total never negative'] },
      { title: 'Store coupons as a Set / single active coupon', file: 'applyCoupon', how: 'Replace the array with a Set keyed by code (or enforce one coupon per order), making duplicates structurally impossible.',
        pros: ['Removes the duplicate class of bug by construction'], cons: ['Touches every reader of state.coupons', 'Policy change if single-coupon is chosen'],
        complexity: 'Medium', maintainability: 'High', sideEffects: ['Serialization/order history code expecting an array must be updated'], preferableWhen: 'The coupon model is being extended (more codes, server sync).',
        tests: ['Table-driven tests over coupon combinations', 'Order total snapshot tests'] },
    ],
    rationale: 'The duplicate guard directly addresses the root cause with the smallest diff; clamping is recommended additionally as an invariant but alone leaves R4 violated.',
  },
  'stale-fixed-discount': {
    fns: ['applyCoupon', 'discountAmount'],
    rootCause: 'applyCoupon() stores `state.fixedDiscount = Math.min(coupon.value, subtotal())` once, at apply time. When the cart later shrinks, discountAmount() reuses the stale amount, so a $20 discount is subtracted from a $12 subtotal.',
    evidence: ['FLAT20 applied directly to a $12 cart is correctly capped (follow-up test), so the cap works at apply time.', 'After removing an item, discount stayed at $20.00 while subtotal dropped to $12.00.', 'discountAmount() adds `state.fixedDiscount` without recomputing against the current subtotal.'],
    altExplanations: ['The remove button could fail to re-render totals (ruled out: subtotal updated correctly; only the discount was stale).'],
    confidence: 0.9,
    uncertainty: 'Low — the defect reproduced through two different cart-shrinking paths (remove and quantity 0).',
    primary: { title: 'Recompute the fixed discount from current state', file: 'discountAmount', complexity: 'Low', maintainability: 'High',
      approach: 'Derive the fixed discount inside discountAmount() from state.coupons and cap the total discount at the current subtotal; stop caching it in applyCoupon().',
      why: 'Making the discount a pure function of the current cart removes the stale value that caused the negative total.',
      snippet: `function discountAmount() {
   const sub = subtotal();
-  let percent = 0;
+  let percent = 0, fixed = 0;
   for (const code of state.coupons) {
     const c = COUPONS[code];
     if (c.type === 'percent') percent += c.value;
+    else fixed += c.value;
   }
-  return round2((sub * percent) / 100 + state.fixedDiscount);
+  return round2(Math.min(sub, (sub * percent) / 100 + fixed));
}`,
      sideEffects: ['state.fixedDiscount becomes unused and should be removed from applyCoupon().'],
      tests: ['FLAT20 → remove larger item → total $0.00', 'FLAT20 → set quantity 0 → total $0.00', 'FLAT20 on $37 cart → $17.00 total (unchanged behaviour)'] },
    alternatives: [
      { title: 'Re-cap on every cart mutation', file: 'removeItem', how: 'Call a `recalcCoupons()` helper from addItem/setQuantity/removeItem that re-applies `Math.min(value, subtotal())`.',
        pros: ['Small, localized change'], cons: ['Every future mutation must remember to call the helper', 'Cached state can drift again'],
        complexity: 'Low', maintainability: 'Low', sideEffects: ['Missed call sites reintroduce the bug'], preferableWhen: 'Cached discount values are required elsewhere (e.g., analytics).',
        tests: ['Each mutation after a fixed coupon keeps total ≥ 0'] },
      { title: 'Guard the total and block checkout on invalid totals', file: 'total', how: 'Clamp `total()` at 0 and have checkout() refuse orders whose total is negative.',
        pros: ['Protects R2 against any pricing bug'], cons: ['Discount line still displays an incorrect value (R3)', 'Treats the symptom'],
        complexity: 'Low', maintainability: 'Medium', sideEffects: ['Customers may see discount > subtotal'], preferableWhen: 'As a last-line safety net in addition to the primary fix.',
        tests: ['checkout() with negative computed total is rejected'] },
    ],
    rationale: 'A derived (non-cached) discount fixes the root cause for all mutation paths; the alternatives either rely on discipline or only hide the symptom.',
  },
  'negative-quantity': {
    fns: ['setQuantity', 'checkout'],
    rootCause: 'setQuantity() only rejects NaN and treats 0 as removal; any negative integer from parseInt() is written to state.items, producing negative line totals and a negative subtotal.',
    evidence: ['Quantity field kept "-1" after blur and the line total became negative.', 'setQuantity() has checks for `isNaN(q)` and `q === 0` but no lower bound.', 'checkout() only verifies the cart is non-empty, so a negative-total order can be placed.'],
    altExplanations: ['The input lacks a `min="0"` attribute, but HTML constraints alone would not prevent programmatic negatives.'],
    confidence: 0.9,
    uncertainty: 'Unknown whether returns/credits are intended to use negative quantities (unlikely in this storefront).',
    primary: { title: 'Validate quantity in setQuantity()', file: 'setQuantity', complexity: 'Low', maintainability: 'High',
      approach: 'Reject any value that is not a non-negative integer, and show a validation message.',
      why: 'Stops the invalid state at its single entry point so subtotal and checkout can never see a negative quantity.',
      snippet: `function setQuantity(id, qty) {
   const q = parseInt(qty, 10);
-  if (isNaN(q)) return;
+  if (isNaN(q) || q < 0 || String(qty).trim() !== String(q)) {
+    state.message = 'Quantity must be a whole number of 0 or more.';
+    return;
+  }`,
      sideEffects: ['Inputs like "2.5" are now rejected instead of truncated to 2.'],
      tests: ['qty -1 → rejected, previous quantity kept', 'qty "abc" → rejected', 'qty 0 still removes the item'] },
    alternatives: [
      { title: 'Server/checkout-side invariant', file: 'checkout', how: 'In checkout(), refuse to create an order unless every quantity > 0 and total ≥ 0.',
        pros: ['Protects order creation from any client-side state corruption'], cons: ['Cart still displays negative values until checkout'],
        complexity: 'Low', maintainability: 'High', sideEffects: ['Users discover the problem late, at checkout'], preferableWhen: 'Orders are created by multiple clients or APIs.',
        tests: ['checkout() with negative quantity → no order created'] },
      { title: 'Constrain the input (min="0", step="1") plus clamping', file: 'render', how: 'Add HTML constraints in ui.js and clamp with Math.max(0, q).',
        pros: ['Better UX: browser prevents typing invalid values'], cons: ['Silent clamping can surprise users; HTML constraints are bypassable'],
        complexity: 'Low', maintainability: 'Medium', sideEffects: ['-1 silently becomes 0 and removes the item'], preferableWhen: 'Combined with the primary fix for UX polish.',
        tests: ['Typing -1 is prevented or clamped', 'Keyboard arrows cannot go below 0'] },
    ],
    rationale: 'Validating at the single mutation point fixes the cause; the checkout invariant is a valuable second layer.',
  },
};

function resolveFn(fns, name) {
  return fns.find((f) => f.name === name) || null;
}

function relevantFunctions(bug, fns) {
  const text = (bug.title + ' ' + bug.steps.join(' ') + ' ' + bug.assertion).toLowerCase();
  const kw = { coupon: ['applycoupon', 'discountamount'], discount: ['discountamount'], quantity: ['setquantity'], remove: ['removeitem', 'subtotal'], total: ['total', 'subtotal'], order: ['checkout'] };
  const want = new Set(Object.entries(kw).filter(([k]) => text.includes(k)).flatMap(([, v]) => v));
  return fns.filter((f) => want.has(f.name.toLowerCase()));
}

function fallbackAnalysis(bug, files, fns) {
  const pb = PLAYBOOK[bug.key];
  if (!pb) {
    const rel = relevantFunctions(bug, fns).slice(0, 4);
    return {
      rootCause: { summary: 'No demo-mode diagnosis exists for this failure class. Relevant code regions were located by keyword but no specific root cause is claimed.', location: rel[0] ? `${rel[0].file}:${rel[0].start} ${rel[0].name}()` : null, evidence: rel.map((f) => `Candidate: ${f.name}() in ${f.file}:${f.start}-${f.end}`), alternatives: [], confidence: 0.2, uncertainty: 'High — configure ANTHROPIC_API_KEY for a model-generated diagnosis.' },
      primary: { title: 'Add an invariant check for the violated requirement', approach: `Enforce "${bug.requirement}" at the point where the value is computed.`, why: 'Generic guidance only.', location: null, snippet: '', sideEffects: [], tests: [bug.steps.join(' → ')] },
      alternatives: [], ranking: 'Insufficient information to rank alternatives.', code: rel,
    };
  }
  const loc = (name) => { const f = resolveFn(fns, name); return f ? `${f.file}:${f.start}-${f.end} ${f.name}()` : `${name}() (not found in source)`; };
  const code = pb.fns.map((n) => resolveFn(fns, n)).filter(Boolean);
  return {
    rootCause: { summary: pb.rootCause, location: code[0] ? loc(code[0].name) : null, evidence: pb.evidence, alternatives: pb.altExplanations, confidence: pb.confidence, uncertainty: pb.uncertainty },
    primary: { ...pb.primary, location: loc(pb.primary.file) },
    alternatives: pb.alternatives.map((a) => ({ ...a, location: loc(a.file) })),
    ranking: pb.rationale, code,
  };
}

// Validate LLM output shape before it reaches the UI; drop references to files/functions that do not exist.
function validateLLM(o, files, fns) {
  const s = (x, d = '') => (typeof x === 'string' ? x : d);
  const arr = (x) => (Array.isArray(x) ? x.filter((y) => typeof y === 'string').slice(0, 8) : []);
  const checkLoc = (file, fn) => {
    const f = fns.find((x) => x.name === fn && (!file || x.file.endsWith(file) || file.endsWith(x.file)));
    if (f) return `${f.file}:${f.start}-${f.end} ${f.name}()`;
    if (file && files.some((x) => x.file.endsWith(file) || file.endsWith(x.file))) return `${file} (function not verified)`;
    return file || fn ? `UNVERIFIED reference: ${file || ''} ${fn || ''}`.trim() : null;
  };
  if (!o || typeof o !== 'object' || !o.rootCause || !o.primaryFix) throw new Error('LLM response missing rootCause/primaryFix');
  const rc = o.rootCause;
  const conf = Math.max(0, Math.min(1, Number(rc.confidence) || 0));
  const alt = (Array.isArray(o.alternatives) ? o.alternatives : []).slice(0, 2).map((a) => ({
    title: s(a.title, 'Alternative'), how: s(a.how), pros: arr(a.pros), cons: arr(a.cons), complexity: s(a.complexity, '—'), maintainability: s(a.maintainability, '—'),
    sideEffects: arr(a.sideEffects), preferableWhen: s(a.preferableWhen), tests: arr(a.tests), location: checkLoc(a.file, a.function),
  }));
  const p = o.primaryFix;
  const relCode = [rc.function, p.function, ...alt.map(() => null)].map((n) => n && fns.find((f) => f.name === n)).filter(Boolean);
  return {
    rootCause: { summary: s(rc.summary), location: checkLoc(rc.file, rc.function), evidence: arr(rc.evidence), alternatives: arr(rc.alternativeExplanations), confidence: conf, uncertainty: s(rc.uncertainty) },
    primary: { title: s(p.title, 'Primary fix'), approach: s(p.approach), complexity: s(p.complexity, '—'), maintainability: s(p.maintainability, '—'), why: s(p.why), location: checkLoc(p.file, p.function), snippet: s(p.snippet).slice(0, 4000), sideEffects: arr(p.sideEffects), tests: arr(p.tests) },
    alternatives: alt, ranking: s(o.ranking), code: [...new Set(relCode)],
  };
}

async function analyze(bug) {
  const files = loadSources();
  const fns = functions(files);
  const base = { bugId: bug.id, generatedAt: new Date().toISOString(), facts: facts(bug), sourceFiles: files.map((f) => f.file), sourceDir: SOURCE_DIR,
    disclaimer: 'Recommendation only. ProofFix has not modified, applied, or tested any of these changes. Verify before merging.' };
  if (llm.status().configured) {
    try {
      const numbered = files.map((f) => `=== ${f.file} ===\n` + f.text.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')).join('\n\n');
      const out = await llm.completeJSON(
        'You are ProofFix, a senior engineer diagnosing a confirmed bug. Use ONLY the provided source and evidence. Never invent files or functions. Distinguish evidence from hypotheses. Reply with a single JSON object, no prose.',
        `BUG (observed facts from real browser execution):\n${JSON.stringify({ title: bug.title, requirement: bug.requirement, assertion: bug.assertion, expected: bug.expected, actual: bug.actual, steps: bug.steps, observations: bug.observations, consoleLogs: bug.logs.slice(0, 20) }, null, 1)}\n\nSOURCE:\n${numbered}\n\n` +
        `Return JSON: {"rootCause":{"summary","file","function","evidence":[str],"alternativeExplanations":[str],"confidence":0..1,"uncertainty"},` +
        `"primaryFix":{"title","approach","why","complexity","maintainability","file","function","snippet":"unified-diff style","sideEffects":[str],"tests":[str]},` +
        `"alternatives":[{"title","how","pros":[str],"cons":[str],"complexity","maintainability","sideEffects":[str],"preferableWhen","tests":[str],"file","function"}] (0-2, only meaningfully different),"ranking":"why the primary is recommended"}`,
        { maxTokens: 4000 }
      );
      return { ...base, mode: 'llm', model: llm.status().model, ...validateLLM(out, files, fns) };
    } catch (e) {
      return { ...base, mode: 'demo-fallback', llmError: e.message, ...fallbackAnalysis(bug, files, fns) };
    }
  }
  return { ...base, mode: 'demo-fallback', ...fallbackAnalysis(bug, files, fns) };
}

module.exports = { analyze, SOURCE_DIR };
