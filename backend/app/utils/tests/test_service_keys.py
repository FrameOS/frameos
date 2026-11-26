"""docs/service-keys-fixtures.json against app/utils/service_keys.py, the
port of frontend/src/utils/serviceKeys.ts (the cloud's runner replays the
same corpus against the TypeScript)."""
import json
import subprocess

import pytest

from app.utils.service_keys import (
    REPO_ROOT,
    build_service_keys_wire,
    deliverable_service_values,
    is_service_id,
    read_service_credentials,
    resolve_scene_key_bindings,
    service_field_secrecy,
    service_registry,
)

FIXTURES = json.loads((REPO_ROOT / "docs" / "service-keys-fixtures.json").read_text())


def test_generated_registry_is_current():
    """The SPA and the cloud read a generated copy of repo/services.json."""
    generator = REPO_ROOT / "frameos" / "tools" / "generate_services.py"
    result = subprocess.run(["python3", str(generator), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_registry_loads():
    registry = service_registry()
    assert registry["openAI"]["fields"][0]["secret"] is True
    assert registry["homeAssistant"]["hostsFrom"] == "url"


@pytest.mark.parametrize("case", FIXTURES["serviceId"], ids=[repr(c["id"]) for c in FIXTURES["serviceId"]])
def test_service_id(case):
    assert is_service_id(case["id"]) is case["isService"]


@pytest.mark.parametrize("case", FIXTURES["secrecy"], ids=[f"{c['service']}.{c['field']}" for c in FIXTURES["secrecy"]])
def test_secrecy(case):
    assert service_field_secrecy(case["service"], case["field"]) == case["secret"]


@pytest.mark.parametrize("case", FIXTURES["deliverable"], ids=[c["name"] for c in FIXTURES["deliverable"]])
def test_deliverable(case):
    assert deliverable_service_values(case["service"], case["stored"]) == case["values"]


@pytest.mark.parametrize("case", FIXTURES["resolve"], ids=[c["name"] for c in FIXTURES["resolve"]])
def test_resolve(case):
    credentials = read_service_credentials(case.get("credentials"))
    assert (
        resolve_scene_key_bindings(case["declared"], case.get("keys"), case.get("legacyGranted"), credentials)
        == case["bindings"]
    )


@pytest.mark.parametrize("case", FIXTURES["wire"], ids=[c["name"] for c in FIXTURES["wire"]])
def test_wire(case):
    result = build_service_keys_wire(case["scenes"], case["settings"], case.get("credentials"))
    assert result == case["expect"]
