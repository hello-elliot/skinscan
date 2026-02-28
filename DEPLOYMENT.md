# Simplest Deploy (Render Free)

This setup keeps quality/security and removes paid Blueprint dependency.

## 1) Backend (already done)

Backend URL: `https://skinscan-3bgp.onrender.com`

Health check:

`https://skinscan-3bgp.onrender.com/healthz`

## 2) Frontend (manual, one-time)

Create Render `Static Site`:

1. Repo: `hello-elliot/skinscan`
2. Branch: `codex/coverage-reliability-backend`
3. Build Command: `bash scripts/build_pages.sh`
4. Publish Directory: `public`

No env vars required. Build script already injects backend URL by default.

## 3) What you get

- Public app URL: `https://<your-static-site>.onrender.com`
- Auto-deploy on every push to branch
- Frontend calls backend API automatically

## 4) Quick validation

In app search:

- `estee lauder advanced night repair serum`
- `dr althea 365`
- `esta louder night repair`

In Network tab confirm calls to:

`https://skinscan-3bgp.onrender.com/resolver/products`

## 5) Post-deploy smoke check (required)

Run:

`bash scripts/smoke_resolver_contract.sh https://skinscan-3bgp.onrender.com`

Expected:
- `ok: true`
- no contract failures for `decisionReason` / `autoResolved`.
