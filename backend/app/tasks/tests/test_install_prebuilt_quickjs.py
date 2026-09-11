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
    payload = tmp_path / "payload" / "quickjs-2026-06-04-quickts.1"
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


def write_manifest(manifest_path: Path, archive_md5: str | None, archive_sha256: str | None = None) -> None:
    entry_sums = {"component_md5sums": {"quickjs": archive_md5} if archive_md5 else {}}
    if archive_sha256:
        entry_sums["component_sha256sums"] = {"quickjs": archive_sha256}
    manifest_path.write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "target": "debian-bookworm-amd64",
                        "versions": {"quickjs": "2026-06-04-quickts.1"},
                        "component_keys": {
                            "quickjs": (
                                "prebuilt-deps/debian-bookworm-amd64/"
                                "quickjs-2026-06-04-quickts.1.tar.gz"
                            )
                        },
                        **entry_sums,
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
        / "quickjs-2026-06-04-quickts.1.tar.gz"
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
    assert (dest / "VERSION").read_text() == "2026-06-04-quickts.1\n"


def run_installer(tmp_path: Path, *, md5: str | None, sha256: str | None, archive_md5_ok: bool = True):
    installer = load_installer()
    archive_root = tmp_path / "archive"
    archive_path = (
        archive_root
        / "prebuilt-deps"
        / "debian-bookworm-amd64"
        / "quickjs-2026-06-04-quickts.1.tar.gz"
    )
    real_md5 = write_quickjs_archive(archive_path, tmp_path)
    real_sha256 = installer.file_sha256sum(archive_path)
    manifest_path = tmp_path / "manifest.json"
    write_manifest(
        manifest_path,
        real_md5 if md5 == "real" else md5,
        real_sha256 if sha256 == "real" else sha256,
    )
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
    return result, dest


def test_sha256_is_verified_and_wins_over_a_multipart_md5(tmp_path):
    result, dest = run_installer(tmp_path, md5="0123456789abcdef0123456789abcdef-3", sha256="real")
    assert result == 0
    assert (dest / "quickjs.h").exists()


def test_sha256_mismatch_refuses_even_when_the_md5_matches(tmp_path, capsys):
    result, dest = run_installer(tmp_path, md5="real", sha256="0" * 64)
    assert result == 2
    assert not dest.exists()
    assert "SHA-256 mismatch" in capsys.readouterr().err


def test_multipart_md5_alone_is_not_a_checksum(tmp_path, capsys):
    # An R2 multipart ETag ("<hex>-<parts>") is not the file's MD5. This used
    # to install the archive unverified.
    result, dest = run_installer(tmp_path, md5="0123456789abcdef0123456789abcdef-3", sha256=None)
    assert result == 2
    assert not dest.exists()
    assert "No verifiable checksum" in capsys.readouterr().err


def test_no_checksum_at_all_refuses(tmp_path, capsys):
    result, dest = run_installer(tmp_path, md5=None, sha256=None)
    assert result == 2
    assert not dest.exists()
    assert "No verifiable checksum" in capsys.readouterr().err


def test_single_part_md5_still_verifies_older_manifests(tmp_path):
    result, dest = run_installer(tmp_path, md5="real", sha256=None)
    assert result == 0
    assert (dest / "libquickjs.a").exists()


def test_committed_manifest_publishes_a_sha256_for_every_archive():
    manifest = json.loads((REPO_ROOT / "tools" / "prebuilt-deps" / "manifest.json").read_text())
    for entry in manifest["entries"]:
        keys = entry.get("component_keys") or {}
        sha256s = entry.get("component_sha256sums") or {}
        for component in keys:
            value = sha256s.get(component) or ""
            assert len(value) == 64 and all(c in "0123456789abcdef" for c in value), (
                entry["target"],
                component,
            )
