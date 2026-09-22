import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  LEAD_SCHEMA,
  approveLead,
  buildQueue,
  candidatesFromGitHubSearch,
  draftForLead,
  hydrateGitHubCandidate,
  outreachReport,
  parseLeads,
  previewQueueDocument,
  qualifyLead,
  recordFollowUp,
  recordLeadStage,
  researchReview,
  serializeLeads,
  validateLead,
} from "../tooling/outreach-pipeline.mjs";

function approvedLead(overrides: Record<string, unknown> = {}) {
  return {
    schema: LEAD_SCHEMA,
    id: "acme-payments",
    project: "acme/payments",
    repository_url: "https://github.com/acme/payments",
    source_url: "https://github.com/acme/payments/blob/main/AGENTS.md",
    observed_signal: "The repository publishes detailed architecture instructions for coding agents.",
    problem_hypothesis: "The instructions state rules without preserving the incidents and rejected designs behind them.",
    segment: "platform_team",
    proof_id: "v1.19-retrieval",
    status: "approved",
    variant: "story",
    follow_ups: 0,
    discovered_at: "2026-08-20",
    qualified_at: "2026-08-21",
    approved_at: "2026-08-22",
    contact: {
      name: "Acme maintainer",
      channel: "email",
      destination: "maintainers@example.invalid",
      permission: "published_project_contact",
    },
    ...overrides,
  };
}

test("GitHub discovery creates research candidates without collecting people or addresses", () => {
  const candidates = candidatesFromGitHubSearch({
    items: [
      {
        path: "AGENTS.md",
        html_url: "https://github.com/Acme/Payments/blob/main/AGENTS.md",
        repository: {
          full_name: "Acme/Payments",
          html_url: "https://github.com/Acme/Payments",
        },
      },
      {
        path: "docs/AGENTS.md",
        html_url: "https://github.com/Acme/Payments/blob/main/docs/AGENTS.md",
        repository: {
          full_name: "Acme/Payments",
          html_url: "https://github.com/Acme/Payments",
        },
      },
    ],
  }, "2026-08-26");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, "discovered");
  assert.equal(candidates[0].contact, undefined);
  assert.equal(candidates[0].source_url, "https://github.com/Acme/Payments/blob/main/AGENTS.md");
  assert.deepEqual(validateLead(candidates[0]), []);
});

test("public repository metadata ranks research without granting contact permission", () => {
  const candidate = candidatesFromGitHubSearch({
    items: [{
      path: "AGENTS.md",
      html_url: "https://github.com/Acme/Payments/blob/main/AGENTS.md",
      repository: { full_name: "Acme/Payments", html_url: "https://github.com/Acme/Payments", fork: false },
    }],
  }, "2026-08-26")[0];
  const hydrated = hydrateGitHubCandidate(candidate, {
    stargazers_count: 100,
    forks_count: 12,
    open_issues_count: 4,
    pushed_at: "2026-08-25T10:00:00Z",
    description: "Developer platform for AI agents",
    fork: false,
    archived: false,
  }, "2026-08-26");
  assert.equal(hydrated.fit_score, 6);
  assert.equal(hydrated.contact, undefined);
  assert.equal(hydrateGitHubCandidate(candidate, { archived: true }, "2026-08-26"), null);
});

test("research review ranks high-signal repositories without turning them into outreach", () => {
  const low = approvedLead({ id: "low", status: "discovered", approved_at: undefined, contact: undefined, fit_score: 1 });
  const high = approvedLead({ id: "high", status: "discovered", approved_at: undefined, contact: undefined, fit_score: 6 });
  assert.deepEqual(researchReview([low, high], 1).map((lead) => lead.id), ["high"]);
});

test("actionable outreach requires evidence, approval, and a permitted contact path", () => {
  assert.deepEqual(validateLead(approvedLead()), []);
  assert.match(
    validateLead(approvedLead({
      contact: { name: "A person", channel: "email", destination: "person@example.invalid", permission: "scraped_personal" },
    })).join(" "),
    /contact\.permission/,
  );
  assert.match(
    validateLead(approvedLead({ observed_signal: "seems relevant" })).join(" "),
    /observed_signal/,
  );
});

test("drafts stay personal, evidence-caveated, and behind the approval gate", () => {
  const message = draftForLead(approvedLead());
  assert.match(message, /Acme maintainer/);
  assert.match(message, /detailed architecture instructions/);
  assert.match(message, /small controlled test/);
  assert.match(message, /free 30-minute memory audit/);
  const qualified = approvedLead({ status: "qualified", approved_at: undefined });
  assert.match(draftForLead(qualified, { preview: true }), /UNAPPROVED PREVIEW — DO NOT SEND/);
  assert.throws(() => draftForLead(qualified), /approved status/);
  assert.throws(() => draftForLead(approvedLead(), { preview: true, followUp: true }), /mutually exclusive/);
  const community = approvedLead({
    contact: {
      name: "Acme community",
      channel: "github_discussions",
      destination: "https://github.com/acme/payments/discussions/categories/show-and-tell",
      permission: "community_permission",
    },
  });
  const communityMessage = draftForLead(community, { preview: true });
  assert.match(communityMessage, /Title: Could Hunch/);
  assert.match(communityMessage, /show that the repository publishes/);
  assert.match(communityMessage, /post the actual receipt and its limits here/);
});

