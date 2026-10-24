# Contributing to Hunch

Thanks for helping build Hunch's engineering-memory and deterministic Change Gate.

## License of contributions

Every contributor signs the **[Contributor Assignment Agreement](CLA.md)** before a
pull request can be merged. You assign to the owner all rights in your contributions,
including copyright and patents, so the owner can use, relicense and sell them on any
terms. You can still use them like anyone else, under the project's published
license. The agreement also covers anything you contributed before you signed it.

Signing takes one comment. On your first pull request, the **CLA** check posts
instructions; reply with a comment that contains exactly this sentence and nothing
else:

    I have read the CLA Document and I hereby sign the CLA

The check then turns green (if it doesn't, comment `recheck` or push a commit). You sign once, and it covers your later pull requests,
until a new version of the CLA asks everyone to sign again.
If you contribute as part of your job, your employer also signs the
[Corporate CLA](CCLA.md). Don't submit code you don't have the right to license this
way.

The check looks up each commit's author on GitHub (or its committer, when the author
email isn't linked to an account), and each of those accounts must sign. Commit with
an email linked to your GitHub account. `Co-Authored-By` trailers are not checked.

Maintainers: don't squash, `--reset-author` or edit an outside contributor's commits
in the web UI before they have signed, because the check would then see you (or
`web-flow`) as the author instead of them.

## Dev setup

Node ≥ 22.13. No build step at dev time — everything runs from source via `tsx`.

```bash
npm install
npm run dev -- doctor        # run the CLI from source (any subcommand after `--`)
npm test                     # fixture-safe runner over test/*.test.ts
node tooling/run-tests.mjs test/check.test.ts  # run one test file
npm run typecheck            # strict tsc — this is the gate (there is no separate lint)
npm run build                # clean + tsc -> dist/ (the published artifact)
```

## Before you open a PR

- **Typecheck + tests are green.** `npm run typecheck && npm test`. Strict `tsc` is the bar.
- **Don't break a recorded invariant.** Run `npm run dev -- check --strict` on your staged
  change; the CI Hunch Guard runs the same check on every PR and fails on a direct,
  high-confidence, non-stale blocking invariant. If you mean to change an invariant,
  supersede the decision rather than silently breaking it.
- **Conventional Commits.** `feat:`, `fix:`, `chore:`, `docs:`, etc. Keep the subject ≤ ~72
  chars; put the *why* in the body when it isn't obvious.
- **Match the surrounding code** — comment density, naming, and idiom. New behavior gets a
  test that mirrors the existing suite.

## Scope notes

- `site/` and `vscode-extension/` are independent sub-projects with their own tooling.
- The MCP server (`src/mcp/`) stays **client-agnostic** — no assistant-specific behavior.
- Synthesis runs on the user's coding **subscription**, never the pay-per-token API.

Questions or a bigger change? Open an issue first so we can align before you build.
