from __future__ import annotations

import importlib.util
import json
import tarfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
INSTALLER_PATH = REPO_ROOT / "frameos" / "tools" / "install_prebuilt_quickjs.py"


def load_installer():
    spec = importlib.util.spec_from_file_location("install_prebuilt_quickjs", INSTALLER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_quickjs_archive(archive_path: Path, tmp_path: Path) -> str:
    payload = tmp_path / "payload" / "quickjs-2026-06-04"
    include = payload / "include" / "quickjs"
    lib = payload / "lib"
    include.mkdir(parents=True)
    lib.mkdir()
    (include / "quickjs.h").write_text("// quickjs\n")
    (include / "quickjs-libc.h").write_text("// quickjs libc\n")
    (include / "cutils.h").write_text("// cutils\n")
    (lib / "libquickjs.a").write_bytes(b"!<arch>\n")

    archive_path.parent.mkdir(parents=True)
    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(payload, arcname=payload.name)

    installer = load_installer()
    return installer.file_md5sum(archive_path)


def write_manifest(manifest_path: Path, archive_md5: str) -> None:
    manifest_path.write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "target": "debian-bookworm-amd64",
                        "versions": {"quickjs": "2026-06-04"},
                        "component_keys": {
                            "quickjs": (
                                "prebuilt-deps/debian-bookworm-amd64/"
                                "quickjs-2026-06-04.tar.gz"
                            )
                        },
                        "component_md5sums": {"quickjs": archive_md5},
                    }
                ]
            }
        )
    )


def test_resolve_prebuilt_target_matches_published_matrix():
    installer = load_installer()

    assert installer.resolve_prebuilt_target("raspios", "bookworm", "aarch64") == (
        "debian-bookworm-arm64"
    )
    assert installer.resolve_prebuilt_target("ubuntu", "noble", "x86_64") == (
        "ubuntu-24.04-amd64"
    )
    assert installer.resolve_prebuilt_target("ubuntu", "resolute", "aarch64") == (
        "ubuntu-26.04-arm64"
    )


def test_installs_prebuilt_quickjs_archive_shape(tmp_path):
    installer = load_installer()
    archive_root = tmp_path / "archive"
    archive_path = (
        archive_root
        / "prebuilt-deps"
        / "debian-bookworm-amd64"
        / "quickjs-2026-06-04.tar.gz"
    )
    archive_md5 = write_quickjs_archive(archive_path, tmp_path)
    manifest_path = tmp_path / "manifest.json"
    write_manifest(manifest_path, archive_md5)
    dest = tmp_path / "quickjs"

    result = installer.main(
        [
            "--dest",
            str(dest),
            "--target",
            "debian-bookworm-amd64",
            "--manifest-file",
            str(manifest_path),
            "--base-url",
            f"{archive_root.as_uri()}/",
        ]
    )

    assert result == 0
    assert (dest / "quickjs.h").read_text() == "// quickjs\n"
    assert (dest / "quickjs-libc.h").read_text() == "// quickjs libc\n"
    assert (dest / "cutils.h").read_text() == "// cutils\n"
    assert (dest / "include" / "quickjs" / "cutils.h").exists()
    assert (dest / "libquickjs.a").read_bytes() == b"!<arch>\n"
    assert (dest / "lib" / "libquickjs.a").exists()
    assert (dest / "VERSION").read_text() == "2026-06-04\n"
