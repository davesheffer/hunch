/**
 * Selection quality on a realistic-sized memory (bug class: ranking that only
 * fails on real data). The unit tests in task-selection.test.ts use tiny stores;
 * on a ~740-record memory, common words crowded out rare identifiers and brand
 * words, file names and pasted stack traces selected unrelated records.
 *
 * The corpus is SYNTHETIC and generated from a fixed seed (no record is copied
 * from any store): ~500 live records with a Zipf-skewed vocabulary, brand/tool
 * words in 5-30 records each, file names, repo-path anchors, version strings,
 * stack-trace snippets, and hand-written TARGET records each about one rare
 * identifier or path. Golden prompts check recall (target in top-3), precision
 * (no false qualifiers), path anchoring and insertion-order stability; the
 * aggregate metrics are asserted at today's measured values (no regressions).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BugSchema, ConstraintSchema, DecisionSchema, FindingSchema, type Bug, type Constraint, type Decision, type Finding } from "../src/core/types.js";
import { lexicalTokens } from "../src/core/delivery.js";
import { DF_CAP_RATIO, MIN_DF_CAP, identifierTokens, liveSelectionRecords, selectForTask, type TaskSelectionRecords } from "../src/core/taskSelection.js";

// ---------------------------------------------------------------------------
// Deterministic generator
// ---------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG, identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Vocabulary in Zipf rank order (rank r drawn with weight 1/r): the head is the
 *  project's everyday nouns (above the DF cap), the long tail is ordinary prose
 *  and domain words that land between a handful and a few dozen records. */
const VOCAB = `
guard lock delivery hook store team policy record task grounding decision memory prompt check merge
commit index write read session gate schema config cache release test agent file path scope git
constraint finding drift topic overlay branch query ledger token partition sync update change run build
error state event rule review graph component workspace provider hunch server client tool output input
default value list order time reason data field form flag step version entry line message status result
keep skip skipped skips push pushed open opened call calls called get set show shown hide hidden
retry retries timeout race stale fresh cold warm empty missing broken flaky slow fast safe unsafe
first last next previous new old same other single double many every each only never always again
window marker anchor label owner principal receipt commitment subject summary payload handler route
renderer sampler compactor watermark backoff debounce throttle heartbeat quorum snapshot tombstone manifest
why how what who because instead before after during between across inside outside around
budget limit count size depth width height offset cursor page batch chunk stream queue worker job
expire expired expiry logout login account user admin role permission access grant revoke audit
notes changelog readme install setup bump tag publish deploy ship cut draft pending held blocked
cleanup twice once loop render effect mount unmount state props context provider reducer selector
upgrade downgrade pin unpin vendor package json yaml toml lockfile registry mirror proxy network offline
trace stack frame throw thrown catch caught reject rejected resolve resolved promise async await
rename renamed move moved copy copied delete deleted create created replace replaced append truncate
orders invoice lines sales customer clinic site schedule visit report reports xml junit parse parsed
renewal renew lease expiry owner pid process thread signal kill exit exited stall stalled hang
remote origin upstream fork clone fetch pull rebase squash cherry conflict resolve diff patch hunk
wins winner precedence priority weight score rank sort tie tiebreak cap threshold ratio frequency
`.trim().split(/\s+/);

const ZIPF_CUMULATIVE = (() => {
  let sum = 0;
  return VOCAB.map((_, i) => (sum += 1 / (i + 1)));
})();
function zipfWord(rand: () => number): string {
  const total = ZIPF_CUMULATIVE[ZIPF_CUMULATIVE.length - 1]!;
  const x = rand() * total;
  let lo = 0;
  let hi = ZIPF_CUMULATIVE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ZIPF_CUMULATIVE[mid]! < x) lo = mid + 1; else hi = mid;
  }
  return VOCAB[lo]!;
}
const FILLER = ["the", "a", "of", "in", "to", "and", "for", "with", "on", "is"];
function phrase(rand: () => number, min: number, max: number): string {
  const n = min + Math.floor(rand() * (max - min + 1));
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    words.push(zipfWord(rand));
    if (rand() < 0.3) words.push(FILLER[Math.floor(rand() * FILLER.length)]!);
  }
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Incidental mentions: inserted into N generic records' context ("seen on macOS"),
 *  never the record's topic. Counts sit in the 5-30 band the real memory showed. */
