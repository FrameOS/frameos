import copy

from app.utils import frame_secrets
from app.utils.frame_secrets import (
    FINGERPRINTS_KEY,
    deploy_snapshot,
    deployed_frame_snapshot,
    redact_frame_secrets,
    restore_snapshot_secrets,
    served_deploy_snapshot,
    websocket_frame_payload,
)


def frame_dict() -> dict:
    return {
        "id": 7,
        "name": "Kitchen",
        "ssh_pass": "raspberry",
        "server_api_key": "api-key",
        "frame_access_key": "access-key",
        "https_proxy": {"enable": True, "port": 8443, "certs": {"server": "CERT", "server_key": "KEY", "client_ca": "CA"}},
        "agent": {"agentEnabled": True, "agentRunCommands": False, "agentSharedSecret": "shared"},
        "frame_admin_auth": {"enabled": True, "user": "admin", "pass": "hunter2"},
        "mountpoints": {
            "enabled": True,
            "items": [
                {"source": "//nas/photos", "target": "/mnt/photos", "username": "u", "password": "p1"},
                {"source": "//nas/other", "target": "/mnt/other", "username": "", "password": ""},
            ],
        },
        "network": {"wifiHotspot": "disabled"},
        "scenes": [{"id": "a"}],
        "last_successful_deploy": {"name": "old"},
        "last_successful_deploy_at": "2026-01-01T00:00:00+00:00",
    }


def test_redact_frame_secrets_strips_every_secret_leaf_and_keeps_the_rest():
    original = frame_dict()
    before = copy.deepcopy(original)

    redacted = redact_frame_secrets(original)

    assert original == before  # never mutates the input (ORM JSON columns)
    for key in ("ssh_pass", "server_api_key", "frame_access_key"):
        assert key not in redacted
    assert redacted["https_proxy"]["certs"] == {"server": "CERT", "client_ca": "CA"}
    assert redacted["agent"] == {"agentEnabled": True, "agentRunCommands": False}
    assert redacted["frame_admin_auth"] == {"enabled": True, "user": "admin"}
    assert [item.keys() for item in redacted["mountpoints"]["items"]] == [
        {"source", "target", "username"},
        {"source", "target", "username", "password"},  # empty: not a secret, shape kept
    ]
    assert redacted["name"] == "Kitchen"
    assert redacted["network"] == {"wifiHotspot": "disabled"}
    assert redacted["scenes"] == [{"id": "a"}]


def test_websocket_payload_omits_secrets_and_their_containers_instead_of_blanking_them():
    payload = websocket_frame_payload(frame_dict())

    # The browser merges shallowly, so a container sent without its secret
    # leaf would wipe the client's copy of that leaf. Omitted keys are kept.
    for key in ("ssh_pass", "server_api_key", "frame_access_key", "https_proxy", "agent", "frame_admin_auth", "mountpoints"):
        assert key not in payload
    assert payload["id"] == 7
    assert payload["name"] == "Kitchen"
    assert payload["scenes"] == [{"id": "a"}]


def test_websocket_payload_handles_partial_broadcasts():
    assert websocket_frame_payload({"agent": {"agentSharedSecret": "x"}, "id": 1, "project_id": 2}) == {
        "id": 1,
        "project_id": 2,
    }


def test_deploy_snapshot_stores_fingerprints_instead_of_secrets():
    snapshot = deploy_snapshot(frame_dict())

    assert "ssh_pass" not in snapshot
    assert "server_key" not in snapshot["https_proxy"]["certs"]
    assert "last_successful_deploy" not in snapshot
    assert "last_successful_deploy_at" not in snapshot
    fingerprints = snapshot[FINGERPRINTS_KEY]
    assert set(fingerprints) == {
        "ssh_pass",
        "server_api_key",
        "frame_access_key",
        "https_proxy.certs.server_key",
        "agent.agentSharedSecret",
        "frame_admin_auth.pass",
        "mountpoints.items.0.password",  # the empty password on item 1 has no fingerprint
    }
    for secret in ("raspberry", "api-key", "access-key", "KEY", "shared", "hunter2", "p1"):
        assert secret not in str(snapshot)
    assert all(len(value) == 64 for value in fingerprints.values())


