import { cleanupDir } from "./fixtures.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isLinkedWorktree } from '../src/extractors/git.js';
// @ts-expect-error tooling is JavaScript
import { prepareDevelopmentRun, runDevelopmentProcess } from '../tooling/development-run.mjs';
// @ts-expect-error tooling is JavaScript
import { summarizeDevelopmentPRs, initialCheckResult, developmentHistoryRef } from '../tooling/development-metrics.mjs';

test('one-task launcher refuses primary/dirty worktrees, retains proposal identity and hashes output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hunch-run-test-')), repo = join(dir, 'repo'), worktree = join(dir, 'worktree'), args = join(dir, 'agent.json');
  mkdirSync(repo); const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv, { cwd, stdio: 'pipe' });
  try {
    git(repo, 'init', '-b', 'agent/primary'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'core.hooksPath', join(dir, 'no-hooks'));
    const proposal = JSON.parse(readFileSync(resolve('.hunch/decisions/dec_064fb9b70e.json'), 'utf8'));
    Object.assign(proposal, { status: 'proposed', valid_to: null, superseded_by: null });
    mkdirSync(join(repo, '.hunch/decisions'), { recursive: true });
    writeFileSync(join(repo, '.hunch/decisions', proposal.id + '.json'), JSON.stringify(proposal));
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture'); git(repo, 'worktree', 'add', '-b', 'agent/test', worktree);
    assert.equal(isLinkedWorktree(repo), false, 'the primary checkout remains primary even on an agent/ branch');
    assert.equal(isLinkedWorktree(worktree), true);
    writeFileSync(args, JSON.stringify({ provider: 'subscription-cli', argv: [process.execPath, '-e', "let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{if(!text.includes('One Hunch development task')||!text.includes('dec_064fb9b70e'))process.exit(2);process.stdout.write('fixture-ok')})"] }));
    const input = { worktree, proposal: join(worktree, '.hunch/decisions', proposal.id + '.json'), argvFile: args };
    assert.throws(() => prepareDevelopmentRun({ ...input, worktree: repo }), /linked Git worktree/);
    const plan = prepareDevelopmentRun(input);
    const receipt = await runDevelopmentProcess(plan);
    assert.equal(receipt.code, 0); assert.equal(receipt.outcome, 'process-exited');
    assert.equal(receipt.task_completion, 'unverified');
    assert.equal(receipt.stdout_hash, 'sha256:' + createHash('sha256').update('fixture-ok').digest('hex'));
    assert.equal(receipt.authority_change, false);
    writeFileSync(join(worktree, 'dirty.txt'), 'uncommitted');
    assert.throws(() => prepareDevelopmentRun(input), /must be clean/);
    rmSync(join(worktree, 'dirty.txt'));
    writeFileSync(join(plan.gitDir, 'hunch-development-run.lock'), 'previous run');
    await assert.rejects(runDevelopmentProcess(plan), /already has a run lock/);
    assert.equal(readFileSync(join(plan.gitDir, 'hunch-development-run.lock'), 'utf8'), 'previous run');
    rmSync(join(plan.gitDir, 'hunch-development-run.lock'));
    const overflow = await runDevelopmentProcess({ ...plan, argv: [process.execPath, '-e', "setInterval(()=>process.stdout.write('x'.repeat(1024)),1)"], timeoutMs: 5000 }, { maxOutputBytes: 8192 });
    assert.equal(overflow.outcome, 'output-limit');
    const marker = join(dir, 'escaped.txt');
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),800)`;
    const timeout = await runDevelopmentProcess({ ...plan, argv: [process.execPath, '-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`], timeoutMs: 200 });
    assert.equal(timeout.outcome, 'timeout');
    await new Promise(r => setTimeout(r, 900));
    assert.equal(existsSync(marker), false, 'descendant must not survive the timeout');
    assert.equal(existsSync(join(plan.gitDir, 'hunch-development-run.lock')), false);
  } finally { cleanupDir(dir); }
});

test('development metrics retain unknown evidence and use a real median', () => {
  assert.equal(developmentHistoryRef('example/project', 'git@github.com:example/project.git', 'trunk'), 'refs/remotes/origin/trunk');
  assert.throws(() => developmentHistoryRef('example/project', 'https://github.com/davesheffer/hunch.git', 'main'), /origin must match/);
  const sha = 'a'.repeat(40);
  const records = [
    { number: 1, url: 'https://example.test/1', createdAt: '2026-09-13T10:00:00Z', mergedAt: '2026-09-13T10:10:00Z', mergeCommit: { oid: sha }, reviews: { nodes: [{ state: 'CHANGES_REQUESTED' }], pageInfo: { hasNextPage: false } } },
    { number: 2, url: 'https://example.test/2', createdAt: '2026-09-13T10:00:00Z', mergedAt: '2026-09-13T10:30:00Z', mergeCommit: { oid: 'b'.repeat(40) } },
  ];
  const result = summarizeDevelopmentPRs(records, [{ message: `Revert fixture\n\nThis reverts commit ${sha}.` }]);
  assert.equal(result.median_time_to_merge_ms, 20 * 60_000);
  assert.equal(result.rows[1].change_requested, null, 'missing review data is unknown');
  assert.equal(result.review_coverage, 1); assert.equal(result.change_request_rate, 1);
  assert.equal(result.explicit_merge_reverts, 1); assert.equal(result.first_pr_head_ci_coverage, 0);
  assert.equal(result.promotion, 'not-evaluated');
});

test('initial-head CI keeps the failed first attempt and refuses incomplete history', () => {
  const names = ['ci (22)', 'ci (24)', 'hunch-guard', 'platform-matrix-safety (macos-latest)', 'platform-matrix-safety (windows-latest)'];
  const runs = names.map((name, i) => ({ id: i + 1, name, conclusion: 'success' }));
  assert.equal(initialCheckResult(runs), 'passed');
  assert.equal(initialCheckResult(runs.slice(1)), 'unknown');
  assert.equal(initialCheckResult(runs, 101), 'unknown');
  runs[0].conclusion = 'failure';
  runs.push({ id: 100, name: 'ci (22)', conclusion: 'success' });
  assert.equal(initialCheckResult(runs), 'failed', 'a later green rerun cannot erase the first failure');
  const workflow = readFileSync('.github/workflows/development-observation.yml', 'utf8');
  assert.match(workflow, /types: \[opened\]/);
  assert.doesNotMatch(workflow, /uses: actions\/checkout|id-token:|contents: write|pull-requests: write/);
});
