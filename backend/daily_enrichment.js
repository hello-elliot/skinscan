#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'product_index.json');
const CATALOG_PATH = path.join(DATA_DIR, 'product_catalog.json');
const BRAND_LEXICON_PATH = path.join(DATA_DIR, 'brand_lexicon.json');
const MISS_PATH = path.join(DATA_DIR, 'coverage_miss_queue.json');
const FEEDBACK_PATH = path.join(DATA_DIR, 'candidate_feedback_queue.json');
const NEGATIVE_ALIAS_RULES_PATH = path.join(DATA_DIR, 'negative_alias_rules.json');
const PROMOTION_REPORT_PATH = path.join(DATA_DIR, 'promotion_report.json');
const PROMOTION_REPORT_HISTORY_PATH = path.join(DATA_DIR, 'promotion_report_history.json');
const REVIEW_QUEUE_PATH = path.join(DATA_DIR, 'review_queue.json');
const ADD_PRODUCT_QUEUE_PATH = path.join(DATA_DIR, 'add_product_queue.json');
const INGESTION_JOBS_PATH = path.join(DATA_DIR, 'ingestion_jobs.json');
const UNKNOWN_PATH = path.join(DATA_DIR, 'unknown_ingredient_queue.json');
const LEARNED_SYNONYMS_PATH = path.join(DATA_DIR, 'ingredient_synonyms_learned.json');
const INGREDIENT_KNOWLEDGE_PATH = path.join(DATA_DIR, 'ingredient_knowledge.json');
const INGREDIENT_PROPOSALS_PATH = path.join(DATA_DIR, 'ingredient_proposals.json');
const FRONTEND_INGREDIENT_OVERRIDES_PATH = path.join(DATA_DIR, 'frontend_ingredient_overrides.json');

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

function aliasFromName(name) {
  const n = normalizeText(name);
  const aliases = new Set([n]);
  aliases.add(n.replace(/\bserum\b/g, '').trim());
  aliases.add(n.replace(/\bcream\b/g, '').trim());
  aliases.add(n.replace(/\bessence\b/g, '').trim());
  return [...aliases].filter(Boolean);
}

function overlapScore(query, text) {
  const q = normalizeText(query).split(' ').filter(Boolean);
  const t = normalizeText(text);
  if (!q.length || !t) return 0;
  const hits = q.filter(w => t.includes(w)).length;
  return hits / q.length;
}

function buildBrandLexicon(products) {
  const aliases = new Set();
  (products || []).forEach(p => {
    const brand = normalizeText(p.brand_canonical || '');
    if (brand.length >= 3) aliases.add(brand);
    (p.brand_aliases || []).forEach(alias => {
      const a = normalizeText(alias);
      if (a.length >= 3) aliases.add(a);
    });
  });
  return [...aliases].sort();
}

function generateAliasVariants(query) {
  const q = normalizeText(query);
  const out = new Set([q]);
  out.add(q.replace(/\bserum\b/g, '').trim());
  out.add(q.replace(/\bcream\b/g, '').trim());
  out.add(q.replace(/\bessence\b/g, '').trim());
  out.add(q.replace(/\s+/g, ' ').trim());
  return [...out].filter(Boolean);
}

function countRecentSelections(dailySelections = {}, days = 1) {
  const now = new Date();
  let total = 0;
  Object.entries(dailySelections || {}).forEach(([day, count]) => {
    const dt = new Date(`${day}T00:00:00Z`);
    const ageDays = Math.floor((now - dt) / (24 * 60 * 60 * 1000));
    if (ageDays >= 0 && ageDays < days) total += Number(count || 0);
  });
  return total;
}

function ensureCatalogAliasMetadata(product) {
  product.alias_confidence = (product.alias_confidence && typeof product.alias_confidence === 'object') ? product.alias_confidence : {};
  product.alias_sources = Array.isArray(product.alias_sources) ? product.alias_sources : [];
  product.promotion_metadata = (product.promotion_metadata && typeof product.promotion_metadata === 'object') ? product.promotion_metadata : {};
  product.last_alias_hit_at = product.last_alias_hit_at || '';
}

