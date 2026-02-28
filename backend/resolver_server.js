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

const SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 2500;
const TOTAL_ENRICH_BUDGET_MS = 6000;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 3;

const ingredientJobs = new Map();
const activeIngredientResolves = new Map();
const sourceCircuit = {
  obf: { failures: 0, openUntil: 0 },
  retailer: { failures: 0, openUntil: 0 },
  brand: { failures: 0, openUntil: 0 }
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
      'night repair serum'
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
    source_priority: 100,
    confidence_metadata: { quality: 'high', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.99 }
  },
  {
    product_id: 'dr_althea_345_relief_cream',
    brand_canonical: 'Dr. Althea',
    name_canonical: '345 Relief Cream',
    name_aliases: ['dr althea 345', '345 relief cream', '345 cream', 'relief cream'],
    brand_aliases: ['dr althea', 'dr. althea', 'althea'],
    line: '345',
    category: 'Cream',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    ingredients_source: '',
    ingredients_last_verified_at: '',
    ingredients_version_hash: '',
    source_priority: 95,
    confidence_metadata: { quality: 'high', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.92 }
  },
  {
    product_id: 'dr_althea_365_relief_essence',
    brand_canonical: 'Dr. Althea',
    name_canonical: '365 Relief Essence',
    name_aliases: ['dr althea 365', '365 relief essence', '365 essence', 'relief essence'],
    brand_aliases: ['dr althea', 'dr. althea', 'althea'],
    line: '365',
    category: 'Essence',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    ingredients_source: '',
    ingredients_last_verified_at: '',
    ingredients_version_hash: '',
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

function isValidIngredientText(text) {
  const tokens = ingredientTokens(text);
  if (tokens.length < 10) return false;
  const alphaLike = tokens.filter(t => /[a-z]/i.test(t)).length;
  return alphaLike >= Math.ceil(tokens.length * 0.8);
}

function productHasIngredients(product) {
  return product && product.ingredients_status === 'available' && String(product.ingredients_text || '').trim().length > 20;
}

function inferResolutionState(productId, product) {
  if (productHasIngredients(product)) return 'available';
  const job = ingredientJobs.get(productId);
  if (job?.state === 'resolving') return 'resolving';
  return 'unavailable';
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
  return {
    productId: product.product_id,
    brand: product.brand_canonical,
    name: product.name_canonical,
    line: product.line || '',
    category: product.category || '',
    imageUrl: product.image_url || '',
    ingredientsStatus: product.ingredients_status || 'missing',
    ingredientsText: product.ingredients_text || '',
    ingredientResolutionState: inferResolutionState(product.product_id, product),
    ingredientJobId: product.product_id,
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
    ingredients_version_hash: product.ingredients_version_hash || ''
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
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.p || null;
}

async function fetchIngredientsFromOBF(query) {
  const cacheKey = `obf:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const url = `https://world.openbeautyfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,brands,ingredients_text,image_small_url,categories`;
  const data = await fetchJsonWithTimeout(url, SOURCE_TIMEOUT_MS, { 'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)' });
  const best = bestScoredProduct(data.products || [], normalizeText(query));
  if (!best || !best.ingredients_text) return null;

  const normalized = normalizeIngredientText(best.ingredients_text);
  if (!isValidIngredientText(normalized)) {
    throw new Error('parser_rejected');
  }

  const payload = {
    source: 'obf',
    ingredientsText: normalized,
    imageUrl: best.image_small_url || '',
    category: String(best.categories || '').split(',')[0]?.trim() || ''
  };
  setSourceCache(cacheKey, payload);
  return payload;
}

function extractIngredientsBlock(text) {
  if (!text) return '';
  const re = [
    /ingredients?\s*[:\-]\s*([\s\S]{80,3000})/i,
    /full\s+ingredients?\s*[:\-]\s*([\s\S]{80,3000})/i,
    /inci\s*[:\-]\s*([\s\S]{80,3000})/i
  ];
  for (const pattern of re) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const line = match[1].split('\n').slice(0, 5).join(', ');
      const normalized = normalizeIngredientText(line);
      if (isValidIngredientText(normalized)) return normalized;
    }
  }
  return '';
}

