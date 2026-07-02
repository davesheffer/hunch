#!/usr/bin/env bash
# The drift-gated wiki — docs that cannot silently rot.
#
# `hunch wiki` renders a component wiki + a specs LEDGER from the decision graph.
# Freshness is deterministic (input hashes + topic pins), not "re-run an agent and
# hope": when the graph moves, `hunch drift` names exactly which pages/docs went
# stale, and `hunch wiki --heal` regenerates ONLY those. A doc that grades
# do-not-trust is ADOPTED — a wiki-managed copy healed against the graph — while
# the original file is never touched, and the copy retires once the original heals.
#
#   npm run build && bash demo/wiki.sh
set -uo pipefail
HUNCH="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli/index.js"
say(){ printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ROOT="$HOME/.hunch-wiki-demo"; rm -rf "$ROOT"; DIR="$ROOT/shop"; mkdir -p "$DIR/src/api" "$DIR/docs"; cd "$DIR"
git init -q; git config user.email d@demo.co; git config user.name Demo; git config commit.gpgsign false

say "A repo with code, a decision (topic 'api.pagination'), and a spec PINNED to it."
cat > src/api/orders.ts <<'TS'
export function listOrders(page: number): unknown {
  return { page, size: 100 }; // offset pagination
}
TS
git add -A && git commit -qm "feat: orders endpoint (offset pagination)"
$HUNCH init --no-providers >/dev/null 2>&1

NOW="2026-01-01T00:00:00Z"
mkdir -p .hunch/decisions
cat > .hunch/decisions/dec_demooffset0.json <<JSON
{ "id": "dec_demooffset0", "title": "Paginate orders by OFFSET", "topic": "api.pagination",
  "status": "accepted", "context": "Simple to ship.", "decision": "Offset+limit pagination on /orders.",
  "consequences": ["deep pages get slow"], "alternatives_rejected": ["cursor pagination (deferred)"],
  "related_files": ["src/api/orders.ts", "docs/pagination.md"],
  "provenance": { "source": "human_confirmed", "confidence": 1, "evidence": [] },
  "valid_from": "$NOW", "date": "$NOW" }
JSON
cat > docs/pagination.md <<'MD'
# Pagination spec
<!-- hunch:topic api.pagination dec_demooffset0 -->
Orders are paginated by OFFSET and LIMIT. See src/api/orders.ts.
MD
git add -A && git commit -qm "docs: pagination spec"
$HUNCH index >/dev/null 2>&1

say "Generate the wiki (deterministic template mode) — pages + a specs ledger."
$HUNCH wiki --no-llm 2>&1 | sed 's/^/   /'

say "The spec is GROUNDED (its pin resolves to the current decision) — CI gate is green:"
grep -A2 "Grounded" wiki/specs.md | sed 's/^/   /'
$HUNCH wiki --check 2>&1 | sed 's/^/   /'

say "The team supersedes the decision: cursor pagination replaces offset."
cat > .hunch/decisions/dec_democursor1.json <<JSON
{ "id": "dec_democursor1", "title": "Paginate orders by CURSOR", "topic": "api.pagination",
  "status": "accepted", "context": "Deep offset pages timed out.", "decision": "Cursor (keyset) pagination on /orders; offset retired.",
  "consequences": ["stable deep pagination"], "alternatives_rejected": ["keeping offset with a cap: still O(n) at depth"],
  "related_files": ["src/api/orders.ts"],
  "provenance": { "source": "human_confirmed", "confidence": 1, "evidence": [] },
  "valid_from": "2026-02-01T00:00:00Z", "date": "2026-02-01T00:00:00Z" }
JSON
$HUNCH supersede dec_demooffset0 --by dec_democursor1 2>&1 | sed 's/^/   /'

say "Nobody edited the docs. Drift names EXACTLY what went stale — deterministic, no model:"
$HUNCH drift 2>&1 | sed 's/^/   /'

say "Heal: regenerate ONLY the stale pages — and ADOPT the stale spec (wiki-managed, graph-healed copy)."
$HUNCH wiki --heal --no-llm 2>&1 | sed 's/^/   /'

say "The adopted copy: re-pinned to the CURRENT decision, correction inline, original prose preserved —"
head -6 wiki/docs/docs-pagination.md | sed 's/^/   /'

say "— while the ORIGINAL file was never touched:"
git diff --stat -- docs/pagination.md | sed 's/^/   /'; git diff --quiet -- docs/pagination.md && echo "   ✓ docs/pagination.md: untouched (Hunch never rewrites your prose)"

say "Gate is green again; the ledger routes readers to the managed copy:"
$HUNCH wiki --check 2>&1 | sed 's/^/   /'
grep -m1 "wiki-managed copy" wiki/specs.md | sed 's/^/   /'

say "Fix the original (re-pin it to the current decision) → the copy retires on the next heal."
cat > docs/pagination.md <<'MD'
# Pagination spec
<!-- hunch:topic api.pagination dec_democursor1 -->
Orders are paginated by CURSOR (keyset). See src/api/orders.ts.
MD
$HUNCH wiki --heal --no-llm 2>&1 | sed 's/^/   /'
[ ! -f wiki/docs/docs-pagination.md ] && printf '\033[1;32m▸ Healed original → adopted copy retired automatically. One readable truth per doc, always drift-gated.\033[0m\n'
rm -rf "$ROOT"
