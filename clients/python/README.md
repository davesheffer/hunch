# Hunch state client for Python

A synchronous Python 3.11+ client for a served Hunch workspace: read what is current, write
records with provenance and idempotency, capture supported observations, fetch exact records,
and poll changes. The server owns permissions, record identity and state semantics.

This package ships in the Hunch 1.33.0 repository. It has not been published to PyPI.
From a checkout containing this client:

```sh
python -m pip install ./clients/python
# Optional Ed25519 request signing:
python -m pip install './clients/python[proof]'
```

```python
import os
from hunch_state import StateClient, StateClientError

client = StateClient(os.environ['HUNCH_STATE_URL'], os.environ['HUNCH_STATE_TOKEN'])
scope = {'kind': 'organization', 'id': 'acme'}
result = client.read({'scope': scope, 'subject': 'customer:123'})
for record in result.get('records', {}).values():
    print(record)
```

Use HTTPS outside a trusted loopback connection. TLS certificate and hostname checks are
enabled by default; pass a verified `ssl.SSLContext` to trust a private CA. Redirects and proxy
environment variables are not followed. The client keeps the token in memory and does not log
it. Create one client per worker; it is synchronous and does not provide thread coordination.

All six state operations negotiate the required capability before sending the verb:
`read`, `write`, `records`, `subscribe`, `capture`, and `capture_batch`. Use `capabilities`
for discovery and `health` for availability (the client sends its credential, so the response
also lists the served `partitions`; an unauthenticated probe of the route gets liveness only). Request dictionaries omit top-level `schema` and
`principal`; the server supplies those. Records inside write requests retain their own schema.
The return value is the complete JSON object, including durability, source hashes, conflicts,
observation cursors and subscription resync signals.

`StateClientError` exposes `status`, `code`, and the original `problem` dictionary.
`StateTransportError` exposes `code` for timeout, connection, redirect, oversized or malformed
responses. A transport failure after a write does not establish whether the write committed.
Reconcile using the original idempotency key and record lookup; the client never retries writes
automatically except once for a DPoP nonce challenge that precedes the operation.

The default timeout is 15 seconds **per blocking socket operation**, not a total wall-clock
deadline. Requests are limited to 1 MiB; responses to 16 MiB, configurable up to 64 MiB through
`max_response_bytes`. DNS resolution and a custom signing callback can take longer than the
socket timeout. Add a process/job deadline when an overall bound is required.

`subscribe` polls once. Retain `head_seq` as the next `after_seq`, including when filters omit
events. If `resync` is true, rebuild the state you hold with reads; do not treat retained events
as a complete history. Keep `floor_seq` and observation page cursors intact.

## Key-bound credentials

Register the public key and exact HTTPS origin on the server as described in
[key-bound principals](../../docs/key-bound-principals.md), then:

```python
from pathlib import Path
from hunch_state.proof import create_proof_signer

client = StateClient(
    os.environ['HUNCH_STATE_URL'], os.environ['HUNCH_STATE_TOKEN'],
    proof=create_proof_signer(Path('client-private.pem').read_bytes()),
)
```

The optional `proof` extra uses PyCA cryptography to sign with an Ed25519 PEM or private JWK.
A custom synchronous proof callback can integrate a different key store. Neither the key nor
the token is written to disk by this client.

## Contract and development

`hunch_state.models` provides generated TypedDicts, and the installed `schemas.json` contains
the corresponding structural JSON Schemas. Generate with
`node --import tsx tooling/generate-state-contracts.mjs`; add `--check` to detect drift.
The TypeScript/Zod source is authoritative. Types are not runtime validation: custom Zod
refinements, canonical hashes, currentness and authorization still run on the server.
The delivery envelope remains an opaque mapping in Python; the real-server integration test
validates it with Hunch's canonical assertion.

From the repository root, after `npm run build` and installing the package:

```sh
python -m unittest discover -s clients/python/tests
node tooling/verify-python-state.mjs python
node tooling/verify-python-state.mjs python --proof
python -m build clients/python
```

The final command needs the Python `build` development tool. The HTTPS rehearsal also needs
the proof extra and OpenSSL. Packaging includes no server, memory, user credentials or raw
source documents. The real-server test uses isolated temporary fixtures, not a claimed external
consumer or production deployment.
