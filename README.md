# ProofGraph (QA Autopilot)

Autonomous AI QA engineer: **Paradox QA** (adaptive, real-browser edge-case testing) + **ProofFix** (source-aware, recommendation-only fix suggestions).

## Run

```bash
npm install                      # installs playwright
npx playwright install chromium  # optional: falls back to installed Edge/Chrome if the download is blocked
npm start                        # sample shop on :4100 + dashboard/API on :4000
```

Open **http://localhost:4000** → Start Testing → *Initialize QA Agent*.

Optional live LLM (otherwise ProofFix uses clearly-labelled demo-mode recommendations):

```bash
ANTHROPIC_API_KEY=sk-... PROOFGRAPH_MODEL=claude-sonnet-5-5 npm start
```

End-to-end check (with `npm start` running): `npm run smoke` — drives the dashboard UI itself.

## Layout

| Path | Purpose |
|---|---|
| `QA AUTOPILOT.html` | Existing dashboard. Live mode activates when `/api/health` responds; otherwise the original offline demo runs. |
| `server/index.js` | HTTP API + serves dashboard and `/artifacts/*` screenshots |
| `server/engine.js` | Run orchestration, adaptive rounds, reproducibility re-runs, bug filing, regression suite |
| `server/tests.js` | Requirements, test DSL templates, oracle, adaptive follow-up rules, LLM test validation |
| `server/runner.js` | Playwright execution, assertions, screenshots (execution errors → `blocked`, never bugs) |
| `server/prooffix.js` | Reads source (read-only), diagnosis via LLM or deterministic fallback |
| `sample-app/` | Separate target shop with planted bugs |
| `artifacts/` | Screenshots + `state.json` (in-memory state snapshot) |

## Planted bugs in `sample-app/public/cart.js`

1. Percentage coupons can be applied repeatedly (duplicate check only in the fixed-coupon branch).
2. Fixed coupon amount is cached at apply time; shrinking the cart afterwards yields a negative total.
3. Negative quantities are accepted.

## API

`GET /api/health` · `GET|POST /api/runs` · `GET /api/runs/:id` · `POST /api/runs/:id/next` · `GET /api/bugs` · `GET|PATCH /api/bugs/:id` · `POST /api/bugs/:id/analyze` · `GET|POST /api/regression`
