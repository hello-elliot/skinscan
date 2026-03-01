#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const CANONICAL_INDEX_PATH = path.join(DATA_DIR, 'ingredient_canonical_index.json');
const REPORT_PATH = path.join(DATA_DIR, 'ingredient_ingestion_report.json');

const TIMEOUT_MS = Number(process.env.PUBCHEM_TIMEOUT_MS || 5500);
const MAX_ITEMS = Number(process.env.PUBCHEM_MAX_ITEMS || 120);
const RATE_DELAY_MS = Number(process.env.PUBCHEM_RATE_DELAY_MS || 180);

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'SkinScanResolver/1.0 (ingredient-enrichment)'
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`http_${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error('invalid_json'));
        }
      });
    });
    req.on('error', err => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function fetchCidByName(name) {
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/cids/JSON`;
  const data = await fetchJson(url);
  const list = data?.IdentifierList?.CID;
  return Array.isArray(list) ? list.map(v => String(v)) : [];
}

async function fetchPropertiesByCid(cid) {
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${encodeURIComponent(cid)}/property/InChIKey,CanonicalSMILES/JSON`;
  const data = await fetchJson(url);
  const row = data?.PropertyTable?.Properties?.[0] || {};
  return {
    inchiKey: String(row.InChIKey || '').trim(),
    smiles: String(row.CanonicalSMILES || '').trim()
  };
}

async function fetchSynonymsByCid(cid) {
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${encodeURIComponent(cid)}/synonyms/JSON`;
  const data = await fetchJson(url);
  const list = data?.InformationList?.Information?.[0]?.Synonym;
  return Array.isArray(list) ? list : [];
}

function curatedSynonyms(items, canonicalId) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const normalized = normalizeIngredientToken(raw);
    if (!normalized) continue;
    if (normalized.length < 3 || normalized.length > 120) continue;
    if (/^(PRODUCT|MIXTURE|FORMULA|CID\s)/i.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 35) break;
  }
  if (!seen.has(canonicalId)) out.unshift(canonicalId);
  return out;
}

function parseArgs(argv) {
  const out = { tokens: [], maxItems: MAX_ITEMS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tokens' && argv[i + 1]) {
      out.tokens = String(argv[i + 1])
        .split('|')
        .map(normalizeIngredientToken)
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (a === '--max-items' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.maxItems = n;
      i += 1;
    }
  }
  return out;
}

function confidenceForMatch(cids, synonyms, canonicalId) {
  if (!cids.length) return 'low';
  if (cids.length > 1) return 'low';
  const hasExactSynonym = synonyms.some(s => normalizeIngredientToken(s) === canonicalId);
  return hasExactSynonym ? 'high' : 'medium';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = readJson(CANONICAL_INDEX_PATH, {
    version: 1,
    source: 'cosing',
    updatedAt: nowIso(),
    items: []
  });

  const reportBase = readJson(REPORT_PATH, {
    generatedAt: nowIso(),
    cosing: {},
    pubchem: {},
    notes: []
  });

  if (!Array.isArray(index.items) || !index.items.length) {
    reportBase.generatedAt = nowIso();
    reportBase.pubchem = {
      ok: false,
      reason: 'canonical_index_empty',
      scanned: 0,
      enriched: 0,
      ambiguous: 0,
      failed: 0
    };
    writeJson(REPORT_PATH, reportBase);
    console.log(JSON.stringify(reportBase.pubchem));
    return;
  }

  const tokenSet = new Set(args.tokens || []);
  const candidates = index.items.filter(item => {
    if (!item || !item.canonicalId) return false;
    if (tokenSet.size && !tokenSet.has(normalizeIngredientToken(item.canonicalId))) return false;
    const hasCid = String(item.identifiers?.pubchemCid || '').trim().length > 0;
    const hasSyn = Array.isArray(item.synonyms) && item.synonyms.length > 0;
    return !(hasCid && hasSyn);
  }).slice(0, args.maxItems);

  let scanned = 0;
  let enriched = 0;
  let ambiguous = 0;
  let failed = 0;

  for (const item of candidates) {
    scanned += 1;
    try {
      const cids = await fetchCidByName(item.inciName || item.canonicalId);
      if (!cids.length) {
        failed += 1;
        await sleep(RATE_DELAY_MS);
        continue;
      }
      const cid = cids[0];
      const [props, syns] = await Promise.all([
        fetchPropertiesByCid(cid),
        fetchSynonymsByCid(cid)
      ]);
      const confidence = confidenceForMatch(cids, syns, normalizeIngredientToken(item.canonicalId));
      if (confidence === 'low') {
        ambiguous += 1;
        await sleep(RATE_DELAY_MS);
        continue;
      }

      item.identifiers = {
        ...(item.identifiers || {}),
        pubchemCid: String(cid),
        inchiKey: props.inchiKey || item.identifiers?.inchiKey || '',
        smiles: props.smiles || item.identifiers?.smiles || ''
      };
      item.synonyms = curatedSynonyms([...(item.synonyms || []), ...syns], normalizeIngredientToken(item.canonicalId));
      item.metadata = {
        ...(item.metadata || {}),
        confidence,
        lastUpdatedAt: nowIso(),
        enrichmentSource: 'pubchem'
      };
      enriched += 1;
    } catch (_) {
      failed += 1;
    }
    await sleep(RATE_DELAY_MS);
  }

  index.updatedAt = nowIso();
  writeJson(CANONICAL_INDEX_PATH, index);

  reportBase.generatedAt = nowIso();
  reportBase.pubchem = {
    ok: true,
    scanned,
    enriched,
    ambiguous,
    failed,
    maxItems: args.maxItems,
    tokenScope: tokenSet.size ? tokenSet.size : null
  };
  writeJson(REPORT_PATH, reportBase);
  console.log(JSON.stringify(reportBase.pubchem));
}

main();
