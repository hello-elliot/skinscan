#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SRC_HTML="$ROOT_DIR/forks/skinscan_current_working.html"
OUT_DIR="$ROOT_DIR/public"
OUT_HTML="$OUT_DIR/index.html"
OVERRIDES_PATH="$ROOT_DIR/backend/data/frontend_ingredient_overrides.json"
CANONICAL_INDEX_PATH="$ROOT_DIR/backend/data/ingredient_canonical_index.json"

if [ ! -f "$SRC_HTML" ]; then
  echo "Missing source HTML: $SRC_HTML" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

RESOLVER_URL="${RESOLVER_API_URL:-}"
if [ -z "$RESOLVER_URL" ]; then
  RESOLVER_URL="https://skinscan-3bgp.onrender.com"
fi

PROXY_URL="${SKINSCAN_PROXY_URL:-}"
if [ -z "$PROXY_URL" ]; then
  PROXY_URL="${RESOLVER_URL%/}/resolver/ai-proxy"
fi

INJECT_SCRIPT="<script>window.__SKINSCAN_RESOLVER_API_URL='${RESOLVER_URL}';window.__SKINSCAN_PROXY_URL='${PROXY_URL}';</script>"
OVERRIDES_JSON="$(node - "$OVERRIDES_PATH" "$CANONICAL_INDEX_PATH" <<'NODE'
const fs = require('fs');
const overridesPath = process.argv[2];
const canonicalPath = process.argv[3];

const normalize = (value) => String(value || '')
  .toUpperCase()
  .replace(/[()[\]{}]/g, ' ')
  .replace(/\s*\/\s*/g, '/')
  .replace(/\s*-\s*/g, '-')
  .replace(/[;,|]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const readJson = (path, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (_) {
    return fallback;
  }
};

const merged = readJson(overridesPath, { db: {}, aliases: {}, synonyms: {}, familyRules: [] });
merged.db = merged.db || {};
merged.aliases = merged.aliases || {};
merged.synonyms = merged.synonyms || {};
merged.familyRules = Array.isArray(merged.familyRules) ? merged.familyRules : [];

const canonical = readJson(canonicalPath, { items: [] });
for (const item of (canonical.items || [])) {
  const canonicalId = normalize(item.canonicalId || item.inciName || '');
  if (!canonicalId) continue;
  if (!merged.db[canonicalId]) continue;
  const candidates = [item.inciName, ...(item.synonyms || [])]
    .map(normalize)
    .filter(Boolean);
  for (const key of candidates) {
    merged.aliases[key] = canonicalId;
    merged.synonyms[key] = canonicalId;
  }
}

process.stdout.write(JSON.stringify(merged));
NODE
)"
OVERRIDES_JSON="$(printf '%s' "$OVERRIDES_JSON" | tr '\n' ' ' | sed "s|</|<\\\\/|g")"
INJECT_SCRIPT="${INJECT_SCRIPT}<script>window.__SKINSCAN_INGREDIENT_OVERRIDES=${OVERRIDES_JSON};</script>"

awk -v inject="$INJECT_SCRIPT" '
  BEGIN { inserted=0 }
  {
    if (inserted == 0 && $0 ~ /<script>/) {
      print inject;
      inserted=1;
    }
    print $0;
  }
  END {
    if (inserted == 0) print inject;
  }
' "$SRC_HTML" > "$OUT_HTML"

echo "Built Pages artifact: $OUT_HTML"
