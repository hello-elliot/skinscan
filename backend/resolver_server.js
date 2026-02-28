#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const SOURCE_PROFILE_PATH = path.join(DATA_DIR, 'product_source_profiles.json');
const INGREDIENT_KNOWLEDGE_PATH = path.join(DATA_DIR, 'ingredient_knowledge.json');
const INGREDIENT_PROPOSALS_PATH = path.join(DATA_DIR, 'ingredient_proposals.json');
const FRONTEND_INGREDIENT_OVERRIDES_PATH = path.join(DATA_DIR, 'frontend_ingredient_overrides.json');

const SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 3000;
const SYNC_ENRICH_BUDGET_MS = 10000;
const ASYNC_POLL_BUDGET_MS = 8000;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 3;
const AI_PROXY_URL = process.env.AI_PROXY_URL || 'https://skinscan-proxy.kelly-f.workers.dev';
const AI_FALLBACK_ENABLED = String(process.env.AI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_RESOLVE_ENABLED = String(process.env.AUTO_RESOLVE_ENABLED || 'true').toLowerCase() !== 'false';

const GENERIC_PRODUCT_TOKENS = new Set([
  'serum', 'cream', 'cleanser', 'toner', 'essence', 'mask', 'moisturizer', 'moisturising', 'moisturizing',
  'gel', 'lotion', 'balm', 'oil', 'ampoule', 'sunscreen', 'sun', 'spf', 'treatment', 'repair', 'hydrating',
  'hydration', 'night', 'day', 'water', 'face', 'skin', 'advanced', 'relief', 'first', 'care'
]);

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

function resolveIngredientKnowledge(token, knowledge) {
  const normalizedToken = normalizeIngredientToken(token);
  if (!normalizedToken) return { normalizedToken: '', matchType: 'unknown', canonicalId: '', confidence: 'low' };
  if (knowledge.canonical[normalizedToken]) {
    return { normalizedToken, matchType: 'exact', canonicalId: normalizedToken, confidence: 'high' };
  }
  const mapped = knowledge.synonyms[normalizedToken];
  if (mapped && knowledge.canonical[mapped]) {
    return { normalizedToken, matchType: 'synonym', canonicalId: mapped, confidence: 'medium' };
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
  const topBrandMismatch = brandHintPresent && !top.brandMatched;
  const weakBrandSignal = !brandHintPresent && top.brandSimilarity < 0.45;
  const ambiguousTop = second ? gap < 0.12 : false;
  const highQuality = (
    top.score >= 0.86 &&
    top.nameSimilarity >= 0.8 &&
    gap >= 0.15 &&
    !topBrandMismatch &&
    !weakBrandSignal
  );
  const exactHigh = highQuality && (top.exactNameMatch || top.nameSimilarity >= 0.92);

  if (unknownBrandLikely && weakBrandSignal) return asCandidateList(rankedWithGaps, 'unknown_brand');
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

  if (top.score >= 0.67 && top.nameSimilarity >= 0.58 && !topBrandMismatch) {
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
    source_urls: Array.isArray(product.source_urls) ? [...new Set(product.source_urls)] : []
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
      source_urls: [...new Set([...(prev.source_urls || []), ...(product.source_urls || [])])]
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
  QUICK_ENRICH_CATALOG.forEach(seed => {
    const seedTexts = listProductTexts(seed).map(normalizeText);
    if (!seedTexts.some(t => t && (normalizedQuery.includes(t) || t.includes(normalizedQuery)))) return;
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
  const brandLexicon = readBrandLexicon(catalog.products);
  const brandHint = detectBrandHint(corrected, catalog.products, brandLexicon);
  const brandSignal = queryLooksBranded(corrected, brandHint, brandLexicon);

  let ranked = [];
  variants.forEach(v => {
    const scored = catalog.products
      .map(p => {
        const result = scoreProduct(v, p, brandHint);
        return { product: ensureProductSchema(p), ...result };
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
    autoResolveEnabled: AUTO_RESOLVE_ENABLED
  });
  return {
    ...classified,
    normalized_query: corrected,
    applied_corrections: applied,
    brand_hint: brandHint?.canonicalBrand || '',
    autoResolveEnabled: AUTO_RESOLVE_ENABLED,
    region: region || '',
    locale: locale || ''
  };
}

async function fetchCandidatesFromConnectors(query) {
  const out = [];
  const obf = await fetchProductCandidatesFromOBF(query).catch(() => []);
  out.push(...obf);
  if (out.length < 4) {
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

async function resolveProductWithFallback(query, region, locale) {
  let result = resolveAgainstCatalog(query, region, locale);
  if (result.state === 'resolved_high') return result;

  const topScore = result.product?.score || result.candidates?.[0]?.score || 0;
  const lowTrustDecision = ['unknown_brand', 'brand_mismatch'].includes(result.decisionReason);
  if (result.state === 'not_found' || topScore < 0.72 || lowTrustDecision) {
    const candidates = await fetchCandidatesFromConnectors(result.normalized_query || query);
    if (candidates.length) {
      upsertCatalogProducts(candidates);
      result = resolveAgainstCatalog(query, region, locale);
    }
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

  if (urls.size < 2) {
    const aiCandidates = await fetchProductCandidatesFromAI(query).catch(() => []);
    aiCandidates
      .filter(c => overlapScore(`${query} ${product.brand_canonical} ${product.name_canonical}`, `${c.brand_canonical} ${c.name_canonical}`) >= 0.65)
      .forEach(c => (c.source_urls || []).forEach(u => urls.add(u)));
  }
  return [...urls].filter(Boolean).slice(0, 10);
}

async function fetchIngredientsFromProfileUrls(productId, kind, explicitUrls = []) {
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
  const known = resolveIngredientKnowledge(t, knowledge);
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

function buildAdapters(product, query, discoveredUrls = []) {
  const q = query || `${product.brand_canonical} ${product.name_canonical}`;
  return [
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
    { name: 'obf', exec: () => fetchIngredientsFromOBF(q) },
    { name: 'retailer', exec: () => fetchIngredientsFromProfileUrls(product.product_id, 'retailer', discoveredUrls) },
    { name: 'brand', exec: () => fetchIngredientsFromProfileUrls(product.product_id, 'brand', discoveredUrls) },
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
    const discoveryQuery = query || `${product.brand_canonical} ${product.name_canonical}`.trim();
    const discoveredUrls = await discoverPdpUrls(discoveryQuery, product).catch(() => []);
    if (discoveredUrls.length) {
      product.source_urls = [...new Set([...(product.source_urls || []), ...discoveredUrls])];
      writeIndex(index);
      upsertCatalogProducts([product]);
    }
    const adapters = buildAdapters(product, query, discoveredUrls);
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
      upsertCatalogProducts([product]);

      const knowledge = readIngredientKnowledge();
      const tokens = ingredientTokens(normalizedIngredients);
      const matchTypeCount = { exact: 0, synonym: 0, family: 0, generic_extract: 0, unknown: 0 };
      tokens.forEach(token => {
        const resolved = resolveIngredientKnowledge(token, knowledge);
        if (matchTypeCount[resolved.matchType] !== undefined) matchTypeCount[resolved.matchType] += 1;
        if (resolved.matchType === 'unknown') upsertUnknownIngredient(token, 'resolver_enriched', productId);
      });

      withJobState(productId, { state: 'available', done: true, lastError: '' });
      pushMetric('ingredient_resolve_succeeded', {
        productId,
        source: attempt.result.source,
        duration_ms: Date.now() - startedAt,
        mode: options.syncMode ? 'sync' : 'async',
        matchTypeCount
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

  let result = await resolveProductWithFallback(query, region, locale);
  if (typeof result.autoResolved !== 'boolean') result.autoResolved = false;
  if (!result.decisionReason) result.decisionReason = 'ambiguous';

  if (result.state === 'not_found') {
    const miss = upsertMiss(query, result.normalized_query, 'no_candidates', { region, locale });
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
      topProductId: top?.productId || '',
      topBrand: top?.brand || '',
      topName: top?.name || '',
      topScore: top?.score || 0,
      decisionReason: result.decisionReason
    });
  }

  pushMetric('resolver_resolved', { query: result.normalized_query, state: result.state });
  result = await enrichResolutionPayload(result, query, locale, region, { syncMode: true, forceRetry: false });
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
  const sourceProductId = String(body.sourceProductId || body.productId || '').trim();
  let count = 0;
  for (const token of items) {
    const rec = upsertUnknownIngredient(String(token || ''), source, sourceProductId);
    if (rec) count += 1;
  }
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
  const index = readIndex();
  const catalog = readCatalog();
  const unknown = readJson(UNKNOWN_QUEUE_PATH, { items: [] });
  const proposals = readIngredientProposals();
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
  const noMatchCount = recentEvents.filter(e => e.name === 'resolver_not_found').length;
  const foundRate = (resolved + notFound) ? resolved / (resolved + notFound) : 1;
  const top1BrandMatchRate = brandComparable.length ? brandMatchedCount / brandComparable.length : 1;
  const wrongAutoSelectionRate = autoResolvedEvents.length ? autoResolvedWrong / autoResolvedEvents.length : 0;
  const candidateListRate = confidenceEvents.length ? candidateListCount / confidenceEvents.length : 0;
  const notFoundRate = (resolved + noMatchCount) ? noMatchCount / (resolved + noMatchCount) : 0;

  sendJson(res, 200, {
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
      proposalCount: proposals.items.length,
      proposalPending: proposals.items.filter(x => x.state === 'proposed').length,
      proposalApproved: proposals.items.filter(x => x.state === 'approved_auto' || x.state === 'approved_manual').length
    },
    kpi: {
      resolverFoundRate24h: Number(foundRate.toFixed(4)),
      resolverNotFound24h: notFound,
      resolverResolved24h: resolved,
      top1BrandMatchRate24h: Number(top1BrandMatchRate.toFixed(4)),
      wrongAutoSelectionRate24h: Number(wrongAutoSelectionRate.toFixed(4)),
      candidateListRate24h: Number(candidateListRate.toFixed(4)),
      notFoundRate24h: Number(notFoundRate.toFixed(4)),
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

    if (req.method === 'POST' && url.pathname === '/resolver/unknown-ingredients/propose') {
      await handleUnknownIngredientsPropose(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resolver/unknown-ingredients/apply') {
      await handleUnknownIngredientsApply(req, res);
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
        autoResolveEnabled: AUTO_RESOLVE_ENABLED,
        endpoints: [
          '/healthz',
          '/resolver/products',
          '/resolver/coverage-metrics',
          '/resolver/unknown-ingredients',
          '/resolver/unknown-ingredients/propose',
          '/resolver/unknown-ingredients/apply'
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
});
