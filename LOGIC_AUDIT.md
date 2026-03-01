# SkinScan Logic Audit and Reliability Recovery

Date: 2026-03-01

## 1. What the app currently does (simple flow)
1. User enters product name.
2. Frontend calls `POST /resolver/products`.
3. Resolver ranks candidates and returns one of:
   - `resolved_high`
   - `resolved_medium`
   - `candidate_list`
   - `not_found`
4. If selected product has ingredients, analysis runs immediately.
5. If ingredients are missing, backend runs async enrichment and frontend polls ingredient status.
6. Analysis computes category safety (acne, reactive, dry, allergens), score (0-5), verdict, and confidence.

## 2. Why failures happened
1. Catalog recall is still small, so unknown brands were pushed into low-quality fallback.
2. Unknown-brand decisioning could still return irrelevant seeded candidates.
3. Add-product panel interaction could collapse unexpectedly due outside-click behavior.
4. URL ingestion lacked strict reason taxonomy and user-facing retry state clarity.
5. URL ingestion safety needed stronger guardrails before scaling (SSRF-style protections).

## 3. Implemented in this recovery pass

### Backend
1. Added deterministic ingestion failure code mapping:
   - `invalid_url`, `blocked_host`, `fetch_timeout`, `parser_no_product`, `parser_no_brand`, `parser_no_name`, `low_similarity`, `upsert_failed`.
2. Wired guarded URL fetch into user URL ingestion path:
   - protocol checks, host safety checks, DNS/public checks, redirect cap, timeout budget, content-type and response-size limits.
3. Tightened unknown-brand candidate gate so weak matches return clean unknown-brand state instead of noisy cards.
4. Added ingestion attempt metadata:
   - `attemptCount`, `lastAttemptAt`, `failureCode` persisted in jobs.
5. Extended API contracts:
   - `POST /resolver/feedback/add-product` now returns `state='queued'` and `estimatedWaitMs`.
   - `GET /resolver/ingestion-status/:jobId` now returns `failureCode`, `failureStage`, `attemptCount`, `lastAttemptAt`.
6. Ensured `candidate_list` responses always carry a candidates array.

### Frontend
1. Fixed add-product panel collapse behavior:
   - outside-click ignores panel clicks, panel stops propagation, optional hide behavior.
2. Added deterministic add-product state machine:
   - `add_idle`, `add_submitting`, `add_queued`, `add_processing`, `add_completed`, `add_failed`.
3. Added clear user messages per ingestion failure code.
4. Kept add-product panel visible during queue/processing and polling cycle.
5. Tightened unknown-brand display behavior:
   - only high-similarity unknown-brand candidates are shown;
   - otherwise show clean “add product” CTA state.
6. Improved skin profile semantics without redesigning UI:
   - `normal` and `dry` are treated as exclusive primary options.
   - if neither selected, default to `normal`.
   - `acne-prone` and `sensitive` remain combinable conditions.

## 4. Current limitations (still true)
1. Catalog size/recall remains the structural bottleneck for long-tail products.
2. Ingestion quality depends on source page structure and access constraints.
3. File-based storage is fine for now, but not ideal for high write concurrency.

## 5. Recommended next execution slice
1. Run daily enrichment on miss queue + feedback queue and monitor `unknown_brand_rate` trend.
2. Add top retailer/brand parser adapters incrementally with strict validator gate.
3. Add canary benchmark gate in deploy pipeline (block if top1 brand match regresses).
4. Keep source names hidden in UX while improving recall in backend.

## 6. Success KPIs to track
1. `top1_brand_match_rate`
2. `unknown_brand_rate`
3. `candidate_list_rate`
4. `wrong_auto_selection_rate`
5. `add_product_success_rate`
6. `ingredients_available_in_session_rate`
