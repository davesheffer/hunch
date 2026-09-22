/**
 * Partition isolation inside ONE overlay home. Organization, team and user partitions share the
 * overlay, so every rule that looks for an incumbent or a supersede target must compare the
 * record's partition with the write's, legacy kinds (decisions / constraints / bugs / findings)
 * belong to the store's own partition only, and a read names a denied partition only when a
 * record there matches the subject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { StateRefusal, partitionOf, readState, stateHomeFor, writeState } from "../src/store/stateBinding.js";
import { readLedger } from "../src/store/changeLedger.js";
import { stateHash, type Scope } from "../src/core/stateContract.js";

const org: Scope = { kind: "organization", id: "acme" };
const user: Scope = { kind: "user", id: "david" };
const prov = (who: string) => ({ source: "agent_recorded", confidence: 0.9, evidence: [`${who} derived it`] });

function overlayStore(): { store: HunchStore; cleanup: () => void } {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-state-partition-"));
  const root = join(sandbox, "repository");
  const overlay = join(sandbox, "private-memory", ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", join(sandbox, "private-memory")]);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, autoCommit: false }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { store, cleanup: () => { store.close(); rmSync(sandbox, { recursive: true, force: true }); } };
}

const agent = (id: string, grants: Scope[]) => ({ id, kind: "agent" as const, grants });

function derived(scope: Scope, who: string, day: string, subject = "customer:c1") {
  const content = `${scopeLabel(scope)} state as of ${day}`;
  return {
    schema: "nuryel.derived/1", scope, subject, content, content_hash: stateHash(content),
    dependencies: [{ kind: "external", ref: { system: "crm", object_type: "event", object_key: "26879", observed_at: `${day}T09:00:00Z`, content_hash: stateHash(`event-${day}`) } }],
    transform_version: "summary/v1", computed_at: `${day}T09:00:00Z`, valid_to: null, state: "current", provenance: prov(who),
  };
}
const scopeLabel = (s: Scope) => `${s.kind}:${s.id}`;

function write(store: HunchStore, principal: ReturnType<typeof agent>, scope: Scope, facet: string, record: Record<string, unknown>, key: string, over: Record<string, unknown> = {}) {
  return writeState(store, { schema: "nuryel.state.write/1", principal, scope, facet, record, idempotency_key: `idem-${principal.id}-${key}`, ...over });
}

function refusal(fn: () => unknown, code: StateRefusal["code"]): StateRefusal {
  try { fn(); } catch (e) {
    assert.ok(e instanceof StateRefusal, `expected a StateRefusal, got ${(e as Error).message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}

function currentDerived(store: HunchStore, principal: ReturnType<typeof agent>, scope: Scope, subject = "customer:c1"): string[] {
  const { response } = readState(store, { schema: "nuryel.state.read/1", principal, scope, subject, facets: ["derived"] });
  return response.state_of_record!.current.filter((r) => r.facet === "derived").map((r) => r.id).sort();
}

test("one current derived statement per subject is counted per partition: an organization statement never blocks a user partition's own", () => {
  const { store, cleanup } = overlayStore();
  try {
    const orgAgent = agent("orc", [org]);
    const userAgent = agent("sofia@david", [user]);
    const both = agent("assistant@david", [org, user]);
    const o = write(store, orgAgent, org, "derived", derived(org, "orc", "2026-09-01"), "o1");
    assert.equal(o.outcome, "created");

    // A user-only principal writes its own current statement for the same subject and transform.
    const u = write(store, userAgent, user, "derived", derived(user, "sofia@david", "2026-09-02"), "u1");
    assert.equal(u.outcome, "created");
    assert.deepEqual(currentDerived(store, userAgent, user), [u.record_id]);
    assert.deepEqual(currentDerived(store, orgAgent, org), [o.record_id], "the organization statement is untouched");

    // Within the user partition the rule still holds.
    const rival = derived(user, "assistant@david", "2026-09-03");
    const e = refusal(() => write(store, both, user, "derived", rival, "u2"), "conflict");
    assert.equal(e.conflict?.incumbent_id, u.record_id, "the incumbent is the user partition's own statement");
    assert.equal(write(store, both, user, "derived", rival, "u2-named", { supersedes: u.record_id }).outcome, "superseded");
  } finally { cleanup(); }
});

test("a supersede target in another partition is refused, even for a principal granted both; nothing moves in either partition", () => {
  const { store, cleanup } = overlayStore();
  try {
    const orgAgent = agent("orc", [org]);
    const userOnly = agent("sofia@david", [user]);
    const both = agent("assistant@david", [org, user]);
    const o = write(store, orgAgent, org, "derived", derived(org, "orc", "2026-09-01"), "o1");
    const { hunchDir } = stateHomeFor(store, org);
    const orgHead = readLedger(hunchDir, org).head_seq;

    const e = refusal(() => write(store, both, user, "derived", derived(user, "assistant@david", "2026-09-02"), "cross", { supersedes: o.record_id }), "conflict");
    assert.equal(e.conflict?.incumbent_id, o.record_id);
    assert.equal(e.conflict?.reason, "supersede target in another partition");
    // A principal that cannot see the target learns nothing about it.
    refusal(() => write(store, userOnly, user, "derived", derived(user, "sofia@david", "2026-09-02"), "cross", { supersedes: o.record_id }), "outside-grants");

    assert.deepEqual(currentDerived(store, orgAgent, org), [o.record_id], "the organization statement is still current");
    assert.equal(readLedger(hunchDir, org).head_seq, orgHead, "no event reached the organization ledger");
    assert.equal(readLedger(hunchDir, user).head_seq, 0, "no event reached the user ledger");
    assert.equal(store.getStateDirect("derived", o.record_id, "private")?.valid_to, null);

    // Without the cross-partition supersedes the user statement is simply created beside it.
    assert.equal(write(store, both, user, "derived", derived(user, "assistant@david", "2026-09-02"), "own").outcome, "created");
  } finally { cleanup(); }
});

test("a record id held by another partition in the same home is never overwritten from this partition", () => {
  const { store, cleanup } = overlayStore();
  try {
    const both = agent("assistant@david", [org, user]);
    const entity = (scope: Scope) => ({ schema: "nuryel.entity/1", id: "customer:clinic-7", kind: "customer", name: "Clinic Seven", scope, refs: [{ system: "crm", object_type: "site", object_key: "7", observed_at: "2026-09-09T08:00:00Z" }], attributes: {}, lifecycle: "active", provenance: prov("assistant@david"), created_at: "2026-09-09T08:00:00Z", updated_at: "2026-09-09T08:00:00Z" });
    const first = write(store, both, org, "entities", entity(org), "e-org");
    assert.equal(first.outcome, "created");
    const e = refusal(() => write(store, both, user, "entities", entity(user), "e-user"), "conflict");
    assert.equal(e.conflict?.reason, "record id held by another partition");
    assert.deepEqual((store.getRec("entities", first.record_id) as { scope: Scope }).scope, org, "the organization entity keeps its partition");
  } finally { cleanup(); }
});

test("legacy kinds are the store's own partition only: an organization or user scope is refused, never re-homed as a repository record", () => {
  const { store, cleanup } = overlayStore();
  try {
    const orgAgent = agent("orc", [org]);
    const constraint = { id: "con_orgwritten01", type: "correctness", statement: "every export must be signed", scope: ["src/**"], severity: "blocking", enforcement: "advisory_v1", rationale: "r", source_decision: null, violations: [], status: "active", valid_from: "2026-09-01T00:00:00Z", valid_to: null, provenance: prov("orc") };
    const e = refusal(() => write(store, orgAgent, org, "constraints", constraint, "c1"), "unsupported");
    assert.match(e.message, /constraints/);
    assert.equal(store.getRec("constraints", "con_orgwritten01"), undefined, "nothing landed");
    const userAgent = agent("sofia@david", [user]);
    const decision = { id: "dec_userwritten01", title: "t", topic: null, status: "accepted", context: "", decision: "d", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov("sofia@david"), date: "2026-09-01T00:00:00Z" };
    refusal(() => write(store, userAgent, user, "decisions", decision, "d1"), "unsupported");
    assert.equal(store.getRec("decisions", "dec_userwritten01"), undefined);

    // The store's own partition still takes legacy kinds.
    const repo = partitionOf(store);
    assert.equal(write(store, agent("engineer", [repo]), repo, "decisions", decision, "d-repo").outcome, "created");
  } finally { cleanup(); }
});

test("a derived-facet read names a denied partition only when a record there matches the subject", () => {
  const { store, cleanup } = overlayStore();
  try {
    write(store, agent("orc", [org]), org, "derived", derived(org, "orc", "2026-09-01"), "o1");
    const userAgent = agent("sofia@david", [user]);
    const read = (subject: string) => readState(store, { schema: "nuryel.state.read/1", principal: userAgent, scope: user, subject, facets: ["derived"] }).response;
    assert.deepEqual(read("customer:unrelated").denied_scopes, [], "an unrelated subject reveals no partition");
    assert.deepEqual(read("customer:c1").denied_scopes, [org], "a matching record is named by partition, never described");
  } finally { cleanup(); }
});
