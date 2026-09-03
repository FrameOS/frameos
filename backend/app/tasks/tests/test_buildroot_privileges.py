"""
Privilege separation on Buildroot images (docs/buildroot-privileges.md §3):
frameos.service runs as the `frameos` user, root work goes through the
privileged door. These pin the image-side half: the rendered unit, the
users/ownership stamped into the partitions, and the door's units.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.tasks import buildroot_user_merge
from app.tasks.buildroot_image import (
    BUILDROOT_DEVICE_UDEV_RULES_NAME,
    BUILDROOT_FRAMEOS_GID,
    BUILDROOT_FRAMEOS_UID,
    BUILDROOT_PRIVILEGED_PATH_UNIT_NAME,
    BUILDROOT_PRIVILEGED_SERVICE_UNIT_NAME,
    BUILDROOT_USERS_TABLE_CONTENT,
    BUILDROOT_USERS_TABLE_WORK_PATH,
    PARTITION_POST_BUILD_SCRIPT,
    BuildrootImageBuilder,
    buildroot_frameos_service_user_for_platform,
    render_buildroot_frameos_service,
    render_buildroot_user_merge_shell,
    render_frameos_partition_ownership_commands,
    stage_buildroot_frameos_service,
    stage_buildroot_privileged_units,
)
from app.tasks.buildroot_platforms import RASPBERRY_PI_32, RASPBERRY_PI_5, RASPBERRY_PI_64

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_unprivileged_unit_carries_the_hardening_block():
    service = render_buildroot_frameos_service(True, user="frameos")
    assert "User=frameos\n" in service
    assert "Group=frameos\n" in service
    assert "NoNewPrivileges=yes\n" in service
    assert "ProtectSystem=strict\n" in service
    assert "ReadWritePaths=/srv/frameos /srv/assets\n" in service
    assert "CapabilityBoundingSet=CAP_SYS_TTY_CONFIG\n" in service
    assert "ExecStartPre=+/bin/sh -c 'for n in /dev/gpiochip*" in service
    assert "chgrp frameos" in service
    assert "Wants=NetworkManager.service\nAfter=network.target NetworkManager.service\n" in service
    assert "Environment=FRAMEOS_HOME=/srv/frameos/current\n" in service
    assert "SupplementaryGroups=video input\n" in service
    assert "SupplementaryGroups=video input tty" not in service
    assert "Environment=LD_LIBRARY_PATH=/srv/frameos/current/drivers:/usr/lib:/usr/local/lib\n" in service
    assert "__FRAMEOS_UNPRIVILEGED_SERVICE__" not in service
    assert "%I" not in service
    assert service.endswith("[Install]\nWantedBy=multi-user.target\n")


def test_root_unit_has_no_hardening_and_no_pre_step():
    # NoNewPrivileges plus an empty bounding set would strip root of the
    # capabilities its own setup code needs.
    service = render_buildroot_frameos_service(False, user="root")
    assert "User=root\n" in service
    assert "NoNewPrivileges" not in service
    assert "ExecStartPre" not in service
    assert "CapabilityBoundingSet" not in service
    assert "NetworkManager" not in service
    assert "After=network.target\n" in service
    assert "/srv/frameos/runtime/frameos-last-exit" in service


def test_unit_template_files_are_the_ones_the_device_embeds():
    # frameos/src/frameos/buildroot_privileges.nim staticReads these same
    # files; a rename here silently breaks the byte-identical rendering an
    # upgrade relies on to leave the read-only rootfs alone.
    for name in (
        "frameos.service",
        "frameos.service.unprivileged",
        BUILDROOT_PRIVILEGED_PATH_UNIT_NAME,
        BUILDROOT_PRIVILEGED_SERVICE_UNIT_NAME,
        BUILDROOT_DEVICE_UDEV_RULES_NAME,
    ):
        assert (REPO_ROOT / "frameos" / name).is_file(), name
    nim = (REPO_ROOT / "frameos" / "src" / "frameos" / "buildroot_privileges.nim").read_text(encoding="utf-8")
    for name in ("frameos.service", "frameos.service.unprivileged", BUILDROOT_PRIVILEGED_PATH_UNIT_NAME,
                 BUILDROOT_PRIVILEGED_SERVICE_UNIT_NAME, BUILDROOT_DEVICE_UDEV_RULES_NAME):
        assert f'staticRead("../../{name}")' in nim, name
    assert f"BuildrootServiceUid* = {BUILDROOT_FRAMEOS_UID}" in nim
    assert f"BuildrootServiceGid* = {BUILDROOT_FRAMEOS_GID}" in nim


def test_service_user_per_platform():
    assert buildroot_frameos_service_user_for_platform(RASPBERRY_PI_64, generic_image=True) == "frameos"
    assert buildroot_frameos_service_user_for_platform(RASPBERRY_PI_5, generic_image=True) == "frameos"
    # wpa_supplicant/hostapd orchestration in the runtime is a root daemon.
    assert buildroot_frameos_service_user_for_platform(RASPBERRY_PI_32, generic_image=True) == "root"
    # A self-hosted backend deploys as root into these images.
    assert buildroot_frameos_service_user_for_platform(RASPBERRY_PI_64, generic_image=False) == "root"
    builder = BuildrootImageBuilder(db=None, redis=None, frame=SimpleNamespace(id=1, buildroot={}))
    assert builder.frameos_service_user == "root"


def test_privileged_units_are_staged_and_enabled(tmp_path):
    stage_buildroot_privileged_units(tmp_path)
    systemd = tmp_path / "etc" / "systemd" / "system"
    path_unit = (systemd / BUILDROOT_PRIVILEGED_PATH_UNIT_NAME).read_text(encoding="utf-8")
    service_unit = (systemd / BUILDROOT_PRIVILEGED_SERVICE_UNIT_NAME).read_text(encoding="utf-8")
    assert "PathExistsGlob=/srv/frameos/privileged/queue/*.json" in path_unit
    assert f"Unit={BUILDROOT_PRIVILEGED_SERVICE_UNIT_NAME}" in path_unit
    assert "ExecStart=/srv/frameos/current/frameos privileged-worker" in service_unit
    assert "User=root" in service_unit
    assert "Type=oneshot" in service_unit
    assert "UMask=0027" in service_unit
    assert "/srv/frameos/current/scenes" not in service_unit
    link = systemd / "multi-user.target.wants" / BUILDROOT_PRIVILEGED_PATH_UNIT_NAME
    assert link.is_symlink() and link.readlink().as_posix() == f"../{BUILDROOT_PRIVILEGED_PATH_UNIT_NAME}"
    rules = (tmp_path / "etc" / "udev" / "rules.d" / BUILDROOT_DEVICE_UDEV_RULES_NAME).read_text(encoding="utf-8")
    assert 'SUBSYSTEM=="spidev", GROUP="frameos"' in rules
    assert 'KERNEL=="gpiochip*", GROUP="frameos"' in rules


def test_stage_frameos_service_takes_the_user(tmp_path):
    stage_buildroot_frameos_service(tmp_path, True, user="root")
    assert "User=root" in (tmp_path / "etc" / "systemd" / "system" / "frameos.service").read_text(encoding="utf-8")
    stage_buildroot_frameos_service(tmp_path, True)
    assert "User=frameos" in (tmp_path / "etc" / "systemd" / "system" / "frameos.service").read_text(encoding="utf-8")


def test_users_table_and_partition_skeleton_use_the_fixed_ids():
    assert BUILDROOT_USERS_TABLE_CONTENT == "frameos 990 frameos 990 * /srv/frameos /bin/false - FrameOS runtime\n"
    assert BUILDROOT_USERS_TABLE_WORK_PATH == "/work/frameos-users.txt"
    assert 'chown 0:990 "$frameos_root/$d"' in PARTITION_POST_BUILD_SCRIPT
    assert 'chmod 2750 "$frameos_root/privileged/results"' in PARTITION_POST_BUILD_SCRIPT
    assert 'chmod 1770 "$frameos_root/privileged/queue"' in PARTITION_POST_BUILD_SCRIPT
    assert "__FRAMEOS_UID__" not in PARTITION_POST_BUILD_SCRIPT


def test_partition_ownership_commands(tmp_path):
    root = tmp_path / "frameos"
    release = root / "releases" / "release_x"
    (release / "drivers").mkdir(parents=True)
    (release / "scenes").mkdir()
    (release / "frameos").write_bytes(b"bin")
    (release / "drivers" / "a.so").write_bytes(b"so")
    (release / "frame.json").write_text("{}")
    (release / "frame.json.admin_session_salt").write_text("salt")
    (release / "scenes.json.gz").write_bytes(b"gz")
    (release / "frameos.service").write_text("[Unit]")
    (release / "state").symlink_to("/srv/frameos/state")
    (root / "current").symlink_to("releases/release_x")
    for d in ("state/NetworkManager/system-connections", "state/wpa_supplicant", "logs", "tmp", "runtime",
              "staging", "privileged/queue", "privileged/results"):
        (root / d).mkdir(parents=True)
    (root / "state" / "NetworkManager" / "system-connections" / "wifi.nmconnection").write_text("x")
    (root / "state" / "cloud_link.json").write_text("{}")
    (root / "privileged" / "results" / "old.json").write_text("{}")
    (root / "vendor" / "inkyPython").mkdir(parents=True)
    (root / "vendor" / "inkyPython" / "install.py").write_text("pass\n")

    cmds = render_frameos_partition_ownership_commands(root)
    lines = cmds.splitlines()

    assert "sif /releases/release_x uid 0" in lines
    assert "sif /releases/release_x gid 990" in lines
    assert "sif /releases/release_x mode 041775" in lines
    assert "sif /releases/release_x/frameos uid 0" in lines
    assert "sif /releases/release_x/frameos mode 0100755" in lines
    assert "sif /releases/release_x/frameos.service uid 0" in lines
    assert "sif /releases/release_x/frameos.service mode 0100644" in lines
    assert "sif /releases/release_x/drivers uid 0" in lines
    assert "sif /releases/release_x/drivers/a.so uid 0" in lines
    assert "sif /releases/release_x/scenes uid 0" in lines
    assert "sif /releases/release_x/frame.json uid 990" in lines
    assert "sif /releases/release_x/frame.json mode 0100600" in lines
    assert "sif /releases/release_x/frame.json.admin_session_salt mode 0100600" in lines
    assert "sif /releases/release_x/scenes.json.gz mode 0100644" in lines
    assert "sif /state uid 0" in lines and "sif /state gid 990" in lines and "sif /state mode 041770" in lines
    assert "sif /state/cloud_link.json uid 990" in lines
    assert not any("NetworkManager" in line or "wpa_supplicant" in line for line in lines)
    assert "sif /logs uid 0" in lines and "sif /logs mode 041770" in lines
    assert "sif /privileged uid 0" in lines and "sif /privileged gid 990" in lines and "sif /privileged mode 040755" in lines
    assert "sif /privileged/queue mode 041770" in lines and "sif /privileged/queue uid 0" in lines
    assert "sif /privileged/results uid 0" in lines and "sif /privileged/results mode 042750" in lines
    assert "sif /privileged/results/old.json uid 0" in lines
    assert "sif /privileged/results/old.json mode 0100640" in lines
    assert "sif /vendor uid 0" in lines and "sif /vendor/inkyPython/install.py uid 0" in lines
    assert not any("/current" in line for line in lines), "symlinks are left alone"


def test_user_merge_appends_once_and_refuses_taken_ids():
    passwd = "root:x:0:0:root:/root:/bin/sh\ndbus:x:100:101:DBus:/run/dbus:/bin/false\n"
    group = "root:x:0:\ndbus:x:101:dbus\n"
    shadow = "root::::::::\ndbus:*:::::::\n"
    p, g, sh, changed = buildroot_user_merge.merge_frameos_user(passwd, group, shadow)
    assert changed == ["group", "passwd", "shadow"]
    assert p.endswith("frameos:x:990:990:FrameOS runtime:/srv/frameos:/bin/false\n")
    assert g.endswith("frameos:x:990:\n")
    assert sh.endswith("frameos:*:::::::\n")
    p2, g2, sh2, changed2 = buildroot_user_merge.merge_frameos_user(p, g, sh)
    assert (p2, g2, sh2, changed2) == (p, g, sh, [])
    with pytest.raises(RuntimeError, match="uid 990"):
        buildroot_user_merge.merge_frameos_user(passwd + "other:x:990:990::/:/bin/false\n", group, shadow)
    with pytest.raises(RuntimeError, match="gid 990"):
        buildroot_user_merge.merge_frameos_user(passwd, group + "other:x:990:\n", shadow)
    with pytest.raises(RuntimeError, match="wrong uid/gid"):
        buildroot_user_merge.merge_frameos_user(
            passwd + "frameos:x:991:991::/:/bin/false\n", group + "frameos:x:990:\n", shadow
        )
    with pytest.raises(RuntimeError, match="wrong gid"):
        buildroot_user_merge.merge_frameos_user(
            passwd + buildroot_user_merge.FRAMEOS_PASSWD_LINE + "\n", group + "frameos:x:991:\n", shadow
        )
    p_existing, g_existing, sh_missing, changed_missing = buildroot_user_merge.merge_frameos_user(
        passwd + buildroot_user_merge.FRAMEOS_PASSWD_LINE + "\n",
        group + buildroot_user_merge.FRAMEOS_GROUP_LINE + "\n",
        shadow,
    )
    assert (p_existing, g_existing) == (
        passwd + buildroot_user_merge.FRAMEOS_PASSWD_LINE + "\n",
        group + buildroot_user_merge.FRAMEOS_GROUP_LINE + "\n",
    )
    assert sh_missing.endswith(buildroot_user_merge.FRAMEOS_SHADOW_LINE + "\n")
    assert changed_missing == ["shadow"]
    # Files without a trailing newline (debugfs `cat` output) still get their own line.
    p3, _, _, _ = buildroot_user_merge.merge_frameos_user("root:x:0:0:root:/root:/bin/sh", "root:x:0:", "")
    assert "\nframeos:x:990:" in p3


def test_user_merge_cli_writes_new_files_and_debugfs_commands(tmp_path):
    etc = tmp_path / "etc"
    etc.mkdir()
    (etc / "passwd").write_text("root:x:0:0:root:/root:/bin/sh\n")
    (etc / "group").write_text("root:x:0:\n")
    (etc / "shadow").write_text("root::::::::\n")
    cmds = tmp_path / "cmds"
    cmds.write_text("mkdir /etc\n")
    assert buildroot_user_merge.main(["x", str(etc), str(cmds)]) == 0
    assert "frameos:x:990:990" in (etc / "passwd.new").read_text()
    text = cmds.read_text()
    assert text.startswith("mkdir /etc\n")
    assert f"rm /etc/passwd\nwrite {etc}/passwd.new /etc/passwd\nsif /etc/passwd mode 0100644\n" in text
    assert f"write {etc}/shadow.new /etc/shadow\nsif /etc/shadow mode 0100600\n" in text


def test_user_merge_shell_embeds_the_module_verbatim():
    shell = render_buildroot_user_merge_shell()
    module = (REPO_ROOT / "backend" / "app" / "tasks" / "buildroot_user_merge.py").read_text(encoding="utf-8")
    assert module in shell
    assert 'debugfs -R "cat /etc/$f" "$rootfs"' in shell
    assert "<<'FRAMEOS_USER_MERGE_PY'" in shell and shell.endswith("FRAMEOS_USER_MERGE_PY\n")
    # The merge module must stay importable without the backend package: it
    # runs as `python3 -` inside the composer container.
    assert "from app." not in module and "import app" not in module
