#!/usr/bin/env bash
# Hunch — the 60-second "it blocked the AI" demo.
#
# Run it (ideally while screen-recording). Self-contained: it makes a throwaway repo,
# teaches Hunch ONE rule a human cares about, then tries to break that rule the way an
# agent would — and watches Hunch refuse the change with a cited receipt. Cleans up after.
#
#   npm i -g @davesheffer/hunch    # needs `hunch` on PATH
#   bash demo/hunch-blocks-it.sh
set -euo pipefail

ROOT="$(mktemp -d)"; DEMO="$ROOT/acme-checkout"
say(){ printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
trap 'rm -rf "$ROOT"' EXIT

say "1. A fresh repo — your codebase."
mkdir -p "$DEMO/src" && cd "$DEMO"
git init -q && git config user.email d@demo.co && git config user.name Demo
cat > src/cart.ts <<'TS'
export function total(items: number[]) {
  return items.reduce((a, b) => a + b, 0);
}
TS
git add -A && git commit -qm "feat: cart total"

say "2. Wire in Hunch and teach it ONE rule a human cares about."
hunch init --no-providers >/dev/null 2>&1
hunch record-constraint "never import lodash — use src/utils" --scope "src/**" --severity blocking >/dev/null
echo '   ✓ rule recorded:  "never import lodash — use src/utils"   (blocking · src/**)'

say "3. The AI 'helpfully' reaches for lodash — the exact thing you forbade."
cat > src/cart.ts <<'TS'
import _ from "lodash";
export function total(items: number[]) {
  return _.sum(items);
}
TS
git add src/cart.ts
echo '   …staged:  + import _ from "lodash"'

say "4. Hunch checks the change before it can land:"
echo
set +e
hunch check --staged --strict
CODE=$?
set -e

echo
if [ "$CODE" -ne 0 ]; then
  printf '\033[1;32m✓ BLOCKED (exit %s) — with the receipt of which rule it broke and why.\033[0m\n' "$CODE"
  printf '\033[1;32m  The same rule holds for Claude Code, Cursor, Copilot & Windsurf — every assistant, and on every PR via `hunch ci`.\033[0m\n'
else
  printf '\033[1;31m(demo note: expected a block — confirm the rule with `hunch review --accept` or check firmness)\033[0m\n'
fi
