#!/usr/bin/env bash
# Real-world end-to-end proof for the two delivery fixes (dec_e0a36efbf5):
#   FIX 1 — toRepoRel realpath-normalizes, so the edit-time hook still delivers when
#           the repo lives under a SYMLINKED root (/tmp, /var, symlinked $HOME).
#   FIX 2 — content-matched constraints (`--match <regex>`) block the ACTUAL violation
#           across the file's whole life, where a scope-only rule silently goes stale.
#
# Runs the freshly BUILT binary (dist/), exactly what a user runs. Exits non-zero if
# any scenario fails. Run:  npm run build && bash demo/real-world-scenarios.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HUNCH="node $REPO_ROOT/dist/cli/index.js"
PASS=0; FAIL=0
ok(){ printf '  \033[1;32m✓ PASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  \033[1;31m✗ FAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
hdr(){ printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
# a guarded file's history, dated in the future so it is unambiguously "changed after
# the rule was recorded" — the exact condition that makes a scope-only rule go stale.
future(){ GIT_AUTHOR_DATE="2030-06-0$1T10:00:00" GIT_COMMITTER_DATE="2030-06-0$1T10:00:00" git commit -qm "$2"; }
newrepo(){ git init -q; git config user.email d@d.co; git config user.name D; git config commit.gpgsign false; }

# ============================================================================
hdr "SCENARIO 1 — edit-time hook delivers under a SYMLINKED root (FIX 1)"
# /tmp is a symlink to /private/tmp on macOS — the case that silently no-op'd the hook.
S1="$(mktemp -d)/repo"; mkdir -p "$S1/src"; cd "$S1"
newrepo
echo 'export function total(x){return x}' > src/cart.ts; git add -A; future 1 init >/dev/null
$HUNCH init --no-providers >/dev/null 2>&1
$HUNCH record-constraint "never import lodash — use src/utils" --scope "src/**" --severity blocking >/dev/null
$HUNCH firmness advisory >/dev/null 2>&1
EVT=$(node -e 'console.log(JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Edit",tool_input:{file_path:process.argv[1],new_string:"x"}}))' "$S1/src/cart.ts")
BYTES=$(echo "$EVT" | $HUNCH hook | wc -c | tr -d ' ')
if [ "$BYTES" -gt 0 ]; then ok "hook DELIVERED context under a symlinked root ($BYTES bytes)"; else no "hook emitted 0 bytes under symlink (FIX 1 regressed)"; fi
echo "$EVT" | $HUNCH hook | grep -qi lodash && ok "delivered the correct rule (mentions lodash)" || no "delivered context did not include the rule"

# ============================================================================
hdr "SCENARIO 2 — content-matched rule keeps its teeth across the file's life (FIX 2)"
# Two repos, IDENTICAL history: a guarded file is churned with several passing commits
# (so it is committed long after the rule) and THEN a commit adds lodash. The only
# difference is whether the rule has a --match content matcher.

mkcase(){ # $1 = extra record-constraint args ; sets DIR
  local extra="$1"; DIR="$(mktemp -d)/repo"; mkdir -p "$DIR/src"; cd "$DIR"; newrepo
  printf 'export function total(x){return x}\n' > src/cart.ts; git add -A; future 1 init >/dev/null
  $HUNCH init --no-providers >/dev/null 2>&1
  $HUNCH record-constraint "never import lodash — use src/utils" --scope "src/**" --severity blocking $extra >/dev/null
  # normal development: the guarded file changes repeatedly, all WITHOUT violating the rule
  printf 'export function totals(x){return x}\nexport function count(x){return x.length}\n' >> src/cart.ts; git add -A; future 2 "feat: helpers" >/dev/null
  printf 'export function avg(x){return x}\n' >> src/cart.ts; git add -A; future 3 "feat: avg" >/dev/null
}

# 2a — SCOPE-ONLY rule (the old behavior): churned file → rule goes stale → does NOT block
mkcase ""
printf 'import _ from "lodash";\nexport function g(o){return _.groupBy(o)}\n' >> src/cart.ts; git add -A; future 4 "add lodash" >/dev/null
$HUNCH check --commit HEAD --strict >/dev/null 2>&1
[ $? -eq 0 ] && ok "scope-only rule: lodash commit NOT blocked — reproduces the staleness gap (advisory)" \
             || no "scope-only rule unexpectedly blocked (scenario setup wrong)"

# 2b — CONTENT-MATCHED rule (the fix): same churn + same violation → BLOCKS
mkcase '--match lodash'
printf 'import _ from "lodash";\nexport function g(o){return _.groupBy(o)}\n' >> src/cart.ts; git add -A; future 4 "add lodash" >/dev/null
$HUNCH check --commit HEAD --strict >/dev/null 2>&1
[ $? -eq 1 ] && ok "content-matched rule: lodash commit BLOCKED across the file's life (FIX 2)" \
             || no "content-matched rule did NOT block the violation (FIX 2 failed)"

# 2c — PRECISION: a passing commit (touches the guarded file, does NOT add lodash) is NOT flagged
mkcase '--match lodash'
printf 'export function median(x){return x}\n' >> src/cart.ts; git add -A; future 4 "feat: median (no lodash)" >/dev/null
OUT=$($HUNCH check --commit HEAD --strict 2>&1); CODE=$?
if [ $CODE -eq 0 ] && ! echo "$OUT" | grep -qi "lodash"; then ok "content-matched rule stays QUIET on a compliant edit (no false positive)"; else no "content-matched rule false-flagged a compliant edit (code=$CODE)"; fi

# 2d — PRECISION: a COMMENT that merely names the term is not a violation (no false positive)
mkcase '--match lodash'
printf '// we deliberately avoid lodash in this module\nexport function median(x){return x}\n' >> src/cart.ts; git add -A; future 4 "feat: median + a comment about lodash" >/dev/null
$HUNCH check --commit HEAD --strict >/dev/null 2>&1
[ $? -eq 0 ] && ok "content-matched rule ignores a comment that names the term (matches code, not comments)" \
             || no "content-matched rule false-blocked a comment (FP regressed)"

# ============================================================================
printf '\n\033[1m── %d passed, %d failed ──\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
