#!/usr/bin/env sh
set -eu

BASE_URL="${1:-${RESOLVER_BASE_URL:-https://skinscan-resolver-api.onrender.com}}"

node - "$BASE_URL" <<'NODE'
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('Missing resolver base URL');
  process.exit(1);
}

const checks = [
  'estee lauder advanced night repair serum',
  'allies of skin molecular silk amino hydrating cleanser'
];

async function post(path, payload) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  return { status: res.status, json };
}

(async () => {
  const failures = [];
  for (const query of checks) {
    const { status, json } = await post('/resolver/products', { query, locale: 'en-US', region: 'US' });
    if (status !== 200) {
      failures.push({ query, reason: `http_${status}` });
      continue;
    }
    if (typeof json.decisionReason !== 'string' || !json.decisionReason.length) {
      failures.push({ query, reason: 'missing_decisionReason' });
    }
    if (typeof json.autoResolved !== 'boolean') {
      failures.push({ query, reason: 'missing_autoResolved' });
    }
    if (!json.state) {
      failures.push({ query, reason: 'missing_state' });
    }
  }

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, checked: checks.length, base }, null, 2));
})();
NODE
