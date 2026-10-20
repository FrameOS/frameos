"""The conformance corpus (docs/cloud-frames-fixtures.json) against the
backend's walker of the verb contract. The Linux runtime
(test_cloud_contract.nim), the ESP32 firmware (test_fos_cloud_contract.c)
and the cloud (cloud-frames-contract.test.ts) run the same file: four
implementations, one verdict per case."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.utils.cloud_frames_contract import (
    CONTRACT_PROFILES,
    CONTRACT_VERB_TYPES,
    check_contract_settings,
    contract_setting_keys,
    contract_verb,
    validate_contract_rule,
)
from app.utils.frame_commands import QUEUEABLE_TYPES

REPO = Path(__file__).resolve().parents[4]
FIXTURES = json.loads((REPO / "docs" / "cloud-frames-fixtures.json").read_text())
CONTRACT = json.loads((REPO / "docs" / "cloud-frames-contract.json").read_text())


@pytest.mark.parametrize("case", FIXTURES["settings"], ids=lambda case: case["name"])
def test_settings_fixture(case):
    for profile in CONTRACT_PROFILES:
        verdict = check_contract_settings(case["settings"], profile) or "ok"
        assert verdict == case["expect"][profile], f"{profile}: {case['name']}"


def test_every_profile_has_a_verdict_in_every_case():
    for case in FIXTURES["settings"]:
        assert set(case["expect"]) == set(CONTRACT_PROFILES), case["name"]


def test_profile_keys_are_the_contracts():
    for profile in CONTRACT_PROFILES:
        expected = [
            key for key, spec in CONTRACT["settings"].items() if profile in spec["profiles"] and not spec.get("companion")
        ]
        assert contract_setting_keys(profile) == expected


def test_the_verb_table_is_the_contracts():
    assert CONTRACT_VERB_TYPES == {verb["type"] for verb in CONTRACT["verbs"]}
    for case in FIXTURES["verbs"]:
        if case["expect"] == "unknown_verb":
            assert case["type"] not in CONTRACT_VERB_TYPES, case["name"]
        elif case["expect"] == "insufficient_scope":
            # A provider can only gate on the table's scope: the device's own
            # answer to an unscoped session is what the case pins.
            assert contract_verb(case["type"])["scope"], case["name"]


def test_the_backend_queues_only_contract_verbs():
    assert QUEUEABLE_TYPES <= CONTRACT_VERB_TYPES


@pytest.mark.parametrize(
    "rule, value, ok",
    [
        ({"type": "int"}, True, False),  # a bool is not an int on the wire
        ({"type": "int"}, 90.0, False),  # nor is a float the Nim walker refuses
        ({"type": "number"}, 1.5, True),
        ({"type": "number"}, float("nan"), False),
        ({"type": "string", "format": "iana_zone"}, "Europe/Tallinn\n", False),
        ({"type": "string", "format": "gpio_label"}, "A:B", False),
    ],
)
def test_the_walker_is_strict_where_the_devices_are(rule, value, ok):
    assert validate_contract_rule(rule, value) is ok
