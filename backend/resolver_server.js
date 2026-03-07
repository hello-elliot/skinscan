#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { spawnSync, spawn } = require('child_process');

const HOST = process.env.RESOLVER_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.RESOLVER_PORT || 8788);

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'product_index.json');
const CATALOG_PATH = path.join(DATA_DIR, 'product_catalog.json');
const BRAND_LEXICON_PATH = path.join(DATA_DIR, 'brand_lexicon.json');
const MISS_PATH = path.join(DATA_DIR, 'coverage_miss_queue.json');
const METRICS_PATH = path.join(DATA_DIR, 'resolver_metrics.json');
const SOURCE_CACHE_PATH = path.join(DATA_DIR, 'source_cache.json');
const UNKNOWN_QUEUE_PATH = path.join(DATA_DIR, 'unknown_ingredient_queue.json');
const CANDIDATE_FEEDBACK_PATH = path.join(DATA_DIR, 'candidate_feedback_queue.json');
const NEGATIVE_ALIAS_RULES_PATH = path.join(DATA_DIR, 'negative_alias_rules.json');
const PROMOTION_REPORT_PATH = path.join(DATA_DIR, 'promotion_report.json');
const ADD_PRODUCT_QUEUE_PATH = path.join(DATA_DIR, 'add_product_queue.json');
const INGESTION_JOBS_PATH = path.join(DATA_DIR, 'ingestion_jobs.json');
const SOURCE_PROFILE_PATH = path.join(DATA_DIR, 'product_source_profiles.json');
const INGREDIENT_KNOWLEDGE_PATH = path.join(DATA_DIR, 'ingredient_knowledge.json');
const INGREDIENT_PROPOSALS_PATH = path.join(DATA_DIR, 'ingredient_proposals.json');
const FRONTEND_INGREDIENT_OVERRIDES_PATH = path.join(DATA_DIR, 'frontend_ingredient_overrides.json');
const INGREDIENT_CANONICAL_INDEX_PATH = path.join(DATA_DIR, 'ingredient_canonical_index.json');
const INGREDIENT_INGESTION_REPORT_PATH = path.join(DATA_DIR, 'ingredient_ingestion_report.json');
const INGEST_COSING_SCRIPT_PATH = path.join(__dirname, 'ingest_cosing.js');
const ENRICH_PUBCHEM_SCRIPT_PATH = path.join(__dirname, 'enrich_pubchem.js');

const SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 3000;
const INGREDIENT_SOURCE_TIMEOUT_MS = Number(process.env.INGREDIENT_SOURCE_TIMEOUT_MS || 5500);
const SYNC_ENRICH_BUDGET_MS = 10000;
const ASYNC_POLL_BUDGET_MS = 8000;
const FAST_SEARCH_BUDGET_MS = Number(process.env.FAST_SEARCH_BUDGET_MS || 1500);
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 3;
const AI_PROXY_URL = process.env.AI_PROXY_URL || 'https://skinscan-proxy.kelly-f.workers.dev';
const AI_FALLBACK_ENABLED = String(process.env.AI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
const SIMPLE_SOURCE_MODE = String(process.env.SIMPLE_SOURCE_MODE || 'true').toLowerCase() !== 'false';
const AUTO_RESOLVE_ENABLED = String(process.env.AUTO_RESOLVE_ENABLED || 'true').toLowerCase() !== 'false';
const STRICT_BRAND_GATE_ENABLED = String(process.env.STRICT_BRAND_GATE_ENABLED || 'true').toLowerCase() !== 'false';
const INGESTION_POLL_INTERVAL_MS = Number(process.env.INGESTION_POLL_INTERVAL_MS || 30000);
const INGESTION_REDIRECT_LIMIT = Number(process.env.INGESTION_REDIRECT_LIMIT || 5);
const INGESTION_RESPONSE_MAX_BYTES = Number(process.env.INGESTION_RESPONSE_MAX_BYTES || (1.5 * 1024 * 1024));
const INGESTION_FETCH_BUDGET_MS = Number(process.env.INGESTION_FETCH_BUDGET_MS || 12000);
const INGESTION_ESTIMATED_JOB_MS = Number(process.env.INGESTION_ESTIMATED_JOB_MS || 4000);

const GENERIC_PRODUCT_TOKENS = new Set([
  'serum', 'cream', 'cleanser', 'toner', 'essence', 'mask', 'moisturizer', 'moisturising', 'moisturizing',
  'gel', 'lotion', 'balm', 'oil', 'ampoule', 'sunscreen', 'sun', 'spf', 'treatment', 'repair', 'hydrating',
  'hydration', 'night', 'day', 'water', 'face', 'skin', 'advanced', 'relief', 'first', 'care'
]);

const ingredientJobs = new Map();
const activeIngredientResolves = new Map();
const sourceCircuit = {
  obf: { failures: 0, openUntil: 0 },
  incidecoder: { failures: 0, openUntil: 0 },
  retailer: { failures: 0, openUntil: 0 },
  brand: { failures: 0, openUntil: 0 },
  ai: { failures: 0, openUntil: 0 }
};
let ingestionWorkerRunning = false;

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

const DEFAULT_INGREDIENT_KNOWLEDGE = {
  canonical: {
    'METHYL GLUCETH-20': { acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'humectant' },
    'TRIPEPTIDE-32': { acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'peptide' },
    'HYDROLYZED ALGIN': { acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'humectant' },
    PANTETHINE: { acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'skin conditioning' },
    'SODIUM RNA': { acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'skin conditioning' },
    'OLETH-3 PHOSPHATE': { acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'emulsifier' },
    'JOJOBA WAX PEG-120 ESTERS': { acne: 1, irr: 0, dry: 0, al: 0, safe: true, func: 'emollient' },
    'CETETH-24': { acne: 1, irr: 0, dry: 0, al: 0, safe: true, func: 'emulsifier' },
    'YELLOW 5': { acne: 0, irr: 1, dry: 0, al: 0, safe: null, func: 'colorant' }
  },
  synonyms: {
    'YEAST EXTRACT/FAEX/EXTRAIT DE LEVURE': 'YEAST EXTRACT',
    'YELLOW 5 (CI 19140)': 'YELLOW 5',
    'CI 19140': 'YELLOW 5'
  },
  family_rules: [
    { pattern: '^TRIPEPTIDE-', canonical: 'TRIPEPTIDE-32' },
    { pattern: '^PEPTIDE-', canonical: 'TRIPEPTIDE-32' },
    { pattern: 'YEAST|FAEX|LEVURE', canonical: 'YEAST EXTRACT' },
    { pattern: 'ALGIN', canonical: 'HYDROLYZED ALGIN' },
    { pattern: '^CETETH-', canonical: 'CETETH-24' },
    { pattern: '^OLETH-', canonical: 'OLETH-3 PHOSPHATE' }
  ]
};

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

function readCandidateFeedbackQueue() {
  return readJson(CANDIDATE_FEEDBACK_PATH, { items: [] });
}

function writeCandidateFeedbackQueue(queue) {
  writeJson(CANDIDATE_FEEDBACK_PATH, {
    items: Array.isArray(queue.items) ? queue.items : []
  });
}

function readNegativeAliasRules() {
  const payload = readJson(NEGATIVE_ALIAS_RULES_PATH, { rules: {} });
  return payload && typeof payload.rules === 'object' && payload.rules ? payload.rules : {};
}

function readAddProductQueue() {
  const queue = readJson(ADD_PRODUCT_QUEUE_PATH, { items: [] });
  return { items: Array.isArray(queue.items) ? queue.items : [] };
}

function writeAddProductQueue(queue) {
  writeJson(ADD_PRODUCT_QUEUE_PATH, {
    items: Array.isArray(queue.items) ? queue.items : []
  });
}

function readIngestionJobs() {
  const jobs = readJson(INGESTION_JOBS_PATH, { items: [] });
  return { items: Array.isArray(jobs.items) ? jobs.items : [] };
}

function writeIngestionJobs(jobs) {
  writeJson(INGESTION_JOBS_PATH, {
    items: Array.isArray(jobs.items) ? jobs.items : []
  });
}

function utcDay(iso = nowIso()) {
  return String(iso).slice(0, 10);
}

function trimDailyBuckets(map = {}, keepDays = 35) {
  const keys = Object.keys(map || {}).sort();
  if (keys.length <= keepDays) return map || {};
  const drop = new Set(keys.slice(0, keys.length - keepDays));
  const out = {};
  keys.forEach(k => {
    if (!drop.has(k)) out[k] = Number(map[k] || 0);
  });
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function slugifyProductId(brand, name) {
  const raw = `${brand || ''} ${name || ''}`.toLowerCase();
  return raw
    .replace(/&/g, ' and ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

function readIngredientKnowledge() {
  const source = readJson(INGREDIENT_KNOWLEDGE_PATH, DEFAULT_INGREDIENT_KNOWLEDGE);
  return {
    canonical: source.canonical || {},
    synonyms: source.synonyms || {},
    family_rules: Array.isArray(source.family_rules) ? source.family_rules : []
  };
}

function writeIngredientKnowledge(knowledge) {
  writeJson(INGREDIENT_KNOWLEDGE_PATH, {
    canonical: knowledge.canonical || {},
    synonyms: knowledge.synonyms || {},
    family_rules: Array.isArray(knowledge.family_rules) ? knowledge.family_rules : []
  });
}

function readIngredientProposals() {
  return readJson(INGREDIENT_PROPOSALS_PATH, { items: [] });
}

function writeIngredientProposals(data) {
  writeJson(INGREDIENT_PROPOSALS_PATH, { items: Array.isArray(data.items) ? data.items : [] });
}

function readFrontendIngredientOverrides() {
  return readJson(FRONTEND_INGREDIENT_OVERRIDES_PATH, { db: {}, aliases: {}, synonyms: {}, familyRules: [] });
}

function writeFrontendIngredientOverrides(value) {
  writeJson(FRONTEND_INGREDIENT_OVERRIDES_PATH, {
    db: value.db || {},
    aliases: value.aliases || {},
    synonyms: value.synonyms || {},
    familyRules: Array.isArray(value.familyRules) ? value.familyRules : []
  });
}

function normalizeIngredientToken(token) {
  return String(token || '')
    .toUpperCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-\s*/g, '-')
    .replace(/[;,|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCanonicalName(name) {
  return normalizeIngredientToken(name).replace(/[^\w\s\/\-.+]/g, '').trim();
}

function readCanonicalIngredientIndex() {
  const source = readJson(INGREDIENT_CANONICAL_INDEX_PATH, {
    version: 1,
    source: 'cosing',
    updatedAt: nowIso(),
    sourceFile: '',
    items: []
  });
  return {
    version: source.version || 1,
    source: source.source || 'cosing',
    updatedAt: source.updatedAt || '',
    sourceFile: source.sourceFile || '',
    items: Array.isArray(source.items) ? source.items : []
  };
}

function buildCanonicalSynonymLookup(canonicalIndex) {
  const map = {};
  for (const item of canonicalIndex.items || []) {
    const canonicalId = formatCanonicalName(item.canonicalId || item.inciName || '');
    if (!canonicalId) continue;
    map[canonicalId] = canonicalId;
    const inciName = formatCanonicalName(item.inciName || '');
    if (inciName) map[inciName] = canonicalId;
    for (const syn of (item.synonyms || [])) {
      const key = formatCanonicalName(syn);
      if (key) map[key] = canonicalId;
    }
  }
  return map;
}

function resolveIngredientKnowledge(token, knowledge, canonicalLookup = null) {
  const normalizedToken = normalizeIngredientToken(token);
  if (!normalizedToken) return { normalizedToken: '', matchType: 'unknown', canonicalId: '', confidence: 'low' };
  if (knowledge.canonical[normalizedToken]) {
    return { normalizedToken, matchType: 'exact', canonicalId: normalizedToken, confidence: 'high' };
  }
  const mapped = knowledge.synonyms[normalizedToken];
  if (mapped && knowledge.canonical[mapped]) {
    return { normalizedToken, matchType: 'synonym', canonicalId: mapped, confidence: 'medium' };
  }
  if (canonicalLookup && canonicalLookup[normalizedToken]) {
    const canonicalId = canonicalLookup[normalizedToken];
    if (knowledge.canonical[canonicalId]) {
      return { normalizedToken, matchType: 'synonym', canonicalId, confidence: 'medium' };
    }
  }
  for (const rule of knowledge.family_rules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(normalizedToken) && knowledge.canonical[rule.canonical]) {
        return { normalizedToken, matchType: 'family', canonicalId: rule.canonical, confidence: 'medium' };
      }
    } catch (_) {}
  }
  if (/\bEXTRACT\b/i.test(normalizedToken)) {
    return { normalizedToken, matchType: 'generic_extract', canonicalId: 'PLANT EXTRACT', confidence: 'low' };
  }
  return { normalizedToken, matchType: 'unknown', canonicalId: '', confidence: 'low' };
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

function createJobId(prefix = 'job') {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rnd}`;
}

function sanitizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function normalizeIngestionFailureCode(reason, fallback = 'upsert_failed') {
  const code = String(reason || '').trim().toLowerCase();
  const map = {
    invalid_url: 'invalid_url',
    blocked_host: 'blocked_host',
    dns_unresolved: 'blocked_host',
    fetch_timeout: 'fetch_timeout',
    redirect_limit: 'fetch_timeout',
    fetch_failed: 'fetch_timeout',
    response_too_large: 'fetch_timeout',
    unsupported_content_type: 'parser_no_product',
    candidate_missing: 'parser_no_product',
    parser_no_product: 'parser_no_product',
    missing_brand: 'parser_no_brand',
    parser_no_brand: 'parser_no_brand',
    missing_name: 'parser_no_name',
    parser_no_name: 'parser_no_name',
    generic_name: 'parser_no_name',
    weak_similarity: 'low_similarity',
    low_similarity: 'low_similarity',
    upsert_failed: 'upsert_failed'
  };
  return map[code] || fallback;
}

function isPrivateIpv4(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = String(ip || '').toLowerCase();
  if (!normalized) return false;
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.replace('::ffff:', '');
    if (net.isIP(mapped) === 4 && isPrivateIpv4(mapped)) return true;
  }
  return false;
}

function hostIsBlocked(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return { blocked: true, failureCode: 'invalid_url' };
  if (host === 'localhost' || host.endsWith('.localhost')) return { blocked: true, failureCode: 'blocked_host' };
  if (host.endsWith('.local')) return { blocked: true, failureCode: 'blocked_host' };
  const ipVersion = net.isIP(host);
  if (ipVersion === 4 && isPrivateIpv4(host)) return { blocked: true, failureCode: 'blocked_host' };
  if (ipVersion === 6 && isPrivateIpv6(host)) return { blocked: true, failureCode: 'blocked_host' };
  return { blocked: false, failureCode: '' };
}

async function resolvePublicHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  const blocked = hostIsBlocked(host);
  if (blocked.blocked) return { ok: false, failureCode: blocked.failureCode };
  const ipVersion = net.isIP(host);
  if (ipVersion === 4 || ipVersion === 6) return { ok: true };
  try {
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || !addresses.length) {
      return { ok: false, failureCode: 'dns_unresolved' };
    }
    for (const addr of addresses) {
      const ip = String(addr.address || '');
      if (!ip) continue;
      if ((addr.family === 4 || net.isIP(ip) === 4) && isPrivateIpv4(ip)) return { ok: false, failureCode: 'blocked_host' };
      if ((addr.family === 6 || net.isIP(ip) === 6) && isPrivateIpv6(ip)) return { ok: false, failureCode: 'blocked_host' };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, failureCode: 'dns_unresolved' };
  }
}

async function fetchPublicPageWithGuards(initialUrl, budgetMs = INGESTION_FETCH_BUDGET_MS) {
  let currentUrl = sanitizeUrl(initialUrl);
  if (!currentUrl) throw new Error('invalid_url');
  const start = Date.now();
  const seen = new Set();
  let redirects = 0;

  while (true) {
    if (Date.now() - start > budgetMs) throw new Error('fetch_timeout');
    const parsed = new URL(currentUrl);
    const hostCheck = await resolvePublicHost(parsed.hostname);
    if (!hostCheck.ok) throw new Error(hostCheck.failureCode || 'blocked_host');
    if (seen.has(currentUrl)) throw new Error('redirect_limit');
    seen.add(currentUrl);

    const remainingMs = Math.max(500, budgetMs - (Date.now() - start));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let res;
    try {
      res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)' }
      });
    } catch (error) {
      clearTimeout(timer);
      if (String(error?.name || '').toLowerCase().includes('abort')) throw new Error('fetch_timeout');
      throw new Error('fetch_failed');
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = String(res.headers.get('location') || '').trim();
      if (!location) throw new Error('fetch_failed');
      currentUrl = sanitizeUrl(new URL(location, currentUrl).toString());
      redirects += 1;
      if (!currentUrl || redirects > INGESTION_REDIRECT_LIMIT) throw new Error('redirect_limit');
      continue;
    }
    if (!res.ok) throw new Error('fetch_failed');

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!(contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('application/ld+json'))) {
      throw new Error('unsupported_content_type');
    }

    const reader = res.body?.getReader ? res.body.getReader() : null;
    if (!reader) {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > INGESTION_RESPONSE_MAX_BYTES) throw new Error('response_too_large');
      return { finalUrl: currentUrl, text };
    }

    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > INGESTION_RESPONSE_MAX_BYTES) throw new Error('response_too_large');
      chunks.push(chunk);
    }
    return { finalUrl: currentUrl, text: Buffer.concat(chunks).toString('utf8') };
  }
}

function looksGenericProductName(name) {
  const tokens = tokenize(name);
  if (!tokens.length) return true;
  const meaningful = tokens.filter(t => !GENERIC_PRODUCT_TOKENS.has(t) && t.length > 2);
  return meaningful.length === 0;
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
  // AI fallback should remain available for ingredient recovery attempts.
  // Circuit-breaking it makes long-tail products fail hard when other sources miss.
  if (name === 'ai') return false;
  return Date.now() < (sourceCircuit[name]?.openUntil || 0);
}

function markAdapterSuccess(name) {
  if (!sourceCircuit[name]) return;
  sourceCircuit[name].failures = 0;
  sourceCircuit[name].openUntil = 0;
}

function markAdapterFailure(name) {
  if (!sourceCircuit[name]) return;
  if (name === 'ai') return;
  sourceCircuit[name].failures += 1;
  if (sourceCircuit[name].failures >= CIRCUIT_FAIL_THRESHOLD) {
    sourceCircuit[name].openUntil = Date.now() + CIRCUIT_OPEN_MS;
    sourceCircuit[name].failures = 0;
  }
}

function isRetryableIngredientFailure(stage = '') {
  const s = String(stage || '').toLowerCase();
  return s === 'rate_limited' || s === 'source_timeout' || s === 'fetch_timeout';
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

function productBrandTokens(product) {
  return [
    normalizeText(product.brand_canonical || ''),
    ...(product.brand_aliases || []).map(normalizeText)
  ].filter(Boolean);
}

function readBrandLexicon(catalogProducts = []) {
  const fromFile = readJson(BRAND_LEXICON_PATH, { aliases: [] });
  const aliases = Array.isArray(fromFile.aliases) ? fromFile.aliases.map(normalizeText).filter(Boolean) : [];
  if (aliases.length) return [...new Set(aliases)];
  const generated = new Set();
  for (const product of catalogProducts) {
    const canonical = normalizeText(product.brand_canonical || '');
    if (canonical.length >= 3) generated.add(canonical);
    for (const alias of product.brand_aliases || []) {
      const normalizedAlias = normalizeText(alias);
      if (normalizedAlias.length >= 3) generated.add(normalizedAlias);
    }
  }
  return [...generated];
}

function detectBrandHint(query, catalogProducts, lexicon = []) {
  const q = normalizeText(query);
  if (!q) return null;
  let best = null;
  const canonicalByAlias = new Map();
  for (const product of catalogProducts || []) {
    const canonical = normalizeText(product.brand_canonical || '');
    if (!canonical) continue;
    const aliases = [...new Set([canonical, ...(product.brand_aliases || []).map(normalizeText)])].filter(Boolean);
    for (const alias of aliases) {
      if (alias.length < 3) continue;
      canonicalByAlias.set(alias, canonical);
    }
  }
  for (const alias of lexicon) {
    const canonical = canonicalByAlias.get(alias) || alias;
    if (alias.length < 3) continue;
    if (!q.includes(alias)) continue;
    const candidate = {
      canonicalBrand: canonical,
      matchedAlias: alias,
      aliasLength: alias.length
    };
    if (!best || candidate.aliasLength > best.aliasLength) best = candidate;
  }
  if (best) return best;

  const seen = new Set();
  for (const product of catalogProducts || []) {
    const canonical = normalizeText(product.brand_canonical || '');
    const aliases = [...new Set([canonical, ...(product.brand_aliases || []).map(normalizeText)])].filter(Boolean);
    for (const alias of aliases) {
      if (alias.length < 3) continue;
      if (seen.has(`${canonical}|${alias}`)) continue;
      seen.add(`${canonical}|${alias}`);
      if (!q.includes(alias)) continue;
      const candidate = {
        canonicalBrand: canonical,
        matchedAlias: alias,
        aliasLength: alias.length
      };
      if (!best || candidate.aliasLength > best.aliasLength) best = candidate;
    }
  }
  return best;
}

function queryLooksBranded(query, brandHint, lexicon = []) {
  if (brandHint) return { looksBranded: true, unknownBrandLikely: false };
  const tokens = tokenize(query);
  if (tokens.length < 2) return { looksBranded: false, unknownBrandLikely: false };

  const first = tokens[0];
  const second = tokens[1];
  const bigram = `${first} ${second}`;
  const trigram = tokens.length > 2 ? `${first} ${second} ${tokens[2]}` : '';
  const hasLexiconPrefix = lexicon.some(alias => alias === first || alias === bigram || alias === trigram || alias.startsWith(bigram));
  const mostlyGenericLead = GENERIC_PRODUCT_TOKENS.has(first) || GENERIC_PRODUCT_TOKENS.has(second);
  const looksBranded = !mostlyGenericLead;
  const unknownBrandLikely = looksBranded && !hasLexiconPrefix;
  return { looksBranded, unknownBrandLikely };
}

function productMatchesBrandHint(product, brandHint) {
  if (!brandHint) return true;
  const tokens = productBrandTokens(product);
  if (!tokens.length) return false;
  if (tokens.some(t => t === brandHint.canonicalBrand || brandHint.canonicalBrand.includes(t) || t.includes(brandHint.canonicalBrand))) return true;
  if (tokens.some(t => t === brandHint.matchedAlias || brandHint.matchedAlias.includes(t) || t.includes(brandHint.matchedAlias))) return true;
  return false;
}

function cleanDisplayText(value, maxLen = 180) {
  if (!value) return '';
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/\((open beauty facts|incidecoder|source:[^)]+)\)/ig, '')
    .replace(/\s+\|\s+(official|reviews?|shop|store).*$/ig, '')
    .trim()
    .slice(0, maxLen);
}

function blockedProductSetForQuery(query, negativeRules = {}) {
  const key = normalizeText(query);
  if (!key) return new Set();
  const ids = Array.isArray(negativeRules[key]) ? negativeRules[key] : [];
  return new Set(ids.map(String));
}

function normalizeIngredientText(raw) {
  if (!raw) return '';
  const scrubbed = String(raw)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/read all the geeky details about[^,\n]+here\s*>>?/ig, ' ')
    .replace(/learn more about[^,\n]+here\s*>>?/ig, ' ')
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
  if (tokens.length < 4) return { valid: false, confidence: 0.2, reason: 'parser_rejected' };
  const alphaLike = tokens.filter(t => /[a-z]/i.test(t)).length;
  const alphaRatio = alphaLike / tokens.length;
  if (alphaRatio < 0.8) return { valid: false, confidence: 0.25, reason: 'parser_rejected' };
  const badPhrase = /(hydrating|moisture|radiant|complexion|formula|texture|feeling|feels|perfect for|all skin types|boosted with|provides a burst|environmental stressors|sulfate[- ]free|paraben[- ]free|gluten[- ]free|soy[- ]free|phthalate[- ]free|vegan)/i;
  const badTokenRatio = tokens.filter(t => badPhrase.test(t) || t.split(/\s+/).length > 9).length / tokens.length;
  if (badTokenRatio > 0.25) return { valid: false, confidence: 0.2, reason: 'parser_rejected' };
  const cuePattern = /\b(aqua|water|acid|extract|oil|glycol|alcohol|sodium|potassium|phosphate|chloride|hydroxide|tocopherol|niacinamide|ceramide|peg-|poly-|ethylhexyl|butyl|acrylate|carbomer|glutamate)\b/i;
  const cueRatio = tokens.filter(t => cuePattern.test(t)).length / tokens.length;
  if (cueRatio < 0.35) return { valid: false, confidence: 0.25, reason: 'parser_rejected' };
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
  if (job.attempts >= 2 && job.lastError && !isRetryableIngredientFailure(job.lastError)) return 'unavailable_final';
  return 'unavailable_retryable';
}

function scoreProduct(query, product, brandHint) {
  const texts = listProductTexts(product);
  const best = texts.reduce((m, t) => Math.max(m, overlapScore(query, t)), 0);
  const brand = overlapScore(query, product.brand_canonical || '');
  const line = overlapScore(query, product.line || '');
  const exactNameMatch = texts.some(t => normalizeText(t) === normalizeText(query));
  const availBoost = product.ingredients_status === 'available' ? 0.15 : 0;
  const recency = product.confidence_metadata?.freshness === 'daily' ? 0.04 : 0;
  const popularity = Number(product.confidence_metadata?.popularity || 0) * 0.06;
  const sourcePriority = Math.min((Number(product.source_priority || 50) / 100) * 0.06, 0.06);
  const brandMatched = productMatchesBrandHint(product, brandHint);
  const brandGateBoost = brandHint ? (brandMatched ? 0.14 : -0.45) : 0;
  const score = (best * 0.62) + (brand * 0.14) + (line * 0.08) + availBoost + recency + popularity + sourcePriority + brandGateBoost;
  return {
    score: Math.max(0, Math.min(1, score)),
    brandMatched,
    nameSimilarity: Number(best.toFixed(3)),
    brandSimilarity: Number(brand.toFixed(3)),
    exactNameMatch
  };
}

function toResolvedProduct(product, scoring, confidence = 'low') {
  const resolutionState = inferResolutionState(product.product_id, product);
  const job = ingredientJobs.get(product.product_id);
  return {
    productId: product.product_id,
    brand: cleanDisplayText(product.brand_canonical, 80),
    name: cleanDisplayText(product.name_canonical, 180),
    line: cleanDisplayText(product.line || '', 120),
    category: cleanDisplayText(product.category || '', 120),
    imageUrl: product.image_url || '',
    ingredientsStatus: product.ingredients_status || 'missing',
    ingredientsText: product.ingredients_text || '',
    ingredientResolutionState: resolutionState,
    ingredientJobId: product.product_id,
    ingredientFailureStage: job?.lastError || '',
    confidence,
    needsConfirmation: confidence !== 'high',
    brandMatched: !!scoring.brandMatched,
    nameSimilarity: Number(scoring.nameSimilarity || 0),
    brandSimilarity: Number(scoring.brandSimilarity || 0),
    exactNameMatch: !!scoring.exactNameMatch,
    negativeRuleBlocked: !!scoring.blockedByNegativeRule,
    scoreGap: 0,
    score: Number(scoring.score.toFixed(3))
  };
}

function annotateScoreGaps(ranked) {
  if (!ranked.length) return [];
  const top = ranked[0];
  const second = ranked[1];
  const topGap = second ? Number((top.score - second.score).toFixed(3)) : 1;
  return ranked.map((item, index) => ({
    ...item,
    scoreGap: index === 0 ? topGap : Number((top.score - item.score).toFixed(3))
  }));
}

function asCandidateList(ranked, decisionReason) {
  return {
    state: 'candidate_list',
    decisionReason,
    autoResolved: false,
    candidates: ranked.slice(0, 7).map((c, i) => ({
      ...c,
      confidence: i === 0 ? 'medium' : 'low',
      needsConfirmation: true
    }))
  };
}

function classify(ranked, options = {}) {
  if (!ranked.length) return { state: 'not_found', decisionReason: 'ambiguous', autoResolved: false };
  const rankedWithGaps = annotateScoreGaps(ranked);
  const top = rankedWithGaps[0];
  const second = rankedWithGaps[1];
  const gap = second ? top.score - second.score : 1;
  const brandHintPresent = !!options.brandHintPresent;
  const unknownBrandLikely = !!options.unknownBrandLikely;
  const autoResolveEnabled = options.autoResolveEnabled !== false;
  const strictBrandGateEnabled = options.strictBrandGateEnabled !== false;
  const topBrandMismatch = brandHintPresent && !top.brandMatched;
  const weakBrandSignal = !brandHintPresent && top.brandSimilarity < 0.45;
  const strictLowBrandSignal = !brandHintPresent && top.brandSimilarity < 0.55;
  const ambiguousTop = second ? gap < 0.12 : false;
  const highQuality = (
    top.score >= 0.86 &&
    top.nameSimilarity >= 0.8 &&
    gap >= 0.15 &&
    !topBrandMismatch &&
    !weakBrandSignal
  );
  const exactHigh = highQuality && (top.exactNameMatch || top.nameSimilarity >= 0.92);
  const unknownBrandCandidates = rankedWithGaps
    .filter(item => item.brandSimilarity >= 0.55 || (item.nameSimilarity >= 0.86 && item.score >= 0.76))
    .slice(0, 7);
  const unknownBrandLowSignal = unknownBrandLikely && top.brandSimilarity < 0.5 && top.nameSimilarity < 0.86;

  if (unknownBrandLowSignal || (unknownBrandLikely && weakBrandSignal)) {
    if (!unknownBrandCandidates.length) {
      return { state: 'candidate_list', decisionReason: 'unknown_brand', autoResolved: false, candidates: [] };
    }
    return asCandidateList(unknownBrandCandidates, 'unknown_brand');
  }
  if (strictBrandGateEnabled && strictLowBrandSignal && top.nameSimilarity < 0.9) {
    if (!unknownBrandCandidates.length) {
      return { state: 'candidate_list', decisionReason: 'unknown_brand', autoResolved: false, candidates: [] };
    }
    return asCandidateList(unknownBrandCandidates, 'unknown_brand');
  }
  if (topBrandMismatch) return asCandidateList(rankedWithGaps, 'brand_mismatch');
  if (ambiguousTop) return asCandidateList(rankedWithGaps, 'low_gap');
  if (second && top.ingredientsStatus !== 'available' && second.ingredientsStatus === 'available' && gap < 0.08) {
    return asCandidateList(rankedWithGaps, 'ambiguous');
  }

  if (highQuality) {
    if (!autoResolveEnabled && !exactHigh) {
      return {
        state: 'resolved_medium',
        decisionReason: 'ambiguous',
        autoResolved: false,
        product: { ...top, confidence: 'medium', needsConfirmation: true }
      };
    }
    return {
      state: 'resolved_high',
      decisionReason: 'exact_high',
      autoResolved: true,
      product: { ...top, confidence: 'high', needsConfirmation: false }
    };
  }

  if (top.score >= 0.67 && top.nameSimilarity >= 0.58 && !topBrandMismatch && (!strictBrandGateEnabled || top.brandSimilarity >= 0.45 || brandHintPresent)) {
    return {
      state: 'resolved_medium',
      decisionReason: 'ambiguous',
      autoResolved: false,
      product: { ...top, confidence: 'medium', needsConfirmation: true }
    };
  }

  return asCandidateList(rankedWithGaps, unknownBrandLikely ? 'unknown_brand' : 'ambiguous');
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
      decisionReason: '',
      brandMismatchFlag: false,
      topCandidates: [],
      details: {}
    };
    queue.items.push(item);
  }
  item.count += 1;
  item.lastSeenAt = now;
  if (details?.decisionReason) item.decisionReason = String(details.decisionReason);
  if (typeof details?.brandMismatchFlag === 'boolean') item.brandMismatchFlag = details.brandMismatchFlag;
  if (Array.isArray(details?.topCandidates)) {
    item.topCandidates = details.topCandidates
      .slice(0, 5)
      .map(c => ({
        productId: String(c.productId || ''),
        brand: String(c.brand || ''),
        name: String(c.name || ''),
        score: Number(c.score || 0)
      }));
  }
  item.details = { ...item.details, ...details };
  writeJson(MISS_PATH, queue);
  return item;
}

function topCandidatesFromResolution(result, limit = 3) {
  const candidates = Array.isArray(result?.candidates)
    ? result.candidates.slice(0, limit)
    : (result?.product ? [result.product] : []);
  return candidates.map(c => ({
    productId: String(c.productId || ''),
    brand: String(c.brand || ''),
    name: String(c.name || ''),
    score: Number(c.score || 0)
  }));
}

function upsertCandidateSelectionFeedback(payload) {
  const queue = readCandidateFeedbackQueue();
  const now = nowIso();
  const normalizedQuery = normalizeText(payload.normalizedQuery || payload.query || '');
  const selectedProductId = String(payload.selectedProductId || '').trim();
  if (!normalizedQuery || !selectedProductId) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const queryHash = Buffer.from(normalizedQuery).toString('hex').slice(0, 16);
  const rawQuery = String(payload.query || '').trim();
  const selectionContext = ['search', 'suggestions', 'retry'].includes(String(payload.selectionContext || ''))
    ? String(payload.selectionContext)
    : 'search';
  const shownCandidateProductIds = Array.isArray(payload.shownCandidateProductIds)
    ? payload.shownCandidateProductIds.map(String).filter(Boolean).slice(0, 10)
    : [];
  const analysisStarted = !!payload.analysisStarted;
  const analysisSucceeded = !!payload.analysisSucceeded;
  const dayKey = utcDay(now);

  let item = queue.items.find(x => x.normalizedQuery === normalizedQuery);
  if (!item) {
    item = {
      queryHash,
      normalizedQuery,
      rawQuerySamples: [],
      firstSeenAt: now,
      lastSeenAt: now,
      totalSelections: 0,
      contextCounts: {},
      shownCandidateProductIds: [],
      dailySelections: {},
      mappingStats: {}
    };
    queue.items.push(item);
  }

  item.totalSelections = Number(item.totalSelections || 0) + 1;
  item.lastSeenAt = now;
  item.rawQuerySamples = [...new Set([...(item.rawQuerySamples || []), rawQuery].filter(Boolean))].slice(0, 10);
  item.contextCounts = item.contextCounts || {};
  item.contextCounts[selectionContext] = Number(item.contextCounts[selectionContext] || 0) + 1;
  item.shownCandidateProductIds = [...new Set([...(item.shownCandidateProductIds || []), ...shownCandidateProductIds])].slice(0, 20);
  item.dailySelections = trimDailyBuckets({
    ...(item.dailySelections || {}),
    [dayKey]: Number((item.dailySelections || {})[dayKey] || 0) + 1
  });
  item.mappingStats = item.mappingStats || {};

  if (!item.mappingStats[selectedProductId]) {
    item.mappingStats[selectedProductId] = {
      productId: selectedProductId,
      count: 0,
      shownCount: 0,
      analysisStarted: 0,
      analysisSucceeded: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      dailySelections: {}
    };
  }

  shownCandidateProductIds.forEach(pid => {
    if (!pid) return;
    if (!item.mappingStats[pid]) {
      item.mappingStats[pid] = {
        productId: pid,
        count: 0,
        shownCount: 0,
        analysisStarted: 0,
        analysisSucceeded: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        dailySelections: {}
      };
    }
    item.mappingStats[pid].shownCount = Number(item.mappingStats[pid].shownCount || 0) + 1;
    item.mappingStats[pid].lastSeenAt = now;
  });

  const selectedStats = item.mappingStats[selectedProductId];
  selectedStats.count = Number(selectedStats.count || 0) + 1;
  if (analysisStarted) selectedStats.analysisStarted = Number(selectedStats.analysisStarted || 0) + 1;
  if (analysisSucceeded) selectedStats.analysisSucceeded = Number(selectedStats.analysisSucceeded || 0) + 1;
  selectedStats.lastSeenAt = now;
  selectedStats.dailySelections = trimDailyBuckets({
    ...(selectedStats.dailySelections || {}),
    [dayKey]: Number((selectedStats.dailySelections || {})[dayKey] || 0) + 1
  });

  writeCandidateFeedbackQueue(queue);
  return {
    ok: true,
    normalizedQuery,
    selectedProductId,
    totalSelections: item.totalSelections
  };
}

function runResolverContractSmokeCheck() {
  const checks = [];
  const sampleQueries = [
    'estee lauder advanced night repair serum',
    'dr althea 345 relief cream',
    'allies of skin molecular silk amino hydrating cleanser'
  ];
  for (const query of sampleQueries) {
    const result = resolveAgainstCatalog(query, 'US', 'en-US');
    const hasDecisionReason = typeof result.decisionReason === 'string' && result.decisionReason.length > 0;
    const hasAutoResolved = typeof result.autoResolved === 'boolean';
    checks.push({
      query,
      state: result.state,
      hasDecisionReason,
      hasAutoResolved,
      ok: hasDecisionReason && hasAutoResolved
    });
  }
  return {
    ok: checks.every(c => c.ok),
    checked: checks.length,
    checks
  };
}

function upsertUnknownIngredient(token, source = 'resolver', sourceProductId = '') {
  const q = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const normalizedToken = normalizeIngredientToken(token);
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
      sources: {},
      sourceProductIds: [],
      sampleTokens: []
    };
    q.items.push(item);
  }
  item.count += 1;
  item.lastSeenAt = now;
  item.sources[source] = (item.sources[source] || 0) + 1;
  if (sourceProductId) {
    item.sourceProductIds = [...new Set([...(item.sourceProductIds || []), String(sourceProductId)])].slice(0, 20);
  }
  item.sampleTokens = [...new Set([...(item.sampleTokens || []), String(token)])].slice(0, 10);
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

function asCatalogProduct(product) {
  if (!product) return null;
  const aliasConfidence = (product.alias_confidence && typeof product.alias_confidence === 'object')
    ? product.alias_confidence
    : {};
  const aliasSources = Array.isArray(product.alias_sources) ? [...new Set(product.alias_sources.map(String))] : [];
  return {
    product_id: product.product_id || slugifyProductId(product.brand_canonical, product.name_canonical),
    brand_canonical: product.brand_canonical || '',
    name_canonical: product.name_canonical || '',
    name_aliases: [...new Set([...(product.name_aliases || []), normalizeText(product.name_canonical || '')].filter(Boolean))],
    brand_aliases: [...new Set([...(product.brand_aliases || []), normalizeText(product.brand_canonical || '')].filter(Boolean))],
    line: product.line || '',
    category: product.category || '',
    image_url: product.image_url || '',
    ingredients_status: product.ingredients_status || 'missing',
    ingredients_text: product.ingredients_text || '',
    ingredients_source: product.ingredients_source || '',
    ingredients_last_verified_at: product.ingredients_last_verified_at || '',
    ingredients_version_hash: product.ingredients_version_hash || '',
    ingredients_confidence: Number(product.ingredients_confidence || 0),
    source_priority: Number(product.source_priority || 50),
    confidence_metadata: {
      quality: product.confidence_metadata?.quality || 'medium',
      freshness: product.confidence_metadata?.freshness || 'daily',
      updated_at: product.confidence_metadata?.updated_at || nowIso(),
      popularity: Number(product.confidence_metadata?.popularity || 0.3)
    },
    source_urls: Array.isArray(product.source_urls) ? [...new Set(product.source_urls)] : [],
    alias_confidence: aliasConfidence,
    alias_sources: aliasSources,
    last_alias_hit_at: product.last_alias_hit_at || '',
    promotion_metadata: (product.promotion_metadata && typeof product.promotion_metadata === 'object') ? product.promotion_metadata : {}
  };
}

function ensureCatalogSeededFromIndex(catalog) {
  if (!catalog.products.length) {
    const index = readIndex();
    catalog.products = index.products.map(asCatalogProduct).filter(Boolean);
  }
  return catalog;
}

function readCatalog() {
  const fallback = { version: 1, last_updated: nowIso(), products: [] };
  const catalog = readJson(CATALOG_PATH, fallback);
  const seeded = ensureCatalogSeededFromIndex({
    version: catalog.version || 1,
    last_updated: catalog.last_updated || nowIso(),
    products: Array.isArray(catalog.products) ? catalog.products : []
  });
  if (seeded.products.length && (!Array.isArray(catalog.products) || !catalog.products.length)) {
    writeCatalog(seeded);
  }
  return seeded;
}

function writeCatalog(catalog) {
  catalog.last_updated = nowIso();
  writeJson(CATALOG_PATH, catalog);
}

function upsertCatalogProducts(products = []) {
  if (!Array.isArray(products) || !products.length) return 0;
  const catalog = readCatalog();
  let changed = 0;
  for (const raw of products) {
    const product = asCatalogProduct(raw);
    if (!product || !product.product_id || !product.name_canonical) continue;
    const existingIdx = catalog.products.findIndex(p => p.product_id === product.product_id
      || normalizeText(`${p.brand_canonical} ${p.name_canonical}`) === normalizeText(`${product.brand_canonical} ${product.name_canonical}`));
    if (existingIdx === -1) {
      catalog.products.push(product);
      changed += 1;
      continue;
    }
    const prev = asCatalogProduct(catalog.products[existingIdx]);
    catalog.products[existingIdx] = {
      ...prev,
      ...product,
      name_aliases: [...new Set([...(prev.name_aliases || []), ...(product.name_aliases || [])])],
      brand_aliases: [...new Set([...(prev.brand_aliases || []), ...(product.brand_aliases || [])])],
      source_urls: [...new Set([...(prev.source_urls || []), ...(product.source_urls || [])])],
      alias_confidence: {
        ...(prev.alias_confidence || {}),
        ...(product.alias_confidence || {})
      },
      alias_sources: [...new Set([...(prev.alias_sources || []), ...(product.alias_sources || [])])],
      promotion_metadata: {
        ...(prev.promotion_metadata || {}),
        ...(product.promotion_metadata || {})
      }
    };
    changed += 1;
  }
  if (changed) {
    writeCatalog(catalog);
    const index = readIndex();
    index.products = [...catalog.products];
    writeIndex(index);
  }
  return changed;
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
  const catalog = readCatalog();
  let changed = false;
  const query = normalizeText(normalizedQuery || '');
  const isStrongSeedMatch = (seed) => {
    if (!query) return false;
    const strongFields = [
      seed.brand_canonical,
      seed.name_canonical,
      ...(seed.brand_aliases || []),
      ...(seed.name_aliases || [])
    ]
      .map(normalizeText)
      .filter(Boolean)
      .filter(value => value.length >= 5);

    if (strongFields.some(value => query.includes(value) || value.includes(query))) return true;
    const baseScore = overlapScore(query, `${seed.brand_canonical || ''} ${seed.name_canonical || ''}`);
    return baseScore >= 0.62;
  };
  QUICK_ENRICH_CATALOG.forEach(seed => {
    if (!isStrongSeedMatch(seed)) return;
    if (!catalog.products.some(p => p.product_id === seed.product_id)) {
      catalog.products.push(asCatalogProduct(seed));
      changed = true;
    }
  });
  if (changed) {
    writeCatalog(catalog);
    const index = readIndex();
    index.products = [...catalog.products];
    writeIndex(index);
  }
  return changed;
}

function resolveAgainstCatalog(query, region, locale) {
  const normalizedQuery = normalizeText(query);
  const { corrected, applied } = applyCorrections(normalizedQuery);
  const variants = generateVariants(corrected);
  const catalog = readCatalog();
  const negativeRules = readNegativeAliasRules();
  const blockedByQuery = blockedProductSetForQuery(corrected, negativeRules);
  const brandLexicon = readBrandLexicon(catalog.products);
  const brandHint = detectBrandHint(corrected, catalog.products, brandLexicon);
  const brandSignal = queryLooksBranded(corrected, brandHint, brandLexicon);

  let ranked = [];
  variants.forEach(v => {
    const scored = catalog.products
      .map(p => {
        const result = scoreProduct(v, p, brandHint);
        const blockedByNegativeRule = blockedByQuery.has(String(p.product_id || ''));
        if (blockedByNegativeRule) result.score = Math.max(0, result.score - 0.35);
        return {
          product: ensureProductSchema(p),
          ...result,
          blockedByNegativeRule
        };
      })
      .filter(s => s.score > (brandHint ? 0.16 : 0.24))
      .map(s => toResolvedProduct(s.product, s, 'low'));
    ranked.push(...scored);
  });

  const dedup = new Map();
  ranked.forEach(r => {
    const prev = dedup.get(r.productId);
    if (!prev || prev.score < r.score) dedup.set(r.productId, r);
  });

  ranked = [...dedup.values()].sort((a, b) => {
    if (!!a.brandMatched !== !!b.brandMatched) return a.brandMatched ? -1 : 1;
    return b.score - a.score;
  });
  if (brandHint && ranked.some(r => r.brandMatched)) {
    ranked = ranked.filter(r => r.brandMatched || r.score >= 0.72);
  }

  const classified = classify(ranked, {
    brandHintPresent: !!brandHint,
    unknownBrandLikely: brandSignal.unknownBrandLikely,
    autoResolveEnabled: AUTO_RESOLVE_ENABLED,
    strictBrandGateEnabled: STRICT_BRAND_GATE_ENABLED
  });
  return {
    ...classified,
    normalized_query: corrected,
    applied_corrections: applied,
    brand_hint: brandHint?.canonicalBrand || '',
    autoResolveEnabled: AUTO_RESOLVE_ENABLED,
    strictBrandGateEnabled: STRICT_BRAND_GATE_ENABLED,
    region: region || '',
    locale: locale || ''
  };
}

async function fetchCandidatesFromConnectors(query) {
  const out = [];
  const obf = await fetchProductCandidatesFromOBF(query).catch(() => []);
  out.push(...obf);
  const inci = await fetchProductCandidatesFromIncidecoder(query).catch(() => []);
  out.push(...inci);
  if (!SIMPLE_SOURCE_MODE && out.length < 4) {
    const ai = await fetchProductCandidatesFromAI(query).catch(() => []);
    out.push(...ai);
  }
  const dedup = new Map();
  out.forEach(item => {
    if (!item) return;
    const key = normalizeText(`${item.brand_canonical} ${item.name_canonical}`);
    if (!key) return;
    if (!dedup.has(key)) dedup.set(key, item);
    else {
      const prev = dedup.get(key);
      dedup.set(key, {
        ...prev,
        ...item,
        source_urls: [...new Set([...(prev.source_urls || []), ...(item.source_urls || [])])],
        name_aliases: [...new Set([...(prev.name_aliases || []), ...(item.name_aliases || [])])],
        brand_aliases: [...new Set([...(prev.brand_aliases || []), ...(item.brand_aliases || [])])]
      });
    }
  });
  return [...dedup.values()];
}

function resolveFromConnectorCandidates(query, candidates = [], region = '', locale = '') {
  const normalized = normalizeText(query);
  const ranked = (candidates || [])
    .map(item => ensureProductSchema(item))
    .map(product => {
      const scoring = scoreProduct(normalized, product, null);
      return toResolvedProduct(product, scoring, 'low');
    })
    .filter(r => Number(r.score || 0) >= 0.2)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      state: 'candidate_list',
      decisionReason: 'unknown_brand',
      autoResolved: false,
      candidates: [],
      normalized_query: normalized,
      applied_corrections: [],
      brand_hint: '',
      autoResolveEnabled: AUTO_RESOLVE_ENABLED,
      strictBrandGateEnabled: STRICT_BRAND_GATE_ENABLED,
      region: region || '',
      locale: locale || ''
    };
  }

  const withGaps = annotateScoreGaps(ranked).slice(0, 7);
  const top = withGaps[0];
  const highEnough = top && top.score >= 0.9 && top.nameSimilarity >= 0.88 && top.scoreGap >= 0.15;
  if (highEnough) {
    return {
      state: 'resolved_medium',
      decisionReason: 'ambiguous',
      autoResolved: false,
      product: { ...top, confidence: 'medium', needsConfirmation: true },
      normalized_query: normalized,
      applied_corrections: [],
      brand_hint: '',
      autoResolveEnabled: AUTO_RESOLVE_ENABLED,
      strictBrandGateEnabled: STRICT_BRAND_GATE_ENABLED,
      region: region || '',
      locale: locale || ''
    };
  }

  return {
    ...asCandidateList(withGaps, 'ambiguous'),
    normalized_query: normalized,
    applied_corrections: [],
    brand_hint: '',
    autoResolveEnabled: AUTO_RESOLVE_ENABLED,
    strictBrandGateEnabled: STRICT_BRAND_GATE_ENABLED,
    region: region || '',
    locale: locale || ''
  };
}

async function resolveProductWithFallback(query, region, locale) {
  let result = resolveAgainstCatalog(query, region, locale);
  if (result.state === 'resolved_high') return result;

  // Keep search responsiveness high: only do live connector recall for clearly weak/no-signal cases.
  let connectorCandidates = [];
  const topScore = result.product?.score || result.candidates?.[0]?.score || 0;
  const lowTrustDecision = ['unknown_brand', 'brand_mismatch'].includes(result.decisionReason);
  const shouldLiveFetch = (
    result.state === 'not_found'
    || (result.state === 'candidate_list' && lowTrustDecision)
    || (result.state === 'candidate_list' && topScore < 0.62)
  );
  if (shouldLiveFetch) {
    connectorCandidates = await fetchCandidatesFromConnectors(result.normalized_query || query);
    if (connectorCandidates.length) {
      upsertCatalogProducts(connectorCandidates);
      result = resolveAgainstCatalog(query, region, locale);
    }
  }

  const stillWeak = (
    result.state === 'candidate_list'
    && result.decisionReason === 'unknown_brand'
    && (!Array.isArray(result.candidates) || result.candidates.length === 0)
  );
  if (stillWeak && connectorCandidates.length) {
    return resolveFromConnectorCandidates(query, connectorCandidates, region, locale);
  }

  if (result.state === 'not_found') {
    quickEnrich(result.normalized_query);
    result = resolveAgainstCatalog(query, region, locale);
  }
  return result;
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 SkinScanResolver/1.0',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      },
      signal: controller.signal
    });
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
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 SkinScanResolver/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      },
      signal: controller.signal
    });
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

async function fetchIngredientsFromOBF(query, timeoutMs = INGREDIENT_SOURCE_TIMEOUT_MS) {
  const cacheKey = `obf:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const url = `https://world.openbeautyfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,brands,ingredients_text,image_small_url,categories,url`;
  const data = await fetchJsonWithTimeout(url, timeoutMs, { 'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)' });
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

async function fetchProductCandidatesFromOBF(query) {
  const cacheKey = `obf-candidates:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;
  const url = `https://world.openbeautyfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=25&fields=product_name,brands,ingredients_text,image_small_url,categories,url`;
  const data = await fetchJsonWithTimeout(url, SOURCE_TIMEOUT_MS, { 'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)' });
  const products = (data.products || [])
    .filter(p => p.product_name && p.brands)
    .map(p => {
      const ingredientsText = normalizeIngredientText(p.ingredients_text || '');
      const quality = scoreIngredientCandidate(ingredientsText);
      const brand = String(p.brands || '').split(',')[0].trim();
      const name = String(p.product_name || '').trim();
      return asCatalogProduct({
        product_id: slugifyProductId(brand, name),
        brand_canonical: brand,
        name_canonical: name,
        name_aliases: [normalizeText(name)],
        brand_aliases: [normalizeText(brand)],
        line: '',
        category: String(p.categories || '').split(',')[0].trim(),
        image_url: p.image_small_url || '',
        ingredients_status: quality.valid ? 'available' : 'missing',
        ingredients_text: quality.valid ? ingredientsText : '',
        ingredients_source: quality.valid ? 'obf' : '',
        ingredients_last_verified_at: quality.valid ? nowIso() : '',
        ingredients_version_hash: quality.valid ? hashText(ingredientsText) : '',
        ingredients_confidence: quality.valid ? quality.confidence : 0,
        source_priority: quality.valid ? 82 : 76,
        confidence_metadata: { quality: quality.valid ? 'high' : 'medium', freshness: 'daily', updated_at: nowIso(), popularity: 0.4 },
        source_urls: p.url ? [p.url] : []
      });
    });
  setSourceCache(cacheKey, products, 6 * 60 * 60 * 1000);
  return products;
}

function parseJsonArrayFromText(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '');
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function fetchProductCandidatesFromAI(query) {
  if (!AI_FALLBACK_ENABLED || adapterOpen('ai')) return [];
  const cacheKey = `ai-candidates:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS + 2500);
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
        max_tokens: 1400,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: [
            'world.openbeautyfacts.org',
            'sephora.com',
            'ulta.com',
            'boots.com',
            'douglas.com',
            'lookfantastic.com',
            'incidecoder.com'
          ]
        }],
        messages: [{
          role: 'user',
          content: `Find up to 8 cosmetic product candidates for query "${query}". Return JSON array only:
[{"brand":"...","name":"...","category":"...","imageUrl":"...","pdpUrl":"...","ingredientsText":"optional comma list"}]`
        }]
      })
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const parsed = parseJsonArrayFromText(text);
    const mapped = parsed
      .map(row => {
        const brand = String(row.brand || '').trim();
        const name = String(row.name || '').trim();
        if (!brand || !name) return null;
        const ingredientsText = normalizeIngredientText(String(row.ingredientsText || ''));
        const quality = scoreIngredientCandidate(ingredientsText);
        return asCatalogProduct({
          product_id: slugifyProductId(brand, name),
          brand_canonical: brand,
          name_canonical: name,
          name_aliases: [normalizeText(name)],
          brand_aliases: [normalizeText(brand)],
          category: String(row.category || '').trim(),
          image_url: String(row.imageUrl || '').trim(),
          ingredients_status: quality.valid ? 'available' : 'missing',
          ingredients_text: quality.valid ? ingredientsText : '',
          ingredients_source: quality.valid ? 'ai_fallback' : '',
          ingredients_last_verified_at: quality.valid ? nowIso() : '',
          ingredients_version_hash: quality.valid ? hashText(ingredientsText) : '',
          ingredients_confidence: quality.valid ? quality.confidence : 0,
          source_priority: quality.valid ? 80 : 70,
          confidence_metadata: { quality: quality.valid ? 'medium' : 'low', freshness: 'daily', updated_at: nowIso(), popularity: 0.35 },
          source_urls: row.pdpUrl ? [String(row.pdpUrl).trim()] : []
        });
      })
      .filter(Boolean);
    setSourceCache(cacheKey, mapped, 6 * 60 * 60 * 1000);
    markAdapterSuccess('ai');
    return mapped;
  } catch (_) {
    markAdapterFailure('ai');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function slugToTitle(slug = '') {
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function splitBrandAndName(rawName = '', inferredBrand = '') {
  const name = String(rawName || '').trim();
  const brand = String(inferredBrand || '').trim();
  if (!name) return { brand, name };
  if (!brand) return { brand: '', name };
  const lowerName = name.toLowerCase();
  const lowerBrand = brand.toLowerCase();
  if (lowerName.startsWith(lowerBrand + ' ')) {
    const stripped = name.slice(brand.length).trim();
    if (stripped.length >= 3) return { brand, name: stripped };
  }
  return { brand, name };
}

function inferBrandFromName(rawName = '') {
  const tokens = String(rawName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '';
  let take = 2;
  if (tokens[1] && tokens[1].toLowerCase() === 'of' && tokens.length >= 3) take = 3;
  if (tokens[0] && tokens[0].toLowerCase() === 'dr' && tokens.length >= 2) take = 2;
  return tokens.slice(0, Math.min(4, take)).join(' ').trim();
}

function slugCandidatesFromText(value = '') {
  const normalized = normalizeText(value).replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!normalized) return [];
  const out = new Set([normalized]);
  out.add(normalized.replace(/\b(and|the)\b/g, '').replace(/-+/g, '-').replace(/^-|-$/g, ''));
  out.add(normalized.replace(/\b(cleanser|cream|serum|essence|mask|lotion)\b/g, '').replace(/-+/g, '-').replace(/^-|-$/g, ''));
  return [...out].filter(Boolean);
}

async function fetchIngredientsFromIncidecoderSlugGuesses(product, query, timeoutMs = INGREDIENT_SOURCE_TIMEOUT_MS) {
  const parts = [];
  if (product?.source_urls?.length) {
    product.source_urls
      .filter(u => String(u).includes('incidecoder.com/products/'))
      .forEach(u => parts.push(String(u).split('/products/')[1] || ''));
  }
  parts.push(...slugCandidatesFromText(`${product?.brand_canonical || ''} ${product?.name_canonical || ''}`));
  parts.push(...slugCandidatesFromText(query || ''));
  const slugs = [...new Set(parts.map(s => String(s || '').trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))].slice(0, 10);
  for (const slug of slugs) {
    const url = `https://incidecoder.com/products/${encodeURIComponent(slug)}`;
    try {
      const html = await fetchTextWithTimeout(url, timeoutMs, {
        'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)'
      });
      const parsed = extractIngredientBlockFromHtml(html, url);
      if (!parsed?.ingredientsText) continue;
      return {
        source: 'incidecoder',
        sourceUrl: url,
        ingredientsText: parsed.ingredientsText,
        confidence: parsed.confidence,
        imageUrl: '',
        category: ''
      };
    } catch (_) {}
  }
  return null;
}

async function fetchProductCandidatesFromIncidecoder(query) {
  const cacheKey = `inci-candidates:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const url = `https://incidecoder.com/search/product?query=${encodeURIComponent(query)}`;
  const text = await fetchTextWithTimeout(url, SOURCE_TIMEOUT_MS, { 'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)' });
  const links = [...String(text || '').matchAll(/href=["']\/products\/([^"']+)["'][^>]*>([^<]{3,220})</gi)]
    .map(m => ({ slug: String(m[1] || '').trim(), title: String(m[2] || '').trim() }))
    .filter(x => x.slug && x.title);

  const products = links.slice(0, 16).map(({ slug, title }) => {
    const rawName = title || slugToTitle(slug);
    const inferredBrand = inferBrandFromName(rawName);
    const split = splitBrandAndName(rawName, inferredBrand);
    const brand = split.brand || inferredBrand;
    const name = split.name || rawName;
    return asCatalogProduct({
      product_id: slugifyProductId(brand || 'incidecoder', name),
      brand_canonical: brand || '',
      name_canonical: name,
      name_aliases: [normalizeText(name), normalizeText(slug.replace(/-/g, ' '))],
      brand_aliases: brand ? [normalizeText(brand)] : [],
      line: '',
      category: '',
      image_url: '',
      ingredients_status: 'missing',
      ingredients_text: '',
      ingredients_source: '',
      ingredients_last_verified_at: '',
      ingredients_version_hash: '',
      ingredients_confidence: 0,
      source_priority: 74,
      confidence_metadata: { quality: 'medium', freshness: 'daily', updated_at: nowIso(), popularity: 0.3 },
      source_urls: [`https://incidecoder.com/products/${slug}`]
    });
  });
  setSourceCache(cacheKey, products, 6 * 60 * 60 * 1000);
  return products;
}

function parseIncidecoderSearchLinks(text) {
  return [...String(text || '').matchAll(/href=["']\/products\/([^"']+)["'][^>]*>([^<]{3,220})</gi)]
    .map(m => ({ slug: String(m[1] || '').trim(), title: String(m[2] || '').trim() }))
    .filter(x => x.slug);
}

async function fetchIngredientsFromIncidecoderSearch(query, timeoutMs = INGREDIENT_SOURCE_TIMEOUT_MS) {
  const cacheKey = `inci-ing:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const searchUrl = `https://incidecoder.com/search/product?query=${encodeURIComponent(query)}`;
  const searchHtml = await fetchTextWithTimeout(searchUrl, Math.max(1200, Math.floor(timeoutMs * 0.45)), {
    'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)'
  });
  const links = parseIncidecoderSearchLinks(searchHtml).slice(0, 4);
  if (!links.length) return null;

  for (const link of links) {
    const url = `https://incidecoder.com/products/${encodeURIComponent(link.slug)}`;
    try {
      const pageHtml = await fetchTextWithTimeout(url, Math.max(1200, Math.floor(timeoutMs * 0.55)), {
        'User-Agent': 'SkinScanResolver/1.0 (support@skinscan.local)'
      });
      const parsed = extractIngredientBlockFromHtml(pageHtml, url);
      if (!parsed) continue;
      const payload = {
        source: 'incidecoder',
        sourceUrl: url,
        ingredientsText: parsed.ingredientsText,
        confidence: parsed.confidence,
        imageUrl: '',
        category: ''
      };
      setSourceCache(cacheKey, payload, 6 * 60 * 60 * 1000);
      return payload;
    } catch (_) {
      // continue to next likely product URL
    }
  }
  return null;
}

async function fetchImmediateIngredientsByQuery(query, budgetMs = 4200) {
  const q = String(query || '').trim();
  if (!q) return null;
  const started = Date.now();
  const left = () => Math.max(250, budgetMs - (Date.now() - started));

  const inci = await fetchIngredientsFromIncidecoderSearch(q, Math.min(2800, left())).catch(() => null);
  if (inci?.ingredientsText) return inci;

  const obf = await fetchIngredientsFromOBF(q, Math.min(2200, left())).catch(() => null);
  if (obf?.ingredientsText) return obf;

  return null;
}

function buildIngredientLookupQueries(product, query) {
  const out = new Set();
  const add = (v) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s.length >= 4) out.add(s);
  };
  add(query);
  add(product?.name_canonical);
  add(`${product?.brand_canonical || ''} ${product?.name_canonical || ''}`);
  add(`${product?.brand_canonical || ''} ${String(product?.name_canonical || '').replace(product?.brand_canonical || '', '').trim()}`);
  add(String(product?.name_canonical || '').replace(/\b(cream|serum|essence|moisturizer|moisturiser|gel|lotion)\b/ig, ''));
  return [...out];
}

async function fetchImmediateIngredientsForProduct(product, query, budgetMs = 5200) {
  if (!product) return null;
  const started = Date.now();
  const left = () => Math.max(300, budgetMs - (Date.now() - started));

  const inciGuess = await fetchIngredientsFromIncidecoderSlugGuesses(product, query || `${product.brand_canonical} ${product.name_canonical}`, Math.min(2400, left())).catch(() => null);
  if (inciGuess?.ingredientsText) return inciGuess;

  const sourceUrls = Array.isArray(product.source_urls) ? product.source_urls.filter(Boolean) : [];
  if (sourceUrls.length) {
    const incidecoderUrls = sourceUrls.filter(u => String(u).toLowerCase().includes('incidecoder.com'));
    if (incidecoderUrls.length) {
      const inciHit = await fetchIngredientsFromProfileUrls(product.product_id, 'brand', incidecoderUrls, Math.min(2600, left())).catch(() => null);
      if (inciHit?.ingredientsText) return inciHit;
    }
    const retailerUrls = sourceUrls.filter(u => classifyUrlKind(u) === 'retailer');
    if (retailerUrls.length) {
      const rHit = await fetchIngredientsFromProfileUrls(product.product_id, 'retailer', retailerUrls, Math.min(2200, left())).catch(() => null);
      if (rHit?.ingredientsText) return rHit;
    }
    const brandUrls = sourceUrls.filter(u => classifyUrlKind(u) === 'brand');
    if (brandUrls.length) {
      const bHit = await fetchIngredientsFromProfileUrls(product.product_id, 'brand', brandUrls, Math.min(2200, left())).catch(() => null);
      if (bHit?.ingredientsText) return bHit;
    }
  }

  const queries = buildIngredientLookupQueries(product, query);
  for (const q of queries) {
    const hit = await fetchImmediateIngredientsByQuery(q, Math.min(2200, left())).catch(() => null);
    if (hit?.ingredientsText) return hit;
    if (left() <= 350) break;
  }
  return null;
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

function extractIngredientBlockFromHtml(text, sourceUrl = '') {
  if (!text) return null;
  const jsonLd = extractJsonLdIngredients(text);
  if (jsonLd) return jsonLd;

  const src = String(sourceUrl || '').toLowerCase();
  const isInciDecoder = src.includes('incidecoder.com');

  // Incidecoder pages often embed INCI in JS payloads rather than visible markup.
  if (isInciDecoder) {
    const inciJsonPatterns = [
      /"inci"\s*:\s*"([^"]{80,12000})"/i,
      /"ingredient_list"\s*:\s*"([^"]{80,12000})"/i,
      /"ingredients_text"\s*:\s*"([^"]{80,12000})"/i
    ];
    for (const pattern of inciJsonPatterns) {
      const m = String(text).match(pattern);
      if (!m || !m[1]) continue;
      const candidate = normalizeIngredientText(decodeHtmlEntities(m[1]).replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\u003c[^>]*\\u003e/g, ' '));
      const quality = scoreIngredientCandidate(candidate);
      if (quality.valid) return { ingredientsText: candidate, confidence: quality.confidence };
    }

    const quotedArrayMatch = String(text).match(/"ingredient_names"\s*:\s*\[([\s\S]{80,12000}?)\]/i);
    if (quotedArrayMatch && quotedArrayMatch[1]) {
      const tokens = [...quotedArrayMatch[1].matchAll(/"([^"]{2,220})"/g)].map(m => m[1]).filter(Boolean);
      const candidate = normalizeIngredientText(tokens.join(', '));
      const quality = scoreIngredientCandidate(candidate);
      if (quality.valid) return { ingredientsText: candidate, confidence: quality.confidence };
    }

    // Some INCI pages embed ingredients as objects in a large JSON payload.
    const ingredientObjectArray = String(text).match(/"ingredients"\s*:\s*\[([\s\S]{120,80000}?)\]/i);
    if (ingredientObjectArray && ingredientObjectArray[1]) {
      const names = [
        ...ingredientObjectArray[1].matchAll(/"(?:name|inci_name|inciName)"\s*:\s*"([^"]{2,220})"/gi)
      ].map(m => decodeHtmlEntities(m[1]).trim()).filter(Boolean);
      if (names.length >= 4) {
        const candidate = normalizeIngredientText(names.join(', '));
        const quality = scoreIngredientCandidate(candidate);
        if (quality.valid) return { ingredientsText: candidate, confidence: quality.confidence };
      }
    }

    // Reliable fallback for INCI product pages: "ingredients explained" links.
    const linkedIngredientNames = [
      ...String(text).matchAll(/href=["']\/ingredients\/[^"']+["'][^>]*>([^<]{2,180})</gi)
    ]
      .map(m => decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter(v => !/^(read more|show all|details?)$/i.test(v));
    if (linkedIngredientNames.length >= 4) {
      const dedup = [...new Set(linkedIngredientNames)];
      const candidate = normalizeIngredientText(dedup.join(', '));
      const quality = scoreIngredientCandidate(candidate);
      if (quality.valid) return { ingredientsText: candidate, confidence: quality.confidence };
    }
  }

  const jsonLikePatterns = [
    /"ingredients"\s*:\s*"([^"]{80,5000})"/i,
    /"ingredientsText"\s*:\s*"([^"]{80,5000})"/i,
    /"ingredientList"\s*:\s*"([^"]{80,5000})"/i,
    /"fullIngredients"\s*:\s*"([^"]{80,5000})"/i
  ];
  for (const pattern of jsonLikePatterns) {
    const m = String(text).match(pattern);
    if (!m || !m[1]) continue;
    const candidate = normalizeIngredientText(m[1].replace(/\\u003c[^>]*\\u003e/g, ' ').replace(/\\"/g, '"'));
    const quality = scoreIngredientCandidate(candidate);
    if (quality.valid) return { ingredientsText: candidate, confidence: quality.confidence };
  }

  const patterns = [
    /ingredients?\s*[:\-]<\/[^>]+>\s*<[^>]+>([\s\S]{80,3200})<\/[^>]+>/i,
    /ingredients?\s*[:\-]\s*([\s\S]{80,3200})/i,
    /full\s+ingredients?\s*[:\-]\s*([\s\S]{80,3200})/i,
    /inci\s*[:\-]\s*([\s\S]{80,3200})/i,
    /what\s+it\s+is\s+formulated\s+without[\s\S]{1,500}?ingredients?\s*[:\-]\s*([\s\S]{80,3200})/i
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

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, ' ');
}

function firstString(value) {
  if (Array.isArray(value)) {
    const found = value.find(v => typeof v === 'string' && v.trim());
    return found ? found.trim() : '';
  }
  if (typeof value === 'string') return value.trim();
  return '';
}

function productNodeFromJsonLd(parsed) {
  const nodes = [];
  if (Array.isArray(parsed)) nodes.push(...parsed);
  else if (parsed && typeof parsed === 'object') nodes.push(parsed);
  const expanded = [];
  nodes.forEach(node => {
    if (!node || typeof node !== 'object') return;
    expanded.push(node);
    if (Array.isArray(node['@graph'])) expanded.push(...node['@graph']);
  });
  return expanded.find(node => {
    const type = Array.isArray(node?.['@type']) ? node['@type'].join(',').toLowerCase() : String(node?.['@type'] || '').toLowerCase();
    return type.includes('product');
  }) || null;
}

function parseProductCandidateFromHtml(text, url = '', fallbackQuery = '') {
  const scripts = [...String(text || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  let parsedProduct = null;
  for (const block of scripts) {
    try {
      const parsed = JSON.parse(block);
      const productNode = productNodeFromJsonLd(parsed);
      if (!productNode) continue;
      const brand = firstString(productNode.brand?.name || productNode.brand);
      const name = firstString(productNode.name);
      if (!brand || !name) continue;
      parsedProduct = {
        brand,
        name,
        category: firstString(productNode.category),
        imageUrl: firstString(productNode.image),
        ingredientsText: normalizeIngredientText(firstString(productNode.ingredients || productNode.activeIngredients))
      };
      break;
    } catch (_) {}
  }

  if (!parsedProduct) {
    const titleMatch = String(text || '').match(/<title[^>]*>([\s\S]{1,260})<\/title>/i);
    const title = decodeHtmlEntities(titleMatch?.[1] || '').replace(/\s+/g, ' ').trim();
    if (title) {
      const segments = title.split(/[\-|\u2013|\u2014|·]/).map(s => s.trim()).filter(Boolean);
      const best = segments.length > 1 ? segments.slice(0, 2) : segments;
      const nameGuess = best[0] || '';
      const brandGuess = best[1] || '';
      parsedProduct = {
        brand: brandGuess || '',
        name: nameGuess || '',
        category: '',
        imageUrl: '',
        ingredientsText: ''
      };
    }
  }

  if (!parsedProduct) return null;
  const name = cleanDisplayText(parsedProduct.name, 180);
  const brand = cleanDisplayText(parsedProduct.brand, 80);
  if (!name || !brand) return null;
  if (looksGenericProductName(name)) return null;
  const ingredientQuality = scoreIngredientCandidate(parsedProduct.ingredientsText || '');
  return asCatalogProduct({
    product_id: slugifyProductId(brand, name),
    brand_canonical: brand,
    name_canonical: name,
    name_aliases: [normalizeText(name), normalizeText(fallbackQuery)],
    brand_aliases: [normalizeText(brand)],
    line: '',
    category: cleanDisplayText(parsedProduct.category || '', 100),
    image_url: parsedProduct.imageUrl || '',
    ingredients_status: ingredientQuality.valid ? 'available' : 'missing',
    ingredients_text: ingredientQuality.valid ? normalizeIngredientText(parsedProduct.ingredientsText || '') : '',
    ingredients_source: ingredientQuality.valid ? 'user_submitted_url' : '',
    ingredients_last_verified_at: ingredientQuality.valid ? nowIso() : '',
    ingredients_version_hash: ingredientQuality.valid ? hashText(parsedProduct.ingredientsText || '') : '',
    ingredients_confidence: ingredientQuality.valid ? ingredientQuality.confidence : 0,
    source_priority: 86,
    confidence_metadata: { quality: ingredientQuality.valid ? 'high' : 'medium', freshness: 'daily', updated_at: nowIso(), popularity: 0.35 },
    source_urls: url ? [url] : []
  });
}

const PRODUCT_CUE_TOKENS = new Set([
  'serum', 'cream', 'cleanser', 'essence', 'toner', 'moisturizer', 'moisturiser',
  'lotion', 'mask', 'balm', 'oil', 'ampoule', 'emulsion', 'gel', 'sunscreen',
  'sun', 'spf', 'wash', 'mist', 'peel', 'exfoliant', 'treatment'
]);

function titleCaseWords(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function inferCandidateFromQuery(query, productUrl = '', ingredientsText = '') {
  const normalized = normalizeText(query);
  const tokens = tokenize(normalized);
  if (tokens.length < 2) return null;

  let brandTokenCount = 2;
  if (tokens[1] === 'of' && tokens.length >= 3) brandTokenCount = 3;
  if (tokens[0] === 'dr' && tokens.length >= 2) brandTokenCount = 2;

  const cueIdx = tokens.findIndex((token, idx) => idx > 0 && PRODUCT_CUE_TOKENS.has(token));
  if (cueIdx > 0) {
    brandTokenCount = Math.max(1, Math.min(4, cueIdx));
  } else {
    brandTokenCount = Math.max(1, Math.min(brandTokenCount, Math.max(1, tokens.length - 1)));
  }

  const brandTokens = tokens.slice(0, brandTokenCount);
  const nameTokens = tokens.slice(brandTokenCount);
  if (!brandTokens.length || !nameTokens.length) return null;

  const brand = cleanDisplayText(titleCaseWords(brandTokens.join(' ')), 80);
  const name = cleanDisplayText(titleCaseWords(nameTokens.join(' ')), 180);
  if (!brand || !name || looksGenericProductName(name)) return null;

  const normalizedIngredients = normalizeIngredientText(ingredientsText);
  const quality = scoreIngredientCandidate(normalizedIngredients);
  return asCatalogProduct({
    product_id: slugifyProductId(brand, name),
    brand_canonical: brand,
    name_canonical: name,
    name_aliases: [normalizeText(name), normalizeText(query)],
    brand_aliases: [normalizeText(brand)],
    line: '',
    category: '',
    image_url: '',
    ingredients_status: quality.valid ? 'available' : 'missing',
    ingredients_text: quality.valid ? normalizedIngredients : '',
    ingredients_source: quality.valid ? 'user_submitted_manual' : '',
    ingredients_last_verified_at: quality.valid ? nowIso() : '',
    ingredients_version_hash: quality.valid ? hashText(normalizedIngredients) : '',
    ingredients_confidence: quality.valid ? quality.confidence : 0,
    source_priority: quality.valid ? 80 : 70,
    confidence_metadata: { quality: quality.valid ? 'medium' : 'low', freshness: 'daily', updated_at: nowIso(), popularity: 0.2 },
    source_urls: productUrl ? [productUrl] : []
  });
}

function validateIngestionCandidate(candidate, query = '') {
  if (!candidate) return { ok: false, reason: 'parser_no_product' };
  if (!String(candidate.brand_canonical || '').trim()) return { ok: false, reason: 'parser_no_brand' };
  if (!String(candidate.name_canonical || '').trim()) return { ok: false, reason: 'parser_no_name' };
  if (looksGenericProductName(candidate.name_canonical)) return { ok: false, reason: 'parser_no_name' };
  if (query) {
    const similarity = overlapScore(query, `${candidate.brand_canonical} ${candidate.name_canonical}`);
    if (similarity < 0.28) return { ok: false, reason: 'low_similarity' };
  }
  return { ok: true };
}

function updateIngestionJob(jobId, patch) {
  const jobs = readIngestionJobs();
  const job = jobs.items.find(x => x.jobId === jobId);
  if (!job) return null;
  Object.assign(job, patch || {}, { updatedAt: nowIso() });
  writeIngestionJobs(jobs);
  return job;
}

function queueSubmission(payload) {
  const now = nowIso();
  const jobId = createJobId('ingest');
  const queue = readAddProductQueue();
  const jobs = readIngestionJobs();
  queue.items.push({
    jobId,
    state: 'queued',
    attemptCount: 0,
    lastAttemptAt: '',
    failureCode: '',
    createdAt: now,
    updatedAt: now,
    processedAt: '',
    source: payload.source || 'user_add_product',
    payload: {
      query: String(payload.query || '').trim(),
      productUrl: sanitizeUrl(payload.productUrl || ''),
      barcode: String(payload.barcode || '').trim(),
      imageUrl: sanitizeUrl(payload.imageUrl || ''),
      ingredientsText: String(payload.ingredientsText || '').trim(),
      locale: String(payload.locale || '').trim(),
      region: String(payload.region || '').trim()
    }
  });
  jobs.items.push({
    jobId,
    state: 'queued',
    attemptCount: 0,
    lastAttemptAt: '',
    failureCode: '',
    createdAt: now,
    updatedAt: now,
    productId: '',
    reason: '',
    source: payload.source || 'user_add_product'
  });
  writeAddProductQueue(queue);
  writeIngestionJobs(jobs);
  return jobId;
}

async function candidateFromSubmission(submission) {
  const query = String(submission.query || '').trim();
  const productUrl = sanitizeUrl(submission.productUrl || '');
  const ingredientsText = normalizeIngredientText(submission.ingredientsText || '');
  let failureCode = '';

  if (productUrl) {
    try {
      const page = await fetchPublicPageWithGuards(productUrl, INGESTION_FETCH_BUDGET_MS);
      const parsed = parseProductCandidateFromHtml(page.text, page.finalUrl, query);
      if (parsed) {
        if (ingredientsText) {
          const quality = scoreIngredientCandidate(ingredientsText);
          if (quality.valid) {
            parsed.ingredients_text = ingredientsText;
            parsed.ingredients_status = 'available';
            parsed.ingredients_source = 'user_submitted_manual';
            parsed.ingredients_last_verified_at = nowIso();
            parsed.ingredients_version_hash = hashText(ingredientsText);
            parsed.ingredients_confidence = Math.max(parsed.ingredients_confidence || 0, quality.confidence);
          }
        }
        return { candidate: parsed, source: 'url', failureCode: '' };
      }
      failureCode = 'parser_no_product';
    } catch (err) {
      failureCode = normalizeIngestionFailureCode(err?.message, 'parser_no_product');
      if (!query) return { candidate: null, source: 'url', failureCode };
    }

    if (query && ['fetch_timeout', 'low_similarity', 'parser_no_product', 'blocked_host'].includes(failureCode)) {
      const provisional = inferCandidateFromQuery(query, productUrl, ingredientsText);
      if (provisional) {
        return { candidate: provisional, source: 'query_provisional', failureCode: '' };
      }
    }
  } else if (submission.productUrl && !productUrl && !query && !submission.barcode) {
    return { candidate: null, source: 'url', failureCode: 'invalid_url' };
  }

  if (query) {
    const resolved = await resolveProductWithFallback(query, submission.region || '', submission.locale || '');
    const rankedCandidate = resolved.product || (Array.isArray(resolved.candidates) ? resolved.candidates[0] : null);
    const rankingSafe = rankedCandidate && (
      resolved.state !== 'candidate_list'
      || (Number(rankedCandidate.brandSimilarity || 0) >= 0.55 && Number(rankedCandidate.nameSimilarity || 0) >= 0.62)
    );
    if (rankingSafe && rankedCandidate) {
      const existing = asCatalogProduct({
        product_id: rankedCandidate.productId || slugifyProductId(rankedCandidate.brand, rankedCandidate.name),
        brand_canonical: rankedCandidate.brand || '',
        name_canonical: rankedCandidate.name || '',
        category: rankedCandidate.category || '',
        image_url: rankedCandidate.imageUrl || '',
        ingredients_status: rankedCandidate.ingredientsStatus === 'available' ? 'available' : 'missing',
        ingredients_text: rankedCandidate.ingredientsText || '',
        ingredients_source: rankedCandidate.ingredientsStatus === 'available' ? 'resolver_feedback' : '',
        ingredients_last_verified_at: rankedCandidate.ingredientsStatus === 'available' ? nowIso() : '',
        ingredients_version_hash: rankedCandidate.ingredientsText ? hashText(rankedCandidate.ingredientsText) : '',
        ingredients_confidence: rankedCandidate.ingredientsStatus === 'available' ? 0.85 : 0,
        source_priority: 84,
        confidence_metadata: { quality: 'medium', freshness: 'daily', updated_at: nowIso(), popularity: 0.3 }
      });
      if (ingredientsText) {
        const quality = scoreIngredientCandidate(ingredientsText);
        if (quality.valid) {
          existing.ingredients_status = 'available';
          existing.ingredients_text = ingredientsText;
          existing.ingredients_source = 'user_submitted_manual';
          existing.ingredients_last_verified_at = nowIso();
          existing.ingredients_version_hash = hashText(ingredientsText);
          existing.ingredients_confidence = quality.confidence;
        }
      }
      return { candidate: existing, source: 'resolver', failureCode: '' };
    }
    failureCode = failureCode || normalizeIngestionFailureCode(resolved.decisionReason === 'unknown_brand' ? 'low_similarity' : 'parser_no_product', 'parser_no_product');
  }

  return { candidate: null, source: 'none', failureCode: failureCode || 'parser_no_product' };
}

async function processQueuedIngestionJobs() {
  if (ingestionWorkerRunning) return;
  ingestionWorkerRunning = true;
  try {
    for (let i = 0; i < 3; i++) {
      const queue = readAddProductQueue();
      const next = queue.items.find(item => item && item.state === 'queued' && !item.processedAt);
      if (!next) break;

      next.state = 'processing';
      next.attemptCount = Number(next.attemptCount || 0) + 1;
      next.lastAttemptAt = nowIso();
      next.failureCode = '';
      next.reason = '';
      next.updatedAt = nowIso();
      writeAddProductQueue(queue);
      updateIngestionJob(next.jobId, {
        state: 'processing',
        attemptCount: next.attemptCount,
        lastAttemptAt: next.lastAttemptAt,
        failureCode: '',
        reason: ''
      });

      try {
        const outcome = await candidateFromSubmission(next.payload || {});
        const candidate = outcome.candidate;
        const validation = validateIngestionCandidate(candidate, normalizeText(next.payload?.query || ''));
        if (!validation.ok) {
          const failureCode = normalizeIngestionFailureCode(outcome.failureCode || validation.reason, 'upsert_failed');
          next.state = 'failed';
          next.failureCode = failureCode;
          next.reason = validation.reason;
          next.processedAt = nowIso();
          next.updatedAt = nowIso();
          writeAddProductQueue(queue);
          updateIngestionJob(next.jobId, {
            state: 'failed',
            reason: validation.reason,
            failureCode,
            attemptCount: next.attemptCount,
            lastAttemptAt: next.lastAttemptAt
          });
          pushMetric('add_product_ingestion_failed', { jobId: next.jobId, reason: validation.reason, failureCode });
          continue;
        }

        try {
          upsertCatalogProducts([candidate]);
        } catch (_) {
          throw new Error('upsert_failed');
        }
        if (candidate.ingredients_status !== 'available') {
          scheduleIngredientResolution(
            candidate.product_id,
            (next.payload?.query || `${candidate.brand_canonical} ${candidate.name_canonical}`).trim(),
            next.payload?.locale || '',
            next.payload?.region || '',
            { syncMode: false, forceRetry: false }
          ).catch(() => {});
        }

        next.state = 'completed';
        next.productId = candidate.product_id;
        next.reason = '';
        next.failureCode = '';
        next.processedAt = nowIso();
        next.updatedAt = nowIso();
        writeAddProductQueue(queue);
        updateIngestionJob(next.jobId, {
          state: 'completed',
          productId: candidate.product_id,
          reason: '',
          failureCode: '',
          attemptCount: next.attemptCount,
          lastAttemptAt: next.lastAttemptAt
        });
        pushMetric('add_product_ingestion_completed', {
          jobId: next.jobId,
          productId: candidate.product_id,
          source: outcome.source
        });
      } catch (err) {
        const reason = String(err?.message || 'ingestion_failed').slice(0, 120);
        const failureCode = normalizeIngestionFailureCode(reason, 'upsert_failed');
        next.state = 'failed';
        next.reason = reason;
        next.failureCode = failureCode;
        next.processedAt = nowIso();
        next.updatedAt = nowIso();
        writeAddProductQueue(queue);
        updateIngestionJob(next.jobId, {
          state: 'failed',
          reason,
          failureCode,
          attemptCount: next.attemptCount,
          lastAttemptAt: next.lastAttemptAt
        });
        pushMetric('add_product_ingestion_failed', { jobId: next.jobId, reason, failureCode });
      }
    }
  } finally {
    ingestionWorkerRunning = false;
  }
}

function loadSourceProfiles() {
  return readJson(SOURCE_PROFILE_PATH, { products: {} });
}

function classifyUrlKind(url) {
  const host = String(url || '').toLowerCase();
  if (!host) return '';
  if (host.includes('sephora.') || host.includes('ulta.') || host.includes('boots.') || host.includes('douglas.') || host.includes('lookfantastic.')) {
    return 'retailer';
  }
  return 'brand';
}

async function discoverPdpUrls(query, product) {
  const urls = new Set([...(product.source_urls || [])]);
  const profiles = loadSourceProfiles();
  (profiles?.products?.[product.product_id]?.brand || []).forEach(u => urls.add(u));
  (profiles?.products?.[product.product_id]?.retailer || []).forEach(u => urls.add(u));

  const obfCandidates = await fetchProductCandidatesFromOBF(query).catch(() => []);
  obfCandidates
    .filter(c => overlapScore(`${query} ${product.brand_canonical} ${product.name_canonical}`, `${c.brand_canonical} ${c.name_canonical}`) >= 0.58)
    .forEach(c => (c.source_urls || []).forEach(u => urls.add(u)));

  const inciCandidates = await fetchProductCandidatesFromIncidecoder(query).catch(() => []);
  inciCandidates
    .filter(c => overlapScore(`${query} ${product.brand_canonical} ${product.name_canonical}`, `${c.brand_canonical} ${c.name_canonical}`) >= 0.5)
    .forEach(c => (c.source_urls || []).forEach(u => urls.add(u)));

  if (!SIMPLE_SOURCE_MODE && urls.size < 2) {
    const aiCandidates = await fetchProductCandidatesFromAI(query).catch(() => []);
    aiCandidates
      .filter(c => overlapScore(`${query} ${product.brand_canonical} ${product.name_canonical}`, `${c.brand_canonical} ${c.name_canonical}`) >= 0.65)
      .forEach(c => (c.source_urls || []).forEach(u => urls.add(u)));
  }
  return [...urls].filter(Boolean).slice(0, 10);
}

async function fetchIngredientsFromProfileUrls(productId, kind, explicitUrls = [], timeoutMs = INGREDIENT_SOURCE_TIMEOUT_MS) {
  const profiles = loadSourceProfiles();
  const urls = [
    ...explicitUrls.filter(url => classifyUrlKind(url) === kind),
    ...(profiles?.products?.[productId]?.[kind] || [])
  ];
  if (!Array.isArray(urls) || !urls.length) return null;

  const dedupUrls = [...new Set(urls)];
  for (const url of dedupUrls) {
    const cacheKey = `${kind}:${normalizeText(productId)}:${hashText(url).slice(0, 8)}`;
    const cached = getSourceCache(cacheKey);
    if (cached) return cached;

    const text = await fetchTextWithTimeout(url, timeoutMs);
    const parsed = extractIngredientBlockFromHtml(text, url);
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
  const raw = String(text || '');
  const ingredientsMatch = raw.match(/INGREDIENTS:\s*([\s\S]+)/i);
  let candidate = '';
  if (ingredientsMatch && ingredientsMatch[1]) {
    candidate = ingredientsMatch[1]
      .replace(/\n\s*(PRODUCT|BRAND)\s*:[^\n]*/gi, ' ')
      .replace(/\n+/g, ', ')
      .trim();
  } else {
    const parsed = parseJsonObjectFromText(raw);
    if (parsed && typeof parsed.ingredients === 'string') candidate = parsed.ingredients;
  }
  if (!candidate) return null;
  const ingredientsText = normalizeIngredientText(candidate);
  const quality = scoreIngredientCandidate(ingredientsText);
  if (!quality.valid) return null;
  return { ingredientsText, confidence: quality.confidence };
}

function parseJsonObjectFromText(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function hasCorroboration(token, canonicalName, knowledge) {
  const t = normalizeIngredientToken(token);
  const c = formatCanonicalName(canonicalName);
  if (t === c) return true;
  if (knowledge.synonyms[t] === c) return true;
  if (knowledge.canonical[c]) return true;
  return (knowledge.family_rules || []).some(rule => {
    try {
      return rule.canonical === c && new RegExp(rule.pattern, 'i').test(t);
    } catch (_) {
      return false;
    }
  });
}

function validateIngredientProposal(raw, token, knowledge) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_payload' };
  const normalizedToken = normalizeIngredientToken(token);
  const canonicalName = formatCanonicalName(raw.canonicalName || raw.canonical_name || normalizedToken);
  const confidence = String(raw.confidence || 'low').toLowerCase();
  const evidenceTier = String(raw.evidenceTier || raw.evidence_tier || confidence || 'low').toLowerCase();
  const proposal = {
    normalizedToken,
    canonicalName,
    rating: {
      acne: clampInt(raw.acne, 0, 5),
      irr: clampInt(raw.irr, 0, 3),
      dry: clampInt(raw.dry, 0, 3),
      al: clampInt(raw.al, 0, 3),
      safe: raw.safe === null ? null : (raw.safe === true || raw.safe === false ? raw.safe : null),
      func: String(raw.func || 'skin conditioning').slice(0, 120).trim() || 'skin conditioning'
    },
    synonyms: [...new Set((Array.isArray(raw.synonyms) ? raw.synonyms : []).map(formatCanonicalName).filter(Boolean).slice(0, 25))],
    confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
    evidenceTier: ['high', 'medium', 'low'].includes(evidenceTier) ? evidenceTier : 'low',
    reasoningShort: String(raw.reasoningShort || raw.reasoning_short || '').slice(0, 300),
    proposedAt: nowIso()
  };

  if (!proposal.canonicalName) return { ok: false, reason: 'missing_canonical' };
  if (proposal.confidence === 'low' && !hasCorroboration(normalizedToken, proposal.canonicalName, knowledge) && proposal.synonyms.length === 0) {
    return { ok: false, reason: 'low_confidence_no_corroboration', proposal };
  }
  return { ok: true, proposal };
}

function heuristicIngredientProposal(token, knowledge) {
  const t = normalizeIngredientToken(token);
  const canonicalIndex = readCanonicalIngredientIndex();
  const canonicalLookup = buildCanonicalSynonymLookup(canonicalIndex);
  const known = resolveIngredientKnowledge(t, knowledge, canonicalLookup);
  if (known.canonicalId) {
    return {
      canonicalName: known.canonicalId,
      acne: 0,
      irr: 0,
      dry: 0,
      al: 0,
      safe: true,
      func: 'skin conditioning',
      synonyms: [t],
      confidence: known.confidence === 'high' ? 'high' : 'medium',
      evidenceTier: 'medium',
      reasoningShort: 'Mapped via existing synonym/family knowledge.'
    };
  }
  const preset = {
    'MELALEUCA ALTERNIFOLIA TEA TREE LEAF WATER': { canonicalName: 'MELALEUCA ALTERNIFOLIA LEAF WATER', acne: 0, irr: 1, dry: 0, al: 0, safe: true, func: 'soothing/antimicrobial', confidence: 'high' },
    'C12-20 ALKYL GLUCOSIDE': { canonicalName: 'C12-20 ALKYL GLUCOSIDE', acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'emulsifier/surfactant', confidence: 'high' },
    'SODIUM DNA': { canonicalName: 'SODIUM DNA', acne: 0, irr: 0, dry: 0, al: 0, safe: true, func: 'skin conditioning', confidence: 'high' }
  }[t];
  if (preset) {
    return { ...preset, synonyms: [t], evidenceTier: 'medium', reasoningShort: 'High-frequency token with stable INCI identity.' };
  }
  if (/\bEXTRACT\b/.test(t)) {
    return {
      canonicalName: 'PLANT EXTRACT',
      acne: 0, irr: 0, dry: 0, al: 0, safe: true,
      func: 'plant extract (generic)',
      synonyms: [t],
      confidence: 'medium',
      evidenceTier: 'low',
      reasoningShort: 'Generic extract fallback.'
    };
  }
  return {
    canonicalName: t,
    acne: 0, irr: 0, dry: 0, al: 0, safe: null,
    func: 'skin conditioning',
    synonyms: [],
    confidence: 'low',
    evidenceTier: 'low',
    reasoningShort: 'Insufficient evidence; provisional neutral fallback.'
  };
}

async function proposeIngredientRating(token, knowledge) {
  const fallback = heuristicIngredientProposal(token, knowledge);
  if (!AI_FALLBACK_ENABLED || adapterOpen('ai')) {
    return { ...fallback, source: 'heuristic' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS + 2500);
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
        max_tokens: 900,
        messages: [{
          role: 'user',
          content: `Assess cosmetic ingredient safety for this INCI token: "${normalizeIngredientToken(token)}". Return strict JSON only:
{
  "canonicalName":"...",
  "acne":0-5,
  "irr":0-3,
  "dry":0-3,
  "al":0-3,
  "func":"...",
  "safe":true|false|null,
  "synonyms":["..."],
  "confidence":"high|medium|low",
  "evidenceTier":"high|medium|low",
  "reasoningShort":"<=200 chars"
}
Use conservative dermatology-aligned assumptions; do not overstate risk without evidence.`
        }]
      })
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const parsed = parseJsonObjectFromText(text);
    const validated = validateIngredientProposal(parsed, token, knowledge);
    if (!validated.ok) return { ...fallback, source: 'heuristic' };
    markAdapterSuccess('ai');
    return { ...validated.proposal, source: 'ai' };
  } catch (_) {
    markAdapterFailure('ai');
    return { ...fallback, source: 'heuristic' };
  } finally {
    clearTimeout(timer);
  }
}

function shouldAutoApproveProposal(proposal, knowledge) {
  if (!proposal) return false;
  if (proposal.confidence === 'high') return true;
  if (proposal.confidence !== 'medium') return false;
  return hasCorroboration(proposal.normalizedToken, proposal.canonicalName, knowledge) || (proposal.synonyms || []).length > 0;
}

function persistApprovedIngredientProposal(proposal, approvalState = 'approved_manual') {
  const knowledge = readIngredientKnowledge();
  const canonicalName = formatCanonicalName(proposal.canonicalName || proposal.normalizedToken);
  knowledge.canonical[canonicalName] = {
    acne: clampInt(proposal.rating?.acne, 0, 5),
    irr: clampInt(proposal.rating?.irr, 0, 3),
    dry: clampInt(proposal.rating?.dry, 0, 3),
    al: clampInt(proposal.rating?.al, 0, 3),
    safe: proposal.rating?.safe === null ? null : !!proposal.rating?.safe,
    func: String(proposal.rating?.func || 'skin conditioning').slice(0, 120)
  };
  knowledge.synonyms[proposal.normalizedToken] = canonicalName;
  (proposal.synonyms || []).forEach(s => {
    const syn = formatCanonicalName(s);
    if (syn) knowledge.synonyms[syn] = canonicalName;
  });
  if (proposal.familyRule && proposal.familyRule.pattern) {
    const exists = (knowledge.family_rules || []).some(rule => rule.pattern === proposal.familyRule.pattern && rule.canonical === canonicalName);
    if (!exists) knowledge.family_rules.push({ pattern: proposal.familyRule.pattern, canonical: canonicalName });
  }
  writeIngredientKnowledge(knowledge);

  const front = readFrontendIngredientOverrides();
  front.db[canonicalName] = knowledge.canonical[canonicalName];
  front.aliases[proposal.normalizedToken] = canonicalName;
  front.synonyms[proposal.normalizedToken] = canonicalName;
  (proposal.synonyms || []).forEach(s => {
    const syn = formatCanonicalName(s);
    if (!syn) return;
    front.aliases[syn] = canonicalName;
    front.synonyms[syn] = canonicalName;
  });
  if (proposal.familyRule && proposal.familyRule.pattern) {
    const exists = (front.familyRules || []).some(rule => rule.pattern === proposal.familyRule.pattern && rule.canonical === canonicalName);
    if (!exists) front.familyRules.push({ pattern: proposal.familyRule.pattern, canonical: canonicalName });
  }
  writeFrontendIngredientOverrides(front);

  const proposals = readIngredientProposals();
  const item = proposals.items.find(x => x.tokenHash === proposal.tokenHash);
  if (item) {
    item.state = approvalState;
    item.approvedAt = nowIso();
    item.canonicalName = canonicalName;
    item.rating = knowledge.canonical[canonicalName];
  }
  writeIngredientProposals(proposals);
}

async function fetchIngredientsFromAIFallback(query, timeoutMs = INGREDIENT_SOURCE_TIMEOUT_MS + 1200) {
  if (!AI_FALLBACK_ENABLED) return null;
  const cacheKey = `ai:${normalizeText(query)}`;
  const cached = getSourceCache(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
          allowed_domains: [
            'world.openbeautyfacts.org',
            'incidecoder.com',
            'sephora.com',
            'ulta.com',
            'boots.com',
            'douglas.com',
            'lookfantastic.com',
            'yesstyle.com',
            'stylevana.com',
            'sundayriley.com',
            'esteelauder.com',
            'dralthea.com'
          ]
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
    done: false,
    adapterTrace: []
  };
  const next = { ...prev, ...patch, updatedAt: nowIso() };
  ingredientJobs.set(productId, next);
  return next;
}

function appendJobAdapterTrace(productId, traceItem) {
  const prev = ingredientJobs.get(productId) || {};
  const trace = Array.isArray(prev.adapterTrace) ? prev.adapterTrace : [];
  const nextTrace = [...trace, { ...traceItem, ts: nowIso() }].slice(-24);
  withJobState(productId, { adapterTrace: nextTrace });
}

async function withTimeoutValue(promise, timeoutMs, fallbackValue) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallbackValue;
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), timeoutMs))
  ]);
}

