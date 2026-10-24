// Paradox QA engine: run orchestration, adaptive follow-up selection, bug creation, regression suite.
const fs = require('fs');
const path = require('path');
const { launch, runTest, ARTIFACTS } = require('./runner');
const T = require('./tests');
const llm = require('./llm');

const STATE_FILE = path.join(ARTIFACTS, 'state.json');
const SEVERITY = { R1: 'critical', R2: 'critical', R3: 'high', R4: 'high', R5: 'medium' };

const db = { runs: [], bugs: [], regression: [], seq: { run: 0, bug: 100 } };
try { Object.assign(db, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
// Runs interrupted by a server restart can never finish.
db.runs.forEach((r) => { if (r.status === 'running') { r.status = 'error'; r.error = 'Interrupted by server restart'; } });

function save() {
  try { fs.mkdirSync(ARTIFACTS, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(db, null, 1)); } catch {}
}

const sig = (steps) => JSON.stringify(steps.map(({ expect, ...s }) => s));
const event = (run, text, kind = 'info', extra = {}) => { run.events.push({ at: new Date().toISOString(), kind, text, ...extra }); };
const reqText = (run, id) => run.requirements.find((r) => r.id === id)?.text || id;

function publicRun(r) {
  const counts = { passed: 0, failed: 0, blocked: 0, running: 0, pending: 0 };
  r.tests.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });
  return { ...r, counts, browserHandle: undefined };
}

function startRun(opts) {
  const url = String(opts.url || '').trim();
  if (!/^https?:\/\/.+/.test(url)) throw Object.assign(new Error('A valid http(s) URL is required'), { status: 400 });
  const maxTests = Math.max(1, Math.min(40, parseInt(opts.maxTests, 10) || 30));
  const mode = opts.mode || 'Standard Exploration';
  const run = {
    id: 'R-' + String(++db.seq.run).padStart(3, '0'),
    appName: String(opts.appName || 'app').slice(0, 60), url, browser: opts.browser || 'Chromium', mode, maxTests,
    budgetMin: Math.max(1, parseInt(opts.budgetMin, 10) || 5),
    requirements: T.resolveRequirements(opts.objectives),
    status: 'running', createdAt: new Date().toISOString(), finishedAt: null, error: null,
    tests: [], events: [], candidates: [], bugIds: [], browserLabel: null,
    maxRounds: mode === 'Adaptive Counterexample Discovery' ? 3 : 2,
  };
  db.runs.unshift(run);
  save();
  execute(run, opts).catch((e) => { run.status = 'error'; run.error = e.message; event(run, 'Run aborted: ' + e.message, 'error'); save(); });
  return run;
}

async function execute(run) {
  const deadline = Date.now() + run.budgetMin * 60000;
  event(run, `Run ${run.id} started against ${run.url}.`);
  const browser = await launch(run.browser);
  run.browserLabel = browser.__label;
  event(run, `Browser launched: ${browser.__label}.`);
  try {
    if (run.mode === 'Regression Testing') {
      await regressionInto(run, browser);
      return;
    }
    let plan = T.initialTests().map((t) => ({ ...t, round: 0, source: 'template' }));
    if (llm.status().configured && run.mode === 'Adaptive Counterexample Discovery') plan.push(...(await llmTests(run)));
    event(run, `Test plan generated: ${plan.length} tests across ${new Set(plan.map((t) => t.category)).size} categories.`);
    const seen = new Set(plan.map((t) => sig(t.steps)));
    let round = 0, fSeq = 0;
    while (plan.length) {
      const failed = [];
      for (const def of plan) {
        if (run.tests.length >= run.maxTests || Date.now() > deadline) {
          run.candidates.push(def);
          continue;
        }
        const t = await exec(run, browser, def);
        if (t.status === 'failed') failed.push(t);
        if (t.status === 'blocked' && run.tests.length === 1) {
          event(run, 'First test blocked — target app is unreachable or incompatible; stopping run.', 'error');
          plan = []; break;
        }
      }
      if (++round >= run.maxRounds) {
        // keep un-run follow-ups available for "Generate Next Test"
        for (const f of failed) for (const fu of followUps(f, seen)) run.candidates.push({ ...fu, id: 'F' + String(++fSeq).padStart(2, '0'), round });
        break;
      }
      plan = [];
      for (const f of failed) {
        for (const fu of followUps(f, seen)) {
          const def = { ...fu, id: 'F' + String(++fSeq).padStart(2, '0'), round };
          plan.push(def);
          event(run, `Selected follow-up ${def.id} "${def.name}" because ${f.id} failed (${f.violations[0].assertion}).`, 'adaptive', { testId: def.id, parent: f.id, why: def.why });
        }
      }
      if (plan.length) event(run, `Adaptive round ${round}: ${plan.length} follow-up tests selected from observed failures.`, 'adaptive');
    }
    run.candidates.forEach((c, i) => { if (!c.id) c.id = 'F' + String(++fSeq).padStart(2, '0') + '-' + i; });
  } finally {
    await browser.close().catch(() => {});
    if (run.status === 'running') run.status = 'completed';
    run.finishedAt = new Date().toISOString();
    const c = publicRun(run).counts;
    event(run, `Run ${run.id} ${run.status}: ${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked. ${run.bugIds.length} confirmed bug(s).`, 'done');
    save();
  }
}

