import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { refreshExistingGrounding, writeAgentsMd, writeCursorRule } from "../src/integrations/providers.js";

test("self-heal: refreshExistingGrounding rewrites a stale grounding doc, idempotently, no scaffolding", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const claude = join(root, "CLAUDE.md");
  updateClaudeMd(root, store); // create a correct CLAUDE.md
  // simulate grounding written by an OLD generator (the param-name bug)
  writeFileSync(claude, readFileSync(claude, "utf8")
    .replace("hunch_context(target)", "hunch_context(target_or_task)")
    .replace("hunch_query(query)", "hunch_query(question)"));
  assert.match(readFileSync(claude, "utf8"), /hunch_context\(target_or_task\)/);
  assert.match(readFileSync(claude, "utf8"), /hunch_query\(question\)/);

  const changed = refreshExistingGrounding(root, store);
  assert.deepEqual(changed, ["CLAUDE.md"], "the stale doc was healed");
  assert.doesNotMatch(readFileSync(claude, "utf8"), /hunch_context\(target_or_task\)/);
  assert.match(readFileSync(claude, "utf8"), /hunch_context\(target\)/);
  assert.doesNotMatch(readFileSync(claude, "utf8"), /hunch_query\(question\)/);
  assert.match(readFileSync(claude, "utf8"), /hunch_query\(query\)/);

  // idempotent: a second pass changes nothing
  assert.deepEqual(refreshExistingGrounding(root, store), []);

  // refresh-only: never scaffolds a doc the project doesn't already have
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(existsSync(join(root, ".cursor", "rules", "hunch.mdc")), false);
});

test("portability: a newly recorded invariant propagates to EVERY existing grounding doc", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  // scaffold grounding for several assistants — they exist, so a refresh targets them all
  mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
  updateClaudeMd(root, store);
  writeAgentsMd(root, store);
  writeCursorRule(root, store);
  // a human records a new blocking invariant after init
  store.json.put("constraints", {
    id: "con_p", statement: "never import lodash", scope: ["src/**"], severity: "blocking",
    forbids: { deps: ["lodash"], symbols: [], patterns: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: "2020-01-01T00:00:00Z" },
  } as never);
  store.reindex();

  refreshExistingGrounding(root, store);
  for (const f of ["CLAUDE.md", "AGENTS.md", join(".cursor", "rules", "hunch.mdc")]) {
    assert.match(readFileSync(join(root, f), "utf8"), /lodash/, `${f} carries the new rule (held against every assistant)`);
  }
});
