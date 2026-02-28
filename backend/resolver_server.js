#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.RESOLVER_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.RESOLVER_PORT || 8788);

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'product_index.json');
const MISS_PATH = path.join(DATA_DIR, 'coverage_miss_queue.json');
const METRICS_PATH = path.join(DATA_DIR, 'resolver_metrics.json');
const SOURCE_CACHE_PATH = path.join(DATA_DIR, 'source_cache.json');
const UNKNOWN_QUEUE_PATH = path.join(DATA_DIR, 'unknown_ingredient_queue.json');
const SOURCE_PROFILE_PATH = path.join(DATA_DIR, 'product_source_profiles.json');

const SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 3000;
const SYNC_ENRICH_BUDGET_MS = 10000;
const ASYNC_POLL_BUDGET_MS = 8000;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 3;
const AI_PROXY_URL = process.env.AI_PROXY_URL || 'https://skinscan-proxy.kelly-f.workers.dev';
const AI_FALLBACK_ENABLED = String(process.env.AI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';

const ingredientJobs = new Map();
const activeIngredientResolves = new Map();
const sourceCircuit = {
  obf: { failures: 0, openUntil: 0 },
  retailer: { failures: 0, openUntil: 0 },
  brand: { failures: 0, openUntil: 0 },
  ai: { failures: 0, openUntil: 0 }
};

const KNOWN_CORRECTIONS = {
  'esta louder': 'estee lauder',
  'estee louder': 'estee lauder',
  'dr althia': 'dr althea',
  'dr. althia': 'dr althea',
  'advanced nite repair': 'advanced night repair',
  'anr estee': 'estee lauder anr'
};

const QUICK_ENRICH_CATALOG = [
  {
    product_id: 'estee_lauder_anr_serum',
    brand_canonical: 'Estee Lauder',
    name_canonical: 'Advanced Night Repair Synchronized Multi-Recovery Complex Serum',
    name_aliases: [
      'advanced night repair',
      'advanced night repair serum',
      'anr',
      'anr serum',
      'synchronized multi-recovery complex',
      'night repair serum',
      'advanced night repair synchronized multi-recovery complex serum'
    ],
    brand_aliases: ['estee lauder', 'estee', 'el'],
    line: 'Advanced Night Repair',
    category: 'Serum',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    ingredients_source: '',
    ingredients_last_verified_at: '',
    ingredients_version_hash: '',
    ingredients_confidence: 0,
    source_priority: 100,
    confidence_metadata: { quality: 'high', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.99 }
  },
  {
    product_id: 'dr_althea_345_relief_cream',
    brand_canonical: 'Dr. Althea',
    name_canonical: '345 Relief Cream',
    name_aliases: ['dr althea 345', '345 relief cream', '345 cream', 'dr althea relief cream'],
    brand_aliases: ['dr althea', 'dr. althea', 'althea'],
    line: '345',
    category: 'Cream',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    ingredients_source: '',
    ingredients_last_verified_at: '',
    ingredients_version_hash: '',
    ingredients_confidence: 0,
    source_priority: 95,
    confidence_metadata: { quality: 'high', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.92 }
  },
  {
    product_id: 'dr_althea_365_relief_essence',
    brand_canonical: 'Dr. Althea',
    name_canonical: '365 Relief Essence',
    name_aliases: ['dr althea 365', '365 relief essence', '365 essence', 'dr althea relief essence'],
    brand_aliases: ['dr althea', 'dr. althea', 'althea'],
    line: '365',
    category: 'Essence',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    ingredients_source: '',
    ingredients_last_verified_at: '',
    ingredients_version_hash: '',
    ingredients_confidence: 0,
    source_priority: 94,
    confidence_metadata: { quality: 'medium', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.85 }
  }
];

const sourceCache = readJson(SOURCE_CACHE_PATH, { items: {} });

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function pruneSourceCache() {
  const now = Date.now();
  let changed = false;
  Object.keys(sourceCache.items || {}).forEach(key => {
    if (!sourceCache.items[key] || sourceCache.items[key].expiresAt <= now) {
      delete sourceCache.items[key];
      changed = true;
    }
  });
  if (changed) writeJson(SOURCE_CACHE_PATH, sourceCache);
}

function getSourceCache(key) {
  const entry = sourceCache.items?.[key];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete sourceCache.items[key];
    writeJson(SOURCE_CACHE_PATH, sourceCache);
    return null;
  }
  return entry.payload;
}

function setSourceCache(key, payload, ttlMs = SOURCE_CACHE_TTL_MS) {
  sourceCache.items = sourceCache.items || {};
  sourceCache.items[key] = { payload, expiresAt: Date.now() + ttlMs, updatedAt: nowIso() };
  writeJson(SOURCE_CACHE_PATH, sourceCache);
}