test("qualification, approval and outcome recording are separate evidence transitions", () => {
  const discovered = approvedLead({ status: "discovered", approved_at: undefined, contact: undefined });
  const qualified = qualifyLead(discovered, {
    observed_signal: discovered.observed_signal,
    problem_hypothesis: discovered.problem_hypothesis,
    segment: "platform_team",
    proof_id: "v1.19-retrieval",
    contact_name: "Acme maintainer",
    contact_channel: "email",
    contact_destination: "maintainers@example.invalid",
    contact_permission: "published_project_contact",
  }, "2026-08-21");
  const approved = approveLead(qualified, "2026-08-22");
  const contacted = recordLeadStage(approved, "contacted", { date: "2026-08-23" });
  assert.equal(contacted.follow_up_at, "2026-08-30");
  const followed = recordFollowUp(contacted, "2026-08-30");
  assert.equal(followed.follow_ups, 1);
  assert.equal(followed.follow_up_at, undefined);
  const replied = recordLeadStage(contacted, "replied", { date: "2026-08-24" });
  const pilot = recordLeadStage(replied, "pilot", { date: "2026-08-25" });
  const activated = recordLeadStage(pilot, "activated", { date: "2026-08-26" });
  assert.equal(activated.activated_at, "2026-08-26");
  assert.throws(() => recordLeadStage(approved, "activated"), /invalid outreach transition/);
});

test("queue allows one due follow-up and never queues do-not-contact records", () => {
  const contacted = approvedLead({
    id: "acme-contacted",
    status: "contacted",
    contacted_at: "2026-08-20",
    follow_up_at: "2026-08-27",
  });
  const exhausted = approvedLead({
    id: "acme-exhausted",
    status: "contacted",
    contacted_at: "2026-08-20",
    follow_up_at: "2026-08-27",
    follow_ups: 1,
  });
  const stopped = approvedLead({ id: "acme-stopped", status: "do_not_contact", approved_at: undefined });
  const queue = buildQueue([contacted, exhausted, stopped], "2026-08-27");
  assert.deepEqual(queue.follow_up.map((lead) => lead.id), ["acme-contacted"]);
  assert.equal(Object.values(queue).flat().some((lead) => lead.id === "acme-stopped"), false);
  assert.throws(() => draftForLead(exhausted, { followUp: true }), /no prior follow-up/);
  assert.throws(() => draftForLead(contacted, { followUp: true, today: "2026-08-26" }), /not due yet/);
  assert.match(draftForLead(contacted, { followUp: true, today: "2026-08-27" }), /will not follow up again/);
});

test("preview queue is visibly unapproved and contains only qualified leads", () => {
  const qualified = approvedLead({ status: "qualified", approved_at: undefined });
  const approved = approvedLead({ id: "already-approved" });
  const document = previewQueueDocument([qualified, approved]);
  assert.match(document, /acme\/payments/);
  assert.match(document, /unapproved — do not send/);
  assert.doesNotMatch(document, /already-approved/);
});

test("JSONL parsing is deterministic and refuses duplicate identity", () => {
  const first = approvedLead({ id: "zeta-project" });
  const second = approvedLead({ id: "alpha-project" });
  const serialized = serializeLeads([first, second]);
  assert.deepEqual(parseLeads(serialized).map((lead) => lead.id), ["alpha-project", "zeta-project"]);
  assert.throws(() => parseLeads(`${JSON.stringify(first)}\n${JSON.stringify(first)}\n`), /duplicate lead id/);
});

test("report measures the observed funnel rather than treating discovery as contact", () => {
  const leads = [
    approvedLead({ id: "one", status: "discovered", approved_at: undefined, contact: undefined }),
    approvedLead({ id: "two", status: "contacted", contacted_at: "2026-08-20" }),
    approvedLead({ id: "three", status: "replied", contacted_at: "2026-08-20", replied_at: "2026-08-21" }),
    approvedLead({ id: "four", status: "activated", contacted_at: "2026-08-20", replied_at: "2026-08-21", pilot_at: "2026-08-22", activated_at: "2026-08-25" }),
  ];
  const report = outreachReport(leads);
  assert.deepEqual(report.funnel, {
    contacted: 3,
    replied: 2,
    pilots: 1,
    activated: 1,
    reply_rate: 0.667,
    pilot_rate_from_contact: 0.333,
    activation_rate_from_pilot: 1,
  });
});

test("CLI runs a lead through explicit qualify, approve, draft and contact evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-outreach-"));
  t.after(() => cleanupDir(root));
  const store = join(root, "leads.jsonl");
  const tool = resolve("tooling/outreach-pipeline.mjs");
  const discovered = approvedLead({ status: "discovered", approved_at: undefined, contact: undefined });
  writeFileSync(store, serializeLeads([discovered]), { mode: 0o600 });
  const run = (...args: string[]) => execFileSync(process.execPath, [tool, ...args, "--file", store], { encoding: "utf8" });

  run(
    "qualify", discovered.id,
    "--signal", discovered.observed_signal,
    "--problem", discovered.problem_hypothesis,
    "--name", "Acme maintainer",
    "--channel", "email",
    "--destination", "maintainers@example.invalid",
    "--permission", "published_project_contact",
    "--segment", "platform_team",
    "--date", "2026-08-21",
  );
  run("approve", discovered.id, "--date", "2026-08-22");
  assert.match(run("draft", discovered.id), /free 30-minute memory audit/);
  run("record", discovered.id, "--status", "contacted", "--date", "2026-08-23");
  const [contacted] = parseLeads(readFileSync(store, "utf8"));
  assert.equal(contacted.status, "contacted");
  assert.equal(contacted.follow_up_at, "2026-08-30");
});
