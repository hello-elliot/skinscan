#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const IMPORT_DIR = path.join(DATA_DIR, 'import');
const CANONICAL_INDEX_PATH = path.join(DATA_DIR, 'ingredient_canonical_index.json');
const REPORT_PATH = path.join(DATA_DIR, 'ingredient_ingestion_report.json');

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

function splitMulti(value) {
  return String(value || '')
    .split(/[;,|]/)
    .map(v => v.trim())
    .filter(Boolean);
}

function dedupeKeepOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = String(item || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function pickDelimiter(headerLine) {
  const tabs = (headerLine.match(/\t/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

function parseDelimited(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  const delimiter = pickDelimiter(lines[0]);
  const splitLine = line => {
    const out = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && ch === delimiter) {
        out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out.map(v => v.trim());
  };

  const headers = splitLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(splitLine);
  return { headers, rows };
}

function pickFieldIndex(headers, candidates) {
  for (const key of candidates) {
    const idx = headers.findIndex(h => h.includes(key));
    if (idx !== -1) return idx;
  }
  return -1;
}

function latestImportFile() {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  const files = fs.readdirSync(IMPORT_DIR)
    .filter(name => /cosing/i.test(name) && /\.(csv|tsv|txt)$/i.test(name))
    .map(name => {
      const full = path.join(IMPORT_DIR, name);
      const stat = fs.statSync(full);
      return { full, mtimeMs: stat.mtimeMs, name };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] || null;
}

function mergeRecord(prev, next) {
  return {
    ...prev,
    canonicalId: next.canonicalId,
    inciName: next.inciName || prev.inciName || next.canonicalId,
    source: 'cosing',
    sourceVersion: next.sourceVersion || prev.sourceVersion || '',
    functions: dedupeKeepOrder([...(prev.functions || []), ...(next.functions || [])]),
    casNumbers: dedupeKeepOrder([...(prev.casNumbers || []), ...(next.casNumbers || [])]),
    ecNumbers: dedupeKeepOrder([...(prev.ecNumbers || []), ...(next.ecNumbers || [])]),
    synonyms: dedupeKeepOrder([...(prev.synonyms || []), ...(next.synonyms || [])]),
    identifiers: {
      ...(prev.identifiers || {}),
      ...(next.identifiers || {})
    },
    metadata: {
      ...(prev.metadata || {}),
      confidence: prev.metadata?.confidence || 'high',
      lastUpdatedAt: nowIso()
    }
  };
}

function main() {
  const sourceFile = latestImportFile();
  const reportBase = readJson(REPORT_PATH, {
    generatedAt: nowIso(),
    cosing: {},
    pubchem: {},
    notes: []
  });

  if (!sourceFile) {
    reportBase.generatedAt = nowIso();
    reportBase.cosing = {
      ok: false,
      sourceFile: '',
      reason: 'no_import_file',
      rowsRead: 0,
      imported: 0,
      updated: 0,
      skippedMissingInci: 0,
      duplicates: 0
    };
    writeJson(REPORT_PATH, reportBase);
    console.log(JSON.stringify(reportBase.cosing));
    return;
  }

  const parsed = parseDelimited(fs.readFileSync(sourceFile.full, 'utf8'));
  const idxInci = pickFieldIndex(parsed.headers, ['inci', 'ingredient name', 'name']);
  const idxFunctions = pickFieldIndex(parsed.headers, ['function']);
  const idxCas = pickFieldIndex(parsed.headers, ['cas']);
  const idxEc = pickFieldIndex(parsed.headers, ['ec']);

  const existing = readJson(CANONICAL_INDEX_PATH, {
    version: 1,
    source: 'cosing',
    updatedAt: nowIso(),
    items: []
  });
  const byId = new Map((existing.items || []).map(item => [item.canonicalId, item]));

  let rowsRead = 0;
  let imported = 0;
  let updated = 0;
  let skippedMissingInci = 0;
  let duplicates = 0;

  for (const row of parsed.rows) {
    rowsRead += 1;
    const rawInci = idxInci >= 0 ? row[idxInci] : '';
    const canonicalId = normalizeIngredientToken(rawInci);
    if (!canonicalId) {
      skippedMissingInci += 1;
      continue;
    }

    const next = {
      canonicalId,
      inciName: String(rawInci || '').trim() || canonicalId,
      source: 'cosing',
      sourceVersion: path.basename(sourceFile.name),
      functions: idxFunctions >= 0 ? splitMulti(row[idxFunctions]) : [],
      casNumbers: idxCas >= 0 ? splitMulti(row[idxCas]) : [],
      ecNumbers: idxEc >= 0 ? splitMulti(row[idxEc]) : [],
      synonyms: [],
      identifiers: {},
      metadata: {
        confidence: 'high',
        lastUpdatedAt: nowIso()
      }
    };

    const prev = byId.get(canonicalId);
    if (!prev) {
      byId.set(canonicalId, next);
      imported += 1;
      continue;
    }

    const merged = mergeRecord(prev, next);
    const prevHash = JSON.stringify(prev);
    const mergedHash = JSON.stringify(merged);
    if (prevHash !== mergedHash) {
      byId.set(canonicalId, merged);
      updated += 1;
    } else {
      duplicates += 1;
    }
  }

  const out = {
    version: 1,
    source: 'cosing',
    updatedAt: nowIso(),
    sourceFile: sourceFile.name,
    items: [...byId.values()].sort((a, b) => a.canonicalId.localeCompare(b.canonicalId))
  };
  writeJson(CANONICAL_INDEX_PATH, out);

  reportBase.generatedAt = nowIso();
  reportBase.cosing = {
    ok: true,
    sourceFile: sourceFile.name,
    rowsRead,
    imported,
    updated,
    skippedMissingInci,
    duplicates,
    canonicalCount: out.items.length
  };
  writeJson(REPORT_PATH, reportBase);
  console.log(JSON.stringify(reportBase.cosing));
}

main();
