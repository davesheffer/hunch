# Restrict a record to named people and agents

Shipped in Hunch 1.33.0 for dedicated partitions. Negotiate `nuryel.record-visibility/1`
and upgrade every server before enabling restrictions. Restricted writes through shared/private
overlays remain unsupported; visibility does not restrict trusted filesystem or Git access.

Partition grants still decide which workspaces a token can access. Within a dedicated partition,
optional `visibility` restricts an individual record:

```json
{
  "visibility": {
    "owner": "alice",
    "readers": ["support-agent", "bob"],
    "writers": ["support-agent"]
  }
}
```

The owner can read and write implicitly. Other writers must also appear in `readers`.
Every principal still needs a grant for the partition. Omit visibility for the existing
partition-wide behavior. Lists contain at most 256 distinct principal IDs each.

Create a restricted record as its owner. Readers can inspect it; writers can update its facts
subject to the existing human-correction and conflict rules. Only the owner changes its audience,
and that change requires `expected_version`. Restricting an existing partition-wide record
requires a human principal, who becomes its owner. Removing visibility opens the record to all
principals granted the partition and also requires the owner and an explicit version.

Supersession follows the same audience rule. A delegated writer must copy the predecessor's
visibility. An owner changing the audience during supersession must name the predecessor's
version. A new record identity cannot silently widen access to the record it replaces.

Capture accepts visibility too. A repeated capture returns an authorized incumbent; it never
changes that incumbent's audience. Requesting different visibility on a duplicate is refused:
use a normal version-checked write. Capture batches and observation reviews use the same checks.

## What readers receive

Authorization applies before subject selection, entity aliases, observation pages and memory
ranking. A hidden exact ID is accounted for as missing. Hidden records do not appear in context
text, hypotheses, omission lists or activity details. A dependent record that names a hidden
record is withheld intact; Hunch does not edit its body while returning the original hash.
Cross-partition HTTP reads check source visibility in the other granted partitions too.
Once protected mode is enabled, declared record dependencies must be available and visible;
missing sources are withheld rather than assumed public. Partitions that have never enabled
visibility retain the legacy cross-partition pointer behavior.

Observation counts and page fingerprints cover only the authorized records. Changes to hidden
observations do not invalidate another reader's observation cursor. Inaccessible conflict
incumbents still prevent contradictory writes, but refusal details do not disclose their IDs,
hashes, titles or differing fields.

Activity requires both the event's original audience and the record's current audience.
Granting access later does not reveal older restricted events; revocation withholds retained
activity too. The stream is marked `filtered`; its sequence may have gaps. `head_seq` and
`floor_seq` remain partition-wide cursor metadata, so they can reveal aggregate activity volume.
Consumers must discard held records and re-read when access changes; a server cannot erase
content already delivered to another process. The operator clears revoked records on refresh.

These checks follow exact structured references. They cannot identify every secret paraphrased
in free-form text. Authors remain responsible for the audience of material they copy.

## Authentication and safe upgrades

The HTTP bearer token determines principal identity; request bodies cannot impersonate another
principal. Local stdio MCP accepts principal assertions from a trusted caller. Direct filesystem,
Git history and ordinary owner-level Hunch tools are trusted-owner interfaces. This feature does
not isolate an untrusted person who can open the underlying files or use unrestricted local MCP.

Use a **dedicated partition home**, such as one created by `hunch serve init`. Restricted writes
through shared/private overlays are refused: other checkouts can open those homes without seeing
a gate at the current checkout. Existing partition-wide overlay behavior remains supported.

Before protected bytes are written, Hunch atomically records
`required_capabilities:["nuryel.record-visibility/1"]` in the partition declaration. Older strict
state readers refuse that declaration, including already-running servers on their next state
operation. Upgrade every server first. The marker remains after restrictions are removed or
history is compacted; do not remove it to force a downgrade. It protects the state API boundary,
not a local owner reading JSON or Git history.

Validation covers unauthorized exact reads, aliases and context; cross-partition source
revocation; capture/review replay; owner/delegated-writer changes; current and historical event
audiences; stable observation snapshots; old-reader declaration refusal; and real-browser
refresh after revocation.
