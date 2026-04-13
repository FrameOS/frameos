from __future__ import annotations

import os
import re
import shlex
import tarfile
import tempfile
from typing import Any

from app.tasks._frame_deployer import FrameDeployer
from app.utils.remote_exec import upload_file

icon = "🔷"

QUICKJS_ARCHIVE_URL = "https://archive.frameos.net/source/vendor/quickjs-{version}.tar.xz"
DEFAULT_QUICKJS_VERSION = "2025-04-26"
DEFAULT_QUICKJS_SHA256 = "2f20074c25166ef6f781f381c50d57b502cb85d470d639abccebbef7954c83bf"

LGPIO_ARCHIVE_URL = "https://archive.frameos.net/source/vendor/lgpio-{version}.tar.gz"
DEFAULT_LGPIO_VERSION = "v0.2.2"
DEFAULT_LGPIO_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

APT_PACKAGE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+.-]*$")


def sanitize_apt_package_name(pkg: str) -> str:
    normalized = pkg.strip()
    if not normalized:
        raise ValueError("Invalid apt package name: empty value")
    if not APT_PACKAGE_NAME_PATTERN.fullmatch(normalized):
        raise ValueError(f"Invalid apt package name: {pkg!r}")
    return normalized


async def install_if_necessary(
    deployer: FrameDeployer,
    pkg: str,
    raise_on_error: bool = True,
    run_after_install: str | None = None,
) -> int:
    try:
        sanitized_pkg = sanitize_apt_package_name(pkg)
    except ValueError as exc:
        await deployer.log("stderr", f"- {exc}")
        if raise_on_error:
            raise
        return 1

    package_installed = (
        await deployer.exec_command(
            f"dpkg-query -W -f='${{Status}}' {shlex.quote(sanitized_pkg)} 2>/dev/null | grep -q '^install ok installed$'",
            raise_on_error=False,
            log_command=False,
            log_output=False,
        )
        == 0
    )
    if package_installed:
        return 0

    output: list[str] = []
    response = await deployer.exec_command(
        f"sudo apt-get install -y {shlex.quote(sanitized_pkg)}",
        raise_on_error=False,
        output=output,
    )
    if response != 0:
        combined_output = "".join(output)
        search_strings = [
            "run apt-get update",
            "404 Not Found",
            "Failed to fetch",
            "failed to fetch",
            "Unable to fetch some archives",
        ]
        if any(s in combined_output for s in search_strings):
            await deployer.log("stdout", f"{icon} Installing {sanitized_pkg} failed. Trying to update apt.")
            response = await deployer.exec_command(
                "sudo apt-get update && sudo apt-get install -y " + shlex.quote(sanitized_pkg),
                raise_on_error=raise_on_error,
            )
            if response != 0:
                await deployer.log("stdout", f"{icon} Installing {sanitized_pkg} failed again.")
    elif run_after_install:
        response = await deployer.exec_command(run_after_install, raise_on_error=raise_on_error)
    return response


async def upload_directory_tree(
    deployer: FrameDeployer, local_dir: str, remote_dir: str, label: str, build_id: str
) -> None:
    normalized_local = os.path.abspath(local_dir)
    if not os.path.isdir(normalized_local):
        await deployer.log("stdout", f"{icon} Skipping {label}; nothing to upload")
        return

    fd, tmp_path = tempfile.mkstemp(suffix=".tar.gz")
    os.close(fd)
    arcname = (
        os.path.basename(remote_dir.rstrip("/"))
        or os.path.basename(normalized_local.rstrip("/"))
        or "payload"
    )
    try:
        with tarfile.open(tmp_path, "w:gz") as archive:
            archive.add(normalized_local, arcname=arcname)
        with open(tmp_path, "rb") as fh:
            data = fh.read()
    finally:
        os.remove(tmp_path)

    remote_archive = f"/tmp/{arcname}_{build_id}.tar.gz"
    await upload_file(deployer.db, deployer.redis, deployer.frame, remote_archive, data)
    parent_dir = os.path.dirname(remote_dir.rstrip("/")) or "/"
    await deployer.exec_command(f"mkdir -p {shlex.quote(parent_dir)}")
    await deployer.exec_command(f"rm -rf {shlex.quote(remote_dir)}", raise_on_error=False)
    await deployer.exec_command(
        f"tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(parent_dir)} && rm {shlex.quote(remote_archive)}"
    )


async def upload_binary(deployer: FrameDeployer, local_path: str, remote_path: str) -> None:
    normalized_local = os.path.abspath(local_path)
    if not os.path.isfile(normalized_local):
        raise FileNotFoundError(f"frameos binary missing at {normalized_local}")
    with open(normalized_local, "rb") as fh:
        data = fh.read()
    await upload_file(deployer.db, deployer.redis, deployer.frame, remote_path, data)
    await deployer.exec_command(f"chmod +x {shlex.quote(remote_path)}", raise_on_error=False)


