from __future__ import annotations

import asyncio
from http import HTTPStatus
import ipaddress
import ssl
from typing import Any, Optional

import httpx
from cryptography import x509
from cryptography.x509.oid import NameOID
from fastapi import HTTPException

from app.models.frame import Frame, normalize_https_proxy
from app.utils.env import get_env_float, get_env_int
from app.utils.network import is_safe_host
from app.utils.remote_exec import _use_remote
from app.ws.remote_ws import http_get_on_frame
from arq import ArqRedis as Redis


FRAME_HTTP_MAX_CONCURRENCY = get_env_int("FRAME_HTTP_MAX_CONCURRENCY", 200)
FRAME_HTTP_TIMEOUT = httpx.Timeout(
    connect=get_env_float("FRAME_HTTP_CONNECT_TIMEOUT", 10.0),
    read=get_env_float("FRAME_HTTP_READ_TIMEOUT", 20.0),
    write=get_env_float("FRAME_HTTP_WRITE_TIMEOUT", 20.0),
    pool=get_env_float("FRAME_HTTP_POOL_TIMEOUT", 10.0),
)
_frame_http_semaphore = asyncio.Semaphore(FRAME_HTTP_MAX_CONCURRENCY)
FRAME_HTTP_RETRIES = get_env_int("FRAME_HTTP_RETRIES", 2)
DEFAULT_FRAME_HTTPS_PROXY_PORT = 8443


def _build_frame_path(
    frame: Frame,
    path: str,
    method: str = "GET",
) -> str:
    """
    Build the relative path used when talking to the device.

    * For **GET** we keep the historical `?k=` query parameter so the
      WebSocket remote (which cannot add headers) can authenticate.
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
    https_proxy = normalize_https_proxy(frame.https_proxy)
    if https_proxy.get("enable"):
        https_port = https_proxy.get("port") or 0
        return "https", https_port if https_port > 0 else DEFAULT_FRAME_HTTPS_PROXY_PORT
    return "http", frame.frame_port


def _build_frame_url(frame: Frame, path: str, method: str) -> str:
    """Return full http://host:port/… URL (adds access key when required)."""
    if not is_safe_host(frame.frame_host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")

    scheme, port = _frame_scheme_port(frame)
    url = f"{scheme}://{frame.frame_host}:{port}{_build_frame_path(frame, path, method)}"
    return url


def _embedded_last_boot_ip(frame: Frame) -> str | None:
    if (frame.mode or "rpios") != "embedded":
        return None
    embedded = frame.embedded if isinstance(frame.embedded, dict) else {}
    last_boot = embedded.get("lastBoot")
    if not isinstance(last_boot, dict):
        return None
    ip = last_boot.get("ip")
    if not isinstance(ip, str) or not ip.strip() or not is_safe_host(ip):
        return None
    return ip.strip()


def _is_embedded_frame(frame: Frame) -> bool:
    return (frame.mode or "rpios") == "embedded"


def _ip_address(host: str):
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _build_direct_frame_url(frame: Frame, host: str, scheme: str, port: int, path: str, method: str) -> str:
    if not is_safe_host(host):
        raise HTTPException(status_code=400, detail="Unsafe frame host")
    return f"{scheme}://{host}:{port}{_build_frame_path(frame, path, method)}"


def _https_certificate_covers_target(frame: Frame, host: str) -> bool:
    target_ip = _ip_address(host)
    if target_ip is None:
        return True

    https_proxy = normalize_https_proxy(frame.https_proxy)
    cert_pem = (https_proxy.get("certs", {}).get("server") or "").strip()
    if not https_proxy.get("enable") or not cert_pem:
        return True

    try:
        cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
    except ValueError:
        return True

    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        san = None

    if san is not None:
        return target_ip in san.get_values_for_type(x509.IPAddress)

    return any(attr.value == host for attr in cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME))


def _add_direct_candidate(
    candidates: list[tuple[str, Any]],
    frame: Frame,
    host: str,
    scheme: str,
    port: int,
    path: str,
    method: str,
    verify: Any,
) -> None:
    url = _build_direct_frame_url(frame, host, scheme, port, path, method)
    if not any(existing_url == url for existing_url, _ in candidates):
        candidates.append((url, verify))


