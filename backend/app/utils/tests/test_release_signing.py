import base64
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app.utils.release_signing import (
    RELEASE_SIGNING_PUBLIC_KEY_BASE64,
    parse_minisig,
    release_asset_name,
    release_signing_public_key_spki_base64,
    verify_release_archive_signature,
)

REPO_ROOT = Path(__file__).resolve().parents[4]


def test_release_signing_key_matches_the_device_runtime():
    nim = (REPO_ROOT / "frameos" / "src" / "frameos" / "ota_pubkey.nim").read_text(encoding="utf-8")
    match = re.search(r'OtaSigningPublicKeyBase64\*\s*=\s*"([^"]+)"', nim)
    assert match, "ota_pubkey.nim no longer defines OtaSigningPublicKeyBase64"
    assert match.group(1) == RELEASE_SIGNING_PUBLIC_KEY_BASE64


def test_spki_wraps_the_raw_key():
    spki = base64.b64decode(release_signing_public_key_spki_base64())
    assert spki[:12] == bytes.fromhex("302a300506032b6570032100")
    assert spki[12:] == base64.b64decode(RELEASE_SIGNING_PUBLIC_KEY_BASE64)
    assert len(spki) == 44


# The .minisig the release workflow published beside
# frameos-2026.9.19-debian-bookworm-arm64.tar.gz, signed by the production
# key above: the same fixture the Nim, C and TypeScript verifiers are held to.
REAL_ASSET = "frameos-2026.9.19-debian-bookworm-arm64.tar.gz"
REAL_MINISIG = """untrusted comment: signature from FrameOS firmware key
RUQnxMf13zADcFFcQyFKSGSP8dlnMFEnZtwiPYna8r7uZj3THgXiAyf55UahO6vTTswZUqCwN9/E/UsA5X9OcUiuBsjcK/nDeww=
trusted comment: frameos frameos-2026.9.19-debian-bookworm-arm64.tar.gz
uzpKdt8H7PSIz+P45GNmLUyI6GI3VVaytR4nGc7yjYeQMSns8swLi35Bf6rObL2ckov4/B+11BuzuTcHU+TsDg==
"""


def test_a_real_release_signature_names_its_asset(tmp_path: Path):
    parsed = parse_minisig(REAL_MINISIG)
    assert parsed.trusted_comment == f"frameos {REAL_ASSET}"
    assert len(parsed.signature) == 64 and len(parsed.global_signature) == 64

    archive = tmp_path / "not-the-release.tar.gz"
    archive.write_bytes(b"not the bytes that were signed")
    # Right asset name: the comment half passes against the PRODUCTION key and
    # the refusal is about the bytes.
    with pytest.raises(ValueError, match="does not verify against the FrameOS signing key"):
        verify_release_archive_signature(archive, REAL_MINISIG, REAL_ASSET)
    # Any other name is refused before the archive is even read.
    for other in (
        "frameos-2026.9.20-debian-bookworm-arm64.tar.gz",
        "frameos-2026.9.19-debian-bookworm-armhf.tar.gz",
        REAL_ASSET + ".evil",
        "",
    ):
        with pytest.raises(ValueError, match="different version or target"):
            verify_release_archive_signature(tmp_path / "missing", REAL_MINISIG, other)
    # Rewriting the comment to match is caught by the global signature.
    with pytest.raises(ValueError, match="trusted comment is not signed"):
        verify_release_archive_signature(
            archive,
            REAL_MINISIG.replace("2026.9.19", "2026.9.20"),
            "frameos-2026.9.20-debian-bookworm-arm64.tar.gz",
        )


def test_a_signature_with_no_signed_comment_is_refused():
    lines = REAL_MINISIG.splitlines()
    for text in (
        "\n".join(lines[:2]),  # the bare file signature this parser used to accept
        "\n".join(lines[:3]),  # comment, no global signature
        "\n".join(lines[:3] + [lines[2], lines[3]]),  # two comments
        "\n".join(lines[:3] + ["AAAA"]),  # truncated global signature
    ):
        with pytest.raises(ValueError):
            parse_minisig(text + "\n")
    # CRLF is a line ending, not part of the signed comment.
    assert parse_minisig(REAL_MINISIG.replace("\n", "\r\n")).trusted_comment == f"frameos {REAL_ASSET}"


def test_release_asset_name_is_the_last_url_segment():
    url = "https://github.com/FrameOS/frameos/releases/download/v2026.9.19/" + REAL_ASSET
    assert release_asset_name(url) == REAL_ASSET
    assert release_asset_name(REAL_ASSET) == REAL_ASSET


def test_the_release_signer_and_this_verifier_agree(tmp_path: Path):
    """tools/sign_firmware.py is what the release job runs; its trusted
    comment format is a contract with every verifier in the field."""
    tool = str(REPO_ROOT / "tools" / "sign_firmware.py")

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, tool, *args], capture_output=True, text=True, timeout=60)

    secret, public = tmp_path / "key.sec", tmp_path / "key.pub"
    assert run("keygen", "--secret-out", str(secret), "--public-out", str(public)).returncode == 0
    asset = tmp_path / "frameos-2026.9.20-debian-bookworm-arm64.tar.gz"
    asset.write_bytes(b"release bytes " * 1000)
    assert run("sign", "--secret", str(secret), str(asset)).returncode == 0
    minisig = asset.with_name(asset.name + ".minisig").read_text(encoding="utf-8")
    key = base64.b64encode(base64.b64decode(public.read_text().splitlines()[-1])[10:]).decode()

    verify_release_archive_signature(asset, minisig, asset.name, key)
    with pytest.raises(ValueError, match="different version or target"):
        verify_release_archive_signature(asset, minisig, "frameos-2026.9.21-debian-bookworm-arm64.tar.gz", key)

    # The tool's own `verify` (the release job's last gate) makes the same
    # call: an asset renamed after signing is refused…
    assert run("verify", "--public", str(public), str(asset)).returncode == 0
    renamed = tmp_path / "frameos-2026.9.21-debian-bookworm-arm64.tar.gz"
    renamed.write_bytes(asset.read_bytes())
    renamed.with_name(renamed.name + ".minisig").write_text(minisig, encoding="utf-8")
    refused = run("verify", "--public", str(public), str(renamed))
    assert refused.returncode != 0 and "signed as" in refused.stderr
    # …and --name signs a file that lives under another name (dev OTA images).
    dev = tmp_path / "esp32-s3-generic.bin"
    dev.write_bytes(b"dev image")
    name = "frameos-2026.9.20-esp32-s3-generic-app.bin"
    assert run("sign", "--secret", str(secret), "--name", name, str(dev)).returncode == 0
    verify_release_archive_signature(dev, dev.with_name(dev.name + ".minisig").read_text(), name, key)
