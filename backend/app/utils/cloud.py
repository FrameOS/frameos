from __future__ import annotations

import base64
import hashlib
from urllib.parse import urlencode, urlparse

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Request

from app.config import config


def state_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def cloud_base_url() -> str:
    return config.FRAMEOS_CLOUD_URL.rstrip("/")


def request_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",", 1)[0].strip()
    proto = forwarded_proto or request.url.scheme
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


def _url_origin(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def _is_loopback(hostname: str | None) -> bool:
    return hostname in {"localhost", "127.0.0.1", "::1"}


def allowed_browser_origins(request: Request) -> set[str]:
    origins = {request_origin(request)}
    origin = _url_origin(request.headers.get("origin"))
    if origin:
        origins.add(origin)
    referer_origin = _url_origin(request.headers.get("referer"))
    if referer_origin:
        origins.add(referer_origin)
    return origins


def sanitize_return_to(request: Request, return_to: str | None) -> str | None:
    if not return_to:
        return None
    value = return_to.strip()
    if not value:
        return None
    if value.startswith("/") and not value.startswith("//"):
        return value

    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        return None

    value_origin = f"{parsed.scheme}://{parsed.netloc}"
    allowed_origins = allowed_browser_origins(request)
    if value_origin in allowed_origins:
        return value

    if config.DEBUG or config.TEST:
        if _is_loopback(parsed.hostname):
            for origin in allowed_origins:
                if _is_loopback(urlparse(origin).hostname):
                    return value

    return None


def return_to_origin(return_to: str | None) -> str | None:
    return _url_origin(return_to)


def build_cloud_auth_url(
    *,
    redirect_uri: str,
    state: str,
    backend_name: str,
    backend_url: str,
) -> str:
    query = urlencode(
        {
            "redirect_uri": redirect_uri,
            "state": state,
            "backend_name": backend_name,
            "backend_url": backend_url,
        }
    )
    return f"{cloud_base_url()}/api/cloud/backend/auth/start?{query}"


def _fernet() -> Fernet:
    digest = hashlib.sha256(config.SECRET_KEY.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def protect_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def unprotect_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return None
