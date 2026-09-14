# Use shared state from a terminal

Shipped in Hunch 1.33.0. `hunch state` provides capabilities, read, write, records and subscribe
commands through the same authenticated HTTP client and contract as other integrations.
It prints complete JSON on stdout. Failures print one JSON problem on stderr and exit 1;
successful commands exit 0. Subscriptions poll once; the CLI does not resolve conflicts or
retry writes automatically, except for one pre-operation DPoP nonce challenge.

Configure the server and token without placing the token in process arguments:

```sh
export HUNCH_STATE_URL=http://127.0.0.1:7474
# Set HUNCH_STATE_TOKEN through your shell's secret-management mechanism,
# or pass --token-file /path/to/a/private/token-file.
hunch state --token-file ./token capabilities
hunch state --token-file ./token read --scope organization:acme --subject customer:c1
hunch state --token-file ./token records --scope organization:acme --ids nds_RECORD_ID
hunch state --token-file ./token subscribe --scope organization:acme --after 0
```

`--url` overrides `HUNCH_STATE_URL`; the default is `http://127.0.0.1:7474`.
`--token-file` takes precedence over `HUNCH_STATE_TOKEN`. A token file contains only the token,
with optional surrounding whitespace. Use `--pretty` to indent output and `--timeout <ms>` to
set a per-request timeout from 1 to 300000 milliseconds (default 15000).

For complete contract requests, pass a JSON file or pipe stdin. The input is the HTTP request
body, without `schema` or `principal`; the server determines identity from the token.
Do not combine `--input` with shortcut options such as `--scope` or `--subject`.

```sh
hunch state read --input read-request.json
hunch state write --input write-request.json
cat write-request.json | hunch state write --input -
hunch state records --input record-request.json
hunch state subscribe --input subscription-request.json
```

A write request carries `scope`, `facet`, `record` and `idempotency_key`, plus optional
`expected_version`, `supersedes` or `cause`. Copy exact revisions from prior results when
updating a record. Replaying an identical request preserves idempotency; changing its payload
under the same key is refused. See the [state contract](nuryel-state-contract.md) for complete
record schemas and examples.

The CLI negotiates the verb and any new record capability before submitting a request.
This includes [field citations](field-provenance.md) and [record visibility](record-visibility.md).
It does not fetch sources, choose authority, merge conflicts or retry writes automatically.

`subscribe` polls once. Save `head_seq` as the next request's `after_seq`. When `resync` is true,
rebuild held state because earlier events were compacted. A `filtered` stream can have sequence
gaps; those gaps are not evidence of a lost event. Observation reads preserve their complete
`observed_page` object: pass the next cursor in a subsequent JSON request until it is null.

Input is bounded to 1 MiB. Tokens are never part of CLI results. HTTP redirects are refused so
record payloads cannot be forwarded to an unexpected destination.

For a key-bound token, add `--proof-key-file <private PEM or JWK>`. The client answers one server nonce challenge automatically before the request runs. See [Key-bound credentials](key-bound-principals.md) for HTTPS setup and rotation.
