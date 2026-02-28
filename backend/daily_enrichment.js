#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'product_index.json');
const MISS_PATH = path.join(DATA_DIR, 'coverage_miss_queue.json');

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

function main() {
  const index = readJson(INDEX_PATH, { version: 1, last_updated: new Date().toISOString(), products: [] });
  const missQueue = readJson(MISS_PATH, { items: [] });
  const promoted = [];

  index.products = index.products.map(p => ({
    ...p,
    name_aliases: [...new Set([...(p.name_aliases || []), ...aliasFromName(p.name_canonical || '')])],
    brand_aliases: [...new Set([...(p.brand_aliases || []), normalizeText(p.brand_canonical || '')])],
    confidence_metadata: {
      ...(p.confidence_metadata || {}),
      freshness: 'daily',
      updated_at: new Date().toISOString()
    }
  }));

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

  index.products = dedupeProducts(index.products);
  index.last_updated = new Date().toISOString();
  writeJson(INDEX_PATH, index);

  console.log(JSON.stringify({
    ok: true,
    productCount: index.products.length,
    promotedMisses: promoted.length
  }, null, 2));
}

main();