const BRANDS: ReadonlyArray<readonly [string, number]> = [
  ["GitHub", 24], ["SQLite", 30], ["Windows", 20], ["PowerShell", 12], ["macOS", 9], ["useEffect", 6], ["Docker", 10], ["npm", 18],
];
const FILE_NAMES: ReadonlyArray<readonly [string, number]> = [
  ["README.md", 14], ["package.json", 16], ["CHANGELOG.md", 10], ["tsconfig.json", 5], ["AGENTS.md", 8],
];
const VERSIONS: ReadonlyArray<readonly [string, number]> = [
  ["1.27.0", 5], ["1.28.0", 4], ["v1.8.3", 3], ["1.44.0", 6], ["2.0.0-beta.1", 2],
];
/** Code identifiers common across the memory (well above MIN_DF_CAP): they must never pick a record. */
const COMMON_IDENTIFIERS: ReadonlyArray<readonly [string, number]> = [
  ["writeFileSync", 30], ["selectForTask", 12], ["HunchStore", 20], ["readJsonFile", 8], ["process.env", 25], ["hook_policy", 6],
];
const HUB_PATH = "src/cli/main.ts";
/** Anchors drawn for generic records (hub weighted heavily). Rare paths are never drawn. */
const PATHS = [
  "src/store/ledger.ts", "src/store/cache.ts", "src/hooks/gate.ts", "src/hooks/prompt.ts", "src/policy/eval.ts",
  "src/policy/load.ts", "src/delivery/rank.ts", "src/delivery/format.ts", "src/team/roster.ts", "src/serve/http.ts",
  "src/sync/merge.ts", "src/index/fts.ts", "docs/guide.md", "test/ledger.test.ts", "scripts/release.mjs",
];
const STACK_SNIPPETS = [
  "    at Object.renameSync (node:fs:1024:11)\n    at writeJsonAtomic (src/store/ledger.ts:88:5)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
  "    at acquireLock (src/store/cache.ts:31:9)\n    at async Promise.all (index 0)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
  "    at StatementSync.run (node:sqlite:1:1)\n    at indexRecords (src/index/fts.ts:210:12)",
  "    at renderCard (src/delivery/format.ts:120:18)\n    at Array.map (<anonymous>)\n    at Object.readFileSync (node:fs:452:35)",
];

const provenance = { source: "human_confirmed", confidence: 0.8, evidence: [] };
const DATE = "2026-09-01";
const dec = (over: Partial<Decision> & { id: string; title: string }): Decision =>
  DecisionSchema.parse({ status: "accepted", decision: "", provenance, date: DATE, ...over });
const bug = (over: Partial<Bug> & { id: string; title: string }): Bug => BugSchema.parse({ provenance, ...over });
const fnd = (over: Partial<Finding> & { id: string; title: string }): Finding => FindingSchema.parse({ observed_at: DATE, provenance, ...over });
const con = (over: Partial<Constraint> & { id: string; statement: string }): Constraint => ConstraintSchema.parse({ provenance, ...over });

/** Hand-written records: the TARGETS (one rare identifier or rare path each), their
 *  near-miss decoys (many shared prompt words, not the identifier), and the few
 *  records that are genuinely about a precision prompt's topic. */
