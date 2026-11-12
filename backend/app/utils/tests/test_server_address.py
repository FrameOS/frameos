"""The backend's runner of docs/server-address-fixtures.json: the one reading
of a frame's backend address shared with the Nim runtime
(frameos/src/frameos/tests/test_server_address.nim) and the SPA
(cloud/apps/auth-web/src/test/shared-spa/backend-address.test.ts)."""

import json
from pathlib import Path

import pytest

from app.models.frame import server_scheme_from_port, split_server_address
from app.utils.server_address import (
    ServerAddress,
    join_address,
    normalize_scheme,
    scheme_from_port,
    split_address,
)

REPO = Path(__file__).resolve().parents[4]
FIXTURES = json.loads((REPO / "docs" / "server-address-fixtures.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["schemeFromPort"]["cases"], ids=lambda c: str(c["port"]))
def test_scheme_from_port(case):
    assert scheme_from_port(case["port"]) == case["scheme"]
    # The model's wrapper is the same rule, not a second one.
    assert server_scheme_from_port(case["port"]) == case["scheme"]


@pytest.mark.parametrize("case", FIXTURES["normalizeScheme"]["cases"], ids=lambda c: f"{c['scheme']!r}:{c['port']}")
def test_normalize_scheme(case):
    assert normalize_scheme(case["scheme"], case["port"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURES["splitAddress"]["cases"], ids=lambda c: c["input"] or "<empty>")
def test_split_address(case):
    assert split_address(case["input"]) == ServerAddress(case["scheme"], case["host"], case["port"])


def test_split_server_address_fills_what_the_text_left_out():
    """The model's tuple form: the scheme's own port for an address that said
    a scheme but no port, 8989 for one that said neither, None for a scheme
    nobody typed (the caller seeds it)."""
    assert split_server_address("https://backend.local:8443") == ("backend.local", 8443, "https")
    assert split_server_address("https://backend.local") == ("backend.local", 443, "https")
    assert split_server_address("http://backend.local") == ("backend.local", 80, "http")
    assert split_server_address("backend.local") == ("backend.local", 8989, None)
    assert split_server_address("backend.local:9000") == ("backend.local", 9000, None)
    assert split_server_address("user:pw@backend.local") == ("user:pw@backend.local", 8989, None)


def test_join_address_leaves_off_the_scheme_s_own_port():
    assert join_address("https", "backend.local", 443) == "https://backend.local"
    assert join_address("https", "backend.local", 8443) == "https://backend.local:8443"
    assert join_address("http", "backend.local", 80) == "http://backend.local"
    assert join_address("http", "backend.local", 8989) == "http://backend.local:8989"
    assert join_address("http", "fd00::10", 8989) == "http://[fd00::10]:8989"
    assert join_address("http", "[fd00::10]", 8989) == "http://[fd00::10]:8989"
    assert join_address("http", "backend.local", None) == "http://backend.local"
