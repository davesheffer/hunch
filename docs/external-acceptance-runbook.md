# External acceptance operator runbook

This runbook collects the two observations that code, fixtures and a single operator cannot
complete:

1. two repository users must understand a task contribution report in normal use; and
2. two people must use separate Sofia instances against one shared state partition for a week.

Do not substitute two model sessions, two principals controlled by one person, an emulation or a
moderator demonstration. Those are useful engineering checks, but they are a different population.
The evidence files created here stay local because they can identify participants, repositories and
customer work. Commit only a dated aggregate result after the participants approve its wording.

The repository provides a local evidence helper:

```sh
node tooling/external-acceptance.mjs init repository-user /private/path/repository-user-draft.json
node tooling/external-acceptance.mjs init sofia-gate5 /private/path/sofia-gate5-draft.json
node tooling/external-acceptance.mjs digest /private/path/artifact
node tooling/external-acceptance.mjs seal /private/path/draft.json /private/path/sealed.json
node tooling/external-acceptance.mjs validate /private/path/sealed.json
```

`init` and `seal` create new mode-`0600` files and refuse to overwrite an existing path. `seal`
checks every referenced artifact and binds the record to a content hash. `validate` checks both the
sealed record and the retained artifacts. `validate … --structure-only` verifies a moved or archived
record, reports `artifacts_checked: false` and always reports `acceptance_ready: false`. Exit status
is 0 only for a valid passing gate whose artifacts were checked, 1 for a valid failed,
inconclusive or structure-only observation, and 2 for invalid evidence.

## Two repository-user sessions

Use the same qualified Hunch version and package digest in both sessions. Each participant uses a
repository where they normally work and a supported host they normally use. They perform a real
task that produces a contribution card with at least one supported contribution and an evidence
link. Do not teach the labels during the timed portion.

Before each session:

1. Record the Hunch version, exact Hunch commit and published package SHA-256 in `candidate`.
2. Record an opaque participant ID, an opaque repository ID, the repository's exact Git revision,
   host name/version/OS, task ID, task-report content hash, and SHA-256 of the retained local HTML
   report. Do not put a participant's name, email, repository secret or transcript in the packet.
3. Ask the agent for an ordinary repository task. Do not ask it to mention Hunch, generate a report
   or remember a lesson. Let the normal integration present the completed card.
4. Start a monotonic timer when the complete card and its evidence link first become visible.

Read these three prompts verbatim, without hints:

> Is Hunch connected for this task, and what on this report tells you that?

> Name one contribution the report supports for this task.

> Open the evidence for that contribution.

Stop the timer when the evidence view opens. Record the participant's first two answers, the evidence
target, whether each answer was correct, whether the link opened, and whether any coaching occurred
after the card appeared. The moderator judges correctness against the report's evidence grades; a
delivery or unrelated passing check is not a supported application. A participant passes only when
all three actions are correct, uncoached and complete within 30,000 ms. The gate passes only when at
least two distinct repository users pass. Keep failed and inconclusive sessions; do not rerun them
silently until a desired answer appears.

The `hunch.repository-user-acceptance/1` record contains:

- candidate version, commit and package digest;
- moderator identity and the verbatim-question assertion;
- one case per distinct participant with repository revision, host, `htask_…`, report hash, report
  artifact hash, timestamps, timer source, answers, adjudications and coaching state;
- a human disposition and reason; and
- explicit assertions that the packet is local and contains neither credentials nor a transcript.

The helper recomputes elapsed time from the timestamps, permits at most one second of timer rounding,
and rejects a passing disposition if any participant took more than 30 seconds or missed an action.

## Sofia Gate 5: two-user shared-task week

The Sofia repository already supplies the mechanism this run needs:

- `docs/sofia-state.md` documents the served-state connection, refresh worker and publication queues;
- `docs/sofia-baseline.md` defines the measured reply/read classes and private exports; and
- `scripts/baseline-compare.js` pairs the two users' replies and summaries for human review.

This runbook adds the participant boundary and evidence envelope. It does not copy Sofia's CRM data
or replace its instrumentation.

### Preflight

Use two people, two Sofia instances, two Sofia principal IDs and separate credentials. Both
principals receive the same narrow partition grant. Hunch serves on loopback; connect the second
machine through an operator-approved authenticated tunnel or HTTPS reverse proxy. Do not change the
server to an unauthenticated public bind.

Mint the second principal from the server host. The JSON contains the token once, so keep it outside
Git and outside the evidence packet:

```sh
umask 077
hunch serve --config /secure/hunch-serve.json init \
  --partition user:gate5 \
  --root /secure/sofia-state-gate5 \
  --principal sofia@gate5b \
  --json > /secure/sofia-gate5b-bootstrap.json
jq -r .token /secure/sofia-gate5b-bootstrap.json > /secure/sofia-gate5b.token
rm /secure/sofia-gate5b-bootstrap.json
```

On the second machine, an SSH tunnel is one valid loopback-preserving transport:

```sh
ssh -N -L 7474:127.0.0.1:7474 <approved-server-host>
hunch state --url http://127.0.0.1:7474 \
  --token-file /secure/sofia-gate5b.token capabilities --pretty
```

Configure the two Sofia instances with their own token/principal and local databases:

```text
SOFIA_STATE_URL=http://127.0.0.1:7474
SOFIA_STATE_SCOPE=user:gate5
SOFIA_STATE_PRINCIPAL=sofia@gate5b
SOFIA_STATE_TOKEN=<that principal's token>
SOFIA_BASELINE=1
```

Before the window starts, record the exact Hunch/Sofia commits and Hunch package digest. Confirm both
capability calls, both `/api/state/refresh` responses and both `/api/state/publications` responses.
Require zero blocked or pending publications after queues settle. Run and retain the initial replay:

```sh
hunch serve --config /secure/hunch-serve.json replay \
  --partition user:gate5 --json > /private/pilot/start-replay.json
```

Choose at least one real CRM customer or event that both participants are authorized to handle. Copy
the exact `subject` returned by each Sofia's `/api/customers`; both must resolve to the same subject.
Write down the shared task in advance. Do not create a fake CRM mutation merely to fill a receipt.

### Seven-day observation

Run for at least seven elapsed days. Each participant uses their own Sofia during ordinary work and
asks at least one status question about the shared subject. Include at least one opportunity where
the answer should use state written by the other participant's Sofia or by the engineering agent.
The second participant must not be told the answer through chat before asking.

For every adjudicated opportunity, retain the exact state record ID/hash, writer principal and the
later observation time. Classify the answer from Sofia's baseline data:

- `held_state_replies`: the reply carries the held-state receipt marker;
- `source_read_replies`: the request read a source because held state did not answer it; or
- `unsourced_replies`: neither state evidence nor a source read supports the reply.

The three classes must sum to `status_questions`. Separately count held-state opportunities,
material re-derivation despite delivered state, contradictions despite delivered state, repeat
reads, re-summaries, refresh worker failures and publication queue failures. State availability
alone does not prove use; the reviewer must bind the judgment to the exact record and observed reply.

### Close and review

At the end of the window, export each baseline on its own machine. These exports contain reply and
summary text and remain private:

```sh
curl -fsS "http://127.0.0.1:3010/api/baseline?export=1" > /private/pilot/user-a.json
curl -fsS "http://127.0.0.1:3010/api/baseline?export=1" > /private/pilot/user-b.json
node /path/to/sofia/scripts/baseline-compare.js \
  /private/pilot/user-a.json /private/pilot/user-b.json --days 7 \
  > /private/pilot/cross-user-review.txt
```

A human reviews every shared subject-day, records the number of reviewed and unresolved pairs, and
marks material contradictions or re-derivations. Retain a final state replay:

```sh
hunch serve --config /secure/hunch-serve.json replay \
  --partition user:gate5 --json > /private/pilot/final-replay.json
```

Use the final passing replay as the `state-replay` artifact. The sealed
`hunch.sofia-gate5-week/1` packet requires:

- two distinct human participant IDs and Sofia principals over one partition for seven elapsed days;
- exact Hunch and Sofia revisions, package digest and shared scope;
- per-user baseline metrics and one baseline-export artifact per participant;
- exact shared subjects and state record references, with at least one referenced record observed
  by both participants;
- at least one reviewed cross-user pair, with no unresolved pairs for a passing result;
- the hashed comparison output and passing replay artifact; and
- the human disposition, privacy assertions and the mechanism counts.

The helper refuses a passing disposition if either participant has no status question or held-state
opportunity, if state was materially re-derived or contradicted despite delivery, if worker or
publication failures remain, if comparison review is unresolved, if the run is shorter than seven
days, or if an artifact is missing or changed. It validates the evidence envelope and arithmetic;
the human reviewer remains responsible for the semantic judgments.

If the mechanism fails, record `fail` and the observed reason. If access, instrumentation, source
coverage or participant availability prevents a valid comparison, record `inconclusive`. Neither
result closes the gate, and neither should be rewritten as a passing run.
