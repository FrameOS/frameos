"""
The `frameos` runtime user on a Buildroot root partition.

Self-contained on purpose: buildroot_image.py imports the constants from
here, and patch-root.sh embeds this whole file into an inline `python3 -`
heredoc that runs inside the composer container (where the backend package
is not importable) to append the user to the base image's /etc/{passwd,
group,shadow} through debugfs.

Keep in step with frameos/src/frameos/buildroot_privileges.nim, which
creates the same user on a frame upgraded from a root-only release, and
with docs/buildroot-privileges.md §3.
"""

from __future__ import annotations

import sys
from pathlib import Path

FRAMEOS_SERVICE_USER = "frameos"
# Fixed, not allocated: the composed FRAMEOS partition, the line stamped into
# /etc/passwd and the user `frameos setup` creates on an upgraded frame must
# all agree. 990 sits in Buildroot's system range (101..999), far above the
# handful of package users it allocates from 100 upwards (dbus, systemd-*).
FRAMEOS_UID = 990
FRAMEOS_GID = 990
FRAMEOS_PASSWD_LINE = f"{FRAMEOS_SERVICE_USER}:x:{FRAMEOS_UID}:{FRAMEOS_GID}:FrameOS runtime:/srv/frameos:/bin/false"
FRAMEOS_GROUP_LINE = f"{FRAMEOS_SERVICE_USER}:x:{FRAMEOS_GID}:"
# Locked, like Buildroot's own system users (`daemon:*:::::::`).
FRAMEOS_SHADOW_LINE = f"{FRAMEOS_SERVICE_USER}:*:::::::"


def _has_name(content: str, user: str) -> bool:
    return any(line.split(":", 1)[0] == user for line in content.splitlines())


def _id_taken(content: str, wanted: int, user: str) -> bool:
    for line in content.splitlines():
        fields = line.split(":")
        if len(fields) > 2 and fields[0] != user and fields[2] == str(wanted):
            return True
    return False


def _append(content: str, line: str) -> str:
    if content and not content.endswith("\n"):
        content += "\n"
    return content + line + "\n"


def merge_frameos_user(passwd: str, group: str, shadow: str) -> tuple[str, str, str, list[str]]:
    """
    Appends the user/group lines unless present. Returns the three files and
    the names of those that changed. Raises when the fixed uid or gid belongs
    to someone else: a duplicate id would be worse than a failed compose.
    """
    user = FRAMEOS_SERVICE_USER
    changed: list[str] = []
    if not _has_name(group, user):
        if _id_taken(group, FRAMEOS_GID, user):
            raise RuntimeError(f"gid {FRAMEOS_GID} is taken by another group")
        group = _append(group, FRAMEOS_GROUP_LINE)
        changed.append("group")
    if not _has_name(passwd, user):
        if _id_taken(passwd, FRAMEOS_UID, user):
            raise RuntimeError(f"uid {FRAMEOS_UID} is taken by another user")
        passwd = _append(passwd, FRAMEOS_PASSWD_LINE)
        changed.append("passwd")
    if shadow and not _has_name(shadow, user):
        shadow = _append(shadow, FRAMEOS_SHADOW_LINE)
        changed.append("shadow")
    return passwd, group, shadow, changed


def render_debugfs_user_commands(etc_dir: Path, changed: list[str]) -> str:
    """debugfs commands that replace the changed files with `<name>.new` from etc_dir."""
    lines: list[str] = []
    for name in changed:
        mode = "0100600" if name == "shadow" else "0100644"
        lines.append(f"rm /etc/{name}")
        lines.append(f"write {etc_dir / (name + '.new')} /etc/{name}")
        lines.append(f"sif /etc/{name} mode {mode}")
    return "".join(line + "\n" for line in lines)


def main(argv: list[str]) -> int:
    """
    usage: buildroot_user_merge.py <etc-dir> <debugfs-cmds-file>

    <etc-dir> holds passwd/group/shadow as read from the root partition;
    the rewritten copies land beside them as *.new and the debugfs commands
    to install them are appended to <debugfs-cmds-file>.
    """
    etc_dir = Path(argv[1])
    cmds = Path(argv[2])
    files = {name: (etc_dir / name).read_text(encoding="utf-8") if (etc_dir / name).exists() else "" for name in ("passwd", "group", "shadow")}
    passwd, group, shadow, changed = merge_frameos_user(files["passwd"], files["group"], files["shadow"])
    for name, content in (("passwd", passwd), ("group", group), ("shadow", shadow)):
        (etc_dir / f"{name}.new").write_text(content, encoding="utf-8")
    with cmds.open("a", encoding="utf-8") as out:
        out.write(render_debugfs_user_commands(etc_dir, changed))
    print(f"frameos user: {'added to ' + ', '.join(changed) if changed else 'already present'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