def test_restore_fills_matching_secrets_back_in_and_leaves_rotated_ones_out():
    current = frame_dict()
    snapshot = deploy_snapshot(current)

    unchanged = restore_snapshot_secrets(snapshot, current)
    assert FINGERPRINTS_KEY not in unchanged
    for key in ("ssh_pass", "server_api_key", "frame_access_key", "https_proxy", "agent", "frame_admin_auth", "mountpoints"):
        assert unchanged[key] == current[key]

    rotated = copy.deepcopy(current)
    rotated["ssh_pass"] = "new-password"
    rotated["https_proxy"]["certs"]["server_key"] = "NEWKEY"
    rotated["mountpoints"]["items"][0]["password"] = "p2"
    restored = restore_snapshot_secrets(snapshot, rotated)
    assert "ssh_pass" not in restored
    assert "server_key" not in restored["https_proxy"]["certs"]
    assert "password" not in restored["mountpoints"]["items"][0]
    assert restored["server_api_key"] == "api-key"  # still matches
    assert restored["agent"]["agentSharedSecret"] == "shared"
    assert snapshot[FINGERPRINTS_KEY]  # the stored copy is untouched
    assert "ssh_pass" not in snapshot


def test_restore_accepts_fingerprints_made_with_a_previous_secret_key(monkeypatch):
    current = frame_dict()
    monkeypatch.setattr(frame_secrets.config, "SECRET_KEY", "old-key")
    monkeypatch.setattr(frame_secrets.config, "PREVIOUS_SECRET_KEYS", [])
    snapshot = deploy_snapshot(current)

    monkeypatch.setattr(frame_secrets.config, "SECRET_KEY", "new-key")
    assert "ssh_pass" not in restore_snapshot_secrets(snapshot, current)

    monkeypatch.setattr(frame_secrets.config, "PREVIOUS_SECRET_KEYS", ["old-key"])
    assert restore_snapshot_secrets(snapshot, current)["ssh_pass"] == "raspberry"


def test_restore_leaves_legacy_snapshots_and_non_dicts_alone():
    legacy = {"name": "old", "ssh_pass": "kept-from-before"}
    assert restore_snapshot_secrets(legacy, frame_dict()) is legacy
    assert restore_snapshot_secrets(None, frame_dict()) is None


def test_deployed_frame_snapshot_reads_the_frame_columns():
    class FakeFrame:
        pass

    current = frame_dict()
    frame = FakeFrame()
    for key, value in current.items():
        setattr(frame, key, value)
    frame.last_successful_deploy = deploy_snapshot(current)

    restored = deployed_frame_snapshot(frame)
    assert restored["ssh_pass"] == "raspberry"
    assert restored["https_proxy"] == current["https_proxy"]

    frame.last_successful_deploy = None
    assert deployed_frame_snapshot(frame) is None


def test_served_snapshot_is_the_stored_form_and_converts_legacy_ones():
    stored = deploy_snapshot(frame_dict())
    assert served_deploy_snapshot(stored) is stored
    assert served_deploy_snapshot(None) is None

    legacy = {"name": "old", "ssh_pass": "raspberry", "agent": {"agentSharedSecret": "shared"}}
    served = served_deploy_snapshot(legacy)
    assert "ssh_pass" not in served
    assert served["agent"] == {}
    assert served[FINGERPRINTS_KEY] == deploy_snapshot(legacy)[FINGERPRINTS_KEY]
    assert legacy["ssh_pass"] == "raspberry"  # the stored row is left alone


def test_websocket_payload_keeps_the_secret_free_snapshot_and_fingerprints():
    frame = frame_dict()
    frame["last_successful_deploy"] = deploy_snapshot(frame)
    frame["secret_fingerprints"] = frame["last_successful_deploy"][FINGERPRINTS_KEY]

    payload = websocket_frame_payload(frame)

    assert payload["last_successful_deploy"] == frame["last_successful_deploy"]
    assert payload["secret_fingerprints"] == frame["secret_fingerprints"]
    for secret in ("raspberry", "api-key", "access-key", "KEY", "shared", "hunter2", "p1"):
        assert secret not in str(payload)