async function fetchIngredientsFromRetailer(query) {
  const cacheKey = `retailer:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const searchUrls = [
    `https://r.jina.ai/http://www.sephora.com/search?keyword=${encodeURIComponent(query)}`,
    `https://r.jina.ai/http://www.ulta.com/search?search=${encodeURIComponent(query)}`
  ];

  for (const url of searchUrls) {
    const text = await fetchTextWithTimeout(url, SOURCE_TIMEOUT_MS);
    const ingredients = extractIngredientsBlock(text);
    if (!ingredients) continue;
    const payload = { source: 'retailer', ingredientsText: ingredients, imageUrl: '', category: '' };
    setSourceCache(cacheKey, payload);
    return payload;
  }

  return null;
}

async function fetchIngredientsFromBrand(product) {
  const name = `${product.brand_canonical || ''} ${product.name_canonical || ''}`.trim();
  const cacheKey = `brand:${normalizeText(name)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const brand = normalizeText(product.brand_canonical || '');
  const urls = [];
  if (brand.includes('estee lauder')) {
    urls.push(`https://r.jina.ai/http://www.esteelauder.com/search?search=${encodeURIComponent(product.name_canonical || '')}`);
  }
  if (brand.includes('dr althea')) {
    urls.push(`https://r.jina.ai/http://www.dralthea.com/search?q=${encodeURIComponent(product.name_canonical || '')}`);
  }

  for (const url of urls) {
    const text = await fetchTextWithTimeout(url, SOURCE_TIMEOUT_MS);
    const ingredients = extractIngredientsBlock(text);
    if (!ingredients) continue;
    const payload = { source: 'brand', ingredientsText: ingredients, imageUrl: '', category: product.category || '' };
    setSourceCache(cacheKey, payload);
    return payload;
  }

  return null;
}

function withJobState(productId, patch) {
  const prev = ingredientJobs.get(productId) || {
    productId,
    state: 'unavailable',
    startedAt: '',
    updatedAt: nowIso(),
    attempts: 0,
    lastError: ''
  };
  const next = { ...prev, ...patch, updatedAt: nowIso() };
  ingredientJobs.set(productId, next);
  return next;
}

async function tryAdapter(name, fn, context) {
  if (adapterOpen(name)) {
    return { ok: false, failureStage: 'rate_limited' };
  }
  const remaining = context.deadline - Date.now();
  if (remaining <= 100) {
    return { ok: false, failureStage: 'source_timeout' };
  }

  try {
    const result = await fn(Math.min(SOURCE_TIMEOUT_MS, remaining));
    if (!result || !isValidIngredientText(result.ingredientsText || '')) {
      markAdapterFailure(name);
      return { ok: false, failureStage: 'no_ingredient_block_found' };
    }
    markAdapterSuccess(name);
    return { ok: true, result };
  } catch (err) {
    markAdapterFailure(name);
    if (String(err?.name || '').toLowerCase().includes('abort')) {
      return { ok: false, failureStage: 'source_timeout' };
    }
    if (String(err?.message || '').includes('parser_rejected')) {
      return { ok: false, failureStage: 'parser_rejected' };
    }
    return { ok: false, failureStage: 'no_ingredient_block_found' };
  }
}