function specialRecords(): TaskSelectionRecords {
  const decisions: Decision[] = [
    dec({ id: "dec_t_showinforms", title: "Guards skip fields whose ShowInForms flag is false", context: "The intake form guard evaluated hidden fields. ShowInForms false now short-circuits the guard, so hidden fields are skipped.", decision: "Check ShowInForms before running any field guard.", related_files: ["src/forms/render.ts"] }),
    dec({ id: "dec_d_hiddenfields", title: "Why hidden form fields get skipped by the guard", context: "Hidden fields get skipped because the form guard only sees shown fields.", decision: "Keep the guard on shown form fields only." }),
    dec({ id: "dec_d_formguard", title: "Form guard order: why skipped fields get no default", context: "Skipped form fields get no default value; the guard runs after the form is shown.", decision: "Leave skipped fields empty." }),
    dec({ id: "dec_t_getorders", title: "Read orders through dbo.GetOrders instead of inline SQL", context: "The sync job queried the orders table directly and held a table lock.", decision: "Call the dbo.GetOrders procedure; it reads with a row lock only.", related_files: ["db/procs/orders.sql"] }),
    dec({ id: "dec_d_orderslock", title: "Orders sync takes a lock before it runs", context: "What the orders sync locks when it runs decides whether the clinic schedule stalls.", decision: "Lock the orders batch, not the table." }),
    dec({ id: "dec_t_resolvepending", title: "resolve_pending_commit runs after every merge", context: "Provenance repair queued in pending files was never applied; resolve_pending_commit is now called from the post-merge hook.", decision: "Call resolve_pending_commit after a merge, never before." }),
    dec({ id: "dec_t_ledgersnapshot", title: "buildLedgerSnapshot takes a read lock on the store", context: "Snapshots taken while the store was locked for write returned half-written entries.", decision: "buildLedgerSnapshot acquires the shared read lock and is safe to call while a write lock is queued." }),
    dec({ id: "dec_t_writeatomic", title: "writeAtomicJsonFile writes a temp file then renames", context: "An interrupted write in place truncated the index.", decision: "writeAtomicJsonFile writes to a temp file and renames it over the target instead of writing in place.", related_files: ["src/store/io.ts"] }),
    dec({ id: "dec_d_renameinplace", title: "Rename instead of writing in place for every ledger write", context: "Why rename: writing in place leaves a truncated file on crash.", decision: "Rename instead of writing in place." }),
    dec({ id: "dec_t_invoicelines", title: "Team policy for sales.InvoiceLines updates", context: "Updates to sales.InvoiceLines changed invoice totals without review.", decision: "Route every sales.InvoiceLines update through the finance team policy." }),
    dec({ id: "dec_t_hookpolicyevaluator", title: "HookPolicyEvaluator: the strictest hook policy wins", context: "Two hook policies matched one edit and the evaluator picked the first.", decision: "HookPolicyEvaluator ranks matching policies by severity; the strictest wins, ties break on id." }),
    dec({ id: "dec_d_policywins", title: "How hook policy precedence decides which policy wins", context: "How the hook decides which policy wins when two match: precedence by severity.", decision: "Policy precedence: severity first, then scope depth." }),
    dec({ id: "dec_t_overlayremote", title: "ensureOverlayRemote pushes the overlay branch on first sync", context: "The overlay branch existed only locally, so a second machine saw no private memory.", decision: "ensureOverlayRemote adds the remote and pushes the overlay branch once." }),
    dec({ id: "dec_t_orgpartition", title: "org_partition_map assigns one owning team per partition", context: "Two teams wrote to the same partition with no owner.", decision: "org_partition_map lists exactly one owner team for each partition." }),
    dec({ id: "dec_t_drawersub", title: "useDrawerSubscription memoizes the delivery filter", context: "The drawer re-rendered on every delivery event because the filter object changed each render.", decision: "useDrawerSubscription memoizes the filter and compares event ids." }),
    dec({ id: "dec_t_writelockrenewal", title: "Renew the serve write lease before half its window", context: "A slow request outlived the lease and a second writer took over.", decision: "Renew at half the lease window; release on exit.", related_files: ["src/serve/writelockRenewal.ts"] }),
    dec({ id: "dec_s_writelockrenewal", title: "Lease renewal logs the owner pid", context: "Debugging stolen leases needed the owner.", decision: "Log owner pid on every renewal.", related_files: ["src/serve/writelockRenewal.ts", HUB_PATH] }),
    dec({ id: "dec_t_conductor", title: "The farm conductor reaps exited agents before scheduling", context: "An agent that exited left its slot held and the farm stalled.", decision: "Reap exited agents on every scheduling tick.", related_files: ["tooling/agent-farm/conductor.mjs"] }),
    // Genuinely about precision prompts' topics.
    dec({ id: "dec_p_github_pr", title: "Open a PR from a pushed branch; never push to main on GitHub", context: "Direct pushes to main skipped review.", decision: "Push a branch to GitHub and open a PR for every change." }),
    dec({ id: "dec_p_release_bump", title: "Bump the version in package.json only in the release PR", context: "Version bumps in feature PRs conflicted.", decision: "Only the release PR bumps the package.json version." }),
    dec({ id: "dec_p_docs_sync", title: "Keep README.md and CHANGELOG.md in sync at release", context: "The README install steps lagged the CHANGELOG.", decision: "Update CHANGELOG.md and README.md together in the release PR." }),
  ];
  const bugs: Bug[] = [
    bug({ id: "bug_t_sessiontokens", title: "Rows in user_session_tokens never expire after logout", symptom: "user_session_tokens kept rows for logged-out accounts.", root_cause: "Logout deleted the cookie but not the user_session_tokens row.", affected_files: ["db/tables/sessions.sql"] }),
    bug({ id: "bug_s_showinforms", title: "ShowInForms default flipped in the form schema", symptom: "New fields were hidden.", root_cause: "Schema default for ShowInForms changed to false." }),
    bug({ id: "bug_p_enoent_config", title: "First run crashed with ENOENT when .hunch/config.json was missing", symptom: "Error: ENOENT: no such file or directory, open .hunch/config.json", root_cause: "loadConfig read the config file before init created it.", affected_files: ["src/core/config.ts"] }),
    bug({ id: "bug_s_eperm", title: "EPERM on rename during atomic ledger write", symptom: `Error: EPERM: operation not permitted, rename\n${STACK_SNIPPETS[0]}`, root_cause: "An antivirus scanner held the temp file.", affected_files: ["src/store/ledger.ts"] }),
    bug({ id: "bug_s_lockheld", title: "Cache lock held by a dead pid", symptom: `Error: lock held by pid 4242\n${STACK_SNIPPETS[1]}`, root_cause: "Stale lock file after a crash.", affected_files: ["src/store/cache.ts"] }),
    bug({ id: "bug_s_dblocked", title: "Index rebuild failed: database is locked", symptom: `Error: database is locked\n${STACK_SNIPPETS[2]}`, root_cause: "Two indexers ran at once.", affected_files: ["src/index/fts.ts"] }),
    bug({ id: "bug_s_undefinedtitle", title: "Card render threw on a record with no title", symptom: `TypeError: Cannot read properties of undefined (reading 'title')\n${STACK_SNIPPETS[3]}`, root_cause: "Findings without a title reached the card renderer.", affected_files: ["src/delivery/format.ts"] }),
  ];
  const constraints: Constraint[] = [
    con({ id: "con_t_retrybudget", statement: "MAX_RETRY_BUDGET caps delivery retries per task", rationale: "Raising MAX_RETRY_BUDGET let one failing hook retry delivery for minutes.", scope: ["src/delivery/**"], severity: "warning" }),
    con({ id: "con_s_serve", statement: "Served writes hold the write lease", rationale: "Two writers corrupt the ledger.", scope: ["src/serve/**"], severity: "blocking" }),
    con({ id: "con_s_srcall", statement: "Source files stay ESM TypeScript", rationale: "One module system.", scope: ["src/**"], severity: "warning" }),
    con({ id: "con_s_policy", statement: "Policy evaluation is pure", rationale: "Replays must reproduce verdicts.", scope: ["src/policy/**"], severity: "warning" }),
  ];
  const findings: Finding[] = [
    fnd({ id: "fnd_t_parsetestreport", title: "parseTestReportXml drops skipped tests from the report", observation: "JUnit <skipped/> elements are ignored by parseTestReportXml, so skipped tests vanish from the test report.", affected_files: ["src/extract/testReport.ts"] }),
  ];
  return { decisions, bugs, constraints, findings };
}

