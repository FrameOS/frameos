from __future__ import annotations

from dataclasses import dataclass

from app.utils.ssh_key_utils import (
    default_ssh_key_ids,
    normalize_ssh_keys,
    select_ssh_keys_for_frame,
    ssh_key_map,
)


@dataclass
class DummyFrame:
    ssh_keys: list[str] | None = None


def test_normalize_ssh_keys_from_list():
    settings = {
        "ssh_keys": {
            "keys": [
                {"id": "alpha", "private": "priv-a", "public": "pub-a", "use_for_new_frames": 1},
                {"id": "", "private": "ignore"},
                "not-a-dict",
                {"id": "beta", "name": "Beta Key"},
            ]
        }
    }

    assert normalize_ssh_keys(settings) == [
        {
            "id": "alpha",
            "name": "alpha",
            "private": "priv-a",
            "public": "pub-a",
            "use_for_new_frames": True,
        },
        {
            "id": "beta",
            "name": "Beta Key",
            "private": "",
            "public": "",
            "use_for_new_frames": False,
        },
    ]


def test_normalize_ssh_keys_legacy_defaults():
    settings = {"ssh_keys": {"default": "legacy-private", "default_public": "legacy-public"}}

    assert normalize_ssh_keys(settings) == [
        {
            "id": "default",
            "name": "Default",
            "private": "legacy-private",
            "public": "legacy-public",
            "use_for_new_frames": True,
        }
    ]


def test_ssh_key_map_uses_normalized_keys():
    settings = {
        "ssh_keys": {
            "keys": [
                {"id": "alpha", "public": "pub-a"},
                {"id": "beta", "public": "pub-b"},
            ]
        }
    }

    assert ssh_key_map(settings) == {
        "alpha": {
            "id": "alpha",
            "name": "alpha",
            "private": "",
            "public": "pub-a",
            "use_for_new_frames": False,
        },
        "beta": {
            "id": "beta",
            "name": "beta",
            "private": "",
            "public": "pub-b",
            "use_for_new_frames": False,
        },
    }


def test_select_ssh_keys_for_frame_prefers_frame_selection():
    settings = {
        "ssh_keys": {
            "keys": [
                {"id": "alpha", "use_for_new_frames": True},
                {"id": "beta"},
            ]
        }
    }
    frame = DummyFrame(ssh_keys=["beta"])

    assert select_ssh_keys_for_frame(frame, settings) == [
        {
            "id": "beta",
            "name": "beta",
            "private": "",
            "public": "",
            "use_for_new_frames": False,
        }
    ]


def test_select_ssh_keys_for_frame_falls_back_to_defaults():
    settings = {
        "ssh_keys": {
            "keys": [
                {"id": "alpha", "use_for_new_frames": True},
                {"id": "beta"},
            ]
        }
    }
    frame = DummyFrame(ssh_keys=["missing"])

    assert select_ssh_keys_for_frame(frame, settings) == [
        {
            "id": "alpha",
            "name": "alpha",
            "private": "",
            "public": "",
            "use_for_new_frames": True,
        }
    ]


def test_select_ssh_keys_for_frame_returns_all_when_no_defaults():
    settings = {"ssh_keys": {"keys": [{"id": "alpha"}, {"id": "beta"}]}}
    frame = DummyFrame()

    assert select_ssh_keys_for_frame(frame, settings) == [
        {
            "id": "alpha",
            "name": "alpha",
            "private": "",
            "public": "",
            "use_for_new_frames": False,
        },
        {
            "id": "beta",
            "name": "beta",
            "private": "",
            "public": "",
            "use_for_new_frames": False,
        },
    ]


def test_default_ssh_key_ids_returns_only_default_ids():
    settings = {
        "ssh_keys": {
            "keys": [
                {"id": "alpha", "use_for_new_frames": True},
                {"id": "beta", "use_for_new_frames": False},
            ]
        }
    }

    assert default_ssh_key_ids(settings) == ["alpha"]
