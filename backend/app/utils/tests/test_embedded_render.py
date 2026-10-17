import asyncio
from pathlib import Path

import pytest

from app.utils.embedded_render import (
    RENDER_RETRY_AFTER_SECONDS,
    RenderQueueFull,
    _SAVED_ASSETS_MARKER,
    _STATE_MARKER,
    _parse_marker,
)

STDERR = """[scene] {"event":"render:done","sceneId":"scene-a","ms":1.0}
__FRAMEOS_SCENE_STATE__{"sceneId":"scene-a","state":{"word":"hi"},"seeded":true}
__FRAMEOS_SAVED_ASSETS__{"files":["wikicommons/a.jpg"],"skippedOverBudget":1}
"""


def test_parse_marker_extracts_each_payload():
    state = _parse_marker(STDERR, _STATE_MARKER)
    assert state == {"sceneId": "scene-a", "state": {"word": "hi"}, "seeded": True}
    saved = _parse_marker(STDERR, _SAVED_ASSETS_MARKER)
    assert saved == {"files": ["wikicommons/a.jpg"], "skippedOverBudget": 1}


def test_parse_marker_missing_and_invalid():
    assert _parse_marker("[scene] nothing here\n", _STATE_MARKER) is None
    assert _parse_marker(f"{_STATE_MARKER}not-json\n", _STATE_MARKER) is None
    # A spoofed marker mid-line does not match; only line starts count.
    assert _parse_marker(f"[scene] {_STATE_MARKER}{{}}\n", _STATE_MARKER) is None


def test_parse_marker_takes_last_line():
    text = (
        f'{_STATE_MARKER}{{"sceneId":"old"}}\n'
        f'{_STATE_MARKER}{{"sceneId":"new"}}\n'
    )
    assert _parse_marker(text, _STATE_MARKER) == {"sceneId": "new"}


@pytest.mark.asyncio
async def test_render_queue_refuses_past_the_waiter_cap(monkeypatch, tmp_path):
    """Two slots and a bounded queue behind them: with the slots busy and
    MAX_RENDER_WAITERS coroutines already waiting, the next render raises
    RenderQueueFull instead of parking; once a slot frees, the queue drains
    and new renders are accepted again."""
    from types import SimpleNamespace

    from app.utils import embedded_render

    release = asyncio.Event()
    started = 0

    class FakeProcess:
        returncode = 0

        async def communicate(self, _input):
            nonlocal started
            started += 1
            await release.wait()
            return b"\x00" * 16, b""

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(embedded_render.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(embedded_render.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(embedded_render, "wasm_assets_dir", lambda: tmp_path)
    monkeypatch.setattr(embedded_render, "RENDER_HARNESS", Path(embedded_render.__file__))
    monkeypatch.setattr(embedded_render, "_render_semaphore", asyncio.Semaphore(embedded_render.RENDER_CONCURRENCY))
    monkeypatch.setattr(embedded_render, "_render_waiters", 0)

    frame = SimpleNamespace(id=1, name="f", timezone=None, network={}, scenes=[{"id": "s", "nodes": [], "edges": []}])

    async def render():
        return await embedded_render.render_scene_rgba(frame, 2, 2)

    tasks = [
        asyncio.create_task(render())
        for _ in range(embedded_render.RENDER_CONCURRENCY + embedded_render.MAX_RENDER_WAITERS)
    ]
    for _ in range(20):
        await asyncio.sleep(0)
    assert started == embedded_render.RENDER_CONCURRENCY
    assert embedded_render.render_queue_depth() == embedded_render.MAX_RENDER_WAITERS

    with pytest.raises(RenderQueueFull) as exc:
        await render()
    assert exc.value.retry_after == RENDER_RETRY_AFTER_SECONDS

    release.set()
    results = await asyncio.gather(*tasks)
    assert all(result == b"\x00" * 16 for result in results)
    assert embedded_render.render_queue_depth() == 0
    assert await render() == b"\x00" * 16
