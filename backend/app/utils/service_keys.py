"""Service keys: which key of which service each scene on a frame may use,
and what the frame is sent. docs/service-keys.md is the contract,
docs/service-keys-fixtures.json the corpus (this module's runner is
app/utils/tests/test_service_keys.py). A port of
frontend/src/utils/serviceKeys.ts, which the SPA and the cloud share: change
the two together.

The registry is repo/services.json, read here at run time (the backend image
ships it). A missing registry is an error, never an empty one: an empty
registry would make every OpenAI field deliverable, the plane's own
`openAI.backendApiKey` included.
"""
from __future__ import annotations

import json
import random
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
REGISTRY_PATH = REPO_ROOT / "repo" / "services.json"

SERVICE_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,40}$")
SERVICE_FIELD_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,40}$")
CREDENTIAL_ID_PATTERN = re.compile(r"^k_[a-z0-9]{8,24}$")
SERVICE_CREDENTIALS_GROUP = "serviceCredentials"
DEFAULT_KEY_REF = "default"
# The planes' own settings groups: never a service (generate_services.py's list).
PLANE_SETTINGS_GROUPS = frozenset({
    "buildEnvironment", "buildHost", "defaults", "modalSandbox", "personal",
    "posthog", "repositories", "serviceCredentials", "serviceKeys",
    "serviceSettings", "ssh_keys",
})


def _full(pattern: re.Pattern, value: Any) -> bool:
    # `re.match` with `$` accepts a trailing newline; the TS `test` does not.
    return isinstance(value, str) and pattern.fullmatch(value) is not None


@lru_cache(maxsize=1)
def service_registry() -> dict[str, dict[str, Any]]:
    """repo/services.json's services, each field with `secret` filled in."""
    doc = json.loads(REGISTRY_PATH.read_text())
    services = doc.get("services")
    if not isinstance(services, dict):
        raise RuntimeError(f"{REGISTRY_PATH}: no `services`")
    registry: dict[str, dict[str, Any]] = {}
    for service_id, spec in services.items():
        fields = []
        for field in spec.get("fields") or []:
            entry = {"name": field["name"], "label": field["label"], "secret": field.get("secret", True) is not False}
            for key in ("placeholder", "hint"):
                if isinstance(field.get(key), str) and field[key]:
                    entry[key] = field[key]
            fields.append(entry)
        registry[service_id] = {**{k: v for k, v in spec.items() if k != "fields"}, "fields": fields}
    return registry


def is_service_id(value: Any) -> bool:
    return (
        _full(SERVICE_ID_PATTERN, value)
        and not _full(CREDENTIAL_ID_PATTERN, value)
        and value not in PLANE_SETTINGS_GROUPS
    )


def is_credential_id(value: Any) -> bool:
    return _full(CREDENTIAL_ID_PATTERN, value)


def registered_service(service_id: str) -> Optional[dict[str, Any]]:
    return service_registry().get(service_id) if isinstance(service_id, str) else None


