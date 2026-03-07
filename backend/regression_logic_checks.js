#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'forks', 'skinscan_current_working.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function assertContains(label, needle) {
  if (!html.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`);
  }
}

function main() {
  // Skin-model guardrails
  assertContains('primary skin set', "const PRIMARY_SKIN_TYPES = new Set(['normal', 'dry', 'oily', 'combination']);");
  assertContains('condition skin set', "const CONDITION_SKIN_TYPES = new Set(['acne-prone', 'sensitive']);");
  assertContains('normal-condition conflict rule', "if (skinProfile.primary === 'normal') skinProfile.primary = 'combination';");
  assertContains('normal clears conditions rule', "if (skinProfile.primary === 'normal' && skinProfile.conditions.length) {");

  // Acne scoring guardrails
  assertContains('acne-prone scoring flag', 'const isAcneProne = !!options.acneProne;');
  assertContains('acne guardrail cap 4', 'if (moderateOrHigher >= 2) score = Math.min(score, 4);');
  assertContains('acne guardrail cap 3', 'if (highRiskEarly >= 1 || moderateOrHigher >= 3) score = Math.min(score, 3);');

  // Acne override sanity set
  [
    "'STEARIC ACID': { acne: 2",
    "'PALMITIC ACID': { acne: 2",
    "'GLYCERYL STEARATE': { acne: 2",
    "'GLYCERYL OLEATE': { acne: 3",
    "'BUTYROSPERMUM PARKII BUTTER': { acne: 2"
  ].forEach((needle) => assertContains('acne override', needle));

  console.log('Skin/acne logic regression checks passed.');
}

main();