async def sync_vendor_dir(
    deployer: FrameDeployer,
    local_dir: str,
    vendor_folder: str,
    label: str,
    cross_compiled: bool,
    build_id: str,
) -> None:
    remote_dir = f"/srv/frameos/vendor/{vendor_folder}"
    if cross_compiled:
        await upload_directory_tree(deployer, local_dir, remote_dir, label, build_id)
    else:
        await deployer.exec_command(
            f"mkdir -p /srv/frameos/vendor && "
            f"cp -r /srv/frameos/build/build_{build_id}/vendor/{vendor_folder} /srv/frameos/vendor/"
        )


async def ensure_ntp_installed(deployer: FrameDeployer) -> None:
    for candidate in ("ntp", "ntpsec"):
        status = await deployer.exec_command(
            f"dpkg-query -W -f='${{Status}}' {shlex.quote(candidate)} 2>/dev/null | grep -q '^install ok installed$'",
            raise_on_error=False,
            log_command=False,
            log_output=False,
        )
        if status == 0:
            return

    for candidate in ("ntp", "ntpsec"):
        response = await install_if_necessary(deployer, candidate, raise_on_error=False)
        if response == 0:
            return

    raise Exception("Unable to install ntp or ntpsec via apt")


async def ensure_lgpio(
    deployer: FrameDeployer,
    drivers: dict[str, Any],
    prebuilt_entry: Any,
    already_installed: bool,
) -> None:
    if not (drivers.get("waveshare") or drivers.get("gpioButton")) or already_installed:
        return

    if await install_if_necessary(deployer, "liblgpio-dev", raise_on_error=False) == 0:
        return

    await deployer.log("stdout", "--> Could not find liblgpio-dev. Trying archived builds.")
    lgpio_installed = False
    if prebuilt_entry:
        lgpio_prebuilt_url = prebuilt_entry.url_for("lgpio")
        lgpio_version = prebuilt_entry.version_for("lgpio", DEFAULT_LGPIO_VERSION)
        lgpio_md5sum = prebuilt_entry.md5_for("lgpio")
    else:
        lgpio_prebuilt_url = None
        lgpio_version = DEFAULT_LGPIO_VERSION
        lgpio_md5sum = None

    if lgpio_prebuilt_url:
        try:
            await deployer.log("stdout", f"--> Installing lgpio {lgpio_version} from archive")
            command = (
                "rm -rf /tmp/lgpio-prebuilt && "
                "mkdir -p /tmp/lgpio-prebuilt && "
                f"wget -q -O /tmp/lgpio-prebuilt/lgpio.tar.gz {shlex.quote(lgpio_prebuilt_url)} && "
            )
            if lgpio_md5sum:
                command += f"echo '{lgpio_md5sum}  /tmp/lgpio-prebuilt/lgpio.tar.gz' | md5sum -c - && "
            command += (
                "tar -xzf /tmp/lgpio-prebuilt/lgpio.tar.gz -C /tmp/lgpio-prebuilt && "
                "sudo mkdir -p /usr/local/include /usr/local/lib && "
                "sudo cp -r /tmp/lgpio-prebuilt/include/. /usr/local/include/ && "
                "sudo cp -r /tmp/lgpio-prebuilt/lib/. /usr/local/lib/ && "
                "sudo ldconfig && "
                "rm -rf /tmp/lgpio-prebuilt"
            )
            await deployer.exec_command(command)
            lgpio_installed = True
        except Exception as exc:
            await deployer.log("stdout", f"--> Failed to install prebuilt lgpio ({exc}). Falling back to source build.")

    if lgpio_installed:
        return

    await deployer.log("stdout", "--> Installing lgpio from source.")
    await install_if_necessary(deployer, "python3-setuptools")
    lgpio_tar = f"{DEFAULT_LGPIO_VERSION}.tar.gz"
    lgpio_source_dir = f"lg-{DEFAULT_LGPIO_VERSION.lstrip('v')}"
    command = (
        "if [ ! -f /usr/local/include/lgpio.h ]; then "
        "  rm -rf /tmp/lgpio-install && "
        "  mkdir -p /tmp/lgpio-install && "
        "  cd /tmp/lgpio-install && "
        f"  wget -q -O {lgpio_tar} {LGPIO_ARCHIVE_URL.format(version=DEFAULT_LGPIO_VERSION)} && "
        f"  echo '{DEFAULT_LGPIO_SHA256}  {lgpio_tar}' | sha256sum -c - && "
        f"  tar -xzf {lgpio_tar} && "
        f"  cd {lgpio_source_dir} && "
        "  make && "
        "  sudo make install && "
        "  sudo rm -rf /tmp/lgpio-install; "
        "fi"
    )
    await deployer.exec_command(command)


