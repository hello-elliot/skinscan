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

## Daily Enrichment Job

```bash
node backend/daily_enrichment.js
```

This updates aliases, deduplicates index records, and promotes frequent misses.

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
    "ingredientsStatus": "missing"
  },
  "normalized_query": "estee lauder advanced night repair serum",
  "applied_corrections": []
}
```

### `POST /resolver/ingredients/enrich`

Input:

```json
{ "productId": "estee_lauder_anr_serum" }
```

### `GET /resolver/coverage-metrics`

Returns index stats, miss queue, and 24h resolver KPI snapshot.

## Data Files

- `backend/data/product_index.json` canonical product index
- `backend/data/coverage_miss_queue.json` miss-driven queue
- `backend/data/resolver_metrics.json` telemetry aggregate events