function adapterOpen(name) {
  return Date.now() < (sourceCircuit[name]?.openUntil || 0);
}

function markAdapterSuccess(name) {
  if (!sourceCircuit[name]) return;
  sourceCircuit[name].failures = 0;
  sourceCircuit[name].openUntil = 0;
}

function markAdapterFailure(name) {
  if (!sourceCircuit[name]) return;
  sourceCircuit[name].failures += 1;
  if (sourceCircuit[name].failures >= CIRCUIT_FAIL_THRESHOLD) {
    sourceCircuit[name].openUntil = Date.now() + CIRCUIT_OPEN_MS;
    sourceCircuit[name].failures = 0;
  }
}

function applyCorrections(normalizedQuery) {
  let corrected = normalizedQuery;
  const applied = [];
  Object.entries(KNOWN_CORRECTIONS).forEach(([wrong, right]) => {
    if (corrected.includes(wrong)) {
      corrected = corrected.replace(wrong, right);
      applied.push({ from: wrong, to: right });
    }
  });
  return { corrected, applied };
}

function tokenize(s) {
  return normalizeText(s).split(' ').filter(Boolean);
}

function overlapScore(query, target) {
  const q = tokenize(query);
  const t = normalizeText(target);
  if (!q.length || !t) return 0;
  const hits = q.filter(w => t.includes(w)).length;
  return hits / q.length;
}

function listProductTexts(p) {
  return [
    p.brand_canonical,
    p.name_canonical,
    ...(p.brand_aliases || []),
    ...(p.name_aliases || []),
    p.line,
    p.category
  ].filter(Boolean);
}

function normalizeIngredientText(raw) {
  if (!raw) return '';
  const scrubbed = String(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/ingredients?\s*[:\-]/ig, ' ')
    .replace(/\(and\)/ig, ',')
    .replace(/[\n;|]/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = scrubbed
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.replace(/^[-.\s]+|[-.\s]+$/g, ''));
  return tokens.join(', ');
}

function ingredientTokens(text) {
  return normalizeIngredientText(text)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

function scoreIngredientCandidate(text) {
  const tokens = ingredientTokens(text);
  if (!tokens.length) return { valid: false, confidence: 0, reason: 'no_ingredient_block_found' };
  if (tokens.length < 10) return { valid: false, confidence: 0.2, reason: 'parser_rejected' };
  const alphaLike = tokens.filter(t => /[a-z]/i.test(t)).length;
  const alphaRatio = alphaLike / tokens.length;
  if (alphaRatio < 0.8) return { valid: false, confidence: 0.25, reason: 'parser_rejected' };
  const longTokenRatio = tokens.filter(t => t.length > 2 && t.length < 80).length / tokens.length;
  const confidence = Number(Math.min(0.99, (alphaRatio * 0.55) + (longTokenRatio * 0.35) + Math.min(tokens.length / 80, 0.1)).toFixed(3));
  if (confidence < 0.6) return { valid: false, confidence, reason: 'validation_failed' };
  return { valid: true, confidence, reason: '' };
}

function productHasIngredients(product) {
  return product && product.ingredients_status === 'available' && String(product.ingredients_text || '').trim().length > 20;
}

function inferResolutionState(productId, product) {
  if (productHasIngredients(product)) return 'available';
  const job = ingredientJobs.get(productId);
  if (job?.state === 'resolving_sync') return 'resolving_sync';
  if (job?.state === 'resolving_async') return 'resolving_async';
  if (!job) return 'unavailable_retryable';
  if (job.attempts >= 2 && job.lastError) return 'unavailable_final';
  return 'unavailable_retryable';
}

function scoreProduct(query, product) {
  const texts = listProductTexts(product);
  const best = texts.reduce((m, t) => Math.max(m, overlapScore(query, t)), 0);
  const brand = overlapScore(query, product.brand_canonical || '');
  const line = overlapScore(query, product.line || '');
  const availBoost = product.ingredients_status === 'available' ? 0.15 : 0;
  const recency = product.confidence_metadata?.freshness === 'daily' ? 0.04 : 0;
  const popularity = Number(product.confidence_metadata?.popularity || 0) * 0.06;
  const sourcePriority = Math.min((Number(product.source_priority || 50) / 100) * 0.06, 0.06);
  return Math.max(0, Math.min(1, (best * 0.62) + (brand * 0.14) + (line * 0.08) + availBoost + recency + popularity + sourcePriority));
}

function toResolvedProduct(product, score, confidence) {
  const resolutionState = inferResolutionState(product.product_id, product);
  const job = ingredientJobs.get(product.product_id);
  return {
    productId: product.product_id,
    brand: product.brand_canonical,
    name: product.name_canonical,
    line: product.line || '',
    category: product.category || '',
    imageUrl: product.image_url || '',
    ingredientsStatus: product.ingredients_status || 'missing',
    ingredientsText: product.ingredients_text || '',
    ingredientResolutionState: resolutionState,
    ingredientJobId: product.product_id,
    ingredientFailureStage: job?.lastError || '',
    confidence,
    needsConfirmation: confidence !== 'high',
    score: Number(score.toFixed(3))
  };
}

function classify(ranked) {
  if (!ranked.length) return { state: 'not_found' };
  const top = ranked[0];
  const second = ranked[1];
  const gap = second ? top.score - second.score : 1;
  if (second && top.ingredientsStatus !== 'available' && second.ingredientsStatus === 'available' && gap < 0.08) {
    return {
      state: 'candidate_list',
      candidates: ranked.slice(0, 7).map((c, i) => ({
        ...c,
        confidence: i === 0 ? 'medium' : 'low',
        needsConfirmation: true
      }))
    };
  }
  if (top.score >= 0.85 && gap >= 0.15) {
    return { state: 'resolved_high', product: { ...top, confidence: 'high', needsConfirmation: false } };
  }
  if (top.score >= 0.65) {
    return { state: 'resolved_medium', product: { ...top, confidence: 'medium', needsConfirmation: true } };
  }
  return {
    state: 'candidate_list',
    candidates: ranked.slice(0, 7).map((c, i) => ({
      ...c,
      confidence: i === 0 ? 'medium' : 'low',
      needsConfirmation: true
    }))
  };
}

function generateVariants(query) {
  const variants = new Set([query]);
  const q = normalizeText(query);
  variants.add(q.replace(/\bserum\b/g, '').trim());
  variants.add(q.replace(/\bcream\b/g, '').trim());
  variants.add(q.replace(/\bessence\b/g, '').trim());
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length > 2) variants.add(tokens.slice(0, 2).join(' '));
  if (tokens.length > 3) variants.add(tokens.slice(0, 3).join(' '));
  return [...variants].filter(Boolean);
}