interface Corpus {
  records: TaskSelectionRecords;
  /** Every live record's anchors, for computing path expectations from construction. */
  anchors: Map<string, readonly string[]>;
}

const SEED = 0x5e1ec7;
const GENERIC = { decisions: 380, constraints: 32, findings: 30, bugs: 28 };

function buildCorpus(): Corpus {
  const rand = rng(SEED);
  const special = specialRecords();
  type Draft = { id: string; kind: "decision" | "constraint" | "finding" | "bug"; title: string; context: string; body: string; files: string[] };
  const drafts: Draft[] = [];
  const kinds = [["decision", "dec_g", GENERIC.decisions], ["constraint", "con_g", GENERIC.constraints], ["finding", "fnd_g", GENERIC.findings], ["bug", "bug_g", GENERIC.bugs]] as const;
  for (const [kind, prefix, n] of kinds) {
    for (let i = 0; i < n; i++) {
      const files: string[] = [];
      const anchorCount = Math.floor(rand() * 3);
      for (let a = 0; a < anchorCount; a++) {
        const file = rand() < 0.35 ? HUB_PATH : PATHS[Math.floor(rand() * PATHS.length)]!;
        if (!files.includes(file)) files.push(file);
      }
      drafts.push({ id: `${prefix}_${String(i).padStart(3, "0")}`, kind, title: phrase(rand, 3, 6), context: phrase(rand, 8, 14), body: phrase(rand, 6, 10), files });
    }
  }
  // Incidental mentions, each in a fixed number of distinct generic records.
  for (const [token, count] of [...BRANDS, ...FILE_NAMES, ...VERSIONS, ...COMMON_IDENTIFIERS]) {
    for (const draft of shuffle(drafts, rand).slice(0, count)) {
      const words = draft.context.split(" ");
      words.splice(Math.floor(rand() * (words.length + 1)), 0, token);
      draft.context = words.join(" ");
    }
  }
  // A few generic bugs carry a pasted stack trace (frames shared with the special bugs).
  for (const draft of drafts.filter((d) => d.kind === "bug").slice(0, 6)) {
    draft.context += `\n${STACK_SNIPPETS[Math.floor(rand() * STACK_SNIPPETS.length)]}`;
  }
  const records: TaskSelectionRecords = {
    decisions: [...special.decisions],
    bugs: [...special.bugs],
    constraints: [...special.constraints],
    findings: [...special.findings],
  };
  const out = records as { decisions: Decision[]; bugs: Bug[]; constraints: Constraint[]; findings: Finding[] };
  for (const d of drafts) {
    if (d.kind === "decision") out.decisions.push(dec({ id: d.id, title: d.title, context: d.context, decision: d.body, related_files: d.files }));
    else if (d.kind === "bug") out.bugs.push(bug({ id: d.id, title: d.title, symptom: d.context, root_cause: d.body, affected_files: d.files }));
    else if (d.kind === "finding") out.findings.push(fnd({ id: d.id, title: d.title, observation: `${d.context} ${d.body}`, affected_files: d.files }));
    else {
      // Constraints scope by glob: a directory of their drawn file, or none (broad rules live in specialRecords).
      const scope = d.files.length ? [d.files[0]!.replace(/\/[^/]+$/, "/**")] : ["docs/**"];
      out.constraints.push(con({ id: d.id, statement: d.title, rationale: `${d.context} ${d.body}`, scope, severity: rand() < 0.2 ? "blocking" : "warning" }));
    }
  }
  // Superseded/rejected history naming the targets' identifiers: never live, never selected.
  for (const [i, name] of ["ShowInForms", "dbo.GetOrders", "resolve_pending_commit", "HookPolicyEvaluator", "useDrawerSubscription"].entries()) {
    out.decisions.push(dec({ id: `dec_h_${i}`, title: `Old approach to ${name}`, context: `${name} used to run inline.`, status: "superseded", superseded_by: "dec_x", valid_to: "2026-08-01T00:00:00Z", related_files: ["src/serve/writelockRenewal.ts"] }));
    out.decisions.push(dec({ id: `dec_r_${i}`, title: `Rejected rewrite of ${name}`, context: `${name} rewrite was rejected.`, status: "rejected" }));
  }
  const live = liveSelectionRecords(records);
  const anchors = new Map<string, readonly string[]>();
  for (const d of live.decisions) anchors.set(d.id, d.related_files);
  for (const b of live.bugs) anchors.set(b.id, b.affected_files);
  for (const f of live.findings) anchors.set(f.id, f.affected_files);
  for (const c of live.constraints) anchors.set(c.id, c.scope);
  return { records: live, anchors };
}

