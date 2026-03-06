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
- `AUTO_RESOLVE_ENABLED=true|false` (if `false`, only strict exact-high matches auto-resolve)
- `STRICT_BRAND_GATE_ENABLED=true|false` (if `true`, stricter brand-confidence gating before medium/high resolution)
- `INGESTION_POLL_INTERVAL_MS` (default `30000`; background cadence for queued add-product ingestion jobs)
- `FAST_SEARCH_BUDGET_MS` (default `1500`; timeout budget for `/resolver/products/fast`)

## Daily Enrichment Job

```bash
node backend/daily_enrichment.js
```

This updates aliases, deduplicates index records, and promotes frequent misses.
It also refreshes `product_catalog.json` and applies lightweight unknown-ingredient synonym promotion into `ingredient_knowledge.json`.
It now also consumes `candidate_feedback_queue.json` to:
- auto-promote high-confidence query->product mappings into aliases
- produce `promotion_report.json` and `review_queue.json`
- update `negative_alias_rules.json` for conflict suppression
- seed ingestion jobs from frequent misses/feedback into `add_product_queue.json`
- compact append-only queue/job files and append promotion snapshots to `promotion_report_history.json`

It also runs ingredient coverage flywheel tasks:
- CosIng canonical ingest (`backend/ingest_cosing.js`) when import file exists in `backend/data/import/`
- PubChem identifier/synonym enrichment (`backend/enrich_pubchem.js`)
- canonical synonym merge into `frontend_ingredient_overrides.json`

## Ingredient Ingestion Scripts

```bash
node backend/ingest_cosing.js
node backend/enrich_pubchem.js
```

Optional targeted enrichment:

```bash
node backend/enrich_pubchem.js --tokens "METHYL GLUCETH-20|SODIUM DNA" --max-items 50
```

CosIng import discovery:
- place latest export in `backend/data/import/`
- filename must include `cosing` and extension `.csv`, `.tsv`, or `.txt`

## API

### `POST /resolver/products/fast`

Fast typeahead endpoint for search suggestions only.
It does **not** start ingredient enrichment jobs and returns quickly with `latencyMs`.

Input:

```json
{ "query": "sunday riley vitamin c cream", "locale": "en-US", "region": "US" }
```

Output:

```json
{
  "state": "candidate_list",
  "decisionReason": "unknown_brand",
  "autoResolved": false,
  "candidates": [],
  "normalized_query": "sunday riley vitamin c cream",
  "latencyMs": 482
}
```

### `POST /resolver/products`

Input:

```json
{ "query": "estee lauder advanced night repair serum", "locale": "en-US", "region": "US" }
```

Output:

```json
{
  "state": "resolved_high",
  "decisionReason": "exact_high",
  "autoResolved": true,
  "product": {
    "productId": "estee_lauder_anr_serum",
    "brand": "Estee Lauder",
    "name": "Advanced Night Repair Synchronized Multi-Recovery Complex Serum",
    "brandMatched": true,
    "nameSimilarity": 0.98,
    "brandSimilarity": 1,
    "scoreGap": 0.19,
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

### `POST /resolver/feedback/candidate-selection`

Input:

```json
{
  "query": "allies of skin molecular silk amino hydrating cleanser",
  "normalizedQuery": "allies of skin molecular silk amino hydrating cleanser",
  "shownCandidateProductIds": ["product_a", "product_b"],
  "selectedProductId": "product_a",
  "selectionContext": "search",
  "analysisStarted": true,
  "analysisSucceeded": true
}
```

Stores supervised selection feedback used by daily alias-promotion jobs.

### `POST /resolver/feedback/add-product`

Input:

```json
{
  "query": "allies of skin molecular silk amino hydrating cleanser",
  "productUrl": "https://...",
  "ingredientsText": "optional comma-separated INCI list",
  "locale": "en-US",
  "region": "US"
}
```

Output:

```json
{ "accepted": true, "ingestionJobId": "ingest_xxx" }
```

Creates an async ingestion job that upserts a normalized catalog record and triggers ingredient retrieval when needed.

### `GET /resolver/ingestion-status/:jobId`

Returns:

```json
{
  "jobId": "ingest_xxx",
  "state": "queued|processing|completed|failed",
  "productId": "optional_product_id",
  "reason": "optional_failure_reason",
  "updatedAt": "2026-02-28T20:00:00.000Z"
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

Returns index stats, miss queue, contract smoke status, and 24h resolver KPI snapshot.
Also includes `coverage` summary:
- `unknownBrandRate`
- `top1BrandMatchRate`
- `catalogSize`
- `aliasPromotionCount`
If contract fields are missing (`decisionReason` / `autoResolved`), KPI output is blocked (`kpi: null`).

### `POST /resolver/ingredients/ingest-cosing`

Triggers canonical CosIng ingestion pipeline and returns ingestion summary.

### `POST /resolver/ingredients/enrich-pubchem`

Triggers PubChem enrichment. Optional body:

```json
{ "tokens": ["METHYL GLUCETH-20", "SODIUM DNA"], "maxItems": 80 }
```

### `GET /resolver/ingredients/coverage-metrics`

Returns ingredient-level coverage KPIs:
- `exactMatchRate`
- `synonymMatchRate`
- `familyMatchRate`
- `unknownRate`
- canonical/rated counts and latest ingestion report.

### `GET /resolver/smoke-check`

Returns resolver contract smoke-check status for key canary queries.

## Smoke Script

```bash
bash scripts/smoke_resolver_contract.sh https://skinscan-3bgp.onrender.com
```

Checks live deploy contract shape:
- `decisionReason` is present
- `autoResolved` is boolean
- `state` exists

## Data Files

- `backend/data/product_index.json` canonical product index
- `backend/data/product_catalog.json` searchable catalog with aliases/freshness
- `backend/data/brand_lexicon.json` daily-generated brand alias lexicon
- `backend/data/coverage_miss_queue.json` miss-driven queue
- `backend/data/candidate_feedback_queue.json` UI selection feedback queue
- `backend/data/negative_alias_rules.json` query/product suppression rules from conflicts
- `backend/data/promotion_report.json` daily auto-promotion output
- `backend/data/promotion_report_history.json` daily promotion audit history
- `backend/data/review_queue.json` daily high-conflict/low-confidence review items
- `backend/data/add_product_queue.json` append-only add-product ingestion queue
- `backend/data/ingestion_jobs.json` async ingestion status records
- `backend/data/resolver_metrics.json` telemetry aggregate events
- `backend/data/source_cache.json` file-backed source cache (24h TTL)
- `backend/data/canary_queries.json` canary search queries for regression checks
- `backend/data/unknown_ingredient_queue.json` backend unknown-ingredient queue
- `backend/data/ingredient_synonyms_learned.json` nightly review-driven synonym candidates
- `backend/data/ingredient_knowledge.json` canonical ingredient + synonym + family rules
- `backend/data/ingredient_proposals.json` proposal pipeline state
- `backend/data/frontend_ingredient_overrides.json` runtime UI ingredient override payload
- `backend/data/ingredient_canonical_index.json` CosIng-backed canonical ingredient index
- `backend/data/ingredient_ingestion_report.json` latest CosIng/PubChem ingestion summary
- `backend/data/product_source_profiles.json` curated PDP sources for top products
