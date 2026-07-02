# Contributing to Hunch

Thanks for helping build the Engineering Memory OS.

## License of contributions

By submitting a contribution (a pull request, patch, or any change), you agree it is
licensed under the **Apache License, Version 2.0** — the same license as the project
(see [LICENSE](LICENSE)). This is the default under Apache-2.0 §5; no separate CLA is
required. Don't submit code you don't have the right to license this way.

## Dev setup

Node ≥ 22.13. No build step at dev time — everything runs from source via `tsx`.

```bash
npm install
npm run dev -- doctor        # run the CLI from source (any subcommand after `--`)
npm test                     # tsx --test over test/*.test.ts
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
