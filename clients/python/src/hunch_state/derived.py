"""read_or_compute: the reuse rule every derived-state writer otherwise re-derives by hand.

Same rules as the TypeScript helper (docs/nuryel-state-contract.md, "Read or compute"):

1. Read the subject. A current statement under the same transform whose dependency SET equals the
   given one is reused and ``compute`` never runs. The set, not the order: the server derives a
   statement's identity from its dependency hashes sorted.
2. Otherwise run ``compute`` once and write the result as the subject's current statement.
3. The idempotency key names the REQUEST: subject, transform and dependencies, the content hash,
   and computed_at. A key without the content hash is reused when the same evidence yields new
   wording, and the contract refuses a reused key with another payload for good.
4. ``supersedes`` names the current statement it replaces under the same transform.
5. The audience carries forward: without an explicit ``visibility`` the new statement keeps the one
   it supersedes. An explicit change sends the predecessor's record hash as ``expected_version``.
6. No retries. Refusals and transport failures surface; calling again re-reads first, so a write
   that did land is reused instead of written twice.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, TypedDict, NotRequired, cast

from .client import StateClient
from .models import DependencyRef, DerivedState, ReadRequest, RecordsRequest, Scope, WriteRequest, WriteResult

DERIVED_SCHEMA = "nuryel.derived/1"


class ComputedContent(TypedDict):
    content: str
    field_provenance: NotRequired[list[dict[str, Any]]]


class ReadOrComputeResult(TypedDict):
    reused: bool
    record: DerivedState
    read_receipt: str
    write: NotRequired[WriteResult]
    superseded: NotRequired[str | None]


def _canonical(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical form rejects non-finite numbers")
        return int(value) if value.is_integer() and abs(value) < 2 ** 53 else value
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        # Code-unit order, as the server sorts keys (JavaScript string comparison).
        for key in sorted(value.keys(), key=lambda k: str(k).encode("utf-16-be")):
            if not isinstance(key, str):
                raise ValueError("canonical form requires string keys")
            if key == "__proto__":
                raise ValueError("canonical form rejects reserved key __proto__")
            out[key] = _canonical(value[key])
        return out
    raise ValueError(f"canonical form rejects {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """The server's canonical JSON for strings, integers, booleans, null, lists and objects."""
    return json.dumps(_canonical(value), ensure_ascii=False, separators=(",", ":"), sort_keys=False, allow_nan=False)


def state_hash(value: Any) -> str:
    """``sha256:<hex>`` over the canonical form: the server's stateHash."""
    try:
        encoded = canonical_json(value).encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("canonical form rejects lone surrogates") from None
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _dependency_set(dependencies: Sequence[Mapping[str, Any]]) -> str:
    return "\n".join(sorted(canonical_json(dep) for dep in dependencies))


def read_or_compute(client: StateClient, *, scope: Scope, subject: str, transform_version: str,
                    dependencies: Sequence[DependencyRef], provenance: Mapping[str, Any],
                    compute: Callable[[], str | ComputedContent],
                    now: Callable[[], str] | None = None,
                    visibility: Mapping[str, Any] | None = None) -> ReadOrComputeResult:
    if not dependencies:
        raise ValueError("read_or_compute: derived state needs at least one dependency")
    deps = [cast(Mapping[str, Any], dep) for dep in dependencies]

    read = client.read(cast(ReadRequest, {"scope": scope, "subject": subject, "facets": ["derived"]}))
    state = cast(dict[str, Any], read).get("state_of_record") or {}
    refs = [ref for ref in state.get("current", [])
            if ref.get("facet") == "derived" and ref.get("scope") == scope]
    record_hash = {ref["id"]: ref.get("record_hash") for ref in refs}
    records: dict[str, Any] = dict(cast(dict[str, Any], read).get("records") or {})
    unseen = [ref["id"] for ref in refs if ref["id"] not in records]
    if unseen:
        # Hosts that predate `records` on the read answer by id instead.
        answered = client.records(cast(RecordsRequest, {"scope": scope, "ids": unseen}))
        records.update(cast(dict[str, Any], answered).get("records") or {})
    current = [records[ref["id"]] for ref in refs if isinstance(records.get(ref["id"]), dict)]
    current = [r for r in current if r.get("schema") == DERIVED_SCHEMA and r.get("subject") == subject
               and r.get("transform_version") == transform_version and r.get("state") == "current"
               and r.get("valid_to") is None]

    wanted = _dependency_set(deps)
    receipt = str(cast(dict[str, Any], read).get("receipt_id", ""))
    for record in current:
        if _dependency_set(record.get("dependencies", [])) == wanted:
            return {"reused": True, "record": cast(DerivedState, record), "read_receipt": receipt}

    computed = compute()
    content = computed if isinstance(computed, str) else computed["content"]
    field_provenance = None if isinstance(computed, str) else computed.get("field_provenance")
    if not isinstance(content, str) or not content:
        raise ValueError("read_or_compute: compute must return non-empty content")
    content_hash = state_hash(content)
    computed_at = now() if now else datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    incumbent = next((r for r in current if _dependency_set(r.get("dependencies", [])) != wanted), None)

    statement = state_hash({"scope": scope, "subject": subject, "transform_version": transform_version,
                            "dependencies": sorted(canonical_json(dep) for dep in deps)})
    audience = dict(visibility) if visibility is not None else (incumbent or {}).get("visibility")
    audience_changes = incumbent is not None and canonical_json(incumbent.get("visibility")) != canonical_json(audience)
    record_out: dict[str, Any] = {
        "schema": DERIVED_SCHEMA, "scope": scope, "subject": subject, "content": content,
        "content_hash": content_hash, "dependencies": list(deps), "transform_version": transform_version,
        "computed_at": computed_at, "valid_to": None, "state": "current", "provenance": dict(provenance),
    }
    if field_provenance:
        record_out["field_provenance"] = field_provenance
    if audience:
        record_out["visibility"] = audience
    request: dict[str, Any] = {"scope": scope, "facet": "derived", "record": record_out,
                               "idempotency_key": f"derived:{statement[7:23]}:{content_hash[7:23]}:{computed_at}"}
    if incumbent is not None:
        request["supersedes"] = incumbent["id"]
        if audience_changes:
            request["expected_version"] = record_hash.get(incumbent["id"])
    write = client.write(cast(WriteRequest, request))
    stored = cast(dict[str, Any], write).get("record") or {**record_out, "id": write["record_id"]}
    return {"reused": False, "record": cast(DerivedState, stored), "read_receipt": receipt, "write": write,
            "superseded": incumbent["id"] if incumbent is not None else None}
