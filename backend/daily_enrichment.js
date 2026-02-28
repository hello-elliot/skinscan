#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'product_index.json');
const CATALOG_PATH = path.join(DATA_DIR, 'product_catalog.json');
const MISS_PATH = path.join(DATA_DIR, 'coverage_miss_queue.json');
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
  const unknownQueue = readJson(UNKNOWN_PATH, { items: [] });
  const learned = readJson(LEARNED_SYNONYMS_PATH, { items: [] });
  const ingredientKnowledge = readJson(INGREDIENT_KNOWLEDGE_PATH, { canonical: {}, synonyms: {}, family_rules: [] });
  const ingredientProposals = readJson(INGREDIENT_PROPOSALS_PATH, { items: [] });
  const frontendOverrides = readJson(FRONTEND_INGREDIENT_OVERRIDES_PATH, { db: {}, aliases: {}, synonyms: {}, familyRules: [] });
  const promoted = [];
  const promotedUnknowns = [];
  let autoApproved = 0;

  const normalizedProducts = index.products.map(p => ({
    ...p,
    name_aliases: [...new Set([...(p.name_aliases || []), ...aliasFromName(p.name_canonical || '')])],
    brand_aliases: [...new Set([...(p.brand_aliases || []), normalizeText(p.brand_canonical || '')])],
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

  // Placeholder enrichment: append miss query as alias to nearest brand if possible.
  promoted.forEach(q => {
    const match = index.products.find(p => normalizeText(q).includes(normalizeText(p.brand_canonical || '')));
    if (!match) return;
    match.name_aliases = [...new Set([...(match.name_aliases || []), q])];
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

  index.products = dedupeProducts(index.products);
  catalog.products = dedupeProducts(catalog.products);
  index.last_updated = new Date().toISOString();
  catalog.last_updated = new Date().toISOString();
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
    promotedUnknowns: promotedUnknowns.length,
    proposalCount: ingredientProposals.items.length,
    autoApproved
  }, null, 2));
}

main();
