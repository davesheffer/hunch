# Hunch outreach pipeline

This is a small, founder-led outreach system for finding teams that already feel Hunch's problem,
researching them properly, asking permission for a concrete pilot and learning whether the product
creates durable use. It is not a bulk-email system. The tooling discovers public repository signals,
keeps personal lead data outside Git and creates drafts only after a person marks a lead approved.
It never sends a message.

## The offer

Do not open with “AI memory” or a feature list. Open with the loss the recipient can recognize:

> Your AI can read today's code. It usually cannot see why the team chose this design, which
> alternative already failed or which old bug a strange-looking line prevents.

The first ask is a **free 30-minute memory audit on one public repository**. The output is not a
sales demo: it is the actual Hunch receipt, its evidence and its limits. The recipient can decide
whether any result would have helped a recent agent or teammate. No account or meeting is required.

## Who qualifies

Start with maintainers and small platform/devtools teams where all three facts are observable:

1. The repository actively uses coding agents: for example, it publishes `AGENTS.md`, `CLAUDE.md`
   or equivalent project instructions.
2. It has durable engineering reasoning worth preserving: ADRs, architecture boundaries, repeated
   migrations, incident fixes or several contributors changing the same systems.
3. There is a permission-respecting path to contact: a warm introduction, an opt-in, a project-
   published contact address or a community channel that permits project sharing.

Do not qualify a lead because it is famous. Do not scrape personal email addresses. Do not create a
GitHub issue or pull request just to advertise Hunch. Competitor repositories belong in research,
not a disguised sales list.

## Funnel and weekly operating rhythm

Use a deliberately small first batch:

| Stage | Weekly target | Exit condition |
| --- | ---: | --- |
| Discover | 30 repositories | A public agent-workflow signal has an exact source URL. |
| Research | 10 repositories | A specific memory loss or repeated-risk hypothesis is written. |
| Approve | 5 contacts | Contact permission, destination, observation and proof were reviewed. |
| First touch | At most 5 | One short personal message is sent manually. |
| Follow-up | At most 1 each | Seven days passed; stop permanently after this message. |
| Pilot | 1 | The maintainer agrees to inspect a real receipt. |
| Activate | measured, not assumed | They initialize Hunch and use a delivered record on later work. |

Five messages are not a statistical experiment. They are enough to discover whether the words are
confusing and whether the audit offer earns a response. Keep the story-led and proof-led variants
assigned by the tool, then compare them only after each has meaningful volume.

## Local lead store

Initialize the private, gitignored store:

```bash
npm run outreach -- init
```

The default file is `.outreach/leads.jsonl`, written with mode `0600`. Each line follows
`hunch.outreach-lead/1`. Public discovery creates only `discovered` records and never extracts a
person or email. It adds public repository activity/star counts only to prioritize the research
queue; popularity never makes a lead contactable. A researched record looks like this:

```json
{"schema":"hunch.outreach-lead/1","id":"acme-payments","project":"acme/payments","repository_url":"https://github.com/acme/payments","source_url":"https://github.com/acme/payments/blob/main/AGENTS.md","observed_signal":"The repository gives coding agents detailed architecture rules in AGENTS.md.","problem_hypothesis":"The rules say what to do, but a future agent cannot see the incidents and rejected designs behind them.","segment":"platform_team","proof_id":"v1.19-retrieval","status":"qualified","follow_ups":0,"discovered_at":"2026-08-26","qualified_at":"2026-08-26","contact":{"name":"Project maintainer","channel":"email","destination":"maintainers@example.invalid","permission":"published_project_contact"}}
```

The `proof_id` names the evidence offered; since 1.32.0 that is the task contribution report ([Task contribution reports](task-reports.md)), and the two repository-user acceptance sessions the [release plan](next-release-memory-impact.md) requires are recruited through this pipeline, never by automatic contact.

Before drafting, a person runs `qualify` with the researched facts and contact permission, reviews
the result, then runs `approve`. Validation requires the cited observation, project-specific
hypothesis, supported proof and permitted contact path. `scraped_personal` and unknown permissions
are not valid values by design.

## Commands

Discover repositories through the authenticated GitHub CLI. Queries should target a concrete public
signal, not popularity alone:

```bash
npm run outreach -- discover-github \
  --query 'filename:AGENTS.md "architecture"' \
  --limit 30

npm run outreach -- validate
npm run outreach -- queue
npm run outreach -- review --limit 10
npm run outreach -- qualify acme-payments \
  --signal 'The repository gives coding agents architecture rules in AGENTS.md.' \
  --problem 'The rules do not preserve the incidents and rejected designs behind them.' \
  --name 'Project maintainer' --channel email \
  --destination maintainers@example.invalid --permission published_project_contact \
  --segment platform_team
npm run outreach -- draft acme-payments --preview
npm run outreach -- preview-queue
npm run outreach -- approve acme-payments
npm run outreach -- draft acme-payments
npm run outreach -- record acme-payments --status contacted
npm run outreach -- report
```

Use `--file PATH` to work with another private store. `queue` separates research, approval, first
touch, due follow-up and active conversations. `draft LEAD_ID --follow-up` is permitted only for a
contacted lead with zero prior follow-ups.

`draft --preview` prints a visible **UNAPPROVED — DO NOT SEND** review copy for a qualified lead.
`preview-queue` writes all current review copies to the private `.outreach/previews.md` file.
An ordinary `draft` still refuses to run until approval. Drafting never changes state.
Qualification, approval, recording a sent message and recording a reply
are separate explicit commands because each is evidence supplied by the operator, not a fact inferred
from generating text. Record one due follow-up with `record-follow-up`; a second is rejected.

## What to measure

The report calculates:

- reply rate from people actually contacted;
- pilot rate from people contacted;
- activation rate from pilots;
- exact counts at every stage.

Record a pilot as activated only after the participant runs Hunch and later sees a useful saved
decision, correction, bug lesson or constraint. An install alone is not activation. Keep outcome
notes factual: what question they tried, whether Hunch found relevant history, what was missing and
whether they used it again. This becomes product evidence; praise without a task does not.

## Stop rules

- Stop after one unanswered follow-up.
- Mark an explicit refusal `do_not_contact` and remove every future date.
- Pause a message variant if replies show the same misunderstanding three times; fix the copy first.
- Pause the offer if two pilots cannot produce a useful receipt. Investigate the product or target
  profile instead of increasing volume.
- Never quote a benchmark without its denominator and small-test caveat.
