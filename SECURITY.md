# Security Policy

## Reporting a vulnerability

Email **dave.sheffer1@gmail.com** (or open a [private security advisory](https://github.com/davesheffer/hunch/security/advisories/new)).
Please do not file public issues for undisclosed vulnerabilities. Expect an
acknowledgement within a few days.

## Supply-chain posture

Hunch is a developer tool that runs locally and talks to your assistant over
**stdio** (no network server of its own — see `con_e04226bd05`). Its security
controls:

| Control | Where | What it does |
|---|---|---|
| **Audit gate** | `.github/workflows/ci.yml` | `npm audit --omit=dev --audit-level=high` fails the build on a high/critical advisory in any shipped dependency. |
| **Provenance** | `.github/workflows/release.yml` + `publishConfig.provenance` | Every npm release ships a signed [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) — consumers can verify the tarball was built from this repo, unmodified. |
| **Locked installs** | `npm ci` in CI | Installs the exact, integrity-hashed `package-lock.json` tree — no version drift. |
| **API-key isolation** | `src/synthesis/provider.ts` (`con_2ce3f2a547`) | Synthesis runs on your assistant **subscription**; `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` are stripped from spawned child envs. |
| **No-argv injection** | `src/synthesis/provider.ts` | Untrusted content (diffs, commit/test text) is fed to CLIs via **stdin only**, never argv. Model ids from `HUNCH_*_MODEL` are allowlist-validated (`safeModel`) before reaching the Windows shell line. |

### Packages that run install scripts

Only native-build tooling, all mainstream:
`tree-sitter` / `tree-sitter-typescript` / `tree-sitter-javascript` (parsers).
SQLite is Node's built-in `node:sqlite` — no native binding is installed for it.
The `@huggingface/transformers` embedder is an **optional peer** — not installed
unless you opt into local semantic vectors.

## Socket.dev alert triage

These Socket alerts have been reviewed and accepted; mark them as such in the
Socket dashboard. None is reachable malicious behavior.

| Alert | Source | Verdict |
|---|---|---|
| Shell spawn (`shell:true`) | `dist/synthesis/provider.js` | Hardened: untrusted data is stdin-only; model ids validated by `safeModel`. |
| Env / data disclosure | `dist/synthesis/provider.js` | Intended — synthesis sends commit/test text to *your own* subscription CLI. API keys stripped. |
| URL strings | `dist/integrations/providers.js` | `github.com` in a code comment. False positive. |
| Obfuscated code / dynamic `Function` | `@emnapi/runtime` (optional, 3 hops via HF transformers → sharp) | Minified WASM Node-API runtime; `new Function` is env detection. Socket-rated low. Not installed for normal consumers. |
| Network access (`http`) | `@hono/node-server` (via `@modelcontextprotocol/sdk`) | The SDK's optional HTTP transport. Hunch is stdio-only; the module is never loaded. |

## Patching a transitive dependency before its parent

If a CVE lands on a transitive dep and the direct parent hasn't bumped yet, force
the patched version with an `overrides` block in `package.json`, then `npm install`
to refresh the lockfile:

```jsonc
{
  "overrides": {
    "tar-fs": "^2.1.4"            // pin a fixed version everywhere it resolves
    // or scope it: "some-parent": { "tar-fs": "^2.1.4" }
  }
}
```

Remove the override once the parent ships the fix to stay current.
