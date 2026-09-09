"""Response headers for asset bytes the backend hands a browser from its own
origin (a frame's `/asset?mode=image`, the cloud-drive cover proxy).

Assets are scene-writable on the device and project-member-writable here, so
an SVG with a script in it, or an HTML file, opened inline from the backend
origin would run same-origin with the session cookie. Same treatment the
device runtime applies (frameos/src/frameos/server/routes/
admin_api_assets_routes.nim, `setInertAssetHeaders`): no sniffing, a
sandboxed CSP so nothing that does render can script or frame anything, and
the active types go out as downloads instead of inline."""
from __future__ import annotations

from urllib.parse import quote

ACTIVE_CONTENT_TYPE_PREFIXES = (
    "text/html",
    "application/xhtml",
    "image/svg",
    "application/javascript",
    "text/javascript",
    "text/css",
    "text/xml",
    "application/xml",
)

INERT_ASSET_CSP = "default-src 'none'; sandbox"


def is_active_content_type(content_type: str | None) -> bool:
    lower = (content_type or "").strip().lower()
    return any(lower.startswith(prefix) for prefix in ACTIVE_CONTENT_TYPE_PREFIXES)


def _ascii_filename(filename: str) -> str:
    cleaned = "".join(ch if 32 <= ord(ch) < 127 and ch not in '"\\' else "_" for ch in filename)
    return cleaned or "download"


def content_disposition(filename: str, *, inline: bool) -> str:
    kind = "inline" if inline else "attachment"
    return f'{kind}; filename="{_ascii_filename(filename)}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def inert_asset_headers(content_type: str | None, filename: str, *, inline: bool) -> dict[str, str]:
    """Headers for one asset body. `inline` is what the caller wants; an
    active type is forced to an attachment regardless."""
    return {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": INERT_ASSET_CSP,
        "Content-Disposition": content_disposition(
            filename, inline=inline and not is_active_content_type(content_type)
        ),
    }