function pushMetric(name, payload) {
  const metrics = readJson(METRICS_PATH, { events: [] });
  metrics.events.push({ name, payload, ts: nowIso() });
  if (metrics.events.length > 5000) metrics.events = metrics.events.slice(-5000);
  writeJson(METRICS_PATH, metrics);
}

function upsertMiss(rawQuery, normalizedQuery, failureStage, details) {
  const queue = readJson(MISS_PATH, { items: [] });
  const key = normalizeText(rawQuery);
  const now = nowIso();
  let item = queue.items.find(x => x.normalizedQuery === key && x.failureStage === failureStage);
  if (!item) {
    item = {
      queryHash: Buffer.from(key).toString('hex').slice(0, 16),
      rawQuery,
      normalizedQuery,
      failureStage,
      count: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      details: {}
    };
    queue.items.push(item);
  }
  item.count += 1;
  item.lastSeenAt = now;
  item.details = { ...item.details, ...details };
  writeJson(MISS_PATH, queue);
  return item;
}

function upsertUnknownIngredient(token, source = 'resolver') {
  const q = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const normalizedToken = normalizeText(token).toUpperCase();
  if (!normalizedToken) return null;
  const tokenHash = hashText(normalizedToken).slice(0, 16);
  const now = nowIso();
  let item = q.items.find(x => x.tokenHash === tokenHash);
  if (!item) {
    item = {
      normalizedToken,
      tokenHash,
      count: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      sources: {}
    };
    q.items.push(item);
  }
  item.count += 1;
  item.lastSeenAt = now;
  item.sources[source] = (item.sources[source] || 0) + 1;
  writeJson(UNKNOWN_QUEUE_PATH, q);
  return item;
}

function readIndex() {
  return readJson(INDEX_PATH, { version: 1, last_updated: nowIso(), products: [] });
}

function writeIndex(index) {
  index.last_updated = nowIso();
  writeJson(INDEX_PATH, index);
}

function ensureProductSchema(product) {
  return {
    ...product,
    ingredients_source: product.ingredients_source || '',
    ingredients_last_verified_at: product.ingredients_last_verified_at || '',
    ingredients_version_hash: product.ingredients_version_hash || '',
    ingredients_confidence: Number(product.ingredients_confidence || 0)
  };
}

