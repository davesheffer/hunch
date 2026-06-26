#!/usr/bin/env bash
# Architectural Conformance — the head-to-head.
#
# A change that PASSES the linter / SAST (no bad pattern, no forbidden import, no CVE)
# but BREAKS the architecture (a controller now reaches the database directly, bypassing
# the service layer). Pattern-matchers can't express "controllers must not reach the DB" —
# it needs a graph of intent. Hunch catches it, with the receipt of WHY the rule exists.
#
#   npm run build && bash demo/architectural-conformance.sh
set -uo pipefail
HUNCH="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli/index.js"
say(){ printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ROOT="$HOME/.hunch-conform-demo"; rm -rf "$ROOT"; DIR="$ROOT/shop"; mkdir -p "$DIR/src/api" "$DIR/src/services" "$DIR/src/db"; cd "$DIR"
git init -q; git config user.email d@demo.co; git config user.name Demo; git config commit.gpgsign false

say "A layered service: controller → service → database."
cat > src/db/client.ts <<'TS'
export function dbQuery(sql: string): unknown { return { sql }; }
TS
cat > src/services/orders.ts <<'TS'
import { dbQuery } from "../db/client.js";
// the service layer authorizes + batches before touching the DB
export function fetchOrders(userId: string): unknown {
  return dbQuery(`select * from orders where user = '${userId}' limit 100`);
}
TS
cat > src/api/orders.ts <<'TS'
import { fetchOrders } from "../services/orders.js";
export function listOrders(userId: string): unknown {
  return fetchOrders(userId);
}
TS
git add -A && git commit -qm "feat: orders (controller → service → db)"
$HUNCH init --no-providers >/dev/null 2>&1

say "Record the architectural invariant (with its WHY)."
$HUNCH conform --add "controllers must not reach the DB directly — go through the service layer" \
  --assert not-calls --subject listOrders --object dbQuery \
  --why "a controller querying the DB directly caused the Mar-2025 N+1 meltdown; the service layer batches + authorizes" \
  --bug bug_0317_n_plus_one 2>&1 | sed 's/^/   /'
$HUNCH index >/dev/null 2>&1

say "Baseline — architecture holds:"
$HUNCH conform 2>&1 | sed 's/^/   /'

say "Now an AI 'optimizes' the controller to hit the DB directly (one fewer hop)."
cat > src/api/orders.ts <<'TS'
import { dbQuery } from "../db/client.js";
export function listOrders(userId: string): unknown {
  // fewer layers = faster, right?
  return dbQuery(`select * from orders where user = '${userId}' limit 100`);
}
TS
git add -A && git commit -qm "perf: query orders directly from the controller"

say "1) The linter / SAST view (pattern checks):"
if grep -rEn "eval\(|child_process|password\s*=|lodash|require\(['\"]http" src/ >/dev/null 2>&1; then
  echo "   pattern found"
else
  echo "   ✓ SAST/linter: CLEAN — no bad pattern, no forbidden import, no CVE. (A real Semgrep/SonarQube is equally green: ../db/client is a legitimate internal module.)"
fi
$HUNCH check --commit HEAD 2>&1 | grep -iE "invariant|clean|touch no" | head -1 | sed 's/^/   hunch dep-gate: /'

say "2) Architectural Conformance view (Hunch):"
$HUNCH index >/dev/null 2>&1
$HUNCH conform --strict 2>&1 | sed 's/^/   /'
CODE=${PIPESTATUS[0]:-$?}
echo
if $HUNCH conform --strict >/dev/null 2>&1; then
  printf '\033[1;31m   (demo note: expected a violation — check the indexer created the listOrders→dbQuery edge)\033[0m\n'
else
  printf '\033[1;32m▸ BLOCKED — the architectural violation a linter can NOT see, caught deterministically, with the receipt of which decision + which bug it would reopen.\033[0m\n'
fi
rm -rf "$ROOT"
