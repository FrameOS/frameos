from __future__ import annotations

import shlex
import uuid

from arq import ArqRedis as Redis
from sqlalchemy.orm import Session

from app.models.frame import Frame
from app.utils.remote_exec import run_commands, upload_file


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
        f"chown -R {user_quoted}:{user_quoted} \"$home_dir/.ssh\"; "
        f"rm -f {temp_quoted} {known_quoted} \"$merged_keys\""
    )
    await run_commands(db, redis, frame, [command], log_output=False)