async def ensure_quickjs(
    deployer: FrameDeployer,
    *,
    prebuilt_entry: Any,
    build_id: str,
    cross_compiled: bool,
    quickjs_installed: bool,
    quickjs_dirname: str,
) -> str | None:
    if cross_compiled:
        return None

    if quickjs_installed:
        return quickjs_dirname

    quickjs_vendor_dir = f"/srv/frameos/vendor/quickjs/{quickjs_dirname}"
    quickjs_prebuilt_url = prebuilt_entry.url_for("quickjs") if prebuilt_entry else None
    quickjs_md5sum = prebuilt_entry.md5_for("quickjs") if prebuilt_entry else None

    await deployer.exec_command(
        "if [ ! -d /srv/frameos/ ]; then "
        "  sudo mkdir -p /srv/frameos/ && sudo chown $(whoami):$(whoami) /srv/frameos/; "
        "fi"
    )

    if quickjs_prebuilt_url:
        await deployer.log("stdout", f"{icon} Downloading QuickJS prebuilt archive ({quickjs_dirname})")
        quickjs_archive = f"/tmp/quickjs-prebuilt-{build_id}.tar.gz"
        try:
            command = (
                "mkdir -p /srv/frameos/vendor/quickjs/ && "
                f"wget -q -O {quickjs_archive} {shlex.quote(quickjs_prebuilt_url)} && "
            )
            if quickjs_md5sum:
                command += f"echo '{quickjs_md5sum}  {quickjs_archive}' | md5sum -c - && "
            command += f"tar -xzf {quickjs_archive} -C /srv/frameos/vendor/quickjs/ && rm {quickjs_archive}"
            await deployer.exec_command(command)
            await deployer.exec_command(
                "bash -c '"
                f"QUICKJS_DIR={shlex.quote(quickjs_vendor_dir)}; "
                "if [ -d \"$QUICKJS_DIR/include/quickjs\" ]; then "
                "  if [ -f \"$QUICKJS_DIR/include/quickjs/quickjs.h\" ] && [ ! -f \"$QUICKJS_DIR/quickjs.h\" ]; then "
                "    cp \"$QUICKJS_DIR/include/quickjs/quickjs.h\" \"$QUICKJS_DIR/quickjs.h\"; "
                "  fi; "
                "  if [ -f \"$QUICKJS_DIR/include/quickjs/quickjs-libc.h\" ] && [ ! -f \"$QUICKJS_DIR/quickjs-libc.h\" ]; then "
                "    cp \"$QUICKJS_DIR/include/quickjs/quickjs-libc.h\" \"$QUICKJS_DIR/quickjs-libc.h\"; "
                "  fi; "
                "fi; "
                "if [ -f \"$QUICKJS_DIR/lib/libquickjs.a\" ] && [ ! -f \"$QUICKJS_DIR/libquickjs.a\" ]; then "
                "  cp \"$QUICKJS_DIR/lib/libquickjs.a\" \"$QUICKJS_DIR/libquickjs.a\"; "
                "fi'"
            )
            return quickjs_dirname
        except Exception as exc:
            await deployer.log("stderr", f"{icon} Failed to unpack QuickJS prebuilt: {exc}")

    await deployer.log("stdout", "- Installing dependencies for QuickJS")
    for package_name in (
        "libunistring-dev",
        "libtool",
        "cmake",
        "pkg-config",
        "libatomic-ops-dev",
        "libicu-dev",
        "zlib1g-dev",
    ):
        await install_if_necessary(deployer, package_name)

    await deployer.exec_command("cd /srv/frameos/vendor && rm -rf quickjs")
    await deployer.log("stdout", f"{icon} Downloading QuickJS {quickjs_dirname.removeprefix('quickjs-')}")
    await deployer.exec_command(
        "cd /srv/frameos/vendor && "
        f"wget -q {QUICKJS_ARCHIVE_URL.format(version=quickjs_dirname.removeprefix('quickjs-'))} && "
        f"tar -xf {quickjs_dirname}.tar.gz && "
        f"rm {quickjs_dirname}.tar.gz && "
        f"mv quickjs {quickjs_dirname}"
    )
    await deployer.log("stdout", "- Building libquickjs.a")
    await deployer.exec_command(f"cd /srv/frameos/vendor/{quickjs_dirname} && make libquickjs.a")
    await deployer.exec_command(
        f"cd /srv/frameos/vendor/{quickjs_dirname} && echo -n '{quickjs_dirname.removeprefix('quickjs-')}' > VERSION"
    )
    return quickjs_dirname