def _read_field(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or not _full(SERVICE_FIELD_PATTERN, value.get("name")):
        return None
    label = value.get("label")
    field: dict[str, Any] = {
        "name": value["name"],
        "label": label if isinstance(label, str) and label else value["name"],
        "secret": value.get("secret") is not False,
    }
    for key in ("placeholder", "hint"):
        if isinstance(value.get(key), str) and value[key]:
            field[key] = value[key]
    return field


def app_service_definitions(app_config: Any) -> dict[str, dict[str, Any]]:
    """The services an app defines for itself (config.json `services`): ids
    the registry does not have, title and fields only — never `hosts`."""
    result: dict[str, dict[str, Any]] = {}
    services = app_config.get("services") if isinstance(app_config, dict) else None
    if not isinstance(services, dict):
        return result
    for service_id, spec in services.items():
        if not is_service_id(service_id) or registered_service(service_id) or not isinstance(spec, dict):
            continue
        fields: list[dict[str, Any]] = []
        raw_fields = spec.get("fields")
        for raw in raw_fields if isinstance(raw_fields, list) else []:
            field = _read_field(raw)
            if field and not any(f["name"] == field["name"] for f in fields):
                fields.append(field)
        title = spec.get("title")
        definition: dict[str, Any] = {
            "id": service_id,
            "title": title.strip() if isinstance(title, str) and title.strip() else service_id,
        }
        if isinstance(spec.get("description"), str) and spec["description"]:
            definition["description"] = spec["description"]
        definition["fields"] = fields
        definition["registered"] = False
        result[service_id] = definition
    return result


def service_definition(
    service_id: str,
    app_definitions: Optional[Mapping[str, Any]] = None,
    stored_values: Any = None,
) -> dict[str, Any]:
    """What a form draws: the registry's entry, else an app's definition,
    else the bare id with the fields a stored value has (else `apiKey`)."""
    registered = registered_service(service_id)
    if registered:
        definition: dict[str, Any] = {"id": service_id, "title": registered["title"]}
        for key in ("description", "help"):
            if registered.get(key):
                definition[key] = registered[key]
        if registered.get("optional"):
            definition["optional"] = True
        definition["fields"] = [dict(field) for field in registered["fields"]]
        if registered.get("hosts"):
            definition["hosts"] = list(registered["hosts"])
        if registered.get("hostsFrom"):
            definition["hostsFrom"] = registered["hostsFrom"]
        definition["registered"] = True
        return definition
    defined = (app_definitions or {}).get(service_id)
    fields = [dict(field) for field in defined["fields"]] if isinstance(defined, dict) else []
    if isinstance(stored_values, dict):
        for name, value in stored_values.items():
            if isinstance(value, str) and _full(SERVICE_FIELD_PATTERN, name) and not any(f["name"] == name for f in fields):
                fields.append({"name": name, "label": name, "secret": True})
    if not fields:
        fields.append({"name": "apiKey", "label": "API key", "secret": True})
    definition = {"id": service_id, "title": defined["title"] if isinstance(defined, dict) else service_id}
    if isinstance(defined, dict) and defined.get("description"):
        definition["description"] = defined["description"]
    definition["fields"] = fields
    definition["registered"] = False
    return definition


def service_title(service_id: str, app_definitions: Optional[Mapping[str, Any]] = None) -> str:
    registered = registered_service(service_id)
    if registered:
        return registered["title"]
    defined = (app_definitions or {}).get(service_id)
    return defined["title"] if isinstance(defined, dict) else service_id


def service_field_secrecy(service_id: str, field: str) -> Optional[bool]:
    """True/False for a field the registry describes (or any field of an
    unregistered service: True); None for a field the registry does not list
    in a registered service's group — the plane's own list decides."""
    registered = registered_service(service_id)
    if not registered:
        return True
    for known in registered["fields"]:
        if known["name"] == field:
            return bool(known["secret"])
    return None


def deliverable_service_values(service_id: str, stored: Any) -> Optional[dict[str, str]]:
    """The values of one credential a frame may be sent: a registered
    service's registry fields alone, every field of an unregistered one,
    non-empty strings only; None when nothing usable is left."""
    if not isinstance(stored, dict):
        return None
    registered = registered_service(service_id)
    allowed = {field["name"] for field in registered["fields"]} if registered else None
    values: dict[str, str] = {}
    for name in sorted(key for key in stored.keys() if isinstance(key, str)):
        value = stored[name]
        if not _full(SERVICE_FIELD_PATTERN, name) or (allowed is not None and name not in allowed):
            continue
        if isinstance(value, str) and value != "":
            values[name] = value
    return values or None


def read_service_credentials(value: Any) -> dict[str, dict[str, Any]]:
    """The `serviceCredentials` group, read defensively: id → {service, name, values}."""
    result: dict[str, dict[str, Any]] = {}
    if not isinstance(value, dict):
        return result
    for credential_id, raw in value.items():
        if not is_credential_id(credential_id) or not isinstance(raw, dict) or not is_service_id(raw.get("service")):
            continue
        values: dict[str, str] = {}
        if isinstance(raw.get("values"), dict):
            for name, v in raw["values"].items():
                if _full(SERVICE_FIELD_PATTERN, name) and isinstance(v, str):
                    values[name] = v
        name = raw.get("name")
        result[credential_id] = {
            "service": raw["service"],
            "name": name.strip() if isinstance(name, str) and name.strip() else credential_id,
            "values": values,
        }
    return result


def read_scene_key_bindings(value: Any) -> dict[str, Optional[str]]:
    """An install's `keys`: service → "default", a credential id, or None."""
    result: dict[str, Optional[str]] = {}
    if not isinstance(value, dict):
        return result
    for service, ref in value.items():
        if not is_service_id(service):
            continue
        if ref is None or ref is False:
            result[service] = None
        elif ref == DEFAULT_KEY_REF or is_credential_id(ref):
            result[service] = ref
    return result


def resolve_scene_key_bindings(
    declared: Iterable[str],
    keys: Any = None,
    legacy_granted: Optional[Iterable[str]] = None,
    credentials: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> dict[str, Optional[str]]:
    """Which key each declared service gets (docs/service-keys.md "Which key a
    scene gets"): the install's own binding, else the default when the older
    grant covers it, else refused (None)."""
    bindings = read_scene_key_bindings(keys)
    granted = set(legacy_granted or [])
    credentials = credentials or {}
    result: dict[str, Optional[str]] = {}
    for service in sorted({s for s in declared if is_service_id(s)}):
        if service in bindings:
            ref = bindings[service]
            if ref == DEFAULT_KEY_REF:
                result[service] = DEFAULT_KEY_REF
            elif ref is not None and (credentials.get(ref) or {}).get("service") == service:
                result[service] = ref
            else:
                result[service] = None
        else:
            result[service] = DEFAULT_KEY_REF if service in granted else None
    return result


def build_service_keys_wire(
    scenes: Iterable[Mapping[str, Any]],
    settings: Optional[Mapping[str, Any]],
    credentials: Any = None,
) -> dict[str, Any]:
    """`{"serviceKeys": …, "settings": …}` for a frame (docs/service-keys.md
    "On the wire"). Each scene: {id, declared, keys?, legacyGranted?,
    appDefinitions?}. `settings` is the plane's stored settings."""
    stored = settings if isinstance(settings, Mapping) else {}
    creds = read_service_credentials(credentials if credentials is not None else stored.get(SERVICE_CREDENTIALS_GROUP))
    wire: dict[str, Any] = {"v": 1, "keys": {}, "scenes": {}, "services": {}}
    definitions: dict[str, dict[str, Any]] = {}
    uses_default: set[str] = set()
    bound_key_ids: dict[str, set[str]] = {}

    for scene in sorted(scenes, key=lambda s: str(s.get("id"))):
        bindings = resolve_scene_key_bindings(
            scene.get("declared") or [],
            scene.get("keys"),
            scene.get("legacyGranted"),
            creds,
        )
        if not bindings:
            continue
        entry: dict[str, Optional[str]] = {}
        for service, ref in bindings.items():
            if service not in definitions:
                definitions[service] = service_definition(service, scene.get("appDefinitions"), stored.get(service))
            if ref is None:
                entry[service] = None
                continue
            key_id = service if ref == DEFAULT_KEY_REF else ref
            entry[service] = key_id
            if ref == DEFAULT_KEY_REF:
                uses_default.add(service)
            bound_key_ids.setdefault(service, set()).add(key_id)
            if key_id not in wire["keys"]:
                source = stored.get(service) if ref == DEFAULT_KEY_REF else (creds.get(ref) or {}).get("values")
                values = deliverable_service_values(service, source)
                if values:
                    wire["keys"][key_id] = {"service": service, "values": values}
        wire["scenes"][str(scene.get("id"))] = entry

    for service_id in sorted(definitions):
        definition = definitions[service_id]
        described: dict[str, Any] = {
            "title": definition["title"],
            "fields": [
                {"name": field["name"], "label": field["label"]}
                if field["secret"]
                else {"name": field["name"], "label": field["label"], "secret": False}
                for field in definition["fields"]
            ],
        }
        if definition.get("hosts"):
            described["hosts"] = list(definition["hosts"])
        if definition.get("hostsFrom"):
            described["hostsFrom"] = definition["hostsFrom"]
        wire["services"][service_id] = described

    legacy: dict[str, dict[str, str]] = {}
    for service in sorted(bound_key_ids):
        legacy_id: Optional[str] = (
            service
            if service in uses_default and service in wire["keys"]
            else next((k for k in sorted(bound_key_ids[service]) if k in wire["keys"]), None)
        )
        if legacy_id:
            legacy[service] = dict(wire["keys"][legacy_id]["values"])

    return {"serviceKeys": wire, "settings": legacy}


def declared_services(app_config: Any) -> list[str]:
    """The service ids an app's config declares (its `settings` list)."""
    listed = app_config.get("settings") if isinstance(app_config, dict) else None
    return sorted({s for s in listed if is_service_id(s)}) if isinstance(listed, list) else []


def new_credential_id(rng: Optional[random.Random] = None) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    pick = (rng or random.SystemRandom()).choice
    return "k_" + "".join(pick(alphabet) for _ in range(12))
