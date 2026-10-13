"""The project's photo library (docs/photos.md): albums on the backend's disk
that frames play through share links. Every tool is one `/api/photos` route,
except two: photo_upload sends a file in the route's chunks (fetching it
first when given a URL), and photo_album_install is `POST /api/photos/scene`
followed by frame_scene_install. The names match the cloud's photos tools.

Every write takes `confirm`: a frame playing a shared album shows what is
in the folder on its next photo, so adding, moving, recoloring or deleting
a photo changes what a physical frame shows. Sharing makes a folder
readable by anyone who has the link."""
from __future__ import annotations

import base64
import binascii
import json
import secrets
from typing import Any
from urllib.parse import unquote, urljoin, urlparse

import httpx
from fastapi import HTTPException

from app.utils.network import assert_url_target_allowed

from ..client import ToolContext
from ..protocol import McpServer
from ..registry import Tool, confirmed
from ..result import ApiError, McpInputError, image, run, text
from .frames import DEPLOY, FRAME_ID

CHUNK_BYTES = 4 * 1024 * 1024
# What the route takes (app/utils/photos.py MAX_UPLOAD_BYTES).
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_REDIRECTS = 5
# MCP clients pass these on to a model; the rest come back as a summary.
INLINE_IMAGE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")
MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024

PATH = {"type": "string", "description": "Path in the library, e.g. \"Summer 2026/beach.jpg\" (photos_list has them)."}
FOLDER = {"type": "string", "description": "Folder path in the library; \"\" is the root."}
PATHS = {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1, "maxItems": 1000}
LIBRARY_WRITE = "changes the photo library, which frames playing a shared album show on their next photo"


def _filename_from_url(url: str) -> str:
    return unquote(urlparse(url).path.rsplit("/", 1)[-1]).strip()


def _outbound_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=60)


