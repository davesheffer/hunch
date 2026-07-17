/** The CI Constraint Guard — Hunch's enforcement edge. A GitHub Actions workflow
 *  that runs `hunch check` over a pull request's diff, posts the result as a
 *  sticky PR comment (citing the con_/dec_ ids), and FAILS the check on a direct,
 *  high-confidence, non-stale blocking invariant (the hardened strict gate). This
 *  turns the engineering memory from advisory into a merge gate — and it's
 *  structurally uncopyable: it reasons over the diff PLUS the constraints
 *  committed in the same git history. Idempotent: never clobbers a user's edits.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HUNCH_VERSION } from "../core/version.js";

// `\${{ … }}` keeps GitHub Actions expressions literal inside this template
// literal (a bare `${` would be JS interpolation).
export function ciWorkflowYaml(): string {
  return `# Hunch — CI Constraint Guard. Blocks a PR that breaks a recorded invariant,
# re-adds deliberately-retired code, or contradicts an in-force decision, and
# comments with the why (con_/dec_ ids). Make this a required check to enforce.
name: Hunch Guard

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  hunch-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Check the actual PR head, not GitHub's synthetic merge commit. This
          # lets repository readiness checks prove the branch contains its live
          # base instead of passing merely because GitHub pre-merged it.
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0 # full history: the guard diffs base...head and reads git log

      - uses: actions/setup-node@v4
        with:
          node-version: 22.13.0

      - name: Install Hunch
        # Pin the same release that generated this file so every assistant and CI
        # evaluate the graph with identical semantics. Dependabot/Renovate (or a
        # deliberate hunch-ci refresh) can advance this in a reviewed change.
        run: npm install -g @davesheffer/hunch@${HUNCH_VERSION}

      - name: Fetch the PR base branch
        # checkout sets up no origin/<base> tracking ref; create it explicitly so
        # the guard's base...head diff resolves (otherwise it sees zero changes and
        # passes vacuously).
        run: git fetch --no-tags origin "+refs/heads/\${{ github.base_ref }}:refs/remotes/origin/\${{ github.base_ref }}"

      - name: Run Constraint Guard
        id: guard
        # The report is posted as a public PR comment, so it MUST stay public-only:
        # --public-only excludes any private overlay, and HUNCH_PRIVATE_DIR is neutralized
        # here as defense-in-depth. Never wire a private memory store into CI.
        env:
          HUNCH_PRIVATE_DIR: ""
        run: |
          set +e
          hunch check --base "origin/\${{ github.base_ref }}" --strict --format markdown --public-only > hunch-report.md
          echo "exit=$?" >> "$GITHUB_OUTPUT"
          set -e

      - name: Comment on PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = (fs.existsSync('hunch-report.md') ? fs.readFileSync('hunch-report.md', 'utf8') : '').trim();
            if (!body) { core.info('Hunch: empty report — skipping comment.'); return; }
            const marker = '<!-- hunch-guard -->';
            const { owner, repo } = context.repo;
            const issue_number = context.payload.pull_request.number;
            const out = marker + '\\n' + body;
            try {
              const all = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number });
              const existing = all.find(c => c.body && c.body.includes(marker));
              if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: out });
              else await github.rest.issues.createComment({ owner, repo, issue_number, body: out });
            } catch (e) {
              core.warning('Hunch: could not post PR comment (fork PR has a read-only token?): ' + e.message);
            }

      - name: Enforce (fail on a blocking invariant)
        # Default to 1 if the guard step died before recording its exit — never a
        # vacuous pass.
        if: always()
        run: exit \${{ steps.guard.outputs.exit || '1' }}
`;
}

export interface CiResult {
  path: string;
  action: "created" | "exists";
}

/** Write .github/workflows/hunch-guard.yml. Never overwrites an existing file
 *  (respects user edits) — reports "exists" instead. */
export function writeCiWorkflow(root: string): CiResult {
  const dir = join(root, ".github", "workflows");
  const path = join(dir, "hunch-guard.yml");
  if (existsSync(path)) return { path, action: "exists" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, ciWorkflowYaml());
  return { path, action: "created" };
}