function isOlderThanDays(iso, days) {
  if (!iso) return false;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

function createId(prefix = 'job') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function compactQueueItems(items, maxItems = 5000, keepProcessedDays = 30) {
  const filtered = (items || []).filter(item => {
    if (!item) return false;
    if (!item.processedAt) return true;
    return !isOlderThanDays(item.processedAt, keepProcessedDays);
  });
  if (filtered.length <= maxItems) return filtered;
  return filtered.slice(filtered.length - maxItems);
}

function compactJobs(items, maxItems = 5000, keepCompletedDays = 30) {
  const filtered = (items || []).filter(item => {
    if (!item) return false;
    if (!['completed', 'failed'].includes(item.state)) return true;
    return !isOlderThanDays(item.updatedAt || item.createdAt || '', keepCompletedDays);
  });
  if (filtered.length <= maxItems) return filtered;
  return filtered.slice(filtered.length - maxItems);
}

function dedupeProducts(products) {
  const byKey = new Map();
  products.forEach(p => {
    const key = normalizeText(`${p.brand_canonical} ${p.name_canonical}`);
    if (!key) return;
    if (!byKey.has(key)) {
      byKey.set(key, p);
      return;
    }
    const prev = byKey.get(key);
    const merged = {
      ...prev,
      ...p,
      name_aliases: [...new Set([...(prev.name_aliases || []), ...(p.name_aliases || [])])],
      brand_aliases: [...new Set([...(prev.brand_aliases || []), ...(p.brand_aliases || [])])]
    };
    byKey.set(key, merged);
  });
  return [...byKey.values()];
}

function normalizeIngredientToken(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldAutoApproveProposal(proposal) {
  if (!proposal) return false;
  if (proposal.state && proposal.state !== 'proposed') return false;
  if (proposal.confidence === 'high') return true;
  if (proposal.confidence === 'medium' && proposal.autoApprovedEligible) return true;
  return false;
}

function main() {
  const index = readJson(INDEX_PATH, { version: 1, last_updated: new Date().toISOString(), products: [] });
  const catalog = readJson(CATALOG_PATH, { version: 1, last_updated: new Date().toISOString(), products: [] });
  const missQueue = readJson(MISS_PATH, { items: [] });
  const feedbackQueue = readJson(FEEDBACK_PATH, { items: [] });
  const negativeAliasRules = readJson(NEGATIVE_ALIAS_RULES_PATH, { rules: {} });
  const addProductQueue = readJson(ADD_PRODUCT_QUEUE_PATH, { items: [] });
  const ingestionJobs = readJson(INGESTION_JOBS_PATH, { items: [] });
  const promotionHistory = readJson(PROMOTION_REPORT_HISTORY_PATH, { items: [] });
  const unknownQueue = readJson(UNKNOWN_PATH, { items: [] });
  const learned = readJson(LEARNED_SYNONYMS_PATH, { items: [] });
  const ingredientKnowledge = readJson(INGREDIENT_KNOWLEDGE_PATH, { canonical: {}, synonyms: {}, family_rules: [] });
  const ingredientProposals = readJson(INGREDIENT_PROPOSALS_PATH, { items: [] });
  const frontendOverrides = readJson(FRONTEND_INGREDIENT_OVERRIDES_PATH, { db: {}, aliases: {}, synonyms: {}, familyRules: [] });
  const promoted = [];
  const unresolvedMisses = [];
  const promotionReport = [];
  const reviewQueue = [];
  const promotedUnknowns = [];
  const seededIngestionJobs = [];
  let autoApproved = 0;

  const normalizedProducts = index.products.map(p => ({
    ...p,
    name_aliases: [...new Set([...(p.name_aliases || []), ...aliasFromName(p.name_canonical || '')])],
    brand_aliases: [...new Set([...(p.brand_aliases || []), normalizeText(p.brand_canonical || '')])],
    alias_confidence: (p.alias_confidence && typeof p.alias_confidence === 'object') ? p.alias_confidence : {},
    alias_sources: Array.isArray(p.alias_sources) ? p.alias_sources : [],
    last_alias_hit_at: p.last_alias_hit_at || '',
    promotion_metadata: (p.promotion_metadata && typeof p.promotion_metadata === 'object') ? p.promotion_metadata : {},
    confidence_metadata: {
      ...(p.confidence_metadata || {}),
      freshness: 'daily',
      updated_at: new Date().toISOString()
    }
  }));
  index.products = normalizedProducts;
  catalog.products = dedupeProducts([...(catalog.products || []), ...normalizedProducts]);

  missQueue.items.forEach(miss => {
    if ((miss.count || 0) < 3) return;
    const query = normalizeText(miss.normalizedQuery || miss.rawQuery || '');
    if (!query) return;
    const exists = index.products.some(p => {
      const aliases = [...(p.name_aliases || []), ...(p.brand_aliases || []), p.name_canonical, p.brand_canonical].map(normalizeText);
      return aliases.some(a => a && (a.includes(query) || query.includes(a)));
    });
    if (!exists) {
      promoted.push(query);
    }
  });

  const brandLexicon = buildBrandLexicon(index.products);

  // Miss-driven lightweight enrichment: attach frequent queries as aliases only when nearest canonical product is clear.
  promoted.forEach(q => {
    const scored = index.products
      .map(p => ({
        product: p,
        score: overlapScore(q, `${p.brand_canonical || ''} ${p.name_canonical || ''}`)
      }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1];
    const clearMatch = top && top.score >= 0.75 && (!second || (top.score - second.score) >= 0.14);
    if (clearMatch) {
      top.product.name_aliases = [...new Set([...(top.product.name_aliases || []), q])];
      return;
    }
    const branded = brandLexicon.some(alias => q.startsWith(alias + ' ') || q === alias);
    unresolvedMisses.push({
      query: q,
      count: missQueue.items.find(x => normalizeText(x.normalizedQuery || x.rawQuery || '') === q)?.count || 3,
      branded,
      lastSeenAt: missQueue.items.find(x => normalizeText(x.normalizedQuery || x.rawQuery || '') === q)?.lastSeenAt || new Date().toISOString()
    });
  });

  // Seed web-ingestion queue from frequent misses and high-traffic feedback queries.
  const nowIso = new Date().toISOString();
  const existingQueuedKeys = new Set(
    (addProductQueue.items || [])
      .filter(x => x && (x.state === 'queued' || x.state === 'processing'))
      .map(x => normalizeText(x.payload?.query || ''))
      .filter(Boolean)
  );
  const pushSeededIngestion = (query, source) => {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery || existingQueuedKeys.has(normalizedQuery)) return;
    existingQueuedKeys.add(normalizedQuery);
    const jobId = createId('ingest');
    addProductQueue.items.push({
      jobId,
      state: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
      processedAt: '',
      source,
      payload: {
        query: normalizedQuery,
        productUrl: '',
        barcode: '',
        imageUrl: '',
        ingredientsText: '',
        locale: 'en-US',
        region: 'US'
      }
    });
    ingestionJobs.items.push({
      jobId,
      state: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
      productId: '',
      reason: '',
      source
    });
    seededIngestionJobs.push({ jobId, query: normalizedQuery, source });
  };
  unresolvedMisses
    .filter(miss => Number(miss.count || 0) >= 3)
    .slice(0, 120)
    .forEach(miss => pushSeededIngestion(miss.query, 'miss_queue'));
  feedbackQueue.items
    .filter(item => countRecentSelections(item.dailySelections || {}, 1) >= 3)
    .slice(0, 120)
    .forEach(item => pushSeededIngestion(item.normalizedQuery || '', 'feedback_queue'));

  // Candidate feedback promotion loop: auto-promote only when confidence is strong, route conflicts to review queue.
  feedbackQueue.items.forEach(item => {
    const normalizedQuery = normalizeText(item.normalizedQuery || '');
    if (!normalizedQuery) return;
    const mappingStats = item.mappingStats || {};
    const mappings = Object.values(mappingStats)
      .map(stat => ({
        productId: stat.productId,
        count: Number(stat.count || 0),
        dailyCount: countRecentSelections(stat.dailySelections || {}, 1),
        analysisSucceeded: Number(stat.analysisSucceeded || 0)
      }))
      .filter(x => x.productId);
    if (!mappings.length) return;

    mappings.sort((a, b) => b.count - a.count);
    const top = mappings[0];
    const second = mappings[1] || { count: 0 };
    const totalSelections = Number(item.totalSelections || mappings.reduce((sum, x) => sum + x.count, 0));
    const dailySelections = countRecentSelections(item.dailySelections || {}, 1);
    const dominantShare = totalSelections ? (top.count / totalSelections) : 0;
    const secondShare = totalSelections ? (second.count / totalSelections) : 0;
    const topProduct = index.products.find(p => p.product_id === top.productId);
    const stableProduct = !!(topProduct && topProduct.brand_canonical && topProduct.name_canonical);
    const confidence = Number((dominantShare * 0.8 + Math.min(0.2, (top.analysisSucceeded / Math.max(1, top.count)) * 0.2)).toFixed(3));

    const autoPromote = (
      dailySelections >= 3 &&
      totalSelections >= 20 &&
      dominantShare >= 0.7 &&
      secondShare <= 0.2 &&
      stableProduct
    );

    if (autoPromote) {
      const variants = generateAliasVariants(normalizedQuery);
      ensureCatalogAliasMetadata(topProduct);
      topProduct.name_aliases = [...new Set([...(topProduct.name_aliases || []), ...variants])];
      topProduct.alias_sources = [...new Set([...(topProduct.alias_sources || []), 'feedback_auto'])];
      topProduct.last_alias_hit_at = item.lastSeenAt || new Date().toISOString();
      variants.forEach(alias => {
        topProduct.alias_confidence[alias] = Math.max(Number(topProduct.alias_confidence[alias] || 0), confidence);
        topProduct.promotion_metadata[alias] = {
          promoted_from_feedback: true,
          selectedProductId: top.productId,
          count: top.count,
          confidence,
          promotedAt: new Date().toISOString()
        };
      });
      const blocked = mappings.filter(x => x.productId !== top.productId && x.count > 0).map(x => x.productId);
      if (blocked.length) {
        negativeAliasRules.rules[normalizedQuery] = [...new Set([...(negativeAliasRules.rules[normalizedQuery] || []), ...blocked])];
      }
      promotionReport.push({
        normalizedQuery,
        selectedProductId: top.productId,
        totalSelections,
        dailySelections,
        dominantShare: Number(dominantShare.toFixed(3)),
        secondShare: Number(secondShare.toFixed(3)),
        confidence,
        aliasesAdded: variants
      });
      return;
    }

    if (dailySelections >= 3) {
      reviewQueue.push({
        normalizedQuery,
        totalSelections,
        dailySelections,
        dominantProductId: top.productId,
        dominantShare: Number(dominantShare.toFixed(3)),
        secondShare: Number(secondShare.toFixed(3)),
        mappings: mappings.slice(0, 5),
        reason: !stableProduct
          ? 'no_stable_canonical_match'
          : (secondShare > 0.2 ? 'high_conflict' : 'insufficient_confidence')
      });
    }
  });

  // Promote frequently seen unknown ingredients into a review-driven learned synonyms file.
  unknownQueue.items.forEach(item => {
    if ((item.count || 0) < 3) return;
    if (!item.normalizedToken) return;
    const exists = learned.items.some(x => x.normalizedToken === item.normalizedToken);
    if (exists) return;
    learned.items.push({
      normalizedToken: item.normalizedToken,
      tokenHash: item.tokenHash,
      canonicalId: '',
      status: 'pending_review',
      count: item.count,
      firstSeenAt: item.firstSeenAt || new Date().toISOString(),
      lastSeenAt: item.lastSeenAt || new Date().toISOString()
    });
    promotedUnknowns.push(item.normalizedToken);

    const token = String(item.normalizedToken || '').trim();
    if (!token) return;
    if (ingredientKnowledge.canonical[token]) return;
    const mapped = Object.keys(ingredientKnowledge.canonical || {}).find(k => token.includes(k) || k.includes(token));
    if (mapped) {
      ingredientKnowledge.synonyms[token] = mapped;
    } else if (/EXTRACT/.test(token)) {
      ingredientKnowledge.synonyms[token] = 'PLANT EXTRACT';
    }

    const existingProposal = ingredientProposals.items.find(x => x.tokenHash === item.tokenHash);
    if (!existingProposal) {
      const canonicalName = normalizeIngredientToken(mapped || token);
      ingredientProposals.items.push({
        tokenHash: item.tokenHash,
        normalizedToken: token,
        canonicalName,
        rating: { acne: 0, irr: 0, dry: 0, al: 0, safe: null, func: 'skin conditioning' },
        synonyms: mapped ? [token] : [],
        confidence: mapped ? 'medium' : 'low',
        evidenceTier: mapped ? 'medium' : 'low',
        reasoningShort: mapped ? 'Mapped from canonical overlap during nightly enrichment.' : 'Auto-created from unknown queue.',
        state: 'proposed',
        autoApprovedEligible: !!mapped,
        updatedAt: new Date().toISOString()
      });
    }
  });

  ingredientProposals.items.forEach(p => {
    if (!shouldAutoApproveProposal(p)) return;
    const canonicalName = normalizeIngredientToken(p.canonicalName || p.normalizedToken);
    ingredientKnowledge.canonical[canonicalName] = {
      acne: Number(p.rating?.acne || 0),
      irr: Number(p.rating?.irr || 0),
      dry: Number(p.rating?.dry || 0),
      al: Number(p.rating?.al || 0),
      safe: p.rating?.safe === null ? null : !!p.rating?.safe,
      func: String(p.rating?.func || 'skin conditioning')
    };
    ingredientKnowledge.synonyms[p.normalizedToken] = canonicalName;
    (p.synonyms || []).forEach(s => {
      const syn = normalizeIngredientToken(s);
      if (syn) ingredientKnowledge.synonyms[syn] = canonicalName;
    });
    frontendOverrides.db[canonicalName] = ingredientKnowledge.canonical[canonicalName];
    frontendOverrides.aliases[p.normalizedToken] = canonicalName;
    frontendOverrides.synonyms[p.normalizedToken] = canonicalName;
    (p.synonyms || []).forEach(s => {
      const syn = normalizeIngredientToken(s);
      if (!syn) return;
      frontendOverrides.aliases[syn] = canonicalName;
      frontendOverrides.synonyms[syn] = canonicalName;
    });
    p.state = 'approved_auto';
    p.approvedAt = new Date().toISOString();
    autoApproved += 1;
  });

  index.products = index.products.map(product => {
    ensureCatalogAliasMetadata(product);
    if (product.alias_sources.includes('feedback_auto') && isOlderThanDays(product.last_alias_hit_at, 90)) {
      const staleAliases = Object.entries(product.promotion_metadata || {})
        .filter(([, meta]) => meta && meta.promoted_from_feedback)
        .map(([alias]) => alias);
      if (staleAliases.length) {
        const staleSet = new Set(staleAliases);
        product.name_aliases = (product.name_aliases || []).filter(alias => !staleSet.has(normalizeText(alias)));
        staleAliases.forEach(alias => {
          delete product.alias_confidence[alias];
          delete product.promotion_metadata[alias];
        });
      }
    }
    return product;
  });

  index.products = dedupeProducts(index.products);
  catalog.products = dedupeProducts(catalog.products);
  catalog.miss_candidates = unresolvedMisses.slice(0, 200);
  catalog.review_candidates = reviewQueue.slice(0, 200);
  index.last_updated = new Date().toISOString();
  catalog.last_updated = new Date().toISOString();
  writeJson(BRAND_LEXICON_PATH, {
    updated_at: new Date().toISOString(),
    aliases: buildBrandLexicon(index.products)
  });
  writeJson(NEGATIVE_ALIAS_RULES_PATH, {
    updated_at: new Date().toISOString(),
    rules: negativeAliasRules.rules || {}
  });
  const promotionReportPayload = {
    generated_at: new Date().toISOString(),
    items: promotionReport
  };
  writeJson(PROMOTION_REPORT_PATH, promotionReportPayload);
  promotionHistory.items = Array.isArray(promotionHistory.items) ? promotionHistory.items : [];
  promotionHistory.items.push({
    generated_at: promotionReportPayload.generated_at,
    count: promotionReport.length,
    items: promotionReport.slice(0, 250)
  });
  if (promotionHistory.items.length > 120) {
    promotionHistory.items = promotionHistory.items.slice(promotionHistory.items.length - 120);
  }
  writeJson(PROMOTION_REPORT_HISTORY_PATH, promotionHistory);
  writeJson(REVIEW_QUEUE_PATH, {
    generated_at: new Date().toISOString(),
    items: reviewQueue
  });
  addProductQueue.items = compactQueueItems(addProductQueue.items || [], 5000, 30);
  ingestionJobs.items = compactJobs(ingestionJobs.items || [], 5000, 30);
  writeJson(ADD_PRODUCT_QUEUE_PATH, addProductQueue);
  writeJson(INGESTION_JOBS_PATH, ingestionJobs);
  writeJson(INDEX_PATH, index);
  writeJson(CATALOG_PATH, catalog);
  writeJson(LEARNED_SYNONYMS_PATH, learned);
  writeJson(INGREDIENT_KNOWLEDGE_PATH, ingredientKnowledge);
  writeJson(INGREDIENT_PROPOSALS_PATH, ingredientProposals);
  writeJson(FRONTEND_INGREDIENT_OVERRIDES_PATH, frontendOverrides);

  console.log(JSON.stringify({
    ok: true,
    productCount: index.products.length,
    catalogCount: catalog.products.length,
    promotedMisses: promoted.length,
    unresolvedMisses: unresolvedMisses.length,
    autoPromotions: promotionReport.length,
    seededIngestionJobs: seededIngestionJobs.length,
    reviewQueueCount: reviewQueue.length,
    brandLexiconSize: buildBrandLexicon(index.products).length,
    promotedUnknowns: promotedUnknowns.length,
    proposalCount: ingredientProposals.items.length,
    autoApproved
  }, null, 2));
}

main();
