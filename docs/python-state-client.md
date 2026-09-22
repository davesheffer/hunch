# Python state client

Shipped in the Hunch 1.33.0 repository for Python 3.11+. Python services can use the same state
contract as the TypeScript client, CLI, MCP and operator view. The client lives in `clients/python`
and is installable from this repository; it is not yet published to PyPI. Independent-consumer
adoption remains unverified.

See the [client README](../clients/python/README.md) for installation, typed requests,
timeouts and errors, capability negotiation, subscriptions and optional Ed25519 key binding.
The server remains the source of truth for identity, authorization and current state.

`read_or_compute` reuses a subject's current derived statement when its dependencies are
unchanged and otherwise computes once and writes the replacement with a request-scoped
idempotency key; the rules are in the contract's
[Read or compute](nuryel-state-contract.md#read-or-compute) section.

The package's generated types and structural schemas are checked against the canonical Zod
contract. A Python process exercises the real Hunch server, and TypeScript validates the
returned objects and delivery receipt. This is compatibility evidence from an isolated fixture;
adoption by an independent Python consumer remains a separate acceptance result.