const corpus = buildCorpus();
/** Record id -> its scored tokens (same text fields as selectForTask), for diagnostics only. */
const recordTokens = new Map<string, Set<string>>();
for (const d of corpus.records.decisions) recordTokens.set(d.id, new Set([...lexicalTokens([d.title, d.context, d.decision].join(" ")), ...identifierTokens([d.title, d.context, d.decision].join(" "))]));
for (const b of corpus.records.bugs) recordTokens.set(b.id, new Set([...lexicalTokens([b.title, b.symptom, b.root_cause].join(" ")), ...identifierTokens([b.title, b.symptom, b.root_cause].join(" "))]));
for (const c of corpus.records.constraints) recordTokens.set(c.id, new Set([...lexicalTokens([c.statement, c.rationale].join(" ")), ...identifierTokens([c.statement, c.rationale].join(" "))]));
for (const f of corpus.records.findings) recordTokens.set(f.id, new Set([...lexicalTokens([f.title, f.observation].join(" ")), ...identifierTokens([f.title, f.observation].join(" "))]));
const liveCount = (r: TaskSelectionRecords) => r.decisions.length + r.bugs.length + r.constraints.length + r.findings.length;

function shuffledCorpus(seed: number): TaskSelectionRecords {
  const rand = rng(seed);
  const r = corpus.records;
  return { decisions: shuffle(r.decisions, rand), bugs: shuffle(r.bugs, rand), constraints: shuffle(r.constraints, rand), findings: shuffle(r.findings, rand) };
}