function quickEnrich(normalizedQuery) {
  const index = readIndex();
  let changed = false;
  QUICK_ENRICH_CATALOG.forEach(seed => {
    const seedTexts = listProductTexts(seed).map(normalizeText);
    if (!seedTexts.some(t => t && (normalizedQuery.includes(t) || t.includes(normalizedQuery)))) return;
    if (!index.products.some(p => p.product_id === seed.product_id)) {
      index.products.push(seed);
      changed = true;
    }
  });
  if (changed) writeIndex(index);
  return changed;
}

function resolveAgainstIndex(query, region, locale) {
  const normalizedQuery = normalizeText(query);
  const { corrected, applied } = applyCorrections(normalizedQuery);
  const variants = generateVariants(corrected);
  const index = readIndex();

  let ranked = [];
  variants.forEach(v => {
    const scored = index.products
      .map(p => ({ product: ensureProductSchema(p), score: scoreProduct(v, p) }))
      .filter(s => s.score > 0.24)
      .map(s => toResolvedProduct(s.product, s.score, 'low'));
    ranked.push(...scored);
  });

  const dedup = new Map();
  ranked.forEach(r => {
    const prev = dedup.get(r.productId);
    if (!prev || prev.score < r.score) dedup.set(r.productId, r);
  });

  ranked = [...dedup.values()].sort((a, b) => b.score - a.score);
  const classified = classify(ranked);
  return {
    ...classified,
    normalized_query: corrected,
    applied_corrections: applied,
    region: region || '',
    locale: locale || ''
  };
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function bestScoredProduct(products, query) {
  if (!Array.isArray(products) || !products.length) return null;
  const scored = products
    .filter(p => p.product_name)
    .map(p => {
      const combined = `${p.brands || ''} ${p.product_name || ''}`;
      const score = overlapScore(query, combined);
      const hasIngredients = String(p.ingredients_text || '').trim().length > 30 ? 0.1 : 0;
      return { p, score: score + hasIngredients };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.p || null;
}

async function fetchIngredientsFromOBF(query) {
  const cacheKey = `obf:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const url = `https://world.openbeautyfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,brands,ingredients_text,image_small_url,categories,url`;
  const data = await fetchJsonWithTimeout(url, SOURCE_TIMEOUT_MS, { 'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)' });
  const best = bestScoredProduct(data.products || [], normalizeText(query));
  if (!best || !best.ingredients_text) return null;

  const normalized = normalizeIngredientText(best.ingredients_text);
  const quality = scoreIngredientCandidate(normalized);
  if (!quality.valid) throw new Error(quality.reason || 'parser_rejected');

  const payload = {
    source: 'obf',
    sourceUrl: best.url || '',
    ingredientsText: normalized,
    confidence: quality.confidence,
    imageUrl: best.image_small_url || '',
    category: String(best.categories || '').split(',')[0]?.trim() || ''
  };
  setSourceCache(cacheKey, payload);
  return payload;
}

function extractJsonLdIngredients(text) {
  const scripts = [...String(text || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const block of scripts) {
    try {
      const parsed = JSON.parse(block);
      const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed['@graph']) ? parsed['@graph'] : [])];
      for (const n of nodes) {
        const ing = n?.ingredients || n?.activeIngredients || n?.description;
        if (!ing) continue;
        const txt = Array.isArray(ing) ? ing.join(', ') : String(ing);
        const normalized = normalizeIngredientText(txt);
        const quality = scoreIngredientCandidate(normalized);
        if (quality.valid) return { ingredientsText: normalized, confidence: quality.confidence };
      }
    } catch (_) {}
  }
  return null;
}

function extractIngredientBlockFromHtml(text) {
  if (!text) return null;
  const jsonLd = extractJsonLdIngredients(text);
  if (jsonLd) return jsonLd;

  const patterns = [
    /ingredients?\s*[:\-]<\/[^>]+>\s*<[^>]+>([\s\S]{80,3200})<\/[^>]+>/i,
    /ingredients?\s*[:\-]\s*([\s\S]{80,3200})/i,
    /full\s+ingredients?\s*[:\-]\s*([\s\S]{80,3200})/i,
    /inci\s*[:\-]\s*([\s\S]{80,3200})/i
  ];

  for (const pattern of patterns) {
    const m = String(text).match(pattern);
    if (!m || !m[1]) continue;
    const cleaned = normalizeIngredientText(m[1].replace(/<[^>]+>/g, ' ').split('\n').slice(0, 8).join(', '));
    const quality = scoreIngredientCandidate(cleaned);
    if (quality.valid) return { ingredientsText: cleaned, confidence: quality.confidence };
  }

  return null;
}

function loadSourceProfiles() {
  return readJson(SOURCE_PROFILE_PATH, { products: {} });
}

async function fetchIngredientsFromProfileUrls(productId, kind) {
  const profiles = loadSourceProfiles();
  const urls = profiles?.products?.[productId]?.[kind] || [];
  if (!Array.isArray(urls) || !urls.length) return null;

  for (const url of urls) {
    const cacheKey = `${kind}:${normalizeText(productId)}:${hashText(url).slice(0, 8)}`;
    const cached = getSourceCache(cacheKey);
    if (cached) return cached;

    const text = await fetchTextWithTimeout(url, SOURCE_TIMEOUT_MS);
    const parsed = extractIngredientBlockFromHtml(text);
    if (!parsed) continue;

    const payload = {
      source: kind === 'retailer' ? 'retailer' : 'brand',
      sourceUrl: url,
      ingredientsText: parsed.ingredientsText,
      confidence: parsed.confidence,
      imageUrl: '',
      category: ''
    };
    setSourceCache(cacheKey, payload);
    return payload;
  }

  return null;
}

function parseAiResult(text) {
  const ingredientsMatch = String(text || '').match(/INGREDIENTS:\s*([\s\S]+)/i);
  if (!ingredientsMatch) return null;
  const ingredientsText = normalizeIngredientText(ingredientsMatch[1].split('\n')[0]);
  const quality = scoreIngredientCandidate(ingredientsText);
  if (!quality.valid) return null;
  return { ingredientsText, confidence: quality.confidence };
}

async function fetchIngredientsFromAIFallback(query) {
  if (!AI_FALLBACK_ENABLED) return null;
  const cacheKey = `ai:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS + 1000);
  try {
    const res = await fetch(`${AI_PROXY_URL.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: ['world.openbeautyfacts.org', 'sephora.com', 'ulta.com', 'esteelauder.com', 'dralthea.com', 'incidecoder.com']
        }],
        messages: [{ role: 'user', content: `Find the full INCI ingredients for: ${query}. Prefer official brand pages, major retailers, structured databases. Reply exactly:\nPRODUCT: ...\nBRAND: ...\nINGREDIENTS: comma-separated list.` }]
      })
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const parsed = parseAiResult(text);
    if (!parsed) return null;

    const payload = {
      source: 'ai_fallback',
      sourceUrl: '',
      ingredientsText: parsed.ingredientsText,
      confidence: parsed.confidence,
      imageUrl: '',
      category: ''
    };
    setSourceCache(cacheKey, payload, 6 * 60 * 60 * 1000);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function withJobState(productId, patch) {
  const prev = ingredientJobs.get(productId) || {
    productId,
    state: 'unavailable_retryable',
    startedAt: '',
    updatedAt: nowIso(),
    attempts: 0,
    lastError: '',
    attemptCount: 0,
    done: false
  };
  const next = { ...prev, ...patch, updatedAt: nowIso() };
  ingredientJobs.set(productId, next);
  return next;
}

