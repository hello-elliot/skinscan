#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SRC_HTML="$ROOT_DIR/forks/skinscan_current_working.html"
OUT_DIR="$ROOT_DIR/public"
OUT_HTML="$OUT_DIR/index.html"
OVERRIDES_PATH="$ROOT_DIR/backend/data/frontend_ingredient_overrides.json"

if [ ! -f "$SRC_HTML" ]; then
  echo "Missing source HTML: $SRC_HTML" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

RESOLVER_URL="${RESOLVER_API_URL:-}"
if [ -z "$RESOLVER_URL" ]; then
  RESOLVER_URL="https://skinscan-3bgp.onrender.com"
fi

INJECT_SCRIPT="<script>window.__SKINSCAN_RESOLVER_API_URL='${RESOLVER_URL}';</script>"
if [ -f "$OVERRIDES_PATH" ]; then
  OVERRIDES_JSON="$(tr '\n' ' ' < "$OVERRIDES_PATH" | sed "s|</|<\\\\/|g")"
else
  OVERRIDES_JSON='{"db":{},"aliases":{},"synonyms":{},"familyRules":[]}'
fi
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
