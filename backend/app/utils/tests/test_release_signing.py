import base64
import re
from pathlib import Path

from app.utils.release_signing import (
    RELEASE_SIGNING_PUBLIC_KEY_BASE64,
    release_signing_public_key_spki_base64,
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