async function tryAdapter(name, fn, context) {
  if (adapterOpen(name)) return { ok: false, failureStage: 'rate_limited' };
  const remaining = context.deadline - Date.now();
  if (remaining <= 120) return { ok: false, failureStage: 'source_timeout' };

  try {
    const result = await fn(Math.min(SOURCE_TIMEOUT_MS, remaining));
    if (!result) {
      markAdapterFailure(name);
      return { ok: false, failureStage: 'no_ingredient_block_found' };
    }
    const quality = scoreIngredientCandidate(result.ingredientsText || '');
    if (!quality.valid) {
      markAdapterFailure(name);
      return { ok: false, failureStage: quality.reason || 'validation_failed' };
    }
    markAdapterSuccess(name);
    return { ok: true, result: { ...result, confidence: Number(result.confidence || quality.confidence || 0) } };
  } catch (err) {
    markAdapterFailure(name);
    if (String(err?.name || '').toLowerCase().includes('abort')) return { ok: false, failureStage: 'source_timeout' };
    const message = String(err?.message || '');
    if (message.includes('parser_rejected')) return { ok: false, failureStage: 'parser_rejected' };
    if (message.includes('validation_failed')) return { ok: false, failureStage: 'validation_failed' };
    return { ok: false, failureStage: 'no_ingredient_block_found' };
  }
}

function buildAdapters(product, query) {
  const q = query || `${product.brand_canonical} ${product.name_canonical}`;
  return [
    { name: 'obf', exec: () => fetchIngredientsFromOBF(q) },
    { name: 'retailer', exec: () => fetchIngredientsFromProfileUrls(product.product_id, 'retailer') },
    { name: 'brand', exec: () => fetchIngredientsFromProfileUrls(product.product_id, 'brand') },
    { name: 'ai', exec: () => fetchIngredientsFromAIFallback(q) }
  ];
}