async function tryAdapter(name, fn, context) {
  if (adapterOpen(name)) return { ok: false, failureStage: 'rate_limited' };
  const remaining = context.deadline - Date.now();
  if (remaining <= 120) return { ok: false, failureStage: 'source_timeout' };

  try {
    const result = await fn(Math.min(INGREDIENT_SOURCE_TIMEOUT_MS, remaining));
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

function buildAdapters(product, query, discoveredUrls = []) {
  const q = query || `${product.brand_canonical} ${product.name_canonical}`;
  const adapters = [
    {
      name: 'index-cache',
      exec: async () => {
        if (!productHasIngredients(product)) return null;
        return {
          source: 'index-cache',
          sourceUrl: '',
          ingredientsText: product.ingredients_text,
          confidence: Number(product.ingredients_confidence || 0.9),
          imageUrl: product.image_url || '',
          category: product.category || ''
        };
      }
    },
    { name: 'incidecoder_url', exec: (timeoutMs) => fetchIngredientsFromProfileUrls(product.product_id, 'brand', [...discoveredUrls, ...((product.source_urls || []).filter(u => String(u).includes('incidecoder.com')))], timeoutMs) },
    { name: 'incidecoder_slug', exec: (timeoutMs) => fetchIngredientsFromIncidecoderSlugGuesses(product, q, timeoutMs) },
    { name: 'incidecoder', exec: (timeoutMs) => fetchIngredientsFromIncidecoderSearch(q, timeoutMs) },
    { name: 'obf', exec: (timeoutMs) => fetchIngredientsFromOBF(q, timeoutMs) }
  ];
  if (!SIMPLE_SOURCE_MODE) {
    adapters.push(
      { name: 'retailer', exec: (timeoutMs) => fetchIngredientsFromProfileUrls(product.product_id, 'retailer', discoveredUrls, timeoutMs) },
      { name: 'brand', exec: (timeoutMs) => fetchIngredientsFromProfileUrls(product.product_id, 'brand', discoveredUrls, timeoutMs) },
      { name: 'ai', exec: (timeoutMs) => fetchIngredientsFromAIFallback(q, timeoutMs) }
    );
  }
  return adapters;
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
      lastError: '',
      adapterTrace: []
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

    const immediate = await fetchImmediateIngredientsForProduct(product, query || `${product.brand_canonical} ${product.name_canonical}`, 5200).catch(() => null);
    if (immediate?.ingredientsText && persistResolvedProductIngredients(productId, immediate)) {
      withJobState(productId, { state: 'available', done: true, lastError: '' });
      appendJobAdapterTrace(productId, { stage: 'adapter_success', adapter: 'direct_lookup', source: immediate.source || 'direct_lookup' });
      pushMetric('ingredient_resolve_succeeded', {
        productId,
        source: immediate.source || 'direct_lookup',
        duration_ms: Date.now() - startedAt,
        mode: options.syncMode ? 'sync' : 'async',
        matchTypeCount: { exact: 0, synonym: 0, family: 0, generic_extract: 0, unknown: 0 }
      });
      return;
    }

    const context = { deadline: Date.now() + SYNC_ENRICH_BUDGET_MS };
    const discoveryQuery = query || `${product.brand_canonical} ${product.name_canonical}`.trim();
    const discoveryBudgetMs = Math.max(350, Math.min(1800, context.deadline - Date.now() - 3200));
    const discoveredUrls = await withTimeoutValue(
      discoverPdpUrls(discoveryQuery, product).catch(() => []),
      discoveryBudgetMs,
      []
    );
    appendJobAdapterTrace(productId, { stage: 'discovery', budgetMs: discoveryBudgetMs, discoveredCount: discoveredUrls.length });
    if (discoveredUrls.length) {
      product.source_urls = [...new Set([...(product.source_urls || []), ...discoveredUrls])];
      writeIndex(index);
      upsertCatalogProducts([product]);
    }
    const adapters = buildAdapters(product, query, discoveredUrls);
    let finalFailureStage = 'no_ingredient_block_found';

    for (const adapter of adapters) {
      appendJobAdapterTrace(productId, { stage: 'adapter_start', adapter: adapter.name });
      const attempt = await tryAdapter(adapter.name, adapter.exec, context);
      if (!attempt.ok) {
        finalFailureStage = attempt.failureStage;
        appendJobAdapterTrace(productId, { stage: 'adapter_fail', adapter: adapter.name, failureStage: attempt.failureStage });
        continue;
      }

      const normalizedIngredients = normalizeIngredientText(attempt.result.ingredientsText);
      const quality = scoreIngredientCandidate(normalizedIngredients);
      if (!quality.valid) {
        finalFailureStage = quality.reason || 'validation_failed';
        appendJobAdapterTrace(productId, { stage: 'adapter_fail', adapter: adapter.name, failureStage: finalFailureStage });
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
      upsertCatalogProducts([product]);

      const knowledge = readIngredientKnowledge();
      const canonicalIndex = readCanonicalIngredientIndex();
      const canonicalLookup = buildCanonicalSynonymLookup(canonicalIndex);
      const tokens = ingredientTokens(normalizedIngredients);
      const matchTypeCount = { exact: 0, synonym: 0, family: 0, generic_extract: 0, unknown: 0 };
      tokens.forEach(token => {
        const resolved = resolveIngredientKnowledge(token, knowledge, canonicalLookup);
        if (matchTypeCount[resolved.matchType] !== undefined) matchTypeCount[resolved.matchType] += 1;
        if (resolved.matchType === 'unknown') upsertUnknownIngredient(token, 'resolver_enriched', productId);
      });

      withJobState(productId, { state: 'available', done: true, lastError: '' });
      appendJobAdapterTrace(productId, { stage: 'adapter_success', adapter: adapter.name, source: attempt.result.source });
      pushMetric('ingredient_resolve_succeeded', {
        productId,
        source: attempt.result.source,
        duration_ms: Date.now() - startedAt,
        mode: options.syncMode ? 'sync' : 'async',
        matchTypeCount
      });
      return;
    }

    const attempts = ingredientJobs.get(productId)?.attemptCount || 0;
    const nextState = (attempts >= 2 && !isRetryableIngredientFailure(finalFailureStage))
      ? 'unavailable_final'
      : 'unavailable_retryable';
    withJobState(productId, { state: nextState, done: true, lastError: finalFailureStage });
    appendJobAdapterTrace(productId, { stage: 'final', failureStage: finalFailureStage, state: nextState });

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

function persistResolvedProductIngredients(productId, resolvedPayload) {
  if (!productId || !resolvedPayload?.ingredientsText) return false;
  const normalizedIngredients = normalizeIngredientText(resolvedPayload.ingredientsText);
  const quality = scoreIngredientCandidate(normalizedIngredients);
  if (!quality.valid) return false;

  const index = readIndex();
  const product = index.products.find(x => x.product_id === productId);
  if (!product) return false;

  product.ingredients_text = normalizedIngredients;
  product.ingredients_status = 'available';
  product.ingredients_source = String(resolvedPayload.source || 'direct_lookup');
  product.ingredients_last_verified_at = nowIso();
  product.ingredients_version_hash = hashText(normalizedIngredients);
  product.ingredients_confidence = Number(resolvedPayload.confidence || quality.confidence || 0.7);
  if (resolvedPayload.imageUrl && !product.image_url) product.image_url = resolvedPayload.imageUrl;
  if (resolvedPayload.category && !product.category) product.category = resolvedPayload.category;
  product.confidence_metadata = {
    ...(product.confidence_metadata || {}),
    freshness: 'daily',
    updated_at: nowIso()
  };
  writeIndex(index);
  upsertCatalogProducts([product]);
  return true;
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

async function probeAiProxyHealth() {
  const base = String(AI_PROXY_URL || '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'missing_ai_proxy_url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(base, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: String(err?.name || err?.message || 'unreachable') };
  }
}

async function handleAiProxyBase(_req, res) {
  const health = await probeAiProxyHealth();
  sendJson(res, health.ok ? 200 : 503, {
    ok: health.ok,
    upstream: AI_PROXY_URL,
    status: health.status || 0,
    reason: health.reason || ''
  });
}

async function handleAiProxyMessages(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (_) {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  const upstream = `${String(AI_PROXY_URL || '').replace(/\/+$/, '')}/v1/messages`;
  if (!String(AI_PROXY_URL || '').trim()) {
    sendJson(res, 503, { error: 'ai_proxy_not_configured' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const upstreamRes = await fetch(upstream, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(body || {})
    });
    const text = await upstreamRes.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (_) {
      json = { error: { message: 'invalid_upstream_response' }, raw: String(text || '').slice(0, 1000) };
    }
    sendJson(res, upstreamRes.status, json);
  } catch (err) {
    const isTimeout = String(err?.name || '').toLowerCase() === 'aborterror';
    sendJson(res, isTimeout ? 504 : 503, {
      error: isTimeout ? 'ai_proxy_timeout' : 'ai_proxy_unreachable',
      message: String(err?.message || err || 'proxy_error')
    });
  } finally {
    clearTimeout(timer);
  }
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

  let result = await resolveProductWithFallback(query, region, locale);
  if (typeof result.autoResolved !== 'boolean') result.autoResolved = false;
  if (!result.decisionReason) result.decisionReason = 'ambiguous';
  if (result.state === 'candidate_list' && !Array.isArray(result.candidates)) result.candidates = [];

  if (result.state === 'not_found') {
    const miss = upsertMiss(query, result.normalized_query, 'no_candidates', {
      region,
      locale,
      decisionReason: result.decisionReason || 'ambiguous',
      brandMismatchFlag: false,
      topCandidates: topCandidatesFromResolution(result, 3)
    });
    pushMetric('resolver_not_found', { query: result.normalized_query, missCount: miss.count });
    sendJson(res, 200, result);
    return;
  }

  if (result.state === 'candidate_list' || result.state === 'resolved_medium') {
    const top = result.product || result.candidates?.[0] || null;
    const stageMap = {
      low_gap: 'low_confidence_gap',
      brand_mismatch: 'brand_mismatch',
      unknown_brand: 'unknown_brand',
      ambiguous: 'low_confidence'
    };
    upsertMiss(query, result.normalized_query, stageMap[result.decisionReason] || 'low_confidence', {
      region,
      locale,
      topCandidates: topCandidatesFromResolution(result, 3),
      topProductId: top?.productId || '',
      topBrand: top?.brand || '',
      topName: top?.name || '',
      topScore: top?.score || 0,
      decisionReason: result.decisionReason,
      brandMismatchFlag: result.decisionReason === 'brand_mismatch'
    });
  }

  pushMetric('resolver_resolved', { query: result.normalized_query, state: result.state });
  pushMetric('search_confidence_assigned', {
    query: result.normalized_query,
    state: result.state,
    decisionReason: result.decisionReason || '',
    autoResolved: !!result.autoResolved,
    confidence: result.product?.confidence || (result.candidates?.[0]?.confidence || 'low'),
    brandHint: result.brand_hint || '',
    brandMatched: result.product?.brandMatched ?? null,
    nameSimilarity: result.product?.nameSimilarity ?? (result.candidates?.[0]?.nameSimilarity ?? 0),
    brandSimilarity: result.product?.brandSimilarity ?? (result.candidates?.[0]?.brandSimilarity ?? 0),
    scoreGap: result.product?.scoreGap ?? (result.candidates?.[0]?.scoreGap ?? 0)
  });

  sendJson(res, 200, result);
}

async function handleResolveProductsFast(req, res) {
  const started = Date.now();
  const body = await readBody(req);
  const query = String(body.query || '').trim();
  const region = body.region || '';
  const locale = body.locale || '';
  if (!query) {
    sendJson(res, 400, { error: 'query_required' });
    return;
  }

  const timeoutGuard = new Promise(resolve => {
    setTimeout(() => {
      resolve({
        state: 'candidate_list',
        decisionReason: 'timeout',
        autoResolved: false,
        normalized_query: normalizeText(query),
        candidates: [],
        latencyMs: Date.now() - started
      });
    }, FAST_SEARCH_BUDGET_MS);
  });

  let result = await Promise.race([
    resolveProductWithFallback(query, region, locale),
    timeoutGuard
  ]);
  if (typeof result.autoResolved !== 'boolean') result.autoResolved = false;
  if (!result.decisionReason) result.decisionReason = 'ambiguous';
  if (result.state === 'candidate_list' && !Array.isArray(result.candidates)) result.candidates = [];
  result.latencyMs = Date.now() - started;

  pushMetric('search_fast_resolved', {
    query: result.normalized_query || normalizeText(query),
    state: result.state,
    decisionReason: result.decisionReason,
    autoResolved: !!result.autoResolved,
    latencyMs: result.latencyMs
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
      attemptCount: job?.attemptCount || 0,
      adapterTrace: Array.isArray(job?.adapterTrace) ? job.adapterTrace : []
    }
  };
}

function getRetrievalTrace(productId) {
  const index = readIndex();
  const product = index.products.find(x => x.product_id === productId);
  if (!product) return { statusCode: 404, body: { error: 'missing_product' } };
  const job = ingredientJobs.get(productId);
  return {
    statusCode: 200,
    body: {
      productId,
      state: inferResolutionState(productId, product),
      ingredientsStatus: product.ingredients_status || 'missing',
      ingredientsSource: product.ingredients_source || '',
      updatedAt: product.ingredients_last_verified_at || product.confidence_metadata?.updated_at || '',
      failureStage: job?.lastError || '',
      attemptCount: Number(job?.attemptCount || 0),
      adapterTrace: Array.isArray(job?.adapterTrace) ? job.adapterTrace : []
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

  const immediateQuery = query || `${product.brand_canonical} ${product.name_canonical}`.trim();
  const direct = await fetchImmediateIngredientsForProduct(product, immediateQuery, 3800).catch(() => null);
  if (direct?.ingredientsText) {
    const persisted = persistResolvedProductIngredients(productId, direct);
    if (persisted) {
      withJobState(productId, { state: 'available', done: true, lastError: '' });
      pushMetric('ingredient_direct_lookup_hit', {
        productId,
        source: direct.source || 'direct_lookup',
        route: 'enrich_ingredients'
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
  }

  const scheduled = await scheduleIngredientResolution(productId, immediateQuery, locale, region, {
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

async function handleCandidateSelectionFeedback(req, res) {
  const body = await readBody(req);
  const query = String(body.query || '').trim();
  const normalizedQuery = String(body.normalizedQuery || '').trim();
  const selectedProductId = String(body.selectedProductId || '').trim();
  if (!query && !normalizedQuery) {
    sendJson(res, 400, { error: 'query_required' });
    return;
  }
  if (!selectedProductId) {
    sendJson(res, 400, { error: 'selectedProductId_required' });
    return;
  }

  const feedback = upsertCandidateSelectionFeedback({
    query,
    normalizedQuery,
    shownCandidateProductIds: Array.isArray(body.shownCandidateProductIds) ? body.shownCandidateProductIds : [],
    selectedProductId,
    selectionContext: String(body.selectionContext || 'search').trim(),
    analysisStarted: !!body.analysisStarted,
    analysisSucceeded: !!body.analysisSucceeded
  });
  if (!feedback.ok) {
    sendJson(res, 400, { error: feedback.reason || 'invalid_payload' });
    return;
  }
  pushMetric('candidate_selection_feedback_received', {
    normalizedQuery: feedback.normalizedQuery,
    selectedProductId: feedback.selectedProductId,
    totalSelections: feedback.totalSelections,
    selectionContext: String(body.selectionContext || 'search').trim(),
    analysisStarted: !!body.analysisStarted,
    analysisSucceeded: !!body.analysisSucceeded
  });
  sendJson(res, 200, { ok: true, ...feedback });
}

async function handleAddProductFeedback(req, res) {
  const body = await readBody(req);
  const query = String(body.query || '').trim();
  const rawProductUrl = String(body.productUrl || '').trim();
  const productUrl = sanitizeUrl(body.productUrl || '');
  const barcode = String(body.barcode || '').trim();
  const ingredientsText = String(body.ingredientsText || '').trim();
  const imageUrl = sanitizeUrl(body.imageUrl || body.imageRef || '');
  const locale = String(body.locale || '').trim();
  const region = String(body.region || '').trim();

  if (rawProductUrl && !productUrl) {
    sendJson(res, 400, { error: 'invalid_url' });
    return;
  }
  if (!query && !productUrl && !barcode) {
    sendJson(res, 400, { error: 'query_or_productUrl_or_barcode_required' });
    return;
  }

  const ingestionJobId = queueSubmission({
    source: 'user_add_product',
    query: query || barcode,
    productUrl,
    barcode,
    imageUrl,
    ingredientsText,
    locale,
    region
  });
  pushMetric('add_product_feedback_received', {
    ingestionJobId,
    hasProductUrl: !!productUrl,
    hasBarcode: !!barcode,
    hasIngredientsText: !!ingredientsText
  });
  processQueuedIngestionJobs().catch(() => {});
  sendJson(res, 202, {
    accepted: true,
    ingestionJobId,
    state: 'queued',
    estimatedWaitMs: INGESTION_ESTIMATED_JOB_MS
  });
}

function handleIngestionStatus(_req, res, jobId) {
  const jobs = readIngestionJobs();
  const job = jobs.items.find(x => x.jobId === jobId);
  if (!job) {
    sendJson(res, 404, { error: 'ingestion_job_not_found' });
    return;
  }
  sendJson(res, 200, {
    jobId,
    state: job.state || 'queued',
    productId: job.productId || '',
    reason: job.reason || '',
    failureCode: job.failureCode || '',
    failureStage: job.failureCode || '',
    attemptCount: Number(job.attemptCount || 0),
    lastAttemptAt: job.lastAttemptAt || '',
    updatedAt: job.updatedAt || job.createdAt || '',
    source: job.source || ''
  });
}

function runNodeScript(scriptPath, args = []) {
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    timeout: 120000
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    const stderr = String(run.stderr || '').trim();
    const stdout = String(run.stdout || '').trim();
    throw new Error(stderr || stdout || `script_failed_${path.basename(scriptPath)}`);
  }
  const stdout = String(run.stdout || '').trim();
  if (!stdout) return { ok: true };
  try {
    return JSON.parse(stdout.split('\n').slice(-1)[0]);
  } catch (_) {
    return { ok: true, output: stdout };
  }
}

function enqueuePubchemEnrichment(tokens = []) {
  const clean = [...new Set((tokens || []).map(normalizeIngredientToken).filter(Boolean))].slice(0, 100);
  if (!clean.length) return;
  const child = spawn(process.execPath, [ENRICH_PUBCHEM_SCRIPT_PATH, '--tokens', clean.join('|')], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'ignore',
    detached: false
  });
  child.on('error', () => {});
}

async function handleIngestCosing(_req, res) {
  try {
    const result = runNodeScript(INGEST_COSING_SCRIPT_PATH);
    pushMetric('ingredient_cosing_ingest_run', {
      ok: !!result.ok,
      imported: Number(result.imported || 0),
      updated: Number(result.updated || 0),
      canonicalCount: Number(result.canonicalCount || 0)
    });
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err?.message || 'ingest_failed') });
  }
}

async function handleEnrichPubchem(req, res) {
  const body = await readBody(req);
  const tokens = Array.isArray(body.tokens)
    ? body.tokens.map(normalizeIngredientToken).filter(Boolean).slice(0, 200)
    : [];
  const maxItems = Number(body.maxItems || 120);
  const args = [];
  if (tokens.length) args.push('--tokens', tokens.join('|'));
  if (Number.isFinite(maxItems) && maxItems > 0) args.push('--max-items', String(Math.min(500, maxItems)));
  try {
    const result = runNodeScript(ENRICH_PUBCHEM_SCRIPT_PATH, args);
    pushMetric('ingredient_pubchem_enrich_run', {
      ok: !!result.ok,
      scanned: Number(result.scanned || 0),
      enriched: Number(result.enriched || 0),
      ambiguous: Number(result.ambiguous || 0),
      failed: Number(result.failed || 0)
    });
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err?.message || 'enrichment_failed') });
  }
}

async function handleUnknownIngredients(req, res) {
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  const source = String(body.source || 'client').trim() || 'client';
  const sourceProductId = String(body.sourceProductId || body.productId || '').trim();
  let count = 0;
  const triggerTokens = [];
  for (const token of items) {
    const rec = upsertUnknownIngredient(String(token || ''), source, sourceProductId);
    if (rec) {
      count += 1;
      if (Number(rec.count || 0) >= 3) triggerTokens.push(rec.normalizedToken);
    }
  }
  if (triggerTokens.length) enqueuePubchemEnrichment(triggerTokens);
  pushMetric('unknown_ingredient_ingested', { count, source });
  sendJson(res, 200, { ok: true, count });
}

async function handleUnknownIngredientsPropose(req, res) {
  const body = await readBody(req);
  const force = !!body.force;
  const explicitTokens = Array.isArray(body.tokens) ? body.tokens.map(normalizeIngredientToken).filter(Boolean) : [];
  const queue = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const knowledge = readIngredientKnowledge();
  const proposals = readIngredientProposals();
  const tokens = explicitTokens.length
    ? explicitTokens
    : queue.items.filter(x => (x.count || 0) >= 3).map(x => x.normalizedToken).filter(Boolean);

  const out = [];
  for (const token of tokens) {
    const tokenHash = hashText(token).slice(0, 16);
    const existing = proposals.items.find(x => x.tokenHash === tokenHash);
    if (existing && !force) {
      out.push(existing);
      continue;
    }
    const proposed = await proposeIngredientRating(token, knowledge);
    const validated = validateIngredientProposal(proposed, token, knowledge);
    const baseRecord = {
      tokenHash,
      normalizedToken: token,
      canonicalName: formatCanonicalName(proposed.canonicalName || token),
      rating: {
        acne: clampInt(proposed.acne ?? proposed.rating?.acne, 0, 5),
        irr: clampInt(proposed.irr ?? proposed.rating?.irr, 0, 3),
        dry: clampInt(proposed.dry ?? proposed.rating?.dry, 0, 3),
        al: clampInt(proposed.al ?? proposed.rating?.al, 0, 3),
        safe: proposed.safe === null ? null : (proposed.safe === true || proposed.safe === false ? proposed.safe : null),
        func: String((proposed.func ?? proposed.rating?.func) || 'skin conditioning').slice(0, 120)
      },
      synonyms: [...new Set((proposed.synonyms || []).map(formatCanonicalName).filter(Boolean))],
      confidence: ['high', 'medium', 'low'].includes(String(proposed.confidence || '').toLowerCase()) ? String(proposed.confidence).toLowerCase() : 'low',
      evidenceTier: ['high', 'medium', 'low'].includes(String(proposed.evidenceTier || '').toLowerCase()) ? String(proposed.evidenceTier).toLowerCase() : 'low',
      reasoningShort: String(proposed.reasoningShort || '').slice(0, 300),
      source: proposed.source || 'heuristic',
      state: 'proposed',
      updatedAt: nowIso()
    };
    const autoApprovedEligible = validated.ok && shouldAutoApproveProposal(validated.proposal, knowledge);
    baseRecord.autoApprovedEligible = autoApprovedEligible;
    baseRecord.validationStatus = validated.ok ? 'ok' : (validated.reason || 'invalid');
    baseRecord.state = autoApprovedEligible ? 'approved_auto' : 'proposed';

    if (existing) {
      Object.assign(existing, baseRecord);
    } else {
      proposals.items.push(baseRecord);
    }
    if (autoApprovedEligible) {
      persistApprovedIngredientProposal(baseRecord, 'approved_auto');
      pushMetric('unknown_ingredient_proposal_auto_approved', { tokenHash, canonicalName: baseRecord.canonicalName });
    } else {
      pushMetric('unknown_ingredient_proposal_created', { tokenHash, validationStatus: baseRecord.validationStatus });
    }
    out.push(baseRecord);
  }

  writeIngredientProposals(proposals);
  sendJson(res, 200, { ok: true, count: out.length, proposals: out });
}

async function handleUnknownIngredientsApply(req, res) {
  const body = await readBody(req);
  const tokenHash = String(body.tokenHash || '').trim();
  const action = String(body.action || '').trim();
  if (!tokenHash || !['approve', 'reject', 'approve_provisional'].includes(action)) {
    sendJson(res, 400, { error: 'invalid_request', required: ['tokenHash', 'action'] });
    return;
  }

  const proposals = readIngredientProposals();
  const proposal = proposals.items.find(x => x.tokenHash === tokenHash);
  if (!proposal) {
    sendJson(res, 404, { error: 'proposal_not_found' });
    return;
  }

  if (action === 'reject') {
    proposal.state = 'rejected';
    proposal.rejectedAt = nowIso();
    writeIngredientProposals(proposals);
    pushMetric('unknown_ingredient_proposal_rejected', { tokenHash });
    sendJson(res, 200, { ok: true, tokenHash, state: proposal.state });
    return;
  }

  if (action === 'approve_provisional') {
    proposal.rating = {
      acne: 0, irr: 0, dry: 0, al: 0, safe: null,
      func: String(proposal.rating?.func || 'skin conditioning')
    };
  }
  persistApprovedIngredientProposal(proposal, 'approved_manual');
  pushMetric('unknown_ingredient_proposal_applied', { tokenHash, action });
  sendJson(res, 200, { ok: true, tokenHash, state: 'approved_manual', canonicalName: proposal.canonicalName });
}

function handleCoverageMetrics(_req, res) {
  const miss = readJson(MISS_PATH, { items: [] });
  const metrics = readJson(METRICS_PATH, { events: [] });
  const feedbackQueue = readCandidateFeedbackQueue();
  const addProductQueue = readAddProductQueue();
  const ingestionJobs = readIngestionJobs();
  const index = readIndex();
  const catalog = readCatalog();
  const promotion = readJson(PROMOTION_REPORT_PATH, { promotedAliases: [] });
  const unknown = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const proposals = readIngredientProposals();
  const canonicalIndex = readCanonicalIngredientIndex();
  const ingredientKnowledge = readIngredientKnowledge();
  const contractCheck = runResolverContractSmokeCheck();
  const last24h = Date.now() - (24 * 60 * 60 * 1000);
  const recentEvents = metrics.events.filter(e => Date.parse(e.ts) >= last24h);
  const resolved = recentEvents.filter(e => e.name === 'resolver_resolved').length;
  const notFound = recentEvents.filter(e => e.name === 'resolver_not_found').length;
  const enrichStarted = recentEvents.filter(e => e.name === 'ingredient_resolve_started').length;
  const enrichSucceeded = recentEvents.filter(e => e.name === 'ingredient_resolve_succeeded').length;
  const enrichFailed = recentEvents.filter(e => e.name === 'ingredient_resolve_failed').length;
  const confidenceEvents = recentEvents.filter(e => e.name === 'search_confidence_assigned');
  const brandComparable = confidenceEvents.filter(e => typeof e.payload?.brandMatched === 'boolean');
  const brandMatchedCount = brandComparable.filter(e => e.payload.brandMatched === true).length;
  const autoResolvedEvents = confidenceEvents.filter(e => e.payload?.autoResolved);
  const autoResolvedWrong = autoResolvedEvents.filter(e => e.payload?.brandMatched === false).length;
  const candidateListCount = confidenceEvents.filter(e => e.payload?.state === 'candidate_list').length;
  const unknownBrandCount = confidenceEvents.filter(e => e.payload?.decisionReason === 'unknown_brand').length;
  const noMatchCount = recentEvents.filter(e => e.name === 'resolver_not_found').length;
  const foundRate = (resolved + notFound) ? resolved / (resolved + notFound) : 1;
  const top1BrandMatchRate = brandComparable.length ? brandMatchedCount / brandComparable.length : 1;
  const wrongAutoSelectionRate = autoResolvedEvents.length ? autoResolvedWrong / autoResolvedEvents.length : 0;
  const candidateListRate = confidenceEvents.length ? candidateListCount / confidenceEvents.length : 0;
  const unknownBrandRate = confidenceEvents.length ? unknownBrandCount / confidenceEvents.length : 0;
  const notFoundRate = (resolved + noMatchCount) ? noMatchCount / (resolved + noMatchCount) : 0;
  const feedbackRecent = feedbackQueue.items.filter(x => Date.parse(x.lastSeenAt || 0) >= last24h);
  const confirmToAnalysisRate = (() => {
    let selections = 0;
    let succeeded = 0;
    feedbackRecent.forEach(item => {
      Object.values(item.mappingStats || {}).forEach(stat => {
        selections += Number(stat.count || 0);
        succeeded += Number(stat.analysisSucceeded || 0);
      });
    });
    return selections ? (succeeded / selections) : 0;
  })();

  const payload = {
    index: {
      productCount: index.products.length,
      catalogCount: catalog.products.length,
      lastUpdated: index.last_updated
    },
    queue: {
      missCount: miss.items.length,
      topMisses: [...miss.items].sort((a, b) => b.count - a.count).slice(0, 10),
      unknownCount: unknown.items.length,
      topUnknown: [...unknown.items].sort((a, b) => b.count - a.count).slice(0, 10),
      candidateFeedbackCount: feedbackQueue.items.length,
      candidateFeedbackRecent24h: feedbackRecent.length,
      proposalCount: proposals.items.length,
      proposalPending: proposals.items.filter(x => x.state === 'proposed').length,
      proposalApproved: proposals.items.filter(x => x.state === 'approved_auto' || x.state === 'approved_manual').length,
      canonicalIngredientCount: (canonicalIndex.items || []).length,
      ratedIngredientCount: Object.keys(ingredientKnowledge.canonical || {}).length,
      ratedSynonymCount: Object.keys(ingredientKnowledge.synonyms || {}).length,
      addProductQueueCount: addProductQueue.items.length,
      addProductPendingCount: addProductQueue.items.filter(x => x.state === 'queued' || x.state === 'processing').length,
      ingestionJobsCount: ingestionJobs.items.length,
      ingestionCompletedCount: ingestionJobs.items.filter(x => x.state === 'completed').length,
      ingestionFailedCount: ingestionJobs.items.filter(x => x.state === 'failed').length
    },
    contract: contractCheck,
    kpi: contractCheck.ok ? {
      resolverFoundRate24h: Number(foundRate.toFixed(4)),
      resolverNotFound24h: notFound,
      resolverResolved24h: resolved,
      top1BrandMatchRate24h: Number(top1BrandMatchRate.toFixed(4)),
      wrongAutoSelectionRate24h: Number(wrongAutoSelectionRate.toFixed(4)),
      candidateListRate24h: Number(candidateListRate.toFixed(4)),
      unknownBrandRate24h: Number(unknownBrandRate.toFixed(4)),
      notFoundRate24h: Number(notFoundRate.toFixed(4)),
      confirmToAnalysisRate24h: Number(confirmToAnalysisRate.toFixed(4)),
      ingredientResolveStarted24h: enrichStarted,
      ingredientResolveSucceeded24h: enrichSucceeded,
      ingredientResolveFailed24h: enrichFailed,
      ingredientResolveSuccessRate24h: enrichStarted ? Number((enrichSucceeded / enrichStarted).toFixed(4)) : 1
    } : null,
    coverage: {
      unknownBrandRate: Number(unknownBrandRate.toFixed(4)),
      top1BrandMatchRate: Number(top1BrandMatchRate.toFixed(4)),
      catalogSize: Number(catalog.products.length || 0),
      aliasPromotionCount: Number(
        Array.isArray(promotion.promotedAliases)
          ? promotion.promotedAliases.length
          : (Array.isArray(promotion.items) ? promotion.items.length : 0)
      )
    }
  };
  if (!contractCheck.ok) payload.error = 'contract_check_failed';
  sendJson(res, 200, payload);
}

function handleIngredientCoverageMetrics(_req, res) {
  const metrics = readJson(METRICS_PATH, { events: [] });
  const canonicalIndex = readCanonicalIngredientIndex();
  const knowledge = readIngredientKnowledge();
  const unknown = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const report = readJson(INGREDIENT_INGESTION_REPORT_PATH, {
    generatedAt: '',
    cosing: {},
    pubchem: {}
  });
  const last24h = Date.now() - (24 * 60 * 60 * 1000);
  const recentEvents = metrics.events.filter(e => Date.parse(e.ts) >= last24h);
  const aggregate = { exact: 0, synonym: 0, family: 0, generic_extract: 0, unknown: 0 };
  recentEvents
    .filter(e => e.name === 'ingredient_resolve_succeeded' && e.payload?.matchTypeCount)
    .forEach(e => {
      Object.keys(aggregate).forEach(key => {
        aggregate[key] += Number(e.payload.matchTypeCount[key] || 0);
      });
    });
  const total = Object.values(aggregate).reduce((sum, v) => sum + v, 0);
  const rate = key => total ? Number((aggregate[key] / total).toFixed(4)) : 0;
  sendJson(res, 200, {
    canonicalCount: (canonicalIndex.items || []).length,
    ratedCanonicalCount: Object.keys(knowledge.canonical || {}).length,
    synonymCount: Object.keys(knowledge.synonyms || {}).length,
    unknownQueueCount: Array.isArray(unknown.items) ? unknown.items.length : 0,
    exactMatchRate: rate('exact'),
    synonymMatchRate: rate('synonym'),
    familyMatchRate: rate('family'),
    unknownRate: rate('unknown'),
    sourceReports: {
      generatedAt: report.generatedAt || '',
      cosing: report.cosing || {},
      pubchem: report.pubchem || {}
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

    if (req.method === 'POST' && url.pathname === '/resolver/products/fast') {
      await handleResolveProductsFast(req, res);
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/resolver/ingredients/enrich' || url.pathname === '/resolver/enrich-ingredients')) {
      await handleEnrichIngredients(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/ai-proxy/v1/messages') {
      await handleAiProxyMessages(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/feedback/candidate-selection') {
      await handleCandidateSelectionFeedback(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/feedback/add-product') {
      await handleAddProductFeedback(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/unknown-ingredients') {
      await handleUnknownIngredients(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/unknown-ingredients/propose') {
      await handleUnknownIngredientsPropose(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/unknown-ingredients/apply') {
      await handleUnknownIngredientsApply(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/ingredients/ingest-cosing') {
      await handleIngestCosing(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/ingredients/enrich-pubchem') {
      await handleEnrichPubchem(req, res);
      return;
    }

    const statusMatch = url.pathname.match(/^\/resolver\/products\/([^/]+)\/ingredients-status$/);
    if (req.method === 'GET' && statusMatch) {
      await handleIngredientsStatus(req, res, decodeURIComponent(statusMatch[1]));
      return;
    }

    const traceMatch = url.pathname.match(/^\/resolver\/debug\/product\/([^/]+)\/retrieval-trace$/);
    if (req.method === 'GET' && traceMatch) {
      const payload = getRetrievalTrace(decodeURIComponent(traceMatch[1]));
      sendJson(res, payload.statusCode, payload.body);
      return;
    }

    const ingestionStatusMatch = url.pathname.match(/^\/resolver\/ingestion-status\/([^/]+)$/);
    if (req.method === 'GET' && ingestionStatusMatch) {
      handleIngestionStatus(req, res, decodeURIComponent(ingestionStatusMatch[1]));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/resolver/coverage-metrics') {
      handleCoverageMetrics(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/resolver/ingredients/coverage-metrics') {
      handleIngredientCoverageMetrics(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/resolver/smoke-check') {
      const contract = runResolverContractSmokeCheck();
      sendJson(res, contract.ok ? 200 : 503, contract);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/resolver/ai-proxy') {
      await handleAiProxyBase(req, res);
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
        autoResolveEnabled: AUTO_RESOLVE_ENABLED,
        strictBrandGateEnabled: STRICT_BRAND_GATE_ENABLED,
        endpoints: [
          '/healthz',
          '/resolver/products',
          '/resolver/products/fast',
          '/resolver/coverage-metrics',
          '/resolver/smoke-check',
          '/resolver/ai-proxy',
          '/resolver/ai-proxy/v1/messages',
          '/resolver/feedback/candidate-selection',
          '/resolver/feedback/add-product',
          '/resolver/ingestion-status/:jobId',
          '/resolver/unknown-ingredients',
          '/resolver/unknown-ingredients/propose',
          '/resolver/unknown-ingredients/apply',
          '/resolver/ingredients/ingest-cosing',
          '/resolver/ingredients/enrich-pubchem',
          '/resolver/ingredients/coverage-metrics',
          '/resolver/debug/product/:productId/retrieval-trace'
        ]
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
  processQueuedIngestionJobs().catch(() => {});
  setInterval(() => {
    processQueuedIngestionJobs().catch(() => {});
  }, Math.max(5000, INGESTION_POLL_INTERVAL_MS));
});
