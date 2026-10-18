"""Photos share links in scene JSON: found anywhere, hidden from the model
behind placeholders, put back in what it returns. The cloud's
share-links-in-scenes.test.ts pins the same rules."""

from app.utils.photo_share_links import PhotoLinkRedactor, has_photo_share_link

TOKEN = "pk_" + "a1B2c3D4" * 4
OTHER = "pk_" + "Zz9_-yX8" * 5
CLOUD_LINK = f"https://cloud.frameos.net/api/photos/shared/{TOKEN}"
BACKEND_LINK = f"/api/photos/shared/{OTHER}"


def album_scene(album: str) -> list[dict]:
    return [
        {
            "id": "album",
            "nodes": [
                {
                    "id": "node-1",
                    "type": "app",
                    "data": {"keyword": "photoAlbum", "config": {"album": album, "counterStateKey": "photoIndex"}},
                }
            ],
        }
    ]


def test_finds_links_absolute_root_relative_and_escaped():
    assert has_photo_share_link(album_scene(CLOUD_LINK))
    assert has_photo_share_link(album_scene(BACKEND_LINK))
    assert has_photo_share_link(album_scene(f"http://10.0.0.5:8989{BACKEND_LINK}/photo?index=3"))
    assert has_photo_share_link({"deep": [{CLOUD_LINK: 1}]})
    assert has_photo_share_link('const a = "https:\\/\\/x\\/api\\/photos\\/shared\\/' + TOKEN + '"')
    assert has_photo_share_link(f"?album=https%3A%2F%2Fx%2Fapi%2Fphotos%2Fshared%2F{TOKEN}")


def test_leaves_bare_tokens_and_other_paths_alone():
    assert not has_photo_share_link(album_scene(TOKEN))
    assert not has_photo_share_link(album_scene("/api/photos/shared/pk_short"))
    assert not has_photo_share_link(album_scene(f"/api/photos/thumb?path={TOKEN}"))
    assert not has_photo_share_link(album_scene("/api/photos/shared/pk_" + "a" * 129))
    assert not has_photo_share_link(None)
    assert not has_photo_share_link(album_scene("/api/photos/shared/pk_photo_link_1"))


def test_redacts_with_stable_numbers_and_keeps_host_and_path():
    redactor = PhotoLinkRedactor()
    assert redactor.redact_text(f"a {BACKEND_LINK} b") == "a /api/photos/shared/pk_photo_link_1 b"
    assert redactor.redact_text(f"{CLOUD_LINK} and {BACKEND_LINK}") == (
        "https://cloud.frameos.net/api/photos/shared/pk_photo_link_2 and /api/photos/shared/pk_photo_link_1"
    )
    assert redactor.size == 2
    redacted = redactor.redact(album_scene(CLOUD_LINK))
    assert TOKEN not in str(redacted)
    assert not has_photo_share_link(redacted)
    # A known token goes where it appears on its own too; an unknown one stays.
    assert redactor.redact_text(f"token {TOKEN}") == "token pk_photo_link_2"
    assert PhotoLinkRedactor().redact_text(f"key {TOKEN}") == f"key {TOKEN}"


def test_restores_what_the_model_returns():
    redactor = PhotoLinkRedactor()
    redacted = redactor.redact(album_scene(BACKEND_LINK))
    redacted[0]["nodes"][0]["data"]["config"]["fit"] = "contain"
    restored = redactor.restore(redacted)
    assert restored[0]["nodes"][0]["data"]["config"] == {
        "album": BACKEND_LINK,
        "counterStateKey": "photoIndex",
        "fit": "contain",
    }
    encoded = f"?album=https%3A%2F%2Fx%2Fapi%2Fphotos%2Fshared%2F{OTHER}"
    assert redactor.restore_text(redactor.redact_text(encoded)) == encoded
    assert redactor.restore_text("pk_photo_link_7") == "pk_photo_link_7"
    assert redactor.restore_text("xpk_photo_link_1") == "xpk_photo_link_1"
    assert PhotoLinkRedactor().restore_text("pk_photo_link_1") == "pk_photo_link_1"
