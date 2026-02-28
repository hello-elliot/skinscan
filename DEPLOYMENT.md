# Dynamic Hosting Setup (Render only, auto-deploy from GitHub)

Use Render for both backend and frontend so you get one-time setup and automatic updates on every push.

## 1) Create services from Blueprint

1. In Render, click `New` -> `Blueprint`.
2. Connect repo: `hello-elliot/skinscan`.
3. Choose branch: `codex/coverage-reliability-backend` (or `main` after merge).
4. Render reads [render.yaml](/Users/ksenia.zvereva/Documents/New%20project/render.yaml) and creates:
   - `skinscan-resolver-api` (backend API)
   - `skinscan-frontend` (public static app)

## 2) Wire frontend to backend once

After first deploy:

1. Open backend service URL (example: `https://skinscan-3bgp.onrender.com`).
2. Open frontend service `Environment`.
3. Set `RESOLVER_API_URL` to backend URL.
4. Trigger manual redeploy for frontend once.

From then on, every GitHub push to the connected branch auto-deploys both services.

## 3) Public URLs

- Frontend (share this): `https://<frontend-service>.onrender.com`
- Backend API:
  - `GET /healthz`
  - `POST /resolver/products`
  - `GET /resolver/coverage-metrics`

## 4) Verify end-to-end

1. Open frontend URL.
2. Search:
   - `estee lauder advanced night repair serum`
   - `dr althea 365`
3. In browser Network tab, verify calls to:
   - `https://<backend>/resolver/products`

## 5) Daily enrichment (manual for now)

```bash
node backend/daily_enrichment.js
```
