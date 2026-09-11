from __future__ import annotations

from app.tasks.prebuilt_deps import PrebuiltEntry


def entry(md5: str | None = None, sha256: str | None = None) -> PrebuiltEntry:
    return PrebuiltEntry(
        target="debian-bookworm-arm64",
        versions={"quickjs": "2026-06-04-quickts.1"},
        component_urls={"quickjs": "https://archive.frameos.net/q.tar.gz"},
        component_md5s={"quickjs": md5} if md5 else {},
        component_sha256s={"quickjs": sha256} if sha256 else {},
    )


def test_sha256_is_preferred():
    sha = "ab" * 32
    command = entry(md5="0e8141a15bc7d9ec19a81a7e17f921b6", sha256=sha).verify_command("quickjs", "/tmp/q.tar.gz")
    assert command == f"echo '{sha}  /tmp/q.tar.gz' | sha256sum -c -"


def test_single_part_md5_is_used_without_a_sha256():
    command = entry(md5="0e8141a15bc7d9ec19a81a7e17f921b6").verify_command("quickjs", "/tmp/q.tar.gz")
    assert command == "echo '0e8141a15bc7d9ec19a81a7e17f921b6  /tmp/q.tar.gz' | md5sum -c -"


def test_multipart_etag_is_not_a_checksum():
    assert entry(md5="8006fcb15aa0c7a23be4d22c3a0db01e-3").verify_command("quickjs", "/tmp/q.tar.gz") is None


def test_nothing_published_means_no_command():
    assert entry().verify_command("quickjs", "/tmp/q.tar.gz") is None


def test_entries_built_without_sha256s_still_work():
    legacy = PrebuiltEntry(
        target="t",
        versions={},
        component_urls={},
        component_md5s={"quickjs": "0e8141a15bc7d9ec19a81a7e17f921b6"},
    )
    assert legacy.sha256_for("quickjs") is None
    assert legacy.verify_command("quickjs", "/x") == "echo '0e8141a15bc7d9ec19a81a7e17f921b6  /x' | md5sum -c -"


def test_verify_file_accepts_the_published_bytes(tmp_path):
    import hashlib

    archive = tmp_path / "q.tar.gz"
    archive.write_bytes(b"quickjs archive")
    sha = hashlib.sha256(b"quickjs archive").hexdigest()
    md5 = hashlib.md5(b"quickjs archive").hexdigest()
    entry(sha256=sha).verify_file("quickjs", archive)
    entry(md5=md5).verify_file("quickjs", archive)
    entry(md5="8006fcb15aa0c7a23be4d22c3a0db01e-3", sha256=sha).verify_file("quickjs", archive)


def test_verify_file_refuses_mismatches_and_unverifiable_archives(tmp_path):
    import hashlib

    import pytest

    archive = tmp_path / "q.tar.gz"
    archive.write_bytes(b"tampered")
    md5 = hashlib.md5(b"tampered").hexdigest()
    with pytest.raises(RuntimeError, match="SHA-256 mismatch"):
        entry(md5=md5, sha256="0" * 64).verify_file("quickjs", archive)
    with pytest.raises(RuntimeError, match="MD5 mismatch"):
        entry(md5="0" * 32).verify_file("quickjs", archive)
    with pytest.raises(RuntimeError, match="no verifiable checksum"):
        entry(md5="8006fcb15aa0c7a23be4d22c3a0db01e-3").verify_file("quickjs", archive)
    with pytest.raises(RuntimeError, match="no verifiable checksum"):
        entry().verify_file("quickjs", archive)