def _frame_http_direct_candidates(frame: Frame, path: str, method: str) -> list[tuple[str, Any]]:
    scheme, port = _frame_scheme_port(frame)
    candidates: list[tuple[str, Any]] = []
    verify = _httpx_verify(frame)
    original_url = _build_direct_frame_url(frame, frame.frame_host, scheme, port, path, method)
    if scheme != "https" or _https_certificate_covers_target(frame, frame.frame_host):
        candidates.append((original_url, verify))

    boot_ip = _embedded_last_boot_ip(frame)
    if boot_ip:
        fallback_port = int(frame.frame_port or 80)
        _add_direct_candidate(candidates, frame, boot_ip, "http", fallback_port, path, method, True)
    elif _is_embedded_frame(frame) and scheme == "https" and _ip_address(frame.frame_host) is not None:
        fallback_port = int(frame.frame_port or 80)
        _add_direct_candidate(candidates, frame, frame.frame_host, "http", fallback_port, path, method, True)

    if not candidates:
        candidates.append((original_url, verify))
    return candidates


def _httpx_verify(frame: Frame):
    https_proxy = normalize_https_proxy(frame.https_proxy)
    if not https_proxy.get("enable"):
        return True
    ca_cert = (https_proxy.get("certs", {}).get("client_ca") or "").strip()
    if not ca_cert:
        return True

    context = ssl.create_default_context()
    context.load_verify_locations(cadata=ca_cert)
    return context


def _tls_connect_error_detail(frame: Frame, error: str) -> Optional[str]:
    lower_error = error.lower()
    if "certificate_verify_failed" not in lower_error and "certificate verify failed" not in lower_error:
        return None

    if "hostname mismatch" in lower_error:
        return (
            "TLS hostname verification failed while connecting to frame. "
            f"The certificate does not match frame host '{frame.frame_host}'. "
            "Regenerate frame TLS material (or upload a certificate that includes this host in SAN/CN) "
            "and redeploy."
        )
    if "ip address mismatch" in lower_error:
        return (
            "TLS ip address verification failed while connecting to frame. "
            f"The certificate does not match frame ip '{frame.frame_host}'. "
            "Regenerate frame TLS material (or upload a certificate that includes this ip in SAN/CN) "
            "and redeploy."
        )

    return (
        "TLS verification failed while connecting to frame. "
        "Set frame.https_proxy.certs.client_ca to the issuing CA certificate."
    )


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
    body: bytes | str | None = None,
    headers: Optional[dict[str, str]] = None,
) -> tuple[int, bytes, dict[str, str]]:
    """Fetch *path* from the frame returning (status, body-bytes, headers)."""
    if await _use_remote(frame, redis):
        remote_body: str | None
        if isinstance(body, bytes):
            remote_body = body.decode("latin1")
        else:
            remote_body = body
        resp = await http_get_on_frame(
            frame.id,
            _build_frame_path(frame, path, method),
            method=method,
            body=remote_body,
            headers=_auth_headers(frame, headers),
            redis=redis,
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
        raise HTTPException(status_code=500, detail="Bad remote response")

    candidates = _frame_http_direct_candidates(frame, path, method)
    hdrs = _auth_headers(frame, headers)
    timeout_errors = (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.WriteTimeout)
    attempts = max(1, FRAME_HTTP_RETRIES)
    last_error: HTTPException | None = None
    async with _frame_http_semaphore:
        for candidate_index, (url, verify) in enumerate(candidates):
            async with httpx.AsyncClient(verify=verify) as client:
                for attempt in range(1, attempts + 1):
                    try:
                        response = await client.request(
                            method,
                            url,
                            headers=hdrs,
                            content=body,
                            timeout=FRAME_HTTP_TIMEOUT,
                        )
                        return response.status_code, response.content, dict(response.headers)
                    except timeout_errors:
                        if attempt < attempts:
                            await asyncio.sleep(0.15 * attempt)
                            continue
                        last_error = HTTPException(
                            status_code=HTTPStatus.REQUEST_TIMEOUT,
                            detail=f"Timeout to {url}",
                        )
                    except httpx.PoolTimeout:
                        raise HTTPException(
                            status_code=HTTPStatus.SERVICE_UNAVAILABLE,
                            detail="Frame request queue is saturated",
                        )
                    except httpx.ConnectError as exc:
                        if detail := _tls_connect_error_detail(frame, str(exc)):
                            last_error = HTTPException(
                                status_code=HTTPStatus.BAD_GATEWAY,
                                detail=detail,
                            )
                            break
                        last_error = HTTPException(
                            status_code=HTTPStatus.BAD_GATEWAY,
                            detail=str(exc),
                        )
                    except Exception as exc:
                        raise HTTPException(
                            status_code=HTTPStatus.INTERNAL_SERVER_ERROR, detail=str(exc)
                        )
                    break
            if candidate_index < len(candidates) - 1:
                continue

    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=HTTPStatus.BAD_GATEWAY, detail="Frame request failed")
