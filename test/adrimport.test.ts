import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseAdrMarkdown, mapAdrCorpus, adrDecisionId, ADR_FILE_RE, UNDATED_ADR_DATE } from "../src/extractors/adrImport.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

const MADR_ACCEPTED = `---
status: accepted
date: 2024-03-01
deciders: alice, bob
---

# Use PostgreSQL for persistence

## Context and Problem Statement

We need a durable relational store for orders.

## Considered Options

- PostgreSQL
- MongoDB
- SQLite

## Decision Outcome

Chosen option: "PostgreSQL", because it fits the relational model and the team knows it.

### Consequences

- Good, because transactions are first-class
- Bad, because ops now runs a stateful service
`;

const NYGARD_SUPERSEDED = `# 2. Store sessions in Redis

## Status

Superseded by [ADR-0004](0004-store-sessions-in-postgres.md)

## Context

Sessions were in-memory and lost on restart.

## Decision

Store sessions in Redis with a 24h TTL.

## Consequences

Redis becomes a hard runtime dependency.
`;

const NYGARD_SUCCESSOR = `---
date: 2024-06-01
---

# 4. Store sessions in Postgres

## Status

Accepted

## Context

Redis was our only stateful non-relational service.

## Decision

Move session storage into the existing Postgres.

## Consequences

One fewer service to operate.
`;

const MADR_REJECTED = `---
status: rejected
date: 2024-05-10
---

# Adopt a service mesh

## Context and Problem Statement

Cross-service auth was hand-rolled per service.

## Decision Outcome

Rejected: the operational cost outweighs the benefit at three services.
`;

const MADR_DEPRECATED = `---
status: deprecated
date: 2024-04-12
---

# Use a shared deployment account

## Context and Problem Statement

Every service originally deployed through one account.

## Decision Outcome

Use the shared account until per-service identities are available.
`;

const INFECTION_HEADING_STYLE = `# Use \`$this\` instead of \`self\`

### Context

The repository consistently uses instance assertion calls.

### Decision

Continue to use \`$this\` for PHPUnit assertions.

### Status

Accepted ([#1061][1061])
`;

const INFECTION_DEPRECATED = `# \`@covers\` annotations usage

### Context

Coverage annotations were historically optional.

### Decision

Keep the historical convention until explicit attributes replace it.

### Status

Deprecated.

It was accepted in [#1060][1060] and superseded by [ADR 0007][ADR-0007]
`;

const INFECTION_SUPERSEDED_WITH_ISSUE = `# Bumping PHP version requirements

## Context

The supported PHP floor needs a durable policy.

## Decision

Drop unsupported versions deliberately.

## Status

Superseded by [ADR 0008](0008-PHP-version-support-policy.md). Was accepted in [#1760].
`;

const INFECTION_PROSE_ALTERNATIVES = `# Compare objects directly

## Context

Tests need to compare independently-created objects.

## Decision

Use a strict object comparator.

## Alternatives considered

Using identity for every comparison was rejected because equal objects are not identical.

Comparing every property manually was rejected because it is easy to omit new properties.

## Status

Proposed.
`;

test("parseAdrMarkdown reads MADR frontmatter, options, chosen option, nested consequences", () => {
  const p = parseAdrMarkdown(MADR_ACCEPTED, "docs/adr/0001-use-postgresql.md")!;
  assert.ok(p, "did not parse");
  assert.equal(p.number, 1);
  assert.equal(p.slug, "use-postgresql");
  assert.equal(p.title, "Use PostgreSQL for persistence");
  assert.equal(p.status, "accepted");
  assert.equal(p.date, "2024-03-01");
  assert.match(p.context, /durable relational store/);
  assert.deepEqual(p.consideredOptions, ["PostgreSQL", "MongoDB", "SQLite"]);
  assert.equal(p.chosenOption, "PostgreSQL");
  assert.equal(p.consequences.length, 2);
  assert.match(p.consequences[0]!, /transactions are first-class/);
});

test("parseAdrMarkdown reads Nygard headings, strips the numbered title, extracts the supersede link", () => {
  const p = parseAdrMarkdown(NYGARD_SUPERSEDED, "doc/adr/0002-store-sessions-in-redis.md")!;
  assert.equal(p.title, "Store sessions in Redis");
  assert.equal(p.status, "superseded");
  assert.deepEqual(p.supersededByNumbers, [4]);
  assert.match(p.decision, /24h TTL/);
  assert.deepEqual(p.consequences, ["Redis becomes a hard runtime dependency."]);
});

test("template and index files never import, while a safe @ slug remains eligible", () => {
  for (const name of ["adr-template.md", "README.md", "index.md", "template.md"]) {
    assert.equal(ADR_FILE_RE.test(name), false, `${name} must not import`);
  }
  assert.equal(ADR_FILE_RE.test("0002-@covers-annotations.md"), true);
  assert.equal(ADR_FILE_RE.test("0000-template.md"), true, "the filename is structurally valid; semantic template exclusion happens during parsing");
  assert.equal(parseAdrMarkdown("# X", "docs/adr/README.md"), null);
  assert.equal(parseAdrMarkdown("# Short decision title", "adr/0000-template.md"), null);
});

