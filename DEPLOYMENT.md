# Dynamic Hosting Setup (GitLab Pages + Resolver API)

This project is split into:

- Static frontend: GitLab Pages
- Dynamic backend API: Render (`backend/resolver_server.js`)

## 1) Deploy backend API on Render

Option A: Blueprint

1. In Render, create a **Blueprint** from this repo/branch.
2. Use [render.yaml](/Users/ksenia.zvereva/Documents/New%20project/render.yaml).
3. Deploy service `skinscan-resolver-api`.
4. Copy resulting API URL, e.g.:
   `https://skinscan-resolver-api.onrender.com`

Option B: Manual Web Service

- Runtime: Node
- Start command:
  `node backend/resolver_server.js`
- Health check path:
  `/healthz`
- Env:
  - `RESOLVER_HOST=0.0.0.0`

## 2) Configure GitLab Pages frontend

CI is defined in [.gitlab-ci.yml](/Users/ksenia.zvereva/Documents/New%20project/.gitlab-ci.yml) and builds from:

- [scripts/build_pages.sh](/Users/ksenia.zvereva/Documents/New%20project/scripts/build_pages.sh)
- source HTML:
  [forks/skinscan_current_working.html](/Users/ksenia.zvereva/Documents/New%20project/forks/skinscan_current_working.html)

Set GitLab CI/CD variable:

- Key: `RESOLVER_API_URL`
- Value: your Render URL, e.g. `https://skinscan-resolver-api.onrender.com`
- Scope: project (optionally protected/masked)

Push branch and run pipeline. Pages artifact publishes `public/index.html`.

## 3) Verify end-to-end

1. Open GitLab Pages URL
2. Search:
   - `estee lauder advanced night repair serum`
   - `dr althea 365`
3. Confirm API is used:
   - Devtools Network should show request to:
     `/resolver/products`
4. Check backend KPI endpoint:
   - `GET https://<resolver-host>/resolver/coverage-metrics`

## 4) Daily enrichment

For now, enrichment runs manually:

```bash
node backend/daily_enrichment.js
```

Later you can schedule this via Render Cron Job using same repository.
