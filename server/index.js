// ProofGraph backend: serves the existing dashboard, the JSON API, and test artifacts (screenshots).
const http = require('http');
const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const prooffix = require('./prooffix');
const llm = require('./llm');
const { ARTIFACTS } = require('./runner');

const PORT = +process.env.PORT || 4000;
const SAMPLE_URL = process.env.SAMPLE_APP_URL || 'http://localhost:4100';
const DASHBOARD = path.join(__dirname, '..', 'QA AUTOPILOT.html');

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); } });
});

const runSummary = (r) => { const p = engine.publicRun(r); return { id: p.id, appName: p.appName, url: p.url, mode: p.mode, status: p.status, createdAt: p.createdAt, finishedAt: p.finishedAt, counts: p.counts, total: p.tests.length, bugIds: p.bugIds, error: p.error }; };
const bugSummary = ({ evidence, logs, observations, testDef, analysis, ...b }) => ({ ...b, analyzed: !!analysis });

const routes = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true, sampleAppUrl: SAMPLE_URL, ai: llm.status(), sourceDir: prooffix.SOURCE_DIR, runs: engine.db.runs.length, bugs: engine.db.bugs.length })],
  ['GET', /^\/api\/runs$/, async () => engine.db.runs.map(runSummary)],
  ['POST', /^\/api\/runs$/, async (req) => engine.publicRun(engine.startRun(await readBody(req)))],
  ['GET', /^\/api\/runs\/([\w-]+)$/, async (req, m) => {
    const r = engine.db.runs.find((x) => x.id === m[1]);
    if (!r) throw Object.assign(new Error('Run not found'), { status: 404 });
    return engine.publicRun(r);
  }],
  ['POST', /^\/api\/runs\/([\w-]+)\/next$/, async (req, m) => engine.nextTest(m[1])],
  ['GET', /^\/api\/bugs$/, async () => engine.db.bugs.map(bugSummary)],
  ['GET', /^\/api\/bugs\/([\w-]+)$/, async (req, m) => {
    const b = engine.db.bugs.find((x) => x.id === m[1]);
    if (!b) throw Object.assign(new Error('Bug not found'), { status: 404 });
    return b;
  }],
  ['PATCH', /^\/api\/bugs\/([\w-]+)$/, async (req, m) => {
    const b = engine.db.bugs.find((x) => x.id === m[1]);
    if (!b) throw Object.assign(new Error('Bug not found'), { status: 404 });
    const body = await readBody(req);
    if (['open', 'investigating', 'verified', 'review'].includes(body.status)) b.status = body.status;
    engine.save();
    return bugSummary(b);
  }],
  ['POST', /^\/api\/bugs\/([\w-]+)\/analyze$/, async (req, m) => {
    const b = engine.db.bugs.find((x) => x.id === m[1]);
    if (!b) throw Object.assign(new Error('Bug not found'), { status: 404 });
    b.analysis = await prooffix.analyze(b);
    if (b.status === 'open') b.status = 'investigating';
    engine.save();
    return b.analysis;
  }],
  ['GET', /^\/api\/regression$/, async () => engine.db.regression],
  ['POST', /^\/api\/regression$/, async (req) => { const body = await readBody(req); return engine.publicRun(await engine.runRegression(body.url)); }],
];

http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (url === '/' || url === '/index.html') return send(res, 200, fs.readFileSync(DASHBOARD), 'text/html; charset=utf-8');
    if (url.startsWith('/artifacts/')) {
      const file = path.join(ARTIFACTS, url.slice('/artifacts/'.length));
      if (!file.startsWith(ARTIFACTS) || !/\.png$/.test(file) || !fs.existsSync(file)) return send(res, 404, { error: 'Artifact not found' });
      return send(res, 200, fs.readFileSync(file), 'image/png');
    }
    for (const [method, re, fn] of routes) {
      const m = url.match(re);
      if (m && req.method === method) return send(res, 200, await fn(req, m));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`[proofgraph] dashboard + API on http://localhost:${PORT}  (AI: ${llm.status().configured ? llm.status().model : 'demo-mode fallback, no API key'})`));
