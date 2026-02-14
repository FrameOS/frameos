from __future__ import annotations

import asyncio
from http import HTTPStatus
import os
import ssl
from typing import Optional

import httpx
from fastapi import HTTPException

from app.models.frame import Frame
from app.utils.network import is_safe_host
from app.utils.remote_exec import _use_agent
from app.ws.agent_ws import http_get_on_frame
from arq import ArqRedis as Redis


def _get_env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


def _get_env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = float(value)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


FRAME_HTTP_MAX_CONCURRENCY = _get_env_int("FRAME_HTTP_MAX_CONCURRENCY", 20)
FRAME_HTTP_TIMEOUT = httpx.Timeout(
    connect=_get_env_float("FRAME_HTTP_CONNECT_TIMEOUT", 2.0),
    read=_get_env_float("FRAME_HTTP_READ_TIMEOUT", 8.0),
    write=_get_env_float("FRAME_HTTP_WRITE_TIMEOUT", 8.0),
    pool=_get_env_float("FRAME_HTTP_POOL_TIMEOUT", 2.0),
)
_frame_http_semaphore = asyncio.Semaphore(FRAME_HTTP_MAX_CONCURRENCY)


def _build_frame_path(
    frame: Frame,
    path: str,
    method: str = "GET",
) -> str:
    """
    Build the relative path used when talking to the device.

    * For **GET** we keep the historical `?k=` query parameter so the
      WebSocket agent (which cannot add headers) can authenticate.
    * For **POST** and every other verb we **omit** the query parameter
      – the plain-HTTP fallback is able to use the `Authorization`
      header instead.
    """
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    if (
        method == "GET"
        and frame.frame_access not in ("public", "protected")
        and frame.frame_access_key
    ):
        sep = "&" if "?" in path else "?"
        path = f"{path}{sep}k={frame.frame_access_key}"
    return path


def _frame_scheme_port(frame: Frame) -> tuple[str, int]:
    if frame.enable_tls:
        tls_port = frame.tls_port or 0
        return "https", tls_port if tls_port > 0 else frame.frame_port
    return "http", frame.frame_port


def _build_frame_url(frame: Frame, path: str, method: str) -> str:
    """Return full http://host:port/… URL (adds access key when required)."""
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    scheme, port = _frame_scheme_port(frame)
    url = f"{scheme}://{frame.frame_host}:{port}{_build_frame_path(frame, path, method)}"
    return url


def _httpx_verify(frame: Frame):
    if not frame.enable_tls:
        return True
    ca_cert = (frame.tls_client_ca_cert or "").strip()
    if not ca_cert:
        return True

    context = ssl.create_default_context()
    context.load_verify_locations(cadata=ca_cert)
    return context


def _auth_headers(
    frame: Frame, hdrs: Optional[dict[str, str]] = None
) -> dict[str, str]:
    """
    Inject HTTP Authorization header when the frame is not public.
    """
    hdrs = dict(hdrs or {})
    if frame.frame_access != "public" and frame.frame_access_key:
        hdrs.setdefault("Authorization", f"Bearer {frame.frame_access_key}")
    return hdrs


async def _fetch_frame_http_bytes(
    frame: Frame,
    redis: Redis,
    *,
    path: str,
    method: str = "GET",
) -> tuple[int, bytes, dict[str, str]]:
    """Fetch *path* from the frame returning (status, body-bytes, headers)."""
    if await _use_agent(frame, redis):
        resp = await http_get_on_frame(
            frame.id,
            _build_frame_path(frame, path, method),
            method=method,
            headers=_auth_headers(frame),
        )
        if isinstance(resp, dict):
            status = int(resp.get("status", 0))
            if resp.get("binary"):
                body = resp.get("body", b"")  # already bytes
            else:
                raw = resp.get("body", "")
                body = raw.encode("latin1") if isinstance(raw, str) else raw
            hdrs = {
                str(k).lower(): str(v) for k, v in (resp.get("headers") or {}).items()
            }
            return status, body, hdrs
        raise HTTPException(status_code=500, detail="Bad agent response")

    url = _build_frame_url(frame, path, method)
    hdrs = _auth_headers(frame)
    verify = _httpx_verify(frame)
    async with _frame_http_semaphore:
        async with httpx.AsyncClient(verify=verify) as client:
            try:
                response = await client.request(
                    method,
                    url,
                    headers=hdrs,
                    timeout=FRAME_HTTP_TIMEOUT,
                )
            except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.WriteTimeout):
                raise HTTPException(
                    status_code=HTTPStatus.REQUEST_TIMEOUT,
                    detail=f"Timeout to {url}",
                )
            except httpx.PoolTimeout:
                raise HTTPException(
                    status_code=HTTPStatus.SERVICE_UNAVAILABLE,
                    detail="Frame request queue is saturated",
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc)
                )

    return response.status_code, response.content, dict(response.headers)
