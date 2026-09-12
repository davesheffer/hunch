# Native change proof

`hunch.change-proof/1` is Hunch's standalone semantic evidence artifact for one exact committed
Git tree transition. It combines Hunch's exact change identity with revision-pinned Project DNA,
base and result semantic-graph seals, relevant current memory, dependency blast radius,
architectural conformance, the strict Change Gate result, and every bounded omission or unknown.

The artifact is useful on its own. It does not depend on ORC or Hunch Memory, and it grants no
execution, CI, deployment, merge, ranking, promotion, or policy authority.

## Produce a proof

```bash
hunch prove <base-ref> [result-ref]
hunch prove <base-ref> [result-ref] --json
hunch prove <base-ref> [result-ref] --public-only --json
```

The equivalent MCP tool is `hunch_change_proof`, with `base_ref`, optional `result_ref`, optional
`public_only`, and the standard `cwd` hint for clients that have changed repository or worktree.
Both surfaces call the same derivation and return the same sealed artifact.

`--public-only` is required before publication when a private overlay is configured. A local proof
uses the public/private union and says `memory.scope: "union"`; a publication-safe proof reads only
the public JSON store and says `memory.scope: "public"`. The chosen scope, referenced records, and
their hashes are part of the proof seal.

## What is bound

| Field | Evidence |
| --- | --- |
| `repository` and `change` | Exact base/result commits and `hunch.change-identity/1`, derived from Git's raw tree delta |
| `project_dna` | Result-revision profile/content seal and the canonically ordered trait IDs |
| `graph.base` / `graph.result` | Exact-commit source and topology hashes, counts, and incomplete-scan issue counts |
| `changed_files` | Canonical repository-relative paths plus the exact change-identity count |
| `blast_radius` | Reverse dependency reachability across both base and result graphs, with depth and graph provenance |
| `decisions` / `constraints` | Relevant in-force record IDs, content hashes, relevance reasons, and path seals |
| `conformance` | Predicate and result-detail hashes evaluated against the exact result graph |
| `guard` | The existing strict Hunch Change Gate verdict, blocker identities, and a privacy-safe report hash |
| `omissions` / `unknowns` | Counted, hashed receipts for every bounded truncation or unavailable semantic claim |

The engine package/version is also sealed. This intentionally prevents reuse across a Hunch release
whose semantic derivation may have changed, even if the Git transition is identical.

## Verdicts and gaps

- `fail` means a displayed conformance receipt is violated or the strict Change Gate has a blocker.
- `unknown` means no displayed failure exists, but at least one omission or unknown prevents a
  complete pass claim.
- `pass` means the strict gate passes, all conformance receipts are satisfied, and there are no
  omissions or unknowns.

Parse failures, invalid encodings, unsafe paths, oversized files, truncated diffs, and bounded
collection tails never disappear silently. They produce hashed gap receipts or stop proof creation
when an exact identity cannot be represented safely.

## Validate and transport

TypeScript consumers should validate the complete structural, canonical-order, cross-field, verdict,
and cryptographic contract before trusting an artifact:

```ts
import { assertChangeProof, type ChangeProof } from "@davesheffer/hunch/change-proof";

const candidate: unknown = JSON.parse(bytes);
assertChangeProof(candidate);
const proof: ChangeProof = candidate;
```

The package ships these feature-detectable transport resources:

- [`hunch.change-proof.v1.schema.json`](../contracts/change-proof/hunch.change-proof.v1.schema.json)
  describes the strict JSON shape for non-TypeScript transports.
- [`hunch.change-proof.v1.example.json`](../contracts/change-proof/hunch.change-proof.v1.example.json)
  is a synthetic, fully sealed `pass` fixture.
- `@davesheffer/hunch/change-proof` is the authoritative seal validator. JSON Schema validation alone
  cannot verify canonical ordering, cross-field bindings, derived verdicts, or content hashes.

The served state layer (`hunch serve`, which folded the former Hunch Memory service) persists and returns the accepted artifact unchanged, keyed by its `proof_id` and
`content_hash`. An orchestrator such as ORC may reference that untouched proof and derive Passport completeness around it;
it must not rewrite Hunch's verdict or add authority inside the native proof.