async function runIngredientResolutionJob(productId, query, locale, region, options = {}) {
  if (!options.forceRetry && activeIngredientResolves.has(productId)) {
    return activeIngredientResolves.get(productId);
  }

  const promise = (async () => {
    const startedAt = Date.now();
    const prevAttempts = ingredientJobs.get(productId)?.attemptCount || 0;
    withJobState(productId, {
      state: options.syncMode ? 'resolving_sync' : 'resolving_async',
      startedAt: nowIso(),
      attemptCount: prevAttempts + 1,
      attempts: prevAttempts + 1,
      done: false,
      lastError: ''
    });
    pushMetric('ingredient_resolve_started', { productId, query, mode: options.syncMode ? 'sync' : 'async' });

    const index = readIndex();
    const product = index.products.find(x => x.product_id === productId);
    if (!product) {
      withJobState(productId, { state: 'unavailable_final', lastError: 'no_ingredient_block_found', done: true });
      pushMetric('ingredient_resolve_failed', { productId, failure_stage: 'no_ingredient_block_found', mode: options.syncMode ? 'sync' : 'async' });
      return;
    }

    if (productHasIngredients(product)) {
      withJobState(productId, { state: 'available', done: true });
      return;
    }

    const context = { deadline: Date.now() + SYNC_ENRICH_BUDGET_MS };
    const adapters = buildAdapters(product, query);
    let finalFailureStage = 'no_ingredient_block_found';

    for (const adapter of adapters) {
      const attempt = await tryAdapter(adapter.name, adapter.exec, context);
      if (!attempt.ok) {
        finalFailureStage = attempt.failureStage;
        continue;
      }

      const normalizedIngredients = normalizeIngredientText(attempt.result.ingredientsText);
      const quality = scoreIngredientCandidate(normalizedIngredients);
      if (!quality.valid) {
        finalFailureStage = quality.reason || 'validation_failed';
        continue;
      }

      product.ingredients_text = normalizedIngredients;
      product.ingredients_status = 'available';
      product.ingredients_source = attempt.result.source;
      product.ingredients_last_verified_at = nowIso();
      product.ingredients_version_hash = hashText(normalizedIngredients);
      product.ingredients_confidence = attempt.result.confidence || quality.confidence;
      if (attempt.result.imageUrl && !product.image_url) product.image_url = attempt.result.imageUrl;
      if (attempt.result.category && !product.category) product.category = attempt.result.category;
      product.confidence_metadata = {
        ...(product.confidence_metadata || {}),
        freshness: 'daily',
        updated_at: nowIso()
      };
      writeIndex(index);

      withJobState(productId, { state: 'available', done: true, lastError: '' });
      pushMetric('ingredient_resolve_succeeded', {
        productId,
        source: attempt.result.source,
        duration_ms: Date.now() - startedAt,
        mode: options.syncMode ? 'sync' : 'async'
      });
      return;
    }

    const nextState = (ingredientJobs.get(productId)?.attemptCount || 0) >= 2 ? 'unavailable_final' : 'unavailable_retryable';
    withJobState(productId, { state: nextState, done: true, lastError: finalFailureStage });

    upsertMiss(query || `${product.brand_canonical} ${product.name_canonical}`, normalizeText(query || product.name_canonical || ''), finalFailureStage, {
      productId,
      locale: locale || '',
      region: region || ''
    });
    pushMetric('ingredient_resolve_failed', {
      productId,
      failure_stage: finalFailureStage,
      duration_ms: Date.now() - startedAt,
      mode: options.syncMode ? 'sync' : 'async'
    });
  })().finally(() => {
    activeIngredientResolves.delete(productId);
  });

  activeIngredientResolves.set(productId, promise);
  return promise;
}

async function scheduleIngredientResolution(productId, query, locale, region, options = {}) {
  const index = readIndex();
  const product = index.products.find(x => x.product_id === productId);
  if (!product) return { state: 'unavailable_final', jobId: productId, failureStage: 'no_ingredient_block_found', attemptCount: 0 };
  if (productHasIngredients(product)) {
    return { state: 'available', jobId: productId, failureStage: '', attemptCount: ingredientJobs.get(productId)?.attemptCount || 0 };
  }

  const jobPromise = runIngredientResolutionJob(productId, query, locale, region, {
    forceRetry: !!options.forceRetry,
    syncMode: !!options.syncMode
  });

  if (options.syncMode) {
    await Promise.race([jobPromise, new Promise(resolve => setTimeout(resolve, SYNC_ENRICH_BUDGET_MS))]);
  }

  const refreshedIndex = readIndex();
  const refreshedProduct = refreshedIndex.products.find(x => x.product_id === productId) || product;
  const state = inferResolutionState(productId, refreshedProduct);
  const job = ingredientJobs.get(productId);
  return {
    state,
    jobId: productId,
    failureStage: job?.lastError || '',
    attemptCount: job?.attemptCount || 0
  };
}

