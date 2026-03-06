#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'forks', 'skinscan_current_working.html');
const OVERRIDES_PATH = path.join(ROOT, 'backend', 'data', 'frontend_ingredient_overrides.json');
const REPORT_PATH = path.join(ROOT, 'backend', 'data', 'acne_rating_audit_report.json');

function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return null;
  const from = start + startMarker.length;
  const end = src.indexOf(endMarker, from);
  if (end < 0) return null;
  return src.slice(from, end).trim();
}

function loadDbFromHtml(html) {
  const raw = extractBlock(
    html,
    'const INGREDIENT_DB = ',
    '\n\n// ── Normalization alias map'
  );
  if (!raw) throw new Error('Failed to locate INGREDIENT_DB in HTML');
  return JSON.parse(raw.replace(/;\s*$/, ''));
}

function asObjectLiteral(html, start, end) {
  const raw = extractBlock(html, start, end) || '{}';
  // Controlled local source file from repository.
  return Function(`return (${raw});`)();
}

function buildMergedDb() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const db = loadDbFromHtml(html);
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  Object.assign(db, overrides.db || {});
  const aliases = asObjectLiteral(html, 'const INCI_ALIASES = ', '\n\nfunction normalizeIngredient');
  Object.assign(aliases, overrides.aliases || {});
  return { db, aliases };
}

function audit(db) {
  const buckets = {
    fatty_acid_core: /\b(STEARIC ACID|PALMITIC ACID)\b/,
    oleate_esters: /\bOLEATE\b/,
    stearate_esters: /\bSTEARATE\b/,
    palmitate_esters: /\bPALMITATE\b/,
    myristate_esters: /\bMYRISTATE\b/,
    laurate_esters: /\bLAURATE\b/,
    butters: /\bBUTTER\b/
  };
  const exclusions = [
    /RETINYL PALMITATE/, // retinoid derivative; leave to separate class logic
    /ASCORBYL PALMITATE/, // antioxidant ester; avoid blanket inflation
    /EXTRACT$/
  ];

  const suspicious = [];
  const distribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (const [name, data] of Object.entries(db)) {
    const acne = Number(data?.acne ?? 0);
    distribution[String(acne)] = (distribution[String(acne)] || 0) + 1;

    if (exclusions.some((re) => re.test(name))) continue;
    const matched = Object.entries(buckets).find(([, re]) => re.test(name));
    if (!matched) continue;

    const [bucket] = matched;
    if (acne < 2) {
      suspicious.push({
        name,
        acne,
        func: data?.func || '',
        bucket,
        recommendation: 'review_raise_to_2_if_acne-prone evidence supports'
      });
    }
  }

  suspicious.sort((a, b) => a.acne - b.acne || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    totalIngredients: Object.keys(db).length,
    acneDistribution: distribution,
    suspiciousCount: suspicious.length,
    suspicious
  };
}

function main() {
  const { db } = buildMergedDb();
  const report = audit(db);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(`Total: ${report.totalIngredients} | suspicious: ${report.suspiciousCount}`);
}

main();
