#!/usr/bin/env python3
"""Generate the TypeScript copy of the services registry.

Source of truth: repo/services.json (prose: docs/service-keys.md, corpus:
docs/service-keys-fixtures.json). The registry is DATA for the control
planes and the editor — titles, field labels, which fields are secret, where
a key may be sent — and is never compiled into a frame: a frame gets the
few entries its scenes use inside `serviceKeys.services`.

Outputs (committed):

  frontend/src/generated/services.gen.ts   the SPA and the cloud (which
                                           imports the shared frontend)

The backend reads repo/services.json at run time (its image ships repo/).

    python3 frameos/tools/generate_services.py          # write
    python3 frameos/tools/generate_services.py --check  # CI: fail if stale
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / "repo" / "services.json"
OUTPUT = REPO / "frontend" / "src" / "generated" / "services.gen.ts"

SERVICE_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,40}$")
CREDENTIAL_ID = re.compile(r"^k_[a-z0-9]{8,24}$")
FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,40}$")
HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$")
# The control planes' own settings groups: never a service id
# (docs/service-keys.md, "Plane settings are not services").
PLANE_GROUPS = {
    "defaults", "posthog", "repositories", "personal", "ssh_keys",
    "buildEnvironment", "buildHost", "modalSandbox", "serviceCredentials",
    # payload keys beside the groups (docs/service-keys.md "On the wire")
    "serviceKeys", "serviceSettings",
}
SERVICE_KEYS = {"title", "description", "help", "optional", "fields", "hosts", "hostsFrom"}
FIELD_KEYS = {"name", "label", "secret", "placeholder", "hint"}


def fail(message: str) -> None:
    raise SystemExit(f"{SOURCE.relative_to(REPO)}: {message}")


def load() -> dict:
    doc = json.loads(SOURCE.read_text())
    services = doc.get("services")
    if not isinstance(services, dict) or not services:
        fail("`services` must be a non-empty object")
    out: dict = {}
    for service_id, spec in services.items():
        if not SERVICE_ID.match(service_id) or service_id in PLANE_GROUPS or CREDENTIAL_ID.match(service_id):
            fail(f"{service_id!r} is not a service id")
        if not isinstance(spec, dict):
            fail(f"{service_id}: must be an object")
        unknown = set(spec) - SERVICE_KEYS
        if unknown:
            fail(f"{service_id}: unknown keys {sorted(unknown)}")
        if not isinstance(spec.get("title"), str) or not spec["title"].strip():
            fail(f"{service_id}: `title` is required")
        fields = spec.get("fields")
        if not isinstance(fields, list) or not fields:
            fail(f"{service_id}: `fields` must be a non-empty list")
        names: set[str] = set()
        clean_fields = []
        for field in fields:
            if not isinstance(field, dict) or set(field) - FIELD_KEYS:
                fail(f"{service_id}: a field has unknown keys")
            name = field.get("name")
            if not isinstance(name, str) or not FIELD_NAME.match(name) or name in names:
                fail(f"{service_id}: bad or repeated field name {name!r}")
            names.add(name)
            if not isinstance(field.get("label"), str) or not field["label"]:
                fail(f"{service_id}.{name}: `label` is required")
            if "secret" in field and not isinstance(field["secret"], bool):
                fail(f"{service_id}.{name}: `secret` is a boolean")
            clean = {"name": name, "label": field["label"], "secret": field.get("secret", True)}
            for key in ("placeholder", "hint"):
                if isinstance(field.get(key), str) and field[key]:
                    clean[key] = field[key]
            clean_fields.append(clean)
        entry: dict = {"title": spec["title"], "fields": clean_fields}
        for key in ("description", "help"):
            if isinstance(spec.get(key), str) and spec[key]:
                entry[key] = spec[key]
        if spec.get("optional") is True:
            entry["optional"] = True
        hosts = spec.get("hosts")
        if hosts is not None:
            if not isinstance(hosts, list) or not all(isinstance(h, str) and HOST.match(h) for h in hosts):
                fail(f"{service_id}: `hosts` must be lowercase host names (host or host:port)")
            entry["hosts"] = hosts
        hosts_from = spec.get("hostsFrom")
        if hosts_from is not None:
            if hosts_from not in names:
                fail(f"{service_id}: `hostsFrom` must name one of its fields")
            if next(f for f in clean_fields if f["name"] == hosts_from)["secret"]:
                fail(f"{service_id}: `hostsFrom` must name a field that is not secret")
            entry["hostsFrom"] = hosts_from
        out[service_id] = entry
    return dict(sorted(out.items()))


def render(services: dict) -> str:
    body = json.dumps(services, indent=2, ensure_ascii=False)
    return (
        "// Generated by frameos/tools/generate_services.py from repo/services.json — do not edit.\n"
        "// docs/service-keys.md is the contract.\n\n"
        "export type RegistryServiceField = {\n"
        "  name: string\n  label: string\n  secret: boolean\n  placeholder?: string\n  hint?: string\n}\n\n"
        "export type RegistryService = {\n"
        "  title: string\n  description?: string\n  help?: string\n  optional?: boolean\n"
        "  fields: RegistryServiceField[]\n  hosts?: string[]\n  hostsFrom?: string\n}\n\n"
        f"export const SERVICE_REGISTRY: Readonly<Record<string, RegistryService>> = {body}\n\n"
        f"export const PLANE_SETTINGS_GROUPS: readonly string[] = {json.dumps(sorted(PLANE_GROUPS))}\n"
    )


def main() -> int:
    text = render(load())
    if "--check" in sys.argv[1:]:
        if not OUTPUT.exists() or OUTPUT.read_text() != text:
            print(f"{OUTPUT.relative_to(REPO)} is stale: run python3 frameos/tools/generate_services.py", file=sys.stderr)
            return 1
        return 0
    OUTPUT.write_text(text)
    print(f"wrote {OUTPUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