// ---------------------------------------------------------------------------
// Golden prompts
// ---------------------------------------------------------------------------

interface RecallPrompt { prompt: string; target: string; todo?: string }
const RECALL: RecallPrompt[] = [
  { prompt: "why does ShowInForms get skipped for guards", target: "dec_t_showinforms" },
  { prompt: "why does show_in_forms get skipped for guards", target: "dec_t_showinforms" },
  { prompt: "what does dbo.GetOrders lock when the sync runs", target: "dec_t_getorders" },
  { prompt: "where is resolve_pending_commit called after a merge", target: "dec_t_resolvepending" },
  { prompt: "is buildLedgerSnapshot safe to call while the store is locked?", target: "dec_t_ledgersnapshot" },
  { prompt: "can I raise MAX_RETRY_BUDGET for delivery retries", target: "con_t_retrybudget" },
  { prompt: "why does `writeAtomicJsonFile` rename instead of writing in place", target: "dec_t_writeatomic" },
  { prompt: "rows in user_session_tokens never expire after logout", target: "bug_t_sessiontokens" },
  { prompt: "should the team policy cover sales.InvoiceLines updates", target: "dec_t_invoicelines" },
  { prompt: "how does HookPolicyEvaluator decide which hook policy wins", target: "dec_t_hookpolicyevaluator" },
  { prompt: "parseTestReportXml drops skipped tests from the report", target: "fnd_t_parsetestreport" },
  { prompt: "why does ensureOverlayRemote push the overlay branch", target: "dec_t_overlayremote" },
  { prompt: "who owns org_partition_map for each team", target: "dec_t_orgpartition" },
  { prompt: "useDrawerSubscription re-renders on every delivery event", target: "dec_t_drawersub" },
  { prompt: "fix the renewal race in src/serve/writelockRenewal.ts", target: "dec_t_writelockrenewal" },
  { prompt: "the farm stalls in tooling/agent-farm/conductor.mjs when an agent exits", target: "dec_t_conductor" },
];

/** Precision prompts: every qualifying id must be in `allowed`; anything else is a false
 *  qualifier that would hide real file memory. `allowed` = the hand-written records about
 *  the prompt's topic, plus generic records sharing TWO distinct things with the prompt
 *  (e.g. a brand word and another prompt word): the filler is random, so such a co-mention
 *  cannot be called unrelated. One thing alone (a single brand word, a file name, the
 *  boilerplate frames of a pasted stack trace) never makes a record relevant. */
interface PrecisionPrompt { name: string; prompt: string; allowed: readonly string[]; todo?: string }
const PRECISION: PrecisionPrompt[] = [
  { name: "brand: GitHub PR", prompt: "push to GitHub and open a PR", allowed: ["dec_p_github_pr"] },
  {
    name: "brand: PowerShell on Windows", prompt: "run this in PowerShell on Windows",
    // dec_g_078 also shares "window"+"run"; dec_g_268/dec_g_309 share "run". The other 9 share only PowerShell.
    allowed: ["dec_g_078", "dec_g_268", "dec_g_309"],
  },
  { name: "brand: SQLite on macOS", prompt: "upgrade SQLite to 3.46.0 on macOS", allowed: [] },
  { name: "brand: useEffect", prompt: "the useEffect cleanup runs twice", allowed: ["dec_g_315"] /* useEffect + "twice" */ },
  { name: "brand: Docker + npm", prompt: "npm install fails inside Docker", allowed: ["dec_g_017", "dec_g_194"] /* docker+inside, npm+install */ },
  { name: "file name: README.md", prompt: "update README.md with the new install steps", allowed: ["dec_p_docs_sync", "con_g_014", "dec_g_220"] /* readme+install */ },
  { name: "file names: CHANGELOG.md + README.md", prompt: "update CHANGELOG.md and README.md", allowed: ["dec_p_docs_sync", "dec_g_075"] /* changelog+readme */ },
  { name: "file name: package.json version", prompt: "bump the version in package.json to 1.28.0", allowed: ["dec_p_release_bump"] },
  { name: "file name: tsconfig.json / AGENTS.md", prompt: "tighten tsconfig.json and mention it in AGENTS.md", allowed: [] },
  { name: "version: release notes", prompt: "write the release notes for v1.44.0", allowed: [] },
  { name: "version: diff between versions", prompt: "what changed between 1.27.0 and 1.28.0", allowed: [] },
  { name: "common identifier: writeFileSync", prompt: "replace writeFileSync with HunchStore and readJsonFile", allowed: [] },
  {
    name: "stack trace: ENOENT (node internals only)",
    prompt: [
      "Error: ENOENT: no such file or directory, open 'C:\\work\\proj\\.hunch\\config.json'",
      "    at Object.openSync (node:fs:573:3)",
      "    at Object.readFileSync (node:fs:452:35)",
      "    at loadConfig (file:///C:/work/proj/node_modules/@davesheffer/hunch/dist/core/config.js:41:17)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n"),
    allowed: ["bug_p_enoent_config"],
  },
  {
    name: "stack trace: unrelated TypeError through shared node frames",
    prompt: [
      "TypeError: Cannot read properties of null (reading 'length')",
      "    at Array.map (<anonymous>)",
      "    at Object.readFileSync (node:fs:452:35)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n"),
    // Same error genre ("TypeError: Cannot read properties of ..."), so arguably related.
    allowed: ["bug_s_undefinedtitle"],
  },
];

