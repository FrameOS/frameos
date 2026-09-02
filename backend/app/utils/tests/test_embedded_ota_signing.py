import hashlib

from app.utils import embedded_ota_signing as signing


def test_key_is_derived_from_the_install_secret(monkeypatch):
    monkeypatch.setattr(signing.app_config.config, "SECRET_KEY", "install-secret")
    monkeypatch.setattr(signing.app_config.config, "PREVIOUS_SECRET_KEYS", [])
    key = signing.current_signing_key()
    assert key is not None
    assert key == signing.derive_signing_key("install-secret")
    assert key != signing.derive_signing_key("other-secret")
    assert len(key.public_hex) == 64 and len(key.key_id_hex) == 16


def test_previous_secret_keys_keep_signing(monkeypatch, tmp_path):
    image = tmp_path / "ota.bin"
    image.write_bytes(b"firmware" * 1000)
    monkeypatch.setattr(signing.app_config.config, "SECRET_KEY", "new-secret")
    monkeypatch.setattr(signing.app_config.config, "PREVIOUS_SECRET_KEYS", ["old-secret", "new-secret"])
    keys = signing.signing_keys()
    assert [k.key_id_hex for k in keys] == [
        signing.derive_signing_key("new-secret").key_id_hex,
        signing.derive_signing_key("old-secret").key_id_hex,
    ]

    minisigs = signing.sign_image(image)
    assert set(minisigs) == {k.key_id_hex for k in keys}
    digest = hashlib.blake2b(image.read_bytes(), digest_size=64).digest()
    for key in keys:
        assert signing.verify_minisig(key.public, key.key_id, minisigs[key.key_id_hex], digest)
    # A device built under the old key verifies with its own key only.
    old, new = keys[1], keys[0]
    assert not signing.verify_minisig(old.public, old.key_id, minisigs[new.key_id_hex], digest)
    assert not signing.verify_minisig(new.public, new.key_id, minisigs[new.key_id_hex], b"\0" * 64)


def test_signature_is_minisign_compatible(monkeypatch, tmp_path):
    """tools/sign_firmware.py's verifier (what `minisign -V` checks) accepts it."""
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location(
        "sign_firmware", Path(__file__).resolve().parents[4] / "tools" / "sign_firmware.py"
    )
    sign_firmware = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sign_firmware)

    monkeypatch.setattr(signing.app_config.config, "SECRET_KEY", "install-secret")
    monkeypatch.setattr(signing.app_config.config, "PREVIOUS_SECRET_KEYS", [])
    image = tmp_path / "ota.bin"
    image.write_bytes(b"\x01\x02\x03" * 4096)
    key = signing.current_signing_key()
    blob = __import__("base64").b64decode(signing.sign_image(image)[key.key_id_hex])
    sign_firmware.verify_blob(key.public, key.key_id, blob, sign_firmware.blake2b_digest(str(image)))
