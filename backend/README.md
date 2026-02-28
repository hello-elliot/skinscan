# SkinScan Resolver Backend

Lightweight backend index service for high-reliability product resolution.

## Run

```bash
node backend/resolver_server.js
```

Default bind:

- `HOST=127.0.0.1`
- `PORT=8788`

Override:

```bash
RESOLVER_HOST=0.0.0.0 RESOLVER_PORT=8788 node backend/resolver_server.js
```

Optional env:

- `AI_PROXY_URL` (default: `https://skinscan-proxy.kelly-f.workers.dev`)
- `AI_FALLBACK_ENABLED=true|false`

## Daily Enrichment Job

```bash
node backend/daily_enrichment.js
```

This updates aliases, deduplicates index records, and promotes frequent misses.
It also refreshes `product_catalog.json` and applies lightweight unknown-ingredient synonym promotion into `ingredient_knowledge.json`.

## API

### `POST /resolver/products`

Input:

```json
{ "query": "estee lauder advanced night repair serum", "locale": "en-US", "region": "US" }
```

Output:

```json
{
  "state": "resolved_high",
  "product": {
    "productId": "estee_lauder_anr_serum",
    "brand": "Estee Lauder",
    "name": "Advanced Night Repair Synchronized Multi-Recovery Complex Serum",
    "ingredientsStatus": "missing",
    "ingredientResolutionState": "resolving",
    "ingredientJobId": "estee_lauder_anr_serum"
  },
  "normalized_query": "estee lauder advanced night repair serum",
  "applied_corrections": []
}
```

When `ingredientsStatus` is missing, backend runs a hybrid enrichment:
- synchronous attempt up to 10s
- async continuation with status polling path

### `POST /resolver/enrich-ingredients`

Input:

```json
{ "productId": "estee_lauder_anr_serum", "query": "estee lauder advanced night repair serum", "forceRetry": false }
```

Legacy alias still supported: `POST /resolver/ingredients/enrich`.

You can also upsert already-resolved ingredients:

```json
{
  "productId": "estee_lauder_anr_serum",
  "ingredientsText": "Water, Bifida Ferment Lysate, ...",
  "ingredientsSource": "federated-web"
}
```

### `GET /resolver/products/:productId/ingredients-status`

Returns:

```json
{
  "productId": "estee_lauder_anr_serum",
  "state": "available | resolving_sync | resolving_async | unavailable_retryable | unavailable_final",
  "ingredientsStatus": "available",
  "ingredientsText": "Aqua, Bifida Ferment Lysate, ...",
  "updatedAt": "2026-02-28T16:00:00.000Z",
  "failureStage": "",
  "attemptCount": 1
}
```

### `POST /resolver/unknown-ingredients`

Input:

```json
{ "items": ["HYDROXYPROPYL TETRAHYDROPYRANTRIOL"], "source": "resolver" }
```

### `POST /resolver/unknown-ingredients/propose`

Input:

```json
{ "tokens": ["C12-20 ALKYL GLUCOSIDE"], "force": false }
```

Creates AI/heuristic ingredient proposals with constrained scoring schema.

### `POST /resolver/unknown-ingredients/apply`

Input:

```json
{ "tokenHash": "8480d801d8ccddc5", "action": "approve" }
```

Actions: `approve`, `reject`, `approve_provisional`.

### `GET /resolver/coverage-metrics`

Returns index stats, miss queue, and 24h resolver KPI snapshot.

## Data Files

- `backend/data/product_index.json` canonical product index
- `backend/data/product_catalog.json` searchable catalog with aliases/freshness
- `backend/data/coverage_miss_queue.json` miss-driven queue
- `backend/data/resolver_metrics.json` telemetry aggregate events
- `backend/data/source_cache.json` file-backed source cache (24h TTL)
- `backend/data/canary_queries.json` canary search queries for regression checks
- `backend/data/unknown_ingredient_queue.json` backend unknown-ingredient queue
- `backend/data/ingredient_synonyms_learned.json` nightly review-driven synonym candidates
- `backend/data/ingredient_knowledge.json` canonical ingredient + synonym + family rules
- `backend/data/ingredient_proposals.json` proposal pipeline state
- `backend/data/frontend_ingredient_overrides.json` runtime UI ingredient override payload
- `backend/data/product_source_profiles.json` curated PDP sources for top products