/** Path prompts: the bare path, then the same path with common words added. */
interface PathPrompt { path: string; expected: readonly string[]; mustInclude?: readonly string[]; extras: readonly string[] }
/** Records anchored to `path` by construction (literal anchor, or a constraint glob over its directory). */
function anchoredTo(path: string): string[] {
  const out: string[] = [];
  for (const [id, anchors] of corpus.anchors) {
    if (anchors.some((a) => a === path || (a.endsWith("/**") && (path.startsWith(a.slice(0, -2)))))) out.push(id);
  }
  return out.sort();
}
const PATH_PROMPTS: PathPrompt[] = [
  {
    path: "src/serve/writelockRenewal.ts",
    // Superseded dec_h_* also anchor here and must not appear; con_s_serve/con_s_srcall cover it by glob.
    expected: anchoredTo("src/serve/writelockRenewal.ts"),
    mustInclude: ["con_s_serve", "con_s_srcall", "dec_s_writelockrenewal", "dec_t_writelockrenewal"],
    extras: ["fix the guard lock in", "the delivery hook policy for the team store in"],
  },
  {
    path: "tooling/agent-farm/conductor.mjs",
    expected: anchoredTo("tooling/agent-farm/conductor.mjs"),
    mustInclude: ["dec_t_conductor"],
    extras: ["update the task record guard in"],
  },
  { path: HUB_PATH, expected: anchoredTo(HUB_PATH), extras: ["the guard lock delivery in"] },
  { path: "src/policy/eval.ts", expected: anchoredTo("src/policy/eval.ts"), extras: ["policy hook guard store in"] },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const select = (prompt: string, records: TaskSelectionRecords = corpus.records) => selectForTask(records, prompt, { k: 3 });

/** Measured on this corpus when the test was written; a lower recall or a higher
 *  false-qualifier count is a regression. Tighten these when selection improves. */
const BASELINE = { recallAt3: 1, falseQualifiers: 0 };

test("the corpus is realistic: ~500 live records, head words above the DF cap, brand words inside it", () => {
  const n = liveCount(corpus.records);
  assert.ok(n >= 480 && n <= 520, `live records: ${n}`);
  const cap = Math.max(MIN_DF_CAP, Math.ceil(DF_CAP_RATIO * n));
  const df = new Map<string, number>();
  const texts = [
    ...corpus.records.decisions.map((d) => [d.title, d.context, d.decision]),
    ...corpus.records.bugs.map((b) => [b.title, b.symptom, b.root_cause]),
    ...corpus.records.constraints.map((c) => [c.statement, c.rationale]),
    ...corpus.records.findings.map((f) => [f.title, f.observation]),
  ];
  for (const parts of texts) for (const t of lexicalTokens(parts.join(" "))) df.set(t, (df.get(t) ?? 0) + 1);
  for (const head of ["guard", "lock", "delivery", "hook", "store", "team", "policy"]) {
    assert.ok((df.get(head) ?? 0) > cap, `head word "${head}" df ${df.get(head)} must exceed the cap ${cap}`);
  }
  const band = [...df.values()].filter((v) => v > MIN_DF_CAP && v <= cap).length;
  assert.ok(band >= 50, `the mid-frequency band (rare enough to count) holds ${band} words`);
  console.log(`# corpus: ${n} live records, DF cap ${cap}, ${df.size} distinct words, ${band} in the countable mid band`);
});

for (const r of RECALL) {
  test(`recall: ${r.prompt}`, r.todo ? { todo: r.todo } : {}, () => {
    const out = select(r.prompt);
    assert.ok(out.top.some((t) => t.id === r.target), `${r.target} not in top-3: ${JSON.stringify(out.top.map((t) => t.id))}`);
    assert.ok(!out.qualifying.some((id) => id.startsWith("dec_h_") || id.startsWith("dec_r_")), "superseded/rejected history never qualifies");
  });
}

for (const p of PRECISION) {
  test(`precision: ${p.name}`, p.todo ? { todo: p.todo } : {}, () => {
    const out = select(p.prompt);
    const extra = out.qualifying.filter((id) => !p.allowed.includes(id));
    assert.deepEqual(extra, [], `false qualifiers for ${JSON.stringify(p.prompt)}`);
  });
}

for (const p of PATH_PROMPTS) {
  test(`path: ${p.path} selects the records anchored to it, and common words change nothing`, () => {
    assert.ok(p.expected.length > 0);
    for (const id of p.mustInclude ?? []) assert.ok(p.expected.includes(id), `${id} is anchored to ${p.path} by construction`);
    assert.ok(!p.expected.some((id) => id.startsWith("dec_h_")), "superseded history anchored to the path is not live");
    const bare = select(p.path);
    assert.deepEqual([...bare.qualifying].sort(), [...p.expected].sort());
    for (const extra of p.extras) {
      const out = select(`${extra} ${p.path}`);
      assert.deepEqual([...out.qualifying].sort(), [...bare.qualifying].sort(), `adding "${extra}" changed qualifying`);
    }
  });
}

test("stability: selection does not depend on corpus insertion order", () => {
  const prompts = [...RECALL.map((r) => r.prompt), ...PRECISION.map((p) => p.prompt), ...PATH_PROMPTS.map((p) => p.path)];
  for (const seed of [1, 7, 4242]) {
    const shuffled = shuffledCorpus(seed);
    for (const prompt of prompts) {
      const a = select(prompt);
      const b = select(prompt, shuffled);
      assert.deepEqual(b.top, a.top, `top differs under shuffle seed ${seed}: ${JSON.stringify(prompt)}`);
      assert.deepEqual(b.qualifying, a.qualifying, `qualifying order differs under shuffle seed ${seed}: ${JSON.stringify(prompt)}`);
    }
  }
});

test("aggregate metrics hold at the measured baseline (no regressions)", () => {
  let hits = 0;
  for (const r of RECALL) if (select(r.prompt).top.some((t) => t.id === r.target)) hits++;
  const recallAt3 = hits / RECALL.length;
  let falseQualifiers = 0;
  const offenders: string[] = [];
  for (const p of PRECISION) {
    const extra = select(p.prompt).qualifying.filter((id) => !p.allowed.includes(id));
    falseQualifiers += extra.length;
    if (extra.length) offenders.push(`${p.name}: ${extra.length}`);
  }
  console.log(`# selection quality: ${liveCount(corpus.records)} live records, ${RECALL.length} recall + ${PRECISION.length} precision + ${PATH_PROMPTS.length} path prompts`);
  console.log(`# recall@3 on targets: ${hits}/${RECALL.length} = ${recallAt3.toFixed(3)} (baseline ${BASELINE.recallAt3})`);
  console.log(`# false qualifiers on precision prompts: ${falseQualifiers} (baseline ${BASELINE.falseQualifiers})${offenders.length ? ` — ${offenders.join("; ")}` : ""}`);
  if (process.env.SELECTION_QUALITY_VERBOSE) {
    for (const p of [...RECALL.map((r) => r.prompt), ...PRECISION.map((x) => x.prompt)]) {
      const out = select(p);
      console.log(`# ${JSON.stringify(p)} -> top ${JSON.stringify(out.top.map((t) => t.id))} qualifying ${JSON.stringify(out.qualifying)}`);
      const terms = new Set([...lexicalTokens(p), ...identifierTokens(p)]);
      for (const id of out.qualifying) console.log(`#   ${id} shares ${JSON.stringify([...(recordTokens.get(id) ?? [])].filter((t) => terms.has(t)))}`);
    }
  }
  assert.ok(recallAt3 >= BASELINE.recallAt3, `recall@3 regressed: ${recallAt3} < ${BASELINE.recallAt3}`);
  assert.ok(falseQualifiers <= BASELINE.falseQualifiers, `false qualifiers regressed: ${falseQualifiers} > ${BASELINE.falseQualifiers}`);
});
