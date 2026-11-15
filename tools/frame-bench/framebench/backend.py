"""The self-hosted backend the bench frames are attached to.

Auth is an API token (`fb_api_...`, Settings -> API tokens, or
`POST /api/user/api_tokens`), taken from $FRAMEOS_BENCH_TOKEN. The bench only
calls routes the SPA calls.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request


class Backend:
    def __init__(self, url: str | None = None, token: str | None = None, project: int = 1):
        self.url = (url or os.environ.get('FRAMEOS_BENCH_BACKEND') or 'http://localhost:8989').rstrip('/')
        self.token = token or os.environ.get('FRAMEOS_BENCH_TOKEN') or ''
        self.project = project

    def _req(self, path, body=None, method=None, headers=None, raw=False, timeout=60, project=True):
        url = self.url + (f'/api/projects/{self.project}' if project else '/api') + path
        data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
        h = {'Authorization': f'Bearer {self.token}'}
        if data is not None:
            h['content-type'] = 'application/json'
        h.update(headers or {})
        req = urllib.request.Request(url, data=data, method=method or ('POST' if data is not None else 'GET'), headers=h)
        t = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            if raw:
                return (time.time() - t) * 1000, resp.status, dict(resp.headers), payload
            return json.loads(payload or b'{}')

    def ok(self) -> bool:
        try:
            self.frames()
            return True
        except Exception:
            return False

    def frames(self) -> list[dict]:
        return self._req('/frames')['frames']

    def frame(self, fid: int) -> dict:
        return self._req(f'/frames/{fid}')['frame']

    def update_frame(self, fid: int, fields: dict):
        return self._req(f'/frames/{fid}', fields)

    def push(self, fid: int):
        """Save & push: the backend's fast deploy (scenes + settings) to an embedded frame."""
        return self._req(f'/frames/{fid}/fast_deploy', {})

    def event(self, fid: int, name: str, payload: dict | None = None):
        return self._req(f'/frames/{fid}/event/{name}', payload or {})

    def device_render(self, fid: int, api_key: str, etag: str | None = None):
        """What a thin client pulls: GET /api/frames/{id}/embedded/render (FOSB 2)."""
        h = {'Authorization': f'Bearer {api_key}', 'X-FrameOS-Fosb': '2'}
        if etag:
            h['If-None-Match'] = etag
        try:
            return self._req(f'/frames/{fid}/embedded/render', headers=h, raw=True, project=False, timeout=180)
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                return 0, 304, dict(exc.headers), b''
            raise
