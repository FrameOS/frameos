"""The scene an album plays on a frame (docs/photos.md, "Installing photo
scenes"): render event -> render/image fed by the photoAlbum app, then sleep
for the scene's `seconds`. The share link sits in the app node's config, out
of the public state.

The SPA builds the same scene (frontend/src/scenes/photos/photoAlbumScene.ts)
and so does the cloud (cloud/apps/auth-web/src/lib/photos/album-scene.ts);
docs/photo-album-scene.json pins all three to one shape."""
from __future__ import annotations

import uuid
from typing import Any

from app.utils.retired_apps import replacement_app_entry

PHOTO_ALBUM_APP_ORIGIN = "repo/apps/code/photoAlbum"
PHOTO_ALBUM_APP_KEY = "photoAlbum"
DEFAULT_SECONDS = 3600

PHOTO_ALBUM_ORDERS = [
    {"value": "random", "label": "Shuffle"},
    {"value": "sequential", "label": "By name"},
    {"value": "newest", "label": "Newest first"},
    {"value": "oldest", "label": "Oldest first"},
]
PHOTO_ALBUM_FITS = [
    {"value": "cover", "label": "Fill the screen"},
    {"value": "contain", "label": "Show the whole photo"},
]
ORDER_VALUES = tuple(option["value"] for option in PHOTO_ALBUM_ORDERS)
FIT_VALUES = tuple(option["value"] for option in PHOTO_ALBUM_FITS)


def _number(value: float) -> int | float:
    # JSON as the SPA writes it: 600, not 600.0.
    return int(value) if float(value).is_integer() else float(value)


def build_photo_album_scene(*, name: str, album_url: str, seconds: float, order: str, fit: str) -> dict[str, Any]:
    seconds_value = _number(seconds if seconds > 0 else DEFAULT_SECONDS)
    ids = {key: str(uuid.uuid4()) for key in ("event", "render_image", "album", "sleep", "seconds", "order", "fit")}

    def node(node_id: str, node_type: str, data: dict[str, Any], x: int, y: int) -> dict[str, Any]:
        return {"id": node_id, "type": node_type, "data": data, "position": {"x": x, "y": y}}

    def edge(source: str, source_handle: str, target: str, target_handle: str, edge_type: str) -> dict[str, Any]:
        return {
            "id": str(uuid.uuid4()),
            "source": source,
            "sourceHandle": source_handle,
            "target": target,
            "targetHandle": target_handle,
            "type": edge_type,
        }

    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "settings": {
            "backgroundColor": "#000000",
            "refreshInterval": seconds_value,
            "execution": "interpreted",
        },
        "fields": [
            {
                "name": "seconds",
                "role": "refreshInterval",
                "label": "Seconds to show one photo",
                "type": "float",
                "persist": "disk",
                "access": "public",
                "value": str(seconds_value),
            },
            {
                "name": "order",
                "label": "Order",
                "type": "select",
                "options": [dict(option) for option in PHOTO_ALBUM_ORDERS],
                "persist": "disk",
                "access": "public",
                "value": order,
            },
            {
                "name": "fit",
                "label": "Fit",
                "type": "select",
                "options": [dict(option) for option in PHOTO_ALBUM_FITS],
                "persist": "disk",
                "access": "public",
                "value": fit,
            },
            {
                "name": "photoIndex",
                "label": "Position in the album",
                "type": "integer",
                "persist": "disk",
                "access": "private",
                "value": "0",
            },
        ],
        "nodes": [
            node(ids["event"], "event", {"keyword": "render"}, -320, 120),
            node(ids["render_image"], "app", {"keyword": "render/image", "config": {}}, 200, 140),
            node(
                ids["album"],
                "app",
                {
                    "keyword": PHOTO_ALBUM_APP_KEY,
                    "config": {"album": album_url, "counterStateKey": "photoIndex"},
                    "cache": {"enabled": False},
                },
                -260,
                -200,
            ),
            node(ids["sleep"], "app", {"keyword": "logic/nextSleepDuration", "config": {}}, 640, 140),
            node(ids["seconds"], "state", {"keyword": "seconds"}, 560, 40),
            node(ids["order"], "state", {"keyword": "order"}, -520, -140),
            node(ids["fit"], "state", {"keyword": "fit"}, 120, 40),
        ],
        "edges": [
            edge(ids["event"], "next", ids["render_image"], "prev", "appNodeEdge"),
            edge(ids["album"], "fieldOutput", ids["render_image"], "fieldInput/image", "codeNodeEdge"),
            edge(ids["render_image"], "next", ids["sleep"], "prev", "appNodeEdge"),
            edge(ids["seconds"], "fieldOutput", ids["sleep"], "fieldInput/duration", "codeNodeEdge"),
            edge(ids["order"], "fieldOutput", ids["album"], "fieldInput/order", "codeNodeEdge"),
            edge(ids["fit"], "fieldOutput", ids["render_image"], "fieldInput/placement", "codeNodeEdge"),
        ],
        "apps": {PHOTO_ALBUM_APP_KEY: replacement_app_entry(PHOTO_ALBUM_APP_ORIGIN)},
    }
