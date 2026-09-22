import json
import unittest
from pathlib import Path
from typing import Any

from hunch_state import canonical_json, read_or_compute, state_hash

SCOPE = {"kind": "organization", "id": "acme"}
PROVENANCE = {"source": "agent_recorded", "confidence": 0.8, "evidence": ["read_or_compute test"]}


def event(key: str, version: str) -> dict[str, Any]:
    return {"kind": "external", "ref": {"system": "crm", "object_type": "event", "object_key": key,
                                        "version": version, "observed_at": "2026-09-17T10:00:00Z"}}


class FakeClient:
    """Holds current derived statements per subject the way the server answers a read."""
    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}
        self.writes: list[dict[str, Any]] = []

    def read(self, request: dict[str, Any]) -> dict[str, Any]:
        current = [{"facet": "derived", "id": r["id"], "record_hash": state_hash(r), "scope": r["scope"]}
                   for r in self.records.values()
                   if r["subject"] == request["subject"] and r["state"] == "current" and r["valid_to"] is None]
        return {"schema": "nuryel.state.read/1", "receipt_id": "hdr_" + "0" * 24, "scope": request["scope"],
                "denied_scopes": [], "records": {c["id"]: self.records[c["id"]] for c in current},
                "state_of_record": {"subject": request["subject"], "current": current, "in_force": [], "done": [],
                                    "depends_on": [], "invalidated_by": []}}

    def records(self, request: dict[str, Any]) -> dict[str, Any]:
        raise AssertionError("records lookup not expected when the read carries records")

    def write(self, request: dict[str, Any]) -> dict[str, Any]:
        self.writes.append(request)
        record = dict(request["record"])
        record["id"] = "nds_" + state_hash({"s": record["subject"], "t": record["transform_version"],
                                            "d": sorted(canonical_json(d) for d in record["dependencies"])})[7:31]
        if "supersedes" in request:
            self.records[request["supersedes"]]["valid_to"] = record["computed_at"]
        self.records[record["id"]] = record
        return {"schema": "nuryel.state.write/1", "record_id": record["id"], "record_hash": state_hash(record),
                "durability": "committed", "outcome": "created", "conflict": None, "record": record}


class DerivedTests(unittest.TestCase):
    def test_canonical_hash_matches_server_vectors(self) -> None:
        vectors = json.loads((Path(__file__).parent / "state_hash_vectors.json").read_text(encoding="utf-8"))
        for vector in vectors:
            self.assertEqual(state_hash(vector["value"]), vector["hash"], vector["value"])
        self.assertEqual(canonical_json({"b": 1, "a": 2.0}), '{"a":2,"b":1}')
        with self.assertRaises(ValueError):
            canonical_json({"n": float("nan")})
        with self.assertRaises(ValueError):
            canonical_json({"__proto__": 1})

    def test_reuse_supersede_and_request_scoped_keys(self) -> None:
        client = FakeClient()
        calls: list[str] = []

        def compute(text: str) -> Any:
            def run() -> str:
                calls.append(text)
                return text
            return run

        base = dict(scope=SCOPE, subject="customer:c1", transform_version="summary/v1", provenance=PROVENANCE)
        first = read_or_compute(client, dependencies=[event("7", "v1")], compute=compute("Open"),  # type: ignore[arg-type]
                                now=lambda: "2026-09-17T10:00:00.000Z", **base)  # type: ignore[arg-type]
        self.assertFalse(first["reused"])
        self.assertIsNone(first["superseded"])
        self.assertEqual(first["record"]["content_hash"], state_hash("Open"))

        again = read_or_compute(client, dependencies=[event("7", "v1")], compute=compute("never"),  # type: ignore[arg-type]
                                **base)  # type: ignore[arg-type]
        self.assertTrue(again["reused"])
        self.assertEqual(calls, ["Open"])

        moved = read_or_compute(client, dependencies=[event("7", "v2")], compute=compute("Closed"),  # type: ignore[arg-type]
                                now=lambda: "2026-09-17T11:00:00.000Z", **base)  # type: ignore[arg-type]
        self.assertFalse(moved["reused"])
        self.assertEqual(moved["superseded"], first["record"]["id"])
        self.assertEqual(client.writes[-1]["supersedes"], first["record"]["id"])
        key = client.writes[-1]["idempotency_key"]
        self.assertIn(state_hash("Closed")[7:23], key)
        self.assertTrue(key.endswith("2026-09-17T11:00:00.000Z"))

        with self.assertRaises(ValueError):
            read_or_compute(client, dependencies=[], compute=compute("x"), **base)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            read_or_compute(client, subject="customer:c9", scope=SCOPE, transform_version="summary/v1",  # type: ignore[arg-type]
                            provenance=PROVENANCE, dependencies=[event("1", "v1")], compute=lambda: "")  # type: ignore[arg-type]

    def test_same_request_same_key_new_wording_new_key(self) -> None:
        keys = []
        for text, at in [("A", "2026-09-17T12:00:00.000Z"), ("B", "2026-09-17T12:00:00.000Z"),
                         ("A", "2026-09-17T12:05:00.000Z"), ("A", "2026-09-17T12:00:00.000Z")]:
            client = FakeClient()
            read_or_compute(client, scope=SCOPE, subject="customer:c2", transform_version="summary/v1",  # type: ignore[arg-type]
                            provenance=PROVENANCE, dependencies=[event("9", "v1")],  # type: ignore[list-item]
                            compute=lambda text=text: text, now=lambda at=at: at)
            keys.append(client.writes[0]["idempotency_key"])
        self.assertEqual(len(set(keys[:3])), 3)
        self.assertEqual(keys[3], keys[0])


if __name__ == "__main__":
    unittest.main()
