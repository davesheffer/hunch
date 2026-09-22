"""Run by the Node fixture orchestrator against the actual compiled server."""
import json
import os
import ssl
import sys
from pathlib import Path

from hunch_state import StateClient, StateClientError

fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
scope = fixture["scope"]
client = StateClient(fixture["url"], os.environ["HUNCH_PYTHON_TEST_TOKEN"])
guest = StateClient(fixture["url"], os.environ["HUNCH_PYTHON_TEST_GUEST"])
request = fixture["write"]
output = {"health": client.health(), "capabilities": client.capabilities(scope)}
output["write"] = client.write(request)
record_id = output["write"]["record_id"]
assert output["write"]["outcome"] == "created"
assert client.write(request)["outcome"] == "replayed"
output["read"] = client.read({"scope": scope, "subject": request["record"]["subject"]})
assert output["read"]["records"][record_id]["content"] == request["record"]["content"]
output["records"] = client.records({"scope": scope, "ids": [record_id]})
assert output["records"]["records"][record_id]["content"] == request["record"]["content"]
output["subscribe"] = client.subscribe({"scope": scope, "after_seq": 0})
assert output["subscribe"]["events"][0]["record_id"] == record_id
assert output["subscribe"]["resync"] is False
assert client.subscribe({"scope": scope, "after_seq": output["subscribe"]["head_seq"]})["events"] == []
assert guest.records({"scope": scope, "ids": [record_id]})["missing"] == [record_id]
assert record_id not in guest.read({"scope": scope, "subject": request["record"]["subject"]}).get("records", {})
assert guest.subscribe({"scope": scope, "after_seq": 0})["events"] == []
for work, code in [
    (lambda: client.read({"scope": {"kind": "organization", "id": "outside"}}), "outside-grants"),
    (lambda: client.write({**request, "record": {**request["record"], "transform_version": "different"}}), "idempotency"),
    (lambda: StateClient(fixture["url"], "wrong").capabilities(), "unauthorized"),
]:
    try:
        work()
        raise AssertionError("refusal expected")
    except StateClientError as error:
        assert error.code == code, str(error)
        assert error.status >= 400
output["capture"] = client.capture(fixture["capture"])
assert output["capture"]["outcome"] == "created"
output["batch"] = client.capture_batch(fixture["batch"])
assert output["batch"]["results"][0]["status"] == "saved"
# read_or_compute against the real server: the fixture statement is reused without computing;
# a moved dependency computes once and supersedes it; the same moved set is then reused.
from hunch_state import read_or_compute, state_hash
derived = request["record"]
computed: list[str] = []
def compute(text: str):
    def run() -> str:
        computed.append(text)
        return text
    return run
common = {"scope": scope, "subject": derived["subject"], "transform_version": derived["transform_version"],
          "provenance": derived["provenance"]}
reused = read_or_compute(client, dependencies=derived["dependencies"], compute=compute("must not run"), **common)
assert reused["reused"] and reused["record"]["id"] == record_id and computed == []
moved_deps = [{"kind": "schema", "name": "fixture", "fingerprint": state_hash("fixture-v2")}]
moved = read_or_compute(client, dependencies=moved_deps, compute=compute("Python summary v2: שלום 🌱"), **common)
assert not moved["reused"] and moved["superseded"] == record_id and computed == ["Python summary v2: שלום 🌱"], moved
assert moved["record"]["content_hash"] == state_hash("Python summary v2: שלום 🌱")
assert moved["record"].get("visibility") == derived["visibility"], "the superseded statement's audience carries forward"
assert read_or_compute(client, dependencies=list(reversed(moved_deps)), compute=compute("must not run"), **common)["reused"]
output["read_or_compute"] = {"reused": reused["record"]["id"], "written": moved["write"]["record_id"]}
if "https_url" in fixture:
    from hunch_state.proof import create_proof_signer
    context = ssl.create_default_context(cafile=fixture["ca_file"])
    for key in [fixture["private_pem"], fixture["private_jwk"]]:
        bound = StateClient(fixture["https_url"], os.environ["HUNCH_PYTHON_TEST_BOUND"],
                            ssl_context=context, proof=create_proof_signer(key))
        assert bound.capabilities()["principal"]["id"] == "bound"
        assert bound.read({"scope": scope})["schema"] == "nuryel.state.read/1"
    try:
        create_proof_signer(json.dumps({**json.loads(fixture["private_jwk"]), "x": "wrong"}))
        raise AssertionError("mismatched key accepted")
    except ValueError:
        pass
print(json.dumps(output, ensure_ascii=False))
