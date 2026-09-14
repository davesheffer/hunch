# Bind a credential to a signing key

Shipped in Hunch 1.33.0 as optional key binding for HTTP credentials (`nuryel.auth.dpop/1`).
Upgrade every serving process before enabling it. A key-bound credential requires both its token
and a fresh request proof from its registered Ed25519 key, adding protection when a token leaks.
It does not attest a device, identify a person independently, or grant additional permissions.

Hunch implements the protected-resource DPoP flow from [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html),
with Ed25519 keys represented as described in [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037.html)
and [RFC 7638 thumbprints](https://www.rfc-editor.org/rfc/rfc7638.html). It is not an OAuth
authorization server. Hunch still issues opaque tokens through local administrator configuration.

## Set up

Keep the config, private key and runtime authentication directory in a private directory outside
your repository. Generate a key pair on the client machine:

```sh
umask 077
openssl genpkey -algorithm ED25519 -out client-private.pem
openssl pkey -in client-private.pem -pubout -out client-public.pem
```

Register only the public key on the server. The public origin is the exact HTTPS origin users
reach through your reverse proxy, without a trailing slash or path:

```sh
hunch serve init --config /private/hunch/serve.json \
  --partition organization:acme --root /private/hunch/acme \
  --principal agent-one --kind agent \
  --proof-key-file client-public.pem --public-origin https://state.example.com
hunch serve --config /private/hunch/serve.json
```

`serve` continues to bind loopback. Configure the reverse proxy to terminate TLS, preserve the
request path, and forward the Authorization and DPoP headers. The HTTPS origin in configuration
is authoritative; Hunch does not trust forwarded host/protocol headers to construct it. The
proof binds the method, target URI, token and key. TLS protects the request body and headers.

The config stores a public JWK and token hash. `<config-file>.auth/` holds a private nonce key
and recent proof identifiers. Every process serving the same config must share this directory
and support its file lock. Do not delete or restore it from an old backup while serving traffic.
An unavailable/corrupt directory refuses authentication with `503 proof-state-unavailable`.
For the programmatic server with an in-memory config, supply `authStateDir` explicitly.

## Use

The terminal accepts a private PEM or JWK file:

```sh
export HUNCH_STATE_URL=https://state.example.com
# Supply HUNCH_STATE_TOKEN through your secret-management mechanism.
hunch state --proof-key-file client-private.pem capabilities
hunch state --proof-key-file client-private.pem read --scope organization:acme
```

For the TypeScript/Node client:

```ts
import { readFileSync } from 'node:fs';
import { createStateClient } from '@davesheffer/hunch/state';
import { createStateProofSigner } from '@davesheffer/hunch/state-proof';

const client = createStateClient({
  baseUrl: 'https://state.example.com',
  token: process.env.HUNCH_STATE_TOKEN!,
  proof: createStateProofSigner(readFileSync('client-private.pem', 'utf8')),
});
const result = await client.read({scope: {kind: 'organization', id: 'acme'}});
```

The fetch-only client also accepts a custom asynchronous `proof` callback. It receives method,
URL, token and optional nonce. The Node signer is a separate import so other runtimes can use
their own key storage.

The HTTPS operator view accepts a private Ed25519 JWK under **Key-bound token**. Web Crypto
imports it as a non-exportable signing key. The file is read locally, not uploaded; the key,
token and nonce live only in this tab and are cleared on disconnect/reload. Export a JWK from
your own PEM for this view:

```sh
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {createPrivateKey} from "node:crypto"; writeFileSync("client-private.json", JSON.stringify(createPrivateKey(readFileSync("client-private.pem")).export({format:"jwk"})), {mode:0o600,flag:"wx"})'
```

## Rotate, revoke and upgrade

Run `serve init` again for the same principal to rotate its token. Omitting a new proof key
preserves its existing binding; supplying a new public key rotates both token and key. Include
the intended principal kind and grants. There is no automatic downgrade to bearer authentication.

```sh
hunch serve --config /private/hunch/serve.json revoke --principal agent-one
```

Servers built with this feature reread configuration before each request, so rotation and
revocation affect newly admitted requests without restart. Already admitted requests may finish.
Invalid configuration refuses authentication instead of using a cached credential list.

Upgrade and restart **every** server before enabling key binding or relying on live revocation.
Older running servers retain their startup credential snapshot. Older strict config readers
reject the new key-binding fields when restarted. Existing configs and ordinary bearer
credentials continue to work on the new server. The HTTP capability is `nuryel.auth.dpop/1`.

Proofs use `Authorization: DPoP`, `DPoP: <JWT>`, `alg: EdDSA`, and `typ: dpop+jwt`. Hunch checks
the public-key binding, signature, method, target, token hash, server nonce and timestamp. It
accepts proofs no more than 60 seconds old or 5 seconds ahead; synchronize server/client clocks.
Server nonces cover the current and previous minute and are bound to token/key. A shared file
lock makes proof consumption atomic across processes and restarts. Clients retry once on the
explicit `use_dpop_nonce` challenge, which occurs before an operation runs. Other refusals and
network failures never trigger an automatic write retry.
