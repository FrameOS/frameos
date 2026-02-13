from __future__ import annotations

import shlex
import uuid

from typing import Any

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.utils.remote_exec import run_commands, upload_file
from app.utils.ssh_key_utils import ssh_key_map


def resolve_authorized_keys_update(
    ssh_keys: list[str],
    current_keys: list[str] | None,
    settings: dict[str, Any],
) -> tuple[list[str], list[str], list[str]]:
    new_keys = list(dict.fromkeys([key for key in ssh_keys if key]))
    if not new_keys:
        raise ValueError("At least one SSH key must remain installed.")

    key_map = ssh_key_map(settings)
    new_keys = [key for key in new_keys if key in key_map]
    if not new_keys:
        raise ValueError("At least one SSH key must remain installed.")

    current_keys = current_keys or []
    current_known_keys = [key for key in current_keys if key in key_map]
    if current_known_keys and not set(current_known_keys).intersection(new_keys):
        raise ValueError("At least one previously installed SSH key must remain.")

    public_keys = [
        key_map[key].get("public")
        for key in new_keys
        if key_map[key].get("public") and isinstance(key_map[key].get("public"), str)
    ]
    if not public_keys:
        raise ValueError("No public SSH keys available to install.")

    known_public_keys = [
        key.get("public")
        for key in key_map.values()
        if key.get("public") and isinstance(key.get("public"), str)
    ]

    return new_keys, public_keys, known_public_keys


async def _install_authorized_keys(
    db: Session,
    redis: Redis,
    frame: Frame,
    public_keys: list[str],
    known_public_keys: list[str],
) -> None:
    unique_public_keys = list(dict.fromkeys([key.strip() for key in public_keys if key.strip()]))
    unique_known_keys = list(dict.fromkeys([key.strip() for key in known_public_keys if key.strip()]))
    key_blob = "\n".join(unique_public_keys)
    if not unique_public_keys:
        raise ValueError("No valid SSH keys supplied.")

    temp_path = f"/tmp/frameos_authorized_keys_{uuid.uuid4().hex}"
    known_path = f"/tmp/frameos_known_authorized_keys_{uuid.uuid4().hex}"
    await upload_file(db, redis, frame, temp_path, f"{key_blob}\n".encode())
    await upload_file(db, redis, frame, known_path, "\n".join(unique_known_keys).encode())

    user = frame.ssh_user or "frame"
    user_quoted = shlex.quote(user)
    temp_quoted = shlex.quote(temp_path)
    known_quoted = shlex.quote(known_path)
    fallback_home = shlex.quote(f"/home/{user}")

    command = (
        "set -e; "
        f"home_dir=$(getent passwd {user_quoted} | cut -d: -f6 || true); "
        f"if [ -z \"$home_dir\" ]; then home_dir={fallback_home}; fi; "
        f"group_name=$(id -gn {user_quoted} 2>/dev/null || true); "
        "install -d -m 700 \"$home_dir/.ssh\"; "
        "authorized_keys=\"$home_dir/.ssh/authorized_keys\"; "
        "touch \"$authorized_keys\"; "
        "merged_keys=$(mktemp); "
        "awk 'FNR==NR { if (NF>=2) known[$1\" \"$2]=1; next } "
        "{ "
        "if ($0 ~ /^[[:space:]]*#/ || $0 ~ /^[[:space:]]*$/) { print; next } "
        "if (($1\" \"$2) in known) { next } "
        "if (NF>=3 && ($2\" \"$3) in known) { next } "
        "print "
        "}' "
        f"{known_quoted} \"$authorized_keys\" > \"$merged_keys\"; "
        f"cat {temp_quoted} >> \"$merged_keys\"; "
        "install -m 600 \"$merged_keys\" \"$authorized_keys\"; "
        f"if [ -n \"$group_name\" ]; then chown -R {user_quoted}:\"$group_name\" \"$home_dir/.ssh\"; "
        f"else chown -R {user_quoted} \"$home_dir/.ssh\"; fi; "
        f"rm -f {temp_quoted} {known_quoted} \"$merged_keys\""
    )
    await run_commands(db, redis, frame, [command], log_output=False)
