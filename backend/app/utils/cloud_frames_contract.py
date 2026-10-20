"""The self-hosted backend's walker of the cloud verb contract.

docs/cloud-frames-contract.json -> cloud_frames_contract_gen.py. The Linux
runtime (frameos/cloud/contract.nim), the ESP32 firmware
(fos_cloud_contract.c) and the cloud (auth-web cloud-frames-contract.ts) walk
the same tables; docs/cloud-frames-fixtures.json pins all four to one
verdict per case. The backend walks them for the same reason the cloud does:
it is a provider now (docs/convergence-todo.md item 7), and a push the
device would refuse is better refused before it is queued.

Types are strict the way the device's JSON is: an int is a Python int and
never a bool, so a payload this walker accepts serializes to what the Nim
walker accepts (`90.0` is not an int there either).
"""
from __future__ import annotations

import re
from typing import Any, Optional

from app.utils.cloud_frames_contract_gen import CLOUD_FRAMES_CONTRACT

CONTRACT_PROFILES: tuple[str, ...] = tuple(CLOUD_FRAMES_CONTRACT["profiles"])
_SETTINGS: dict[str, dict[str, Any]] = CLOUD_FRAMES_CONTRACT["settings"]
CONTRACT_VERBS: tuple[dict[str, Any], ...] = tuple(CLOUD_FRAMES_CONTRACT["verbs"])
CONTRACT_VERB_TYPES: frozenset[str] = frozenset(verb["type"] for verb in CONTRACT_VERBS)
CONTRACT_LIMITS: dict[str, dict[str, int]] = CLOUD_FRAMES_CONTRACT["limits"]

# The patterns are JavaScript's: `$` there never matches before a trailing
# newline, Python's does, so it becomes `\Z`. (`gpio_label` is prose, not a
# pattern; _matches_format implements it.)
_FORMATS = {
    name: re.compile(re.sub(r"\$$", r"\\Z", pattern))
    for name, pattern in CLOUD_FRAMES_CONTRACT["formats"].items()
    if name != "gpio_label"
}


def _matches_format(fmt: Optional[str], value: str) -> bool:
    if fmt == "gpio_label":
        # 1..32 characters after trimming, no ':' (the firmware's spec
        # separator) and no newline.
        trimmed = value.strip()
        return 1 <= len(trimmed) <= 32 and ":" not in value and "\n" not in value
    if fmt in _FORMATS:
        return _FORMATS[fmt].search(value) is not None
    return True


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value == value and value not in (float("inf"), float("-inf"))


def validate_contract_rule(rule: dict[str, Any], value: Any) -> bool:
    if "anyOf" in rule:
        return any(validate_contract_rule(alternative, value) for alternative in rule["anyOf"])
    kind = rule.get("type")
    if kind == "bool":
        return isinstance(value, bool)
    if kind == "null":
        return value is None
    if kind == "int":
        if not _is_int(value):
            return False
        if "min" in rule and value < rule["min"]:
            return False
        if "max" in rule and value > rule["max"]:
            return False
        return "enum" not in rule or value in rule["enum"]
    if kind == "number":
        if not _is_number(value):
            return False
        if "min" in rule and value < rule["min"]:
            return False
        return "max" not in rule or value <= rule["max"]
    if kind == "string":
        if not isinstance(value, str):
            return False
        if "minLen" in rule and len(value) < rule["minLen"]:
            return False
        if "maxLen" in rule and len(value) > rule["maxLen"]:
            return False
        if "enum" in rule and value not in rule["enum"]:
            return False
        return _matches_format(rule.get("format"), value)
    if kind == "object":
        if not isinstance(value, dict):
            return False
        if "minKeys" in rule and len(value) < rule["minKeys"]:
            return False
        keys = rule.get("keys") or {}
        for key, entry in value.items():
            sub = keys.get(key)
            if sub is not None:
                if not validate_contract_rule(sub, entry):
                    return False
            elif not rule.get("open"):
                return False
        return all(required in value for required in rule.get("required") or [])
    if kind == "array":
        if not isinstance(value, list):
            return False
        if "maxItems" in rule and len(value) > rule["maxItems"]:
            return False
        return all(validate_contract_rule(rule["items"], item) for item in value)
    if kind == "map":
        if not isinstance(value, dict):
            return False
        if "maxEntries" in rule and len(value) > rule["maxEntries"]:
            return False
        for key, entry in value.items():
            if "keyMinLen" in rule and len(key) < rule["keyMinLen"]:
                return False
            if "keyMaxLen" in rule and len(key) > rule["keyMaxLen"]:
                return False
            if not validate_contract_rule(rule["values"], entry):
                return False
        return True
    return False


def _extra_checks(key: str, value: Any) -> bool:
    """The contract's `extraChecks`: cross-field rules the rule language does
    not express, implemented by hand in every walker and pinned by the
    fixtures."""
    if key == "palette":
        names = value.get("colorNames")
        colors = value.get("colors")
        return names is None or len(names) == (len(colors) if isinstance(colors, list) else -1)
    if key == "gpio_buttons":
        pins: set[int] = set()
        for button in value:
            if button["pin"] in pins:
                return False
            pins.add(button["pin"])
        return True
    return True


def contract_setting_rule(key: str, profile: str) -> Optional[dict[str, Any]]:
    """The rule `profile` applies to `key`; None when the profile does not take it."""
    spec = _SETTINGS.get(key)
    pspec = spec["profiles"].get(profile) if spec else None
    if spec is None or pspec is None:
        return None
    return pspec.get("rule", spec["rule"])


def contract_setting_since(key: str, profile: str) -> Optional[str]:
    """The first firmware of `profile` that knows `key` (None: every version).
    Raises KeyError when the profile does not take the key at all."""
    return _SETTINGS[key]["profiles"][profile].get("since")


def contract_setting_restarts(key: str, profile: str) -> bool:
    spec = _SETTINGS.get(key)
    pspec = spec["profiles"].get(profile) if spec else None
    return bool(pspec and pspec.get("restart"))


def contract_setting_companion(key: str) -> Optional[str]:
    spec = _SETTINGS.get(key)
    return spec.get("companion") if spec else None


def contract_setting_keys(profile: str, *, companions: bool = False) -> list[str]:
    """The keys `profile` takes, in contract order. Companion keys only when
    asked: the provider attaches those itself."""
    return [
        key
        for key, spec in _SETTINGS.items()
        if profile in spec["profiles"] and (companions or not spec.get("companion"))
    ]


def validate_contract_setting(key: str, value: Any, profile: str) -> bool:
    rule = contract_setting_rule(key, profile)
    return rule is not None and validate_contract_rule(rule, value) and _extra_checks(key, value)


def check_contract_settings(value: Any, profile: str) -> Optional[str]:
    """The whole-push verdict a device of `profile` gives a set_settings
    object: None when every key is allowed and valid, otherwise the error
    token it acks. Every key's allowance is checked before any value, so the
    verdict does not depend on key order."""
    if not isinstance(value, dict) or not value:
        return "invalid_settings"
    for key in value:
        if contract_setting_rule(key, profile) is None:
            return "setting_not_allowed"
    for key, entry in value.items():
        if not validate_contract_setting(key, entry, profile):
            return "invalid_settings"
        companion = contract_setting_companion(key)
        if companion and companion not in value:
            return "invalid_settings"
    return None


def contract_verb(verb_type: str) -> Optional[dict[str, Any]]:
    return next((verb for verb in CONTRACT_VERBS if verb["type"] == verb_type), None)


def contract_limit(name: str, profile: str) -> int:
    return int(CONTRACT_LIMITS[name][profile])