async function runIngredientResolutionJob(productId, query, locale, region) {
  if (activeIngredientResolves.has(productId)) return activeIngredientResolves.get(productId);

  const promise = (async () => {
    const startedAt = Date.now();
    withJobState(productId, { state: 'resolving', startedAt: nowIso(), attempts: (ingredientJobs.get(productId)?.attempts || 0) + 1, lastError: '' });
    pushMetric('ingredient_resolve_started', { productId, query });

    const index = readIndex();
    const product = index.products.find(x => x.product_id === productId);
    if (!product) {
      withJobState(productId, { state: 'unavailable', lastError: 'missing_product' });
      pushMetric('ingredient_resolve_failed', { productId, failure_stage: 'no_ingredient_block_found' });
      return;
    }

    if (productHasIngredients(product)) {
      withJobState(productId, { state: 'available' });
      return;
    }

    const context = { deadline: Date.now() + TOTAL_ENRICH_BUDGET_MS };
    const sources = [
      { name: 'obf', exec: () => fetchIngredientsFromOBF(query || `${product.brand_canonical} ${product.name_canonical}`) },
      { name: 'retailer', exec: () => fetchIngredientsFromRetailer(`${product.brand_canonical} ${product.name_canonical}`) },
      { name: 'brand', exec: () => fetchIngredientsFromBrand(product) }
    ];

    let finalFailureStage = 'no_ingredient_block_found';
    for (const adapter of sources) {
      const attempt = await tryAdapter(adapter.name, adapter.exec, context);
      if (!attempt.ok) {
        finalFailureStage = attempt.failureStage;
        continue;
      }

      const normalizedIngredients = normalizeIngredientText(attempt.result.ingredientsText);
      product.ingredients_text = normalizedIngredients;
      product.ingredients_status = 'available';
      product.ingredients_source = attempt.result.source;
      product.ingredients_last_verified_at = nowIso();
      product.ingredients_version_hash = hashText(normalizedIngredients);
      if (attempt.result.imageUrl && !product.image_url) product.image_url = attempt.result.imageUrl;
      if (attempt.result.category && !product.category) product.category = attempt.result.category;
      product.confidence_metadata = {
        ...(product.confidence_metadata || {}),
        freshness: 'daily',
        updated_at: nowIso()
      };
      writeIndex(index);
      withJobState(productId, { state: 'available', lastError: '' });
      pushMetric('ingredient_resolve_succeeded', {
        productId,
        source: attempt.result.source,
        duration_ms: Date.now() - startedAt
      });
      return;
    }

    withJobState(productId, { state: 'unavailable', lastError: finalFailureStage });
    upsertMiss(query || `${product.brand_canonical} ${product.name_canonical}`, normalizeText(query || product.name_canonical || ''), finalFailureStage, {
      productId,
      locale: locale || '',
      region: region || ''
    });
    pushMetric('ingredient_resolve_failed', { productId, failure_stage: finalFailureStage, duration_ms: Date.now() - startedAt });
  })().finally(() => {
    activeIngredientResolves.delete(productId);
  });

  activeIngredientResolves.set(productId, promise);
  return promise;
}

function scheduleIngredientResolution(productId, query, locale, region) {
  const index = readIndex();
  const product = index.products.find(x => x.product_id === productId);
  if (!product) return { state: 'unavailable', jobId: productId };
  if (productHasIngredients(product)) {
    return { state: 'available', jobId: productId };
  }
  if (!activeIngredientResolves.has(productId)) {
    runIngredientResolutionJob(productId, query, locale, region).catch(() => {});
  }
  return { state: 'resolving', jobId: productId };
}

function enrichResolutionPayload(result, query, locale, region) {
  if (result.product?.productId) {
    const job = scheduleIngredientResolution(result.product.productId, query, locale, region);
    result.product.ingredientResolutionState = job.state;
    result.product.ingredientJobId = job.jobId;
    result.ingredientResolutionState = job.state;
    result.ingredientJobId = job.jobId;
  }
  return result;
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
  } else {
    pushMetric('resolver_resolved', { query: result.normalized_query, state: result.state });
    result = enrichResolutionPayload(result, query, locale, region);
    pushMetric('search_confidence_assigned', {
      query: result.normalized_query,
      state: result.state,
      confidence: result.product?.confidence || (result.candidates?.[0]?.confidence || 'low')
    });
  }

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
      failureStage: job?.lastError || ''
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
  const locale = String(body.locale || '').trim();
  const region = String(body.region || '').trim();

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

  const scheduled = scheduleIngredientResolution(productId, query || `${product.brand_canonical} ${product.name_canonical}`, locale, region);
  pushMetric('ingredients_enrich_requested', { productId, state: scheduled.state });
  sendJson(res, 200, {
    ok: true,
    productId,
    ingredientResolutionState: scheduled.state,
    ingredientJobId: scheduled.jobId
  });
}

function handleCoverageMetrics(_req, res) {
  const miss = readJson(MISS_PATH, { items: [] });
  const metrics = readJson(METRICS_PATH, { events: [] });
  const index = readIndex();
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
      topMisses: [...miss.items].sort((a, b) => b.count - a.count).slice(0, 10)
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
