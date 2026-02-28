#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.RESOLVER_HOST || '127.0.0.1';
const PORT = Number(process.env.RESOLVER_PORT || 8788);

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'product_index.json');
const MISS_PATH = path.join(DATA_DIR, 'coverage_miss_queue.json');
const METRICS_PATH = path.join(DATA_DIR, 'resolver_metrics.json');

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
    name_aliases: ['advanced night repair', 'anr serum', 'night repair serum'],
    brand_aliases: ['estee lauder', 'estee'],
    line: 'Advanced Night Repair',
    category: 'Serum',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    source_priority: 100,
    confidence_metadata: { quality: 'high', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.99 }
  },
  {
    product_id: 'dr_althea_365_relief_essence',
    brand_canonical: 'Dr. Althea',
    name_canonical: '365 Relief Essence',
    name_aliases: ['dr althea 365', '365 relief essence'],
    brand_aliases: ['dr althea', 'dr. althea'],
    line: '365',
    category: 'Essence',
    image_url: '',
    ingredients_status: 'missing',
    ingredients_text: '',
    source_priority: 94,
    confidence_metadata: { quality: 'medium', freshness: 'daily', updated_at: new Date().toISOString(), popularity: 0.85 }
  }
];

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

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function scoreProduct(query, product) {
  const texts = listProductTexts(product);
  const best = texts.reduce((m, t) => Math.max(m, overlapScore(query, t)), 0);
  const brand = overlapScore(query, product.brand_canonical || '');
  const line = overlapScore(query, product.line || '');
  const availBoost = product.ingredients_status === 'available' ? 0.08 : 0;
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
  metrics.events.push({ name, payload, ts: new Date().toISOString() });
  if (metrics.events.length > 5000) metrics.events = metrics.events.slice(-5000);
  writeJson(METRICS_PATH, metrics);
}

function upsertMiss(rawQuery, normalizedQuery, failureStage, details) {
  const queue = readJson(MISS_PATH, { items: [] });
  const key = normalizeText(rawQuery);
  const now = new Date().toISOString();
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

function quickEnrich(normalizedQuery) {
  const index = readJson(INDEX_PATH, { version: 1, last_updated: new Date().toISOString(), products: [] });
  let changed = false;
  QUICK_ENRICH_CATALOG.forEach(seed => {
    const seedTexts = listProductTexts(seed).map(normalizeText);
    if (!seedTexts.some(t => t && (normalizedQuery.includes(t) || t.includes(normalizedQuery)))) return;
    if (!index.products.some(p => p.product_id === seed.product_id)) {
      index.products.push(seed);
      changed = true;
    }
  });
  if (changed) {
    index.last_updated = new Date().toISOString();
    writeJson(INDEX_PATH, index);
  }
  return changed;
}

function resolveAgainstIndex(query, region, locale) {
  const normalizedQuery = normalizeText(query);
  const { corrected, applied } = applyCorrections(normalizedQuery);
  const variants = generateVariants(corrected);
  const index = readJson(INDEX_PATH, { version: 1, last_updated: new Date().toISOString(), products: [] });

  let ranked = [];
  variants.forEach(v => {
    const scored = index.products
      .map(p => ({ product: p, score: scoreProduct(v, p) }))
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
  const result = {
    ...classified,
    normalized_query: corrected,
    applied_corrections: applied,
    region: region || '',
    locale: locale || ''
  };
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
  }

  sendJson(res, 200, result);
}

async function handleEnrichIngredients(req, res) {
  const body = await readBody(req);
  const productId = String(body.productId || '').trim();
  if (!productId) {
    sendJson(res, 400, { error: 'productId_required' });
    return;
  }
  const index = readJson(INDEX_PATH, { version: 1, last_updated: new Date().toISOString(), products: [] });
  const p = index.products.find(x => x.product_id === productId);
  if (!p) {
    upsertMiss(productId, normalizeText(productId), 'parser_failure', { reason: 'missing_product_id' });
    sendJson(res, 404, { ok: false, reason: 'missing_product' });
    return;
  }
  if (p.ingredients_status !== 'available') {
    p.ingredients_status = 'missing';
  }
  p.confidence_metadata = {
    ...(p.confidence_metadata || {}),
    updated_at: new Date().toISOString(),
    freshness: 'daily'
  };
  index.last_updated = new Date().toISOString();
  writeJson(INDEX_PATH, index);
  pushMetric('ingredients_enrich_requested', { productId });
  sendJson(res, 200, { ok: true, productId, ingredientsStatus: p.ingredients_status });
}

function handleCoverageMetrics(_req, res) {
  const miss = readJson(MISS_PATH, { items: [] });
  const metrics = readJson(METRICS_PATH, { events: [] });
  const index = readJson(INDEX_PATH, { version: 1, last_updated: '', products: [] });
  const last24h = Date.now() - (24 * 60 * 60 * 1000);
  const recentEvents = metrics.events.filter(e => Date.parse(e.ts) >= last24h);
  const resolved = recentEvents.filter(e => e.name === 'resolver_resolved').length;
  const notFound = recentEvents.filter(e => e.name === 'resolver_not_found').length;
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
      resolverResolved24h: resolved
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (req.method === 'POST' && req.url === '/resolver/products') {
      await handleResolveProducts(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/resolver/ingredients/enrich') {
      await handleEnrichIngredients(req, res);
      return;
    }
    if (req.method === 'GET' && req.url === '/resolver/coverage-metrics') {
      handleCoverageMetrics(req, res);
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