function followUps(failed, seen) {
  const rules = (failed.round === 0 && T.FOLLOW_UP_RULES[failed.id]) || T.genericFollowUps(failed, failed);
  const out = [];
  for (const r of rules) {
    const s = sig(r.steps);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ ...r, parent: failed.id, source: failed.round === 0 && T.FOLLOW_UP_RULES[failed.id] ? 'adaptive-rule' : 'adaptive-mutation' });
  }
  return out;
}

// Executes one test definition, re-runs failures for reproducibility, and files bugs.
async function exec(run, browser, def) {
  const t = { ...def, status: 'running', requirementText: reqText(run, def.requirement), stepsText: def.steps.map(T.describeStep) };
  run.tests.push(t);
  save();
  const r = await runTest(browser, run.url, def, run.id);
  Object.assign(t, r);
  if (r.status === 'failed') {
    const again = await runTest(browser, run.url, def, run.id, { suffix: '-rerun' });
    const same = again.status === 'failed' && again.violations[0]?.assertion === r.violations[0].assertion;
    t.reproducibility = same ? 'Always (2/2)' : again.status === 'blocked' ? 'Unconfirmed (rerun blocked)' : 'Intermittent (1/2)';
    const v = r.violations[0];
    t.expected = v.expected; t.actual = v.actual;
    event(run, `${t.id} FAILED — ${v.assertion}. Expected ${v.expected}; actual ${v.actual}. Reproduced: ${t.reproducibility}.`, 'fail', { testId: t.id });
    if (def.minimizes) {
      const parent = run.tests.find((x) => x.id === def.minimizes);
      if (parent && parent.violations[0]?.req === v.req)
        event(run, `Shorter reproduction found for ${parent.id}: ${def.steps.length} steps instead of ${parent.steps.length}.`, 'adaptive', { testId: t.id });
    }
    fileBug(run, t);
  } else if (r.status === 'passed') {
    t.expected = 'All assertions hold'; t.actual = 'All assertions held';
    event(run, `${t.id} passed — ${t.name}.`, 'pass', { testId: t.id });
    if (def.minimizes) event(run, `Minimization: the dropped step is necessary to reproduce ${def.minimizes}.`, 'adaptive', { testId: t.id });
  } else {
    t.expected = 'Test executes'; t.actual = r.error;
    event(run, `${t.id} BLOCKED (execution error, not a defect): ${r.error}`, 'blocked', { testId: t.id });
  }
  save();
  return t;
}

function fileBug(run, t) {
  if (!/^Always/.test(t.reproducibility)) return; // only confirmed, reproducible violations become bug reports
  const v = t.violations[0];
  const key = t.bugKey || `${t.id}:${v.req}:${v.assertion}`;
  const steps = t.stepsText.slice(0, t.failedAtStep);
  const evidence = { testId: t.id, runId: run.id, screenshot: t.screenshot, steps, observations: t.observations, logs: t.logs, violations: t.violations, expected: v.expected, actual: v.actual };
  let bug = db.bugs.find((b) => b.key === key);
  if (bug) {
    bug.lastSeen = new Date().toISOString(); bug.lastRun = run.id;
    if (bug.status === 'verified') bug.status = 'open'; // regressed
    if (!bug.evidence.some((e) => e.runId === run.id && e.testId === t.id)) bug.evidence.push(evidence);
    if (steps.length < bug.steps.length) { bug.steps = steps; bug.testDef = pick(t); }
  } else {
    bug = {
      id: 'BUG-' + ++db.seq.bug, key, title: `${v.assertion} (${t.name.replace(/^[^:]+:\s*/, '')})`,
      severity: SEVERITY[v.req] || 'medium', runId: run.id, lastRun: run.id, status: 'open', reproducibility: t.reproducibility,
      found: new Date().toISOString().slice(0, 10), lastSeen: new Date().toISOString(),
      requirement: reqText(run, v.req), requirementId: v.req, assertion: v.assertion, expected: v.expected, actual: v.actual,
      steps, screenshot: t.screenshot, logs: t.logs, observations: t.observations, testId: t.id, category: t.category,
      url: run.url, testDef: pick(t), evidence: [evidence], analysis: null,
    };
    db.bugs.unshift(bug);
  }
  if (!run.bugIds.includes(bug.id)) run.bugIds.push(bug.id);
  event(run, `Bug report ${bug.id} ${bug.evidence.length > 1 ? 'updated' : 'created'}: ${bug.title}.`, 'bug', { bugId: bug.id });
}

const pick = (t) => ({ id: t.id, name: t.name, category: t.category, requirement: t.requirement, steps: t.steps, failedAtStep: t.failedAtStep });