async def _fetch_photo(url: str) -> bytes:
    """GET a user's URL with the backend's outbound check on every hop."""
    async with _outbound_client() as client:
        for _ in range(MAX_REDIRECTS + 1):
            try:
                await assert_url_target_allowed(url, what="Photo URL")
            except HTTPException as error:
                raise McpInputError(str(error.detail)) from error
            async with client.stream("GET", url) as response:
                if response.is_redirect and response.headers.get("location"):
                    url = urljoin(url, response.headers["location"])
                    continue
                if response.status_code >= 400:
                    raise McpInputError(f"{url} answered {response.status_code}")
                declared = response.headers.get("content-length") or ""
                if declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
                    raise McpInputError(f"{url} is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_UPLOAD_BYTES:
                        raise McpInputError(f"{url} is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB")
                return bytes(body)
        raise McpInputError(f"{url} redirected more than {MAX_REDIRECTS} times")


def register_photo_tools(server: McpServer, ctx: ToolContext) -> None:
    api = ctx.api

    async def photos_status(project_id: int | None = None):
        return await run(lambda: _json(api, "GET", "/api/photos/status", project_id))

    server.tool(Tool(
        name="photos_status",
        description="Whether the photo library is ready (when not, `message` says why and every other photos tool fails), where its files live, the space used and free, and the upload size limit.",
        annotations={"readOnlyHint": True},
        handler=photos_status,
    ))

    async def photos_list(path: str = "", project_id: int | None = None):
        return await run(lambda: _json(api, "GET", "/api/photos/files", project_id, params={"path": path}))

    server.tool(Tool(
        name="photos_list",
        description=(
            "One folder of the photo library: its folders (albums at the root, with item counts and a cover) "
            "and files (size, dimensions, `colors` when the photo has a color profile). path \"\" is the root."
        ),
        properties={"path": FOLDER},
        annotations={"readOnlyHint": True},
        handler=photos_list,
    ))

    async def photo_get(path: str, original: bool = False, project_id: int | None = None):
        async def go():
            if not original:
                try:
                    body, _ = await api.bytes("GET", "/api/photos/thumb", project_id=project_id, params={"path": path})
                    return image(body, "image/jpeg", f"{path} (thumbnail, {len(body)} bytes)")
                except ApiError as error:
                    if error.status != 404:
                        raise
            body, content_type = await api.bytes("GET", "/api/photos/file", project_id=project_id, params={"path": path})
            mime = content_type.split(";")[0].strip()
            if mime in INLINE_IMAGE_TYPES and len(body) <= MAX_INLINE_IMAGE_BYTES:
                return image(body, mime, f"{path} ({mime}, {len(body)} bytes)")
            return text({
                "path": path,
                "content_type": mime,
                "size": len(body),
                "note": "Not returned inline: only JPEG, PNG, GIF and WebP images up to 5 MB are.",
            })

        return await run(go)

    server.tool(Tool(
        name="photo_get",
        description="See one photo: its thumbnail (512 px), or the file itself with original=true (JPEG, PNG, GIF and WebP up to 5 MB come back as an image).",
        properties={"path": PATH, "original": {"type": "boolean"}},
        required=["path"],
        annotations={"readOnlyHint": True},
        handler=photo_get,
    ))

    async def photo_upload(
        confirm: bool,
        folder: str = "",
        filename: str | None = None,
        content_base64: str | None = None,
        url: str | None = None,
        project_id: int | None = None,
    ):
        async def go():
            if (content_base64 is None) == (url is None):
                raise McpInputError("Pass exactly one of content_base64 or url.")
            if url is not None:
                data = await _fetch_photo(url)
                name = filename or _filename_from_url(url)
                if not name:
                    raise McpInputError("The URL has no file name in it; pass filename.")
            else:
                try:
                    data = base64.b64decode(content_base64 or "", validate=True)
                except (binascii.Error, ValueError) as error:
                    raise McpInputError(f"content_base64 is not valid base64: {error}") from error
                if not filename:
                    raise McpInputError("Pass filename with content_base64.")
                name = filename
            upload_id = secrets.token_urlsafe(16)
            chunks = [data[start:start + CHUNK_BYTES] for start in range(0, len(data), CHUNK_BYTES)] or [b""]
            offset = 0
            payload: Any = None
            for index, chunk in enumerate(chunks):
                payload = await api.json(
                    "POST", "/api/photos/upload", project_id=project_id,
                    params={
                        "path": folder,
                        "filename": name,
                        "upload_id": upload_id,
                        "offset": offset,
                        "complete": "1" if index == len(chunks) - 1 else "0",
                    },
                    content=chunk,
                    headers={"content-type": "application/octet-stream"},
                )
                offset += len(chunk)
            return text(payload)

        return await run(go)

    server.tool(Tool(
        name="photo_upload",
        description=(
            "Add a photo to a folder of the library (missing folders are made; a taken name gets \" (2)\"), "
            "from a URL the backend downloads or from base64 bytes. The answer's entry has the real path. "
            "For a file on your own disk, POST it to /api/photos/upload with the API token instead (docs/photos.md). "
            "Requires confirm=true."
        ),
        properties={
            "confirm": confirmed(LIBRARY_WRITE),
            "folder": FOLDER,
            "filename": {"type": "string", "minLength": 1, "maxLength": 255, "description": "Name to store it under; with url, defaults to the URL's file name."},
            "content_base64": {"type": "string"},
            "url": {"type": "string", "description": "http(s) URL of the image."},
        },
        required=["confirm"],
        handler=photo_upload,
    ))

    async def photo_folder_create(confirm: bool, path: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", "/api/photos/folders", project_id, json={"path": path}))

    server.tool(Tool(
        name="photo_folder_create",
        description="Make a folder (an album when it is at the root); missing parents are made too. Requires confirm=true.",
        properties={"confirm": confirmed(LIBRARY_WRITE), "path": {**PATH, "minLength": 1}},
        required=["confirm", "path"],
        handler=photo_folder_create,
    ))

    async def photos_move(confirm: bool, paths: list[str], to: str = "", project_id: int | None = None):
        return await run(lambda: _json(api, "POST", "/api/photos/move", project_id, json={"paths": paths, "to": to}))

    server.tool(Tool(
        name="photos_move",
        description=(
            "Move files and folders into an existing folder (`to`, \"\" for the root). Taken names get \" (2)\"; "
            "nothing moves when one path is missing. Share links follow their folders. Requires confirm=true."
        ),
        properties={"confirm": confirmed(LIBRARY_WRITE), "paths": PATHS, "to": FOLDER},
        required=["confirm", "paths"],
        handler=photos_move,
    ))

    async def photo_rename(confirm: bool, path: str, name: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", "/api/photos/rename", project_id, json={"path": path, "name": name}))

    server.tool(Tool(
        name="photo_rename",
        description="Rename a file or folder in place (`name` is the new last segment). A photo keeps its color profile; share links follow. Requires confirm=true.",
        properties={"confirm": confirmed(LIBRARY_WRITE), "path": {**PATH, "minLength": 1}, "name": {"type": "string", "minLength": 1, "maxLength": 255}},
        required=["confirm", "path", "name"],
        handler=photo_rename,
    ))

    async def photos_delete(confirm: bool, paths: list[str], project_id: int | None = None):
        return await run(lambda: _json(api, "POST", "/api/photos/delete", project_id, json={"paths": paths}))

    server.tool(Tool(
        name="photos_delete",
        description="Delete files and folders for good. A folder goes with everything in it and with the share links at or below it, so frames playing those links stop. Requires confirm=true.",
        properties={"confirm": confirmed("deletes photos for good, from every frame that plays them"), "paths": PATHS},
        required=["confirm", "paths"],
        annotations={"destructiveHint": True},
        handler=photos_delete,
    ))

    async def photo_colors_set(confirm: bool, path: str, colors: dict[str, Any] | None, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", "/api/photos/colors", project_id, json={"path": path, "colors": colors}))

    server.tool(Tool(
        name="photo_colors_set",
        description=(
            "Set a photo's color profile, which frames apply when they show it (docs/asset-color-profiles.md: "
            "exposure, contrast, whites, blacks, saturation, shadows/midtones/highlights, hues, palette). "
            "colors=null removes it, so each frame fits the photo to its panel itself. Requires confirm=true."
        ),
        properties={
            "confirm": confirmed(LIBRARY_WRITE),
            "path": {**PATH, "minLength": 1},
            "colors": {
                "type": ["object", "null"],
                "description": "The profile's `colors` object, e.g. {\"exposure\": 0.3, \"saturation\": 20}; null to remove.",
            },
        },
        required=["confirm", "path", "colors"],
        handler=photo_colors_set,
    ))

    # -- share links ---------------------------------------------------------

    async def photo_shares_list(project_id: int | None = None):
        return await run(lambda: _json(api, "GET", "/api/photos/shares", project_id))

    server.tool(Tool(
        name="photo_shares_list",
        description="The library's share links: token, folder and url. On the backend the url is relative; a frame puts its own server address in front.",
        annotations={"readOnlyHint": True},
        handler=photo_shares_list,
    ))

    async def photo_share_create(confirm: bool, path: str, project_id: int | None = None):
        return await run(lambda: _json(api, "POST", "/api/photos/shares", project_id, json={"path": path}))

    server.tool(Tool(
        name="photo_share_create",
        description="The folder's share link (an existing one is returned as it is). Anyone with the link can see every photo below the folder, with no login. Requires confirm=true.",
        properties={
            "confirm": confirmed("makes the folder's photos readable by anyone who has the link"),
            "path": {**PATH, "minLength": 1, "description": "Folder to share (not the root)."},
        },
        required=["confirm", "path"],
        handler=photo_share_create,
    ))

    async def photo_share_delete(confirm: bool, token: str, project_id: int | None = None):
        return await run(lambda: _json(api, "DELETE", f"/api/photos/shares/{token}", project_id))

    server.tool(Tool(
        name="photo_share_delete",
        description="Revoke a share link. Frames playing it stop getting photos. Requires confirm=true.",
        properties={
            "confirm": confirmed("stops every frame that plays this link"),
            "token": {"type": "string", "pattern": "^pk_[A-Za-z0-9_-]+$", "description": "pk_... token from photo_shares_list."},
        },
        required=["confirm", "token"],
        annotations={"destructiveHint": True},
        handler=photo_share_delete,
    ))

    # -- frames --------------------------------------------------------------

    async def photo_album_install(
        confirm: bool,
        frame_id: int,
        path: str,
        seconds: float | None = None,
        order: str | None = None,
        fit: str | None = None,
        name: str | None = None,
        activate: bool = False,
        deploy: str = "fast",
        project_id: int | None = None,
    ):
        async def go():
            body: dict[str, Any] = {"path": path, "frame_id": frame_id}
            for key, value in (("seconds", seconds), ("order", order), ("fit", fit), ("name", name)):
                if value is not None:
                    body[key] = value
            made = await api.json("POST", "/api/photos/scene", project_id=project_id, json=body)
            install = server.tools["frame_scene_install"].handler
            result = await install(
                confirm=True,
                frame_id=frame_id,
                scenes=[made["scene"]],
                activate=activate,
                preserve_ids=True,
                deploy=deploy,
                project_id=project_id,
            )
            if result.get("isError"):
                return result
            return text({"share": made.get("share"), **_payload(result)})

        return await run(go)

    server.tool(Tool(
        name="photo_album_install",
        description=(
            "Play a folder on a frame: makes the folder's share link (if it has none) and a scene that shows one "
            "photo per `seconds`, installs it on the frame and deploys (the same as Install photo scenes in the "
            "web UI). activate=true shows it now. Requires confirm=true."
        ),
        properties={
            "confirm": confirmed("changes what a physical frame shows"),
            "frame_id": FRAME_ID,
            "path": {**PATH, "minLength": 1, "description": "Folder to play (not the root)."},
            "seconds": {"type": "number", "minimum": 1, "description": "How long each photo stays. Default 3600."},
            "order": {"type": "string", "enum": ["random", "sequential", "newest", "oldest"], "description": "random (default) shows every photo once before any repeats; sequential goes by path."},
            "fit": {"type": "string", "enum": ["cover", "contain"], "description": "cover (default) fills the screen; contain shows the whole photo."},
            "name": {"type": "string", "maxLength": 256, "description": "Scene name. Default: the folder's name."},
            "activate": {"type": "boolean"},
            "deploy": DEPLOY,
        },
        required=["confirm", "frame_id", "path"],
        handler=photo_album_install,
    ))


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    """frame_scene_install's answer, back from its text."""
    texts = [item.get("text", "") for item in result.get("content", []) if item.get("type") == "text"]
    try:
        parsed = json.loads("\n".join(texts))
    except ValueError:
        return {"install": "\n".join(texts)}
    return parsed if isinstance(parsed, dict) else {"install": parsed}


async def _json(api, method: str, path: str, project_id: int | None, **kwargs: Any):
    return text(await api.json(method, path, project_id=project_id, **kwargs))
