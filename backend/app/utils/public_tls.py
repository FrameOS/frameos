"""TLS on the port frames talk to (8989 in Docker and on a Home Assistant
add-on): which certificate uvicorn serves it with, if any.

Two sources, the first that answers wins:

- ``FRAMEOS_SSL_CERTFILE`` / ``FRAMEOS_SSL_KEYFILE`` in the environment — a
  plain Docker container (or a developer) naming the files itself.
- A Home Assistant add-on's options (``/data/options.json``): ``ssl`` on,
  ``certfile`` and ``keyfile`` naming files in Home Assistant's ``/ssl``
  folder — the convention of the Mosquitto, Node-RED and Zigbee2MQTT add-ons,
  so the Let's Encrypt / DuckDNS add-ons' ``fullchain.pem`` + ``privkey.pem``
  work unchanged.

``docker-entrypoint.sh`` runs this module and ``eval``s what it prints: the
two file paths and ``FRAMEOS_PUBLIC_SCHEME=https`` (so the backend can tell
the UI that a new frame's server address starts with ``https://``). A
configured certificate that cannot be read is a refusal to start, never a
silent fall-back to plain HTTP: a frame already told to use https would just
stop reporting, and the add-on log is where the owner looks first.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from dataclasses import dataclass
from typing import Mapping, Optional

ADDON_OPTIONS_PATH = "/data/options.json"
ADDON_SSL_DIR = "/ssl"
DEFAULT_ADDON_CERTFILE = "fullchain.pem"
DEFAULT_ADDON_KEYFILE = "privkey.pem"


@dataclass(frozen=True)
class PublicTls:
    certfile: str
    keyfile: str
    source: str  # "env" | "addon"


class PublicTlsError(Exception):
    pass


def _addon_ssl_path(name: object, default: str, option: str) -> str:
    """``certfile: fullchain.pem`` → ``/ssl/fullchain.pem``. A name that
    climbs out of /ssl (``../data/x``) or is absolute is refused: the option
    names a file in the SSL folder, nothing else."""
    text = str(name or "").strip() or default
    if os.path.isabs(text):
        raise PublicTlsError(
            f"Add-on option {option} must name a file inside {ADDON_SSL_DIR} (for example {default}), not {text!r}."
        )
    full = os.path.normpath(os.path.join(ADDON_SSL_DIR, text))
    if full != ADDON_SSL_DIR and not full.startswith(ADDON_SSL_DIR + os.sep):
        raise PublicTlsError(f"Add-on option {option} must stay inside {ADDON_SSL_DIR}, not {text!r}.")
    if full == ADDON_SSL_DIR:
        raise PublicTlsError(f"Add-on option {option} must name a file inside {ADDON_SSL_DIR}, not {text!r}.")
    return full


def _require_readable(path: str, what: str, hint: str) -> None:
    if not os.path.isfile(path):
        raise PublicTlsError(f"{what} {path} does not exist. {hint}")
    if not os.access(path, os.R_OK):
        raise PublicTlsError(f"{what} {path} is not readable. {hint}")


def resolve_public_tls(
    env: Mapping[str, str],
    options_path: str = ADDON_OPTIONS_PATH,
) -> Optional[PublicTls]:
    """The certificate to serve the public port with, or None for plain
    HTTP. Raises PublicTlsError when TLS is asked for but cannot be set up."""
    env_cert = (env.get("FRAMEOS_SSL_CERTFILE") or "").strip()
    env_key = (env.get("FRAMEOS_SSL_KEYFILE") or "").strip()
    if env_cert or env_key:
        if not (env_cert and env_key):
            raise PublicTlsError("Set both FRAMEOS_SSL_CERTFILE and FRAMEOS_SSL_KEYFILE, or neither.")
        hint = "Mount the certificate into the container or unset FRAMEOS_SSL_CERTFILE / FRAMEOS_SSL_KEYFILE."
        _require_readable(env_cert, "FRAMEOS_SSL_CERTFILE", hint)
        _require_readable(env_key, "FRAMEOS_SSL_KEYFILE", hint)
        return PublicTls(certfile=env_cert, keyfile=env_key, source="env")

    if not env.get("HASSIO_TOKEN") or not os.path.isfile(options_path):
        return None
    try:
        with open(options_path, "r", encoding="utf-8") as handle:
            options = json.load(handle)
    except (OSError, ValueError) as error:
        raise PublicTlsError(f"Could not read the add-on options at {options_path}: {error}") from error
    if not isinstance(options, dict) or not options.get("ssl"):
        return None
    certfile = _addon_ssl_path(options.get("certfile"), DEFAULT_ADDON_CERTFILE, "certfile")
    keyfile = _addon_ssl_path(options.get("keyfile"), DEFAULT_ADDON_KEYFILE, "keyfile")
    hint = (
        "Put the certificate in Home Assistant's /ssl folder (the Let's Encrypt, DuckDNS or NGINX add-ons "
        "write one there), point the add-on's certfile / keyfile options at it, or turn the ssl option off."
    )
    _require_readable(certfile, "The add-on's certfile", hint)
    _require_readable(keyfile, "The add-on's keyfile", hint)
    return PublicTls(certfile=certfile, keyfile=keyfile, source="addon")


def shell_exports(tls: Optional[PublicTls]) -> str:
    """What the entrypoint evals: nothing for plain HTTP."""
    if tls is None:
        return ""
    return "\n".join(
        [
            f"export FRAMEOS_SSL_CERTFILE={shlex.quote(tls.certfile)}",
            f"export FRAMEOS_SSL_KEYFILE={shlex.quote(tls.keyfile)}",
            "export FRAMEOS_PUBLIC_SCHEME=https",
        ]
    )


def main(argv: Optional[list[str]] = None) -> int:
    try:
        tls = resolve_public_tls(os.environ)
    except PublicTlsError as error:
        print(f"🔒 TLS on the frames' port is configured but cannot start: {error}", file=sys.stderr)
        return 1
    if tls is not None:
        where = "the add-on's ssl option" if tls.source == "addon" else "FRAMEOS_SSL_CERTFILE"
        print(f"🔒 Serving the frames' port over HTTPS ({where}): {tls.certfile}", file=sys.stderr)
    print(shell_exports(tls))
    return 0


if __name__ == "__main__":
    sys.exit(main())