// "Generate Next Test": run the next follow-up the observed results justify.
async function nextTest(runId) {
  const run = db.runs.find((r) => r.id === runId);
  if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
  if (run.status === 'running') throw Object.assign(new Error('Run still in progress'), { status: 409 });
  const seen = new Set(run.tests.map((t) => sig(t.steps)));
  let def = run.candidates.find((c) => !seen.has(sig(c.steps)));
  if (!def) {
    for (const f of run.tests.filter((t) => t.status === 'failed')) {
      const fu = T.genericFollowUps(f, f).find((x) => !seen.has(sig(x.steps)));
      if (fu) { def = { ...fu, parent: f.id, source: 'adaptive-mutation', id: 'N' + String(run.tests.length + 1).padStart(2, '0'), round: 9 }; break; }
    }
  }
  if (!def) return { run: publicRun(run), test: null, message: 'No further follow-up tests are justified by the observed results.' };
  run.candidates = run.candidates.filter((c) => c !== def);
  run.status = 'running';
  event(run, `Selected next test ${def.id} "${def.name}"${def.parent ? ` (follow-up of ${def.parent})` : ''}.`, 'adaptive', { testId: def.id, parent: def.parent, why: def.why });
  const browser = await launch(run.browser);
  try {
    const t = await exec(run, browser, def);
    if (t.status === 'failed') for (const fu of followUps(t, new Set([...seen, sig(def.steps)]))) run.candidates.push({ ...fu, id: def.id + '.' + (run.candidates.length + 1), round: (def.round || 0) + 1 });
    return { run: publicRun(run), test: t };
  } finally {
    await browser.close().catch(() => {});
    run.status = 'completed';
    save();
  }
}

// Regression suite: re-execute each bug's minimal reproduction.
async function regressionInto(run, browser) {
  for (const bug of db.bugs) {
    if (run.tests.length >= run.maxTests) break;
    const def = { ...bug.testDef, id: 'REG-' + bug.id.slice(4), name: 'Regression: ' + bug.title, source: 'regression', bugId: bug.id, round: 0 };
    const t = { ...def, status: 'running', requirementText: bug.requirement, stepsText: def.steps.map(T.describeStep) };
    run.tests.push(t);
    const r = await runTest(browser, run.url, def, run.id);
    Object.assign(t, r, r.status === 'failed' ? { expected: r.violations[0].expected, actual: r.violations[0].actual } : {});
    const reg = db.regression.find((x) => x.bugId === bug.id) || (db.regression.push({ bugId: bug.id, name: bug.title, executions: 0 }), db.regression[db.regression.length - 1]);
    Object.assign(reg, { lastRun: new Date().toISOString().slice(0, 10), status: r.status, executions: reg.executions + 1, runId: run.id, steps: t.stepsText, screenshot: r.screenshot, error: r.error, violations: r.violations });
    event(run, `${t.id} ${r.status.toUpperCase()} — ${bug.id} ${r.status === 'failed' ? 'still reproduces' : r.status === 'passed' ? 'no longer reproduces' : 'could not be checked'}.`, r.status === 'failed' ? 'fail' : r.status === 'passed' ? 'pass' : 'blocked');
    save();
  }
}

async function runRegression(url) {
  const target = url || db.bugs[0]?.url;
  if (!db.bugs.length) throw Object.assign(new Error('No bugs discovered yet — run Paradox QA first'), { status: 400 });
  const run = startRun({ url: target, appName: 'regression', mode: 'Regression Testing', maxTests: 40, budgetMin: 5 });
  return run;
}

async function llmTests(run) {
  try {
    const out = await llm.completeJSON(
      'You design adversarial QA tests for a shopping cart. Reply with JSON only.',
      `Requirements:\n${run.requirements.map((r) => `${r.id}: ${r.text}`).join('\n')}\n\nProducts: mug ($12), tee ($25), cap ($8.50). Coupons: SAVE10 (10%), SAVE50 (50%), FLAT20 ($20 fixed).\n` +
      `Allowed steps: {"do":"add","id"}, {"do":"qty","id","value"}, {"do":"remove","id"}, {"do":"coupon","code"}, {"do":"checkout"}. Optional per-step "expect": [{"kind":"couponRejected"|"discountUnchanged"|"qtyNotNegative"|"orderNotNegative","req":"R1".."R5","id"?}].\n` +
      `Propose up to 3 NEW tests (unusual action sequences / boundaries) not covered by: add items, SAVE10, FLAT20 on small cart, bogus code, empty code, qty up/down, SAVE50 twice, qty -1, FLAT20 then remove, qty 0.\n` +
      `Format: {"tests":[{"name","category":"normal|boundary|invalid|empty|repeated|sequence|state","requirement":"R1".."R5","steps":[...]}]}`,
      { maxTokens: 1500, timeoutMs: 45000 }
    );
    const tests = (out.tests || []).slice(0, 3).map(T.validateTest).filter(Boolean).map((t, i) => ({ ...t, id: 'L' + String(i + 1).padStart(2, '0'), round: 0, source: 'llm' }));
    event(run, `LLM proposed ${tests.length} additional validated test(s).`, 'info');
    return tests;
  } catch (e) {
    event(run, 'LLM test generation unavailable, using deterministic templates only: ' + e.message, 'info');
    return [];
  }
}

module.exports = { db, save, startRun, nextTest, runRegression, publicRun };