test("mapAdrCorpus excludes a structurally valid corpus template without a false filename warning", () => {
  const result = mapAdrCorpus([
    { relPath: "adr/0000-template.md", text: "# ADR template\n\n## Status\n\nProposed" },
    { relPath: "adr/0003-PHPUnit-this-over-self.md", text: INFECTION_HEADING_STYLE },
  ]);
  assert.equal(result.decisions.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("Infection-style level-3 headings preserve accepted status, context, and decision", () => {
  const parsed = parseAdrMarkdown(INFECTION_HEADING_STYLE, "adr/0003-PHPUnit-this-over-self.md")!;
  assert.equal(parsed.status, "accepted");
  assert.match(parsed.context, /consistently uses/);
  assert.match(parsed.decision, /Continue to use/);
});

test("Infection's @covers ADR imports and resolves only its explicit ADR successor", () => {
  const parsed = parseAdrMarkdown(INFECTION_DEPRECATED, "adr/0002-@covers-annotations.md")!;
  assert.equal(parsed.status, "accepted", "bare deprecated remains advisory until the corpus proves a successor");
  assert.deepEqual(parsed.supersededByNumbers, [7]);
  assert.ok(!parsed.supersededByNumbers.includes(1060), "a pull request reference is not an ADR relationship");
});

test("an issue number on a successor line is never mistaken for an ADR", () => {
  const parsed = parseAdrMarkdown(INFECTION_SUPERSEDED_WITH_ISSUE, "adr/0005-Bump-PHP-versions.md")!;
  assert.deepEqual(parsed.supersededByNumbers, [8]);
  assert.ok(!parsed.supersededByNumbers.includes(1760));
});

test("prose alternatives remain visible instead of being silently discarded", () => {
  const mapped = mapAdrCorpus([{
    relPath: "adr/0010-compare-objects-directly.md",
    text: INFECTION_PROSE_ALTERNATIVES,
  }]).decisions[0]!;
  assert.equal(mapped.alternatives_rejected.length, 2);
  assert.match(mapped.alternatives_rejected[0]!, /identity/);
  assert.match(mapped.alternatives_rejected[1]!, /property manually/);
});

test("source hashes and dates make undated imports deterministic and reviewable", () => {
  const relPath = "adr/0003-PHPUnit-this-over-self.md";
  const expectedHash = createHash("sha256").update(INFECTION_HEADING_STYLE).digest("hex");
  const withoutGit = mapAdrCorpus([{ relPath, text: INFECTION_HEADING_STYLE }]).decisions[0]!;
  assert.equal(withoutGit.date, UNDATED_ADR_DATE);
  assert.equal(withoutGit.valid_from, undefined);
  assert.ok(withoutGit.provenance.evidence.includes(`sha256:${expectedHash}`));

  const sourceDate = "2026-08-25T12:34:56+00:00";
  const sourceRevision = "a".repeat(40);
  const withGit = mapAdrCorpus([{ relPath, text: INFECTION_HEADING_STYLE, sourceDate, sourceRevision }]).decisions[0]!;
  assert.equal(withGit.date, sourceDate);
  assert.equal(withGit.valid_from, sourceDate);
  assert.equal(withGit.commit, sourceRevision);
  assert.ok(withGit.provenance.evidence.includes(`source-commit:${sourceRevision}`));
});

test("mapAdrCorpus closes the superseded window and sets both pointers from a one-sided link", () => {
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: NYGARD_SUPERSEDED },
    { relPath: "doc/adr/0004-store-sessions-in-postgres.md", text: NYGARD_SUCCESSOR },
  ]);
  assert.equal(warnings.length, 0, warnings.join("; "));
  const redis = decisions.find((d) => d.related_files[0]!.includes("0002"))!;
  const pg = decisions.find((d) => d.related_files[0]!.includes("0004"))!;
  assert.equal(redis.status, "superseded");
  assert.equal(redis.superseded_by, pg.id);
  assert.equal(pg.supersedes, redis.id, "successor gains the supersedes pointer from the one-sided link");
  assert.equal(redis.valid_to, "2024-06-01", "window closes at the successor's date");
  assert.equal(pg.status, "accepted");
  assert.equal(pg.valid_to, null);
});

test("a superseded ADR with no dates anywhere keeps an OPEN window (migration precedent: never fabricate an instant)", () => {
  const undatedSuccessor = NYGARD_SUCCESSOR.replace(/^---\r?\ndate: 2024-06-01\r?\n---\r?\n/, "");
  const { decisions } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: NYGARD_SUPERSEDED },
    { relPath: "doc/adr/0004-store-sessions-in-postgres.md", text: undatedSuccessor },
  ]);
  const redis = decisions.find((d) => d.related_files[0]!.includes("0002"))!;
  assert.equal(redis.status, "superseded", "status carries the truth");
  assert.equal(redis.valid_to, null, "no instant is invented");
});