function enrichResolutionPayload(result, query, locale, region, options = {}) {
  if (!result.product?.productId) return result;
  return scheduleIngredientResolution(result.product.productId, query, locale, region, options).then(job => {
    result.product.ingredientResolutionState = job.state;
    result.product.ingredientJobId = job.jobId;
    result.product.ingredientFailureStage = job.failureStage;
    result.ingredientResolutionState = job.state;
    result.ingredientJobId = job.jobId;
    result.ingredientFailureStage = job.failureStage;
    return result;
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

async function handleResolveProducts(req, res) {
  const body = await readBody(req);
  const query = String(body.query || '').trim();
  const region = body.region || '';
  const locale = body.locale || '';
  if (!query) {
    sendJson(res, 400, { error: 'query_required' });
    return;
  }

  let result = resolveAgainstIndex(query, region, locale);
  if (result.state === 'not_found') {
    quickEnrich(result.normalized_query);
    result = resolveAgainstIndex(query, region, locale);
  }

  if (result.state === 'not_found') {
    const miss = upsertMiss(query, result.normalized_query, 'no_candidates', { region, locale });
    pushMetric('resolver_not_found', { query: result.normalized_query, missCount: miss.count });
    sendJson(res, 200, result);
    return;
  }

  pushMetric('resolver_resolved', { query: result.normalized_query, state: result.state });
  result = await enrichResolutionPayload(result, query, locale, region, { syncMode: true, forceRetry: false });
  pushMetric('search_confidence_assigned', {
    query: result.normalized_query,
    state: result.state,
    confidence: result.product?.confidence || (result.candidates?.[0]?.confidence || 'low')
  });

  sendJson(res, 200, result);
}

function getIngredientStatus(productId) {
  const index = readIndex();
  const product = index.products.find(x => x.product_id === productId);
  if (!product) return { statusCode: 404, body: { error: 'missing_product' } };
  const state = inferResolutionState(productId, product);
  const job = ingredientJobs.get(productId);
  return {
    statusCode: 200,
    body: {
      productId,
      state,
      ingredientsStatus: product.ingredients_status || 'missing',
      ingredientsText: product.ingredients_text || '',
      ingredientsSource: product.ingredients_source || '',
      updatedAt: product.ingredients_last_verified_at || product.confidence_metadata?.updated_at || '',
      failureStage: job?.lastError || '',
      attemptCount: job?.attemptCount || 0
    }
  };
}

async function handleIngredientsStatus(req, res, productId) {
  const payload = getIngredientStatus(productId);
  pushMetric('ingredient_status_polled', { productId, state: payload.body.state || 'missing' });
  sendJson(res, payload.statusCode, payload.body);
}

async function handleEnrichIngredients(req, res) {
  const body = await readBody(req);
  const productId = String(body.productId || '').trim();
  const query = String(body.query || '').trim();
  const ingredientsText = String(body.ingredientsText || '').trim();
  const ingredientsSource = String(body.ingredientsSource || 'manual').trim();
  const locale = String(body.locale || '').trim();
  const region = String(body.region || '').trim();
  const forceRetry = !!body.forceRetry;

  if (!productId) {
    sendJson(res, 400, { error: 'productId_required' });
    return;
  }

  const index = readIndex();
  const product = index.products.find(x => x.product_id === productId);
  if (!product) {
    upsertMiss(productId, normalizeText(productId), 'no_ingredient_block_found', { reason: 'missing_product_id' });
    sendJson(res, 404, { ok: false, reason: 'missing_product' });
    return;
  }

  if (ingredientsText) {
    const normalizedIngredients = normalizeIngredientText(ingredientsText);
    const quality = scoreIngredientCandidate(normalizedIngredients);
    if (!quality.valid) {
      sendJson(res, 400, { ok: false, error: 'invalid_ingredients_text', reason: quality.reason });
      return;
    }
    product.ingredients_text = normalizedIngredients;
    product.ingredients_status = 'available';
    product.ingredients_source = ingredientsSource || 'manual';
    product.ingredients_last_verified_at = nowIso();
    product.ingredients_version_hash = hashText(normalizedIngredients);
    product.ingredients_confidence = quality.confidence;
    product.confidence_metadata = {
      ...(product.confidence_metadata || {}),
      freshness: 'daily',
      updated_at: nowIso()
    };
    writeIndex(index);
    withJobState(productId, { state: 'available', done: true, lastError: '' });
    pushMetric('ingredient_resolve_succeeded', {
      productId,
      source: product.ingredients_source,
      duration_ms: 0,
      mode: 'manual_upsert'
    });
    sendJson(res, 200, {
      ok: true,
      productId,
      ingredientResolutionState: 'available',
      ingredientJobId: productId,
      ingredientFailureStage: '',
      attemptCount: ingredientJobs.get(productId)?.attemptCount || 0
    });
    return;
  }

  const scheduled = await scheduleIngredientResolution(productId, query || `${product.brand_canonical} ${product.name_canonical}`, locale, region, {
    syncMode: false,
    forceRetry
  });

  pushMetric('ingredients_enrich_requested', { productId, state: scheduled.state, forceRetry });
  sendJson(res, 200, {
    ok: true,
    productId,
    ingredientResolutionState: scheduled.state,
    ingredientJobId: scheduled.jobId,
    ingredientFailureStage: scheduled.failureStage,
    attemptCount: scheduled.attemptCount
  });
}

async function handleUnknownIngredients(req, res) {
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  const source = String(body.source || 'client').trim() || 'client';
  let count = 0;
  for (const token of items) {
    const rec = upsertUnknownIngredient(String(token || ''), source);
    if (rec) count += 1;
  }
  pushMetric('unknown_ingredient_ingested', { count, source });
  sendJson(res, 200, { ok: true, count });
}

function handleCoverageMetrics(_req, res) {
  const miss = readJson(MISS_PATH, { items: [] });
  const metrics = readJson(METRICS_PATH, { events: [] });
  const index = readIndex();
  const unknown = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const last24h = Date.now() - (24 * 60 * 60 * 1000);
  const recentEvents = metrics.events.filter(e => Date.parse(e.ts) >= last24h);
  const resolved = recentEvents.filter(e => e.name === 'resolver_resolved').length;
  const notFound = recentEvents.filter(e => e.name === 'resolver_not_found').length;
  const enrichStarted = recentEvents.filter(e => e.name === 'ingredient_resolve_started').length;
  const enrichSucceeded = recentEvents.filter(e => e.name === 'ingredient_resolve_succeeded').length;
  const enrichFailed = recentEvents.filter(e => e.name === 'ingredient_resolve_failed').length;
  const foundRate = (resolved + notFound) ? resolved / (resolved + notFound) : 1;

  sendJson(res, 200, {
    index: {
      productCount: index.products.length,
      lastUpdated: index.last_updated
    },
    queue: {
      missCount: miss.items.length,
      topMisses: [...miss.items].sort((a, b) => b.count - a.count).slice(0, 10),
      unknownCount: unknown.items.length,
      topUnknown: [...unknown.items].sort((a, b) => b.count - a.count).slice(0, 10)
    },
    kpi: {
      resolverFoundRate24h: Number(foundRate.toFixed(4)),
      resolverNotFound24h: notFound,
      resolverResolved24h: resolved,
      ingredientResolveStarted24h: enrichStarted,
      ingredientResolveSucceeded24h: enrichSucceeded,
      ingredientResolveFailed24h: enrichFailed,
      ingredientResolveSuccessRate24h: enrichStarted ? Number((enrichSucceeded / enrichStarted).toFixed(4)) : 1
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/resolver/products') {
      await handleResolveProducts(req, res);
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/resolver/ingredients/enrich' || url.pathname === '/resolver/enrich-ingredients')) {
      await handleEnrichIngredients(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/unknown-ingredients') {
      await handleUnknownIngredients(req, res);
      return;
    }

    const statusMatch = url.pathname.match(/^\/resolver\/products\/([^/]+)\/ingredients-status$/);
    if (req.method === 'GET' && statusMatch) {
      await handleIngredientsStatus(req, res, decodeURIComponent(statusMatch[1]));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/resolver/coverage-metrics') {
      handleCoverageMetrics(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      pruneSourceCache();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        service: 'skinscan-resolver-api',
        ok: true,
        budgets: { syncMs: SYNC_ENRICH_BUDGET_MS, asyncPollMs: ASYNC_POLL_BUDGET_MS },
        endpoints: ['/healthz', '/resolver/products', '/resolver/coverage-metrics']
      });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    sendJson(res, 500, { error: 'server_error', message: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`resolver_server listening on http://${HOST}:${PORT}`);
});