test("mapAdrCorpus maps rejected status, namespaced topics, alternatives minus chosen, provenance", () => {
  const { decisions } = mapAdrCorpus([
    { relPath: "docs/adr/0001-use-postgresql.md", text: MADR_ACCEPTED },
    { relPath: "docs/adr/0003-adopt-a-service-mesh.md", text: MADR_REJECTED },
  ]);
  const pg = decisions.find((d) => d.title.includes("PostgreSQL"))!;
  assert.equal(pg.topic, "adr.use-postgresql");
  assert.deepEqual(pg.alternatives_rejected, ["MongoDB", "SQLite"], "chosen option excluded");
  assert.equal(pg.valid_from, "2024-03-01");
  assert.equal(pg.provenance.source, "imported:madr");
  assert.deepEqual(pg.provenance.evidence[0], "docs/adr/0001-use-postgresql.md");
  const mesh = decisions.find((d) => d.title.includes("service mesh"))!;
  assert.equal(mesh.status, "rejected");
});

test("mapAdrCorpus warns on out-of-corpus supersede references instead of guessing ids", () => {
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: NYGARD_SUPERSEDED },
  ]);
  assert.equal(decisions[0]!.superseded_by, null, "no fabricated id");
  assert.equal(decisions[0]!.status, "superseded", "status still honest");
  assert.ok(warnings.some((w) => w.includes("ADR 4")), warnings.join("; "));
});

test("a bare deprecated ADR stays visible and preserves its source lifecycle without inventing a successor", () => {
  const relPath = "docs/adr/0006-use-a-shared-deployment-account.md";
  const parsed = parseAdrMarkdown(MADR_DEPRECATED, relPath)!;
  assert.equal(parsed.status, "accepted", "deprecated has no native Decision status, so it remains advisory/live pending review");
  assert.equal(parsed.statusRaw, "deprecated");

  const { decisions, warnings } = mapAdrCorpus([{ relPath, text: MADR_DEPRECATED }]);
  assert.equal(decisions[0]!.status, "accepted");
  assert.equal(decisions[0]!.superseded_by, null);
  assert.equal(decisions[0]!.valid_to, null, "no closure instant is fabricated");
  assert.ok(decisions[0]!.provenance.evidence.includes("status: deprecated"), "raw lifecycle remains inspectable");
  assert.ok(warnings.some((w) => w.includes("deprecated status names no resolvable successor")), warnings.join("; "));
});

test("deprecated by a corpus successor still closes the historical window", () => {
  const deprecatedBy = NYGARD_SUPERSEDED.replace("Superseded by", "Deprecated by");
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "doc/adr/0002-store-sessions-in-redis.md", text: deprecatedBy },
    { relPath: "doc/adr/0004-store-sessions-in-postgres.md", text: NYGARD_SUCCESSOR },
  ]);
  const redis = decisions.find((d) => d.related_files[0]!.includes("0002"))!;
  const pg = decisions.find((d) => d.related_files[0]!.includes("0004"))!;
  assert.equal(redis.status, "superseded");
  assert.equal(redis.superseded_by, pg.id);
  assert.equal(redis.valid_to, "2024-06-01");
  assert.equal(warnings.length, 0, warnings.join("; "));
});

test("mapAdrCorpus keeps at most one live decision per topic (highest ADR number wins)", () => {
  const a = MADR_ACCEPTED;
  const { decisions, warnings } = mapAdrCorpus([
    { relPath: "docs/adr/0001-use-postgresql.md", text: a },
    { relPath: "docs/adr/0005-use-postgresql.md", text: a },
  ]);
  const live = decisions.filter((d) => d.status === "accepted");
  assert.equal(live.length, 1);
  assert.ok(live[0]!.related_files[0]!.includes("0005"));
  const closed = decisions.find((d) => d.status === "superseded")!;
  assert.equal(closed.superseded_by, live[0]!.id);
  assert.ok(warnings.some((w) => w.includes("two live ADRs")));
});

test("ids derive from the file path, so re-import updates instead of duplicating", () => {
  assert.equal(adrDecisionId("docs/adr/0001-x.md"), adrDecisionId("docs/adr/0001-x.md"));
  const root = mkdtempSync(join(tmpdir(), "hunch-adr-"));
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-use-postgresql.md"), MADR_ACCEPTED);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const first = mapAdrCorpus([{ relPath: "docs/adr/0001-use-postgresql.md", text: MADR_ACCEPTED }]);
  for (const d of first.decisions) store.putCapture("decisions", d);
  const second = mapAdrCorpus([{ relPath: "docs/adr/0001-use-postgresql.md", text: MADR_ACCEPTED }]);
  for (const d of second.decisions) store.putCapture("decisions", d);
  assert.equal(store.json.loadAll("decisions").length, 1, "re-import is an update, not a duplicate");
  store.close();
  cleanupDir(root);
});
