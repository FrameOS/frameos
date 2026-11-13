import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.utils.embedded_render import (
    RENDER_RETRY_AFTER_SECONDS,
    RenderQueueFull,
    _SAVED_ASSETS_MARKER,
    _STATE_MARKER,
    _parse_marker,
)
from app.utils.device_limits import esp32_device_limits

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


@pytest.mark.asyncio
async def test_a_render_under_a_device_ceiling_reports_running_out(monkeypatch, tmp_path):
    """The harness gets the ceiling, and a refused allocation comes back as
    out_of_memory with the scene's log lines, not as a bare None."""
    from types import SimpleNamespace

    from app.utils import embedded_render

    sent: list[dict] = []

    class FakeProcess:
        returncode = 1

        async def communicate(self, request):
            sent.append(json.loads(request))
            return b"", (
                b'[scene] {"event":"render:scene","sceneId":"s"}\n'
                b'__FRAMEOS_OUT_OF_MEMORY__{"refusedBytes":7680004,"usedBytes":8416300}\n'
                b"embedded_wasm_render: render ran out of memory\n"
            )

    async def fake_exec(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(embedded_render.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(embedded_render.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(embedded_render, "wasm_assets_dir", lambda: tmp_path)
    monkeypatch.setattr(embedded_render, "RENDER_HARNESS", Path(embedded_render.__file__))
    monkeypatch.setattr(embedded_render, "_render_semaphore", asyncio.Semaphore(embedded_render.RENDER_CONCURRENCY))
    monkeypatch.setattr(embedded_render, "_render_waiters", 0)

    frame = SimpleNamespace(id=1, name="f", timezone=None, network={}, scenes=[{"id": "s", "nodes": [], "edges": []}])
    limits = esp32_device_limits(1200, 1600, 8 * 1024 * 1024)
    result = await embedded_render.render_scene(frame, 1200, 1600, device_limits=limits)

    assert sent[0]["deviceLimits"] == limits
    assert result.rgba is None
    assert result.out_of_memory == {"refusedBytes": 7680004, "usedBytes": 8416300}
    assert result.error == "render ran out of memory"
    assert result.scene_logs == ['{"event":"render:scene","sceneId":"s"}']


@pytest.mark.asyncio
async def test_the_harness_gets_the_frames_render_scale_only_when_set(monkeypatch, tmp_path):
    """A frame's own scale rides the request; automatic (0, or a preview with
    no frame row behind it) leaves it to the runtime."""
    from types import SimpleNamespace

    from app.utils import embedded_render

    sent: list[dict] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self, request):
            sent.append(json.loads(request))
            return b"\x00" * 16, b""

    async def fake_exec(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(embedded_render.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(embedded_render.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(embedded_render, "wasm_assets_dir", lambda: tmp_path)
    monkeypatch.setattr(embedded_render, "RENDER_HARNESS", Path(embedded_render.__file__))
    monkeypatch.setattr(embedded_render, "_render_semaphore", asyncio.Semaphore(embedded_render.RENDER_CONCURRENCY))
    monkeypatch.setattr(embedded_render, "_render_waiters", 0)

    scenes = [{"id": "s", "nodes": [], "edges": []}]
    for render_scale in (1.5, 0, None):
        frame = SimpleNamespace(id=1, name="f", timezone=None, network={}, scenes=scenes, render_scale=render_scale)
        await embedded_render.render_scene(frame, 2, 2)
    without_column = SimpleNamespace(id=0, name="f", timezone=None, network={}, scenes=scenes)
    await embedded_render.render_scene(without_column, 2, 2)

    assert sent[0]["renderScale"] == 1.5
    assert ["renderScale" in request for request in sent[1:]] == [False, False, False]


# The renderer's HTTP child checks the address its socket connects to (its
# own lookup), not a lookup made before the request: a name checked once and
# resolved again by fetch could answer the second query with a private
# address (DNS rebinding). `localhost` is the one name a test resolves without
# the network; nothing is listening on the port, so a request that got past
# the check would fail with a connection error instead.
_CHILD_RUNNER = r"""
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const source = readFileSync(process.argv[1], 'utf-8');
const literal = source.split('const FETCH_CHILD_SCRIPT = `')[1].split('\n`\n\n// Set once')[0];
const script = new Function('return `' + literal + '\n`')();
const results = JSON.parse(process.argv[2]).map((req) => {
  const child = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(req), encoding: 'utf-8', timeout: 15000 });
  return JSON.parse(child.stdout || '{}');
});
process.stdout.write(JSON.stringify(results));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="no node on PATH")
def test_renderer_http_child_checks_what_the_socket_connects_to():
    script = Path(__file__).resolve().parents[3] / "tools" / "embedded_wasm_render.mjs"
    requests = [
        {"method": "GET", "url": "http://localhost:9/"},
        {"method": "GET", "url": "http://127.0.0.1:9/"},
        {"method": "GET", "url": "http://metadata.google.internal/", "allowLocalNetwork": True},
    ]
    completed = subprocess.run(
        ["node", "-e", _CHILD_RUNNER, str(script), json.dumps(requests)],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    name, literal, metadata = json.loads(completed.stdout)
    assert name["status"] == 0 and "local network access is off" in name["error"]
    assert literal["status"] == 0 and "local network access is off" in literal["error"]
    assert metadata["status"] == 0 and "cloud metadata address" in metadata["error"]


@pytest.mark.asyncio
async def test_a_thin_clients_presses_go_to_the_harness_with_the_render(monkeypatch, tmp_path):
    """The edges ride the render request; a pull without any sends none, and
    the scene's log lines come back to a caller that collects them."""
    from types import SimpleNamespace

    from app.utils import embedded_render

    sent: list[dict] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self, request):
            sent.append(json.loads(request))
            return b"\x00" * 16, b'[scene] {"event":"event:button","origin":"driver"}\n'

    async def fake_exec(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(embedded_render.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(embedded_render.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(embedded_render, "wasm_assets_dir", lambda: tmp_path)
    monkeypatch.setattr(embedded_render, "RENDER_HARNESS", Path(embedded_render.__file__))
    monkeypatch.setattr(embedded_render, "_render_semaphore", asyncio.Semaphore(embedded_render.RENDER_CONCURRENCY))
    monkeypatch.setattr(embedded_render, "_render_waiters", 0)

    frame = SimpleNamespace(id=1, name="f", timezone=None, network={}, scenes=[{"id": "s", "nodes": [], "edges": []}])
    tap = {"nowMs": 900, "edges": [{"label": "B", "action": "down", "atMs": 400}]}
    logs: list[str] = []
    await embedded_render.render_scene_rgba_and_state(frame, 2, 2, device_input=tap, scene_logs=logs)
    await embedded_render.render_scene_rgba_and_state(frame, 2, 2, device_input={"nowMs": 900, "edges": []})
    await embedded_render.render_scene_rgba_and_state(frame, 2, 2)

    assert json.loads(sent[0]["deviceInputJson"]) == tap
    assert "deviceInputJson" not in sent[1] and "deviceInputJson" not in sent[2]
    assert logs == ['{"event":"event:button","origin":"driver"}']


def _renderer_takes_device_input() -> bool:
    from app.utils.embedded_render import thin_client_renderer_available, wasm_assets_dir

    assets = wasm_assets_dir()
    return (
        thin_client_renderer_available()
        and assets is not None
        and "frameos_wasm_device_input" in (assets / "frameos.js").read_text(errors="replace")
    )


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_device_input(), reason="no wasm bundle with frameos_wasm_device_input")
async def test_a_relayed_tap_reaches_the_scene_in_the_real_runtime():
    """Through the harness and the wasm runtime: a tap the board saw is the
    driver's `gpio` down and up, the `press` they make, and what the scene's
    `button` listener does with it, before the render."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    scene = {
        "id": "taps",
        "name": "Taps",
        "default": True,
        "settings": {"execution": "interpreted"},
        "fields": [{"name": "taps", "type": "integer", "value": "0", "access": "public"}],
        "nodes": [
            {"id": "press", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "button"}},
            {"id": "count", "type": "app", "position": {"x": 0, "y": 0},
             "data": {"keyword": "logic/setAsState", "config": {"stateKey": "taps"}}},
            {"id": "next", "type": "code", "position": {"x": 0, "y": 0},
             "data": {"code": "", "codeArgs": [], "codeOutputs": [{"name": "valueJson", "type": "json"}],
                      "codeJS": "Number(state.taps || 0) + 1"}},
            {"id": "render", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "render"}},
            {"id": "color", "type": "app", "position": {"x": 0, "y": 0},
             "data": {"keyword": "render/color", "config": {"color": "#ffffff"}}},
        ],
        "edges": [
            {"id": "e1", "source": "press", "sourceHandle": "next", "target": "count", "targetHandle": "prev"},
            {"id": "e2", "source": "next", "sourceHandle": "fieldOutput", "target": "count",
             "targetHandle": "fieldInput/valueJson"},
            {"id": "e3", "source": "render", "sourceHandle": "next", "target": "color", "targetHandle": "prev"},
        ],
    }
    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[scene])
    tap = {"nowMs": 10_600, "edges": [
        {"label": "B", "action": "down", "atMs": 10_000}, {"label": "B", "action": "up", "atMs": 10_080}]}

    result = await render_scene(frame, 16, 16, scene_states={"taps": {"taps": 4}}, device_input=tap)

    assert result.rgba is not None, result.error
    assert result.state["state"]["taps"] == 5
    events = [json.loads(line) for line in result.scene_logs if line.startswith("{")]
    heard = [(e["event"], e["payload"]["action"]) for e in events if e.get("origin") == "driver"]
    assert heard == [("event:gpio", "down"), ("event:gpio", "up"), ("event:button", "press")]


def _renderer_takes_control_events() -> bool:
    from app.utils.embedded_render import thin_client_renderer_available, wasm_assets_dir

    assets = wasm_assets_dir()
    return (
        thin_client_renderer_available()
        and assets is not None
        and "frameos_wasm_control_event" in (assets / "frameos.js").read_text(errors="replace")
    )


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_control_events(), reason="no wasm bundle with frameos_wasm_control_event")
async def test_a_held_custom_event_reaches_the_scene_in_the_real_runtime():
    """A custom event the backend held for a thin client runs in the scene,
    from `http:admin`, before the render; an origin no control plane is
    refused."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    scene = {
        "id": "pager",
        "name": "Pager",
        "default": True,
        "settings": {"execution": "interpreted"},
        "fields": [{"name": "page", "type": "integer", "value": "1", "access": "public"}],
        "nodes": [
            {"id": "turn", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "nextPage"}},
            {"id": "set", "type": "app", "position": {"x": 0, "y": 0},
             "data": {"keyword": "logic/setAsState", "config": {"stateKey": "page"}}},
            {"id": "value", "type": "code", "position": {"x": 0, "y": 0},
             "data": {"code": "", "codeArgs": [], "codeOutputs": [{"name": "valueJson", "type": "json"}],
                      "codeJS": "Number(state.page || 0) + Number(context.payload.by || 1)"}},
            {"id": "render", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "render"}},
            {"id": "color", "type": "app", "position": {"x": 0, "y": 0},
             "data": {"keyword": "render/color", "config": {"color": "#ffffff"}}},
        ],
        "edges": [
            {"id": "e1", "source": "turn", "sourceHandle": "next", "target": "set", "targetHandle": "prev"},
            {"id": "e2", "source": "value", "sourceHandle": "fieldOutput", "target": "set",
             "targetHandle": "fieldInput/valueJson"},
            {"id": "e3", "source": "render", "sourceHandle": "next", "target": "color", "targetHandle": "prev"},
        ],
        "customEvents": [{"name": "nextPage"}],
    }
    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[scene])
    events = [
        {"name": "nextPage", "payload": {"by": 2}, "origin": "http:admin"},
        {"name": "nextPage", "payload": {"by": 100}, "origin": "driver"},
    ]

    result = await render_scene(frame, 16, 16, scene_states={"pager": {"page": 4}}, control_events=events)

    assert result.rgba is not None, result.error
    assert result.state["state"]["page"] == 6
    heard = [json.loads(line) for line in result.scene_logs if line.startswith('{"event":"event:nextPage"')]
    assert [entry.get("origin") for entry in heard] == ["http:admin"]


def _renderer_takes_relayed_events() -> bool:
    from app.utils.embedded_render import thin_client_renderer_available, wasm_assets_dir

    assets = wasm_assets_dir()
    return (
        thin_client_renderer_available()
        and assets is not None
        and "frameos_wasm_set_frame" in (assets / "frameos.js").read_text(errors="replace")
    )


def _plain_scene(scene_id: str, color: str, default: bool = False) -> dict:
    return {
        "id": scene_id,
        "name": scene_id.title(),
        **({"default": True} if default else {}),
        "settings": {"execution": "interpreted"},
        "fields": [],
        "nodes": [
            {"id": "render", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "render"}},
            {"id": "color", "type": "app", "position": {"x": 0, "y": 0},
             "data": {"keyword": "render/color", "config": {"color": color}}},
        ],
        "edges": [{"id": "e1", "source": "render", "sourceHandle": "next", "target": "color", "targetHandle": "prev"}],
    }


RELAY_SCENES = [_plain_scene("clock", "#ffffff", default=True), _plain_scene("photos", "#000000")]


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_relayed_events(), reason="no wasm bundle with frameos_wasm_set_frame")
async def test_a_held_key_switches_scenes_through_the_frames_event_map_in_the_real_runtime():
    """docs/server-rendering.md "Keys, touch and the schedule": an ESP32's
    RIGHT held a second, relayed as its driver's two `gpio` edges, is the
    `longPress` the frame's event map makes the next scene, in the render
    the pull asked for. What the plane sent it itself is not delivered."""
    from types import SimpleNamespace

    from app.tasks.embedded_firmware import EMBEDDED_SEEED_RETERMINAL_E10XX_EVENT_MAP
    from app.utils.embedded_render import render_scene

    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=RELAY_SCENES)
    held = {"nowMs": 20_000, "events": [
        {"origin": "driver", "name": "gpio",
         "payload": {"pin": 3, "label": "RIGHT", "level": 0, "action": "down", "atMs": 18_000}},
        {"origin": "driver", "name": "gpio",
         "payload": {"pin": 3, "label": "RIGHT", "level": 1, "action": "up", "atMs": 19_200}},
    ]}
    frame_json = {"eventMap": EMBEDDED_SEEED_RETERMINAL_E10XX_EVENT_MAP, "palette": [], "colors": {}}

    switched = await render_scene(frame, 16, 16, scene_id="clock", device_input=held, frame_json=frame_json)
    assert switched.rgba is not None, switched.error
    assert switched.state["sceneId"] == "photos"
    assert switched.rgba[:4] == bytes((0, 0, 0, 255))
    assert switched.palette == []

    # Without the map the same hold is a long press nobody maps.
    unmapped = await render_scene(frame, 16, 16, scene_id="clock", device_input=held)
    assert unmapped.state["sceneId"] == "clock"


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_relayed_events(), reason="no wasm bundle with frameos_wasm_set_frame")
async def test_a_relayed_schedule_entry_switches_and_the_planes_own_origin_does_not():
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=RELAY_SCENES)
    scheduled = await render_scene(frame, 16, 16, scene_id="clock", device_input={"nowMs": 5, "events": [
        {"origin": "schedule", "name": "setCurrentScene", "payload": {"sceneId": "photos"}}]})
    assert scheduled.state["sceneId"] == "photos"
    claimed = await render_scene(frame, 16, 16, scene_id="clock", device_input={"nowMs": 5, "events": [
        {"origin": "cloud", "name": "setCurrentScene", "payload": {"sceneId": "photos"}}]})
    assert claimed.state["sceneId"] == "clock"


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_relayed_events(), reason="no wasm bundle with frameos_wasm_set_frame")
async def test_the_scene_switcher_opens_again_where_the_plane_left_it_in_the_real_runtime():
    """A fresh process per pull: the switcher a swipe opened comes back with
    what it was opened from and its highlight, and a key walks on from there."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=RELAY_SCENES)
    kept = {"system/sceneSwitcher": {"from": "clock", "highlight": "photos", "page": 0}}

    reopened = await render_scene(frame, 64, 64, scene_id="system/sceneSwitcher", scene_states=kept)
    assert reopened.rgba is not None, reopened.error
    assert reopened.state["sceneId"] == "system/sceneSwitcher"
    assert reopened.state["state"]["from"] == "clock"
    assert reopened.state["state"]["highlight"] == "photos"

    # `B` is a `next` key (buttons.roleByLabel): one step on, wrapping round.
    tap = {"nowMs": 10_600, "edges": [
        {"label": "B", "action": "down", "atMs": 10_000}, {"label": "B", "action": "up", "atMs": 10_080}]}
    walked = await render_scene(frame, 64, 64, scene_id="system/sceneSwitcher", scene_states=kept, device_input=tap)
    assert walked.state["sceneId"] == "system/sceneSwitcher"
    assert walked.state["state"]["highlight"] == "clock"
    assert walked.state["state"]["from"] == "clock"


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_relayed_events(), reason="no wasm bundle with frameos_wasm_set_frame")
async def test_the_scene_settings_open_again_and_the_frame_page_has_nothing_to_show_on_a_plane():
    """The settings' frame page is built from the device's facts; the plane
    has none, so the gear is not offered and asking for the page draws the
    scene's form instead of failing."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=RELAY_SCENES)
    kept = {"system/sceneSettings": {"from": "clock", "fields": [], "values": {}, "opened": "frame"}}
    result = await render_scene(frame, 64, 64, scene_id="system/sceneSettings", scene_states=kept)
    assert result.rgba is not None, result.error
    assert result.state["sceneId"] == "system/sceneSettings"
    assert result.state["state"]["from"] == "clock"
    assert result.state["state"].get("page") != "frame"


# A tap relayed to the plane lands on what the glass shows: a UI's clickable
# regions and its handlers are the last render's (frameos/ui/events.nim), and
# a plane renders in a fresh process, so a pull carrying pointer events draws
# the scene once first (wasm_main.nim frameos_wasm_device_input, found on the
# bench 2026-11-12: a tap on the E1003 did nothing). Pointer positions travel
# as the touch driver sends them: 0..32767 across the picture (fos_touch_wire).
WIRE_MAX = 32767
_relayed_taps_land: bool | None = None


def _wire(pixel: float, size: int) -> int:
    return round(pixel * WIRE_MAX / (size - 1))


def _relayed_tap(x: int, y: int) -> dict:
    """A tap decided on the board a second before it sent it."""
    def edge(name: str, buttons: int, at_ms: int) -> dict:
        return {"origin": "driver", "name": name, "payload": {
            "x": x, "y": y, "pointerId": 1, "pointerType": "touch", "button": 0, "buttons": buttons, "atMs": at_ms}}
    return {"nowMs": 31_000, "events": [edge("pointerDown", 1, 29_900), edge("pointerUp", 0, 29_980)]}


async def _skip_unless_relayed_taps_land() -> None:
    """A bundle from before the fix renders once per pull, however much
    pointer input it carries: there the taps below cannot land, and the test
    is skipped, not failed. A pull carrying one pointer event renders twice in
    a bundle with the fix (asked once per session)."""
    global _relayed_taps_land
    if _relayed_taps_land is None:
        from types import SimpleNamespace
        from typing import Any

        from app.utils.embedded_render import render_scene

        frame: Any = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=RELAY_SCENES)
        probe = await render_scene(frame, 16, 16, scene_id="clock", device_input={"nowMs": 5, "events": [
            {"origin": "driver", "name": "pointerMove", "payload": {"x": 1, "y": 1, "pointerId": 1}}]})
        renders = sum('"event":"render:scene"' in line for line in probe.scene_logs)
        _relayed_taps_land = renders >= 2
    if not _relayed_taps_land:
        pytest.skip("wasm bundle from before relayed taps drew the scene first (rebuild frameos/tools/build_wasm.sh)")


TAP_UI_SOURCE = """
let tapped = false
export function get(app) {
  return (
    <div className={tapped ? "flex w-full h-full bg-white" : "flex w-full h-full bg-black"}>
      <div className="w-1/2 h-full" />
      <div className="w-1/2 h-full bg-red-500" onClick={() => { tapped = true }} />
    </div>
  )
}
"""

TAP_UI_SCENE = {
    "id": "tap-ui",
    "name": "Tap UI",
    "default": True,
    "settings": {"execution": "interpreted"},
    "fields": [],
    "nodes": [
        {"id": "render", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "render"}},
        {"id": "ui", "type": "app", "position": {"x": 0, "y": 200}, "data": {"keyword": "jsxUi", "config": {}}},
        {"id": "image", "type": "app", "position": {"x": 300, "y": 0},
         "data": {"keyword": "render/image", "config": {"placement": "stretch"}}},
    ],
    "edges": [
        {"id": "render-image", "type": "appNodeEdge", "source": "render", "target": "image",
         "sourceHandle": "next", "targetHandle": "prev"},
        {"id": "ui-image", "type": "codeNodeEdge", "source": "ui", "target": "image",
         "sourceHandle": "fieldOutput", "targetHandle": "fieldInput/image"},
    ],
    "apps": {"jsxUi": {
        "origin": "jsxUi", "name": "Tap UI", "category": "data", "description": "", "version": "1.0.0",
        "fields": [], "output": [{"name": "image", "type": "image"}],
        "sources": {
            "config.json": json.dumps({"name": "Tap UI", "category": "data", "description": "", "version": "1.0.0",
                                       "fields": [], "output": [{"name": "image", "type": "image"}],
                                       "permissions": []}),
            "app.tsx": TAP_UI_SOURCE,
        },
    }},
}


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_relayed_events(), reason="no wasm bundle with frameos_wasm_set_frame")
async def test_a_relayed_tap_lands_on_a_ui_in_the_real_runtime():
    """The board's two touch reports over the UI's right half run its
    onClick in the render the pull asked for; the same tap on the left half,
    and no tap at all, leave it as it was."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    await _skip_unless_relayed_taps_land()
    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[TAP_UI_SCENE])
    width, height = 80, 60

    untouched = await render_scene(frame, width, height)
    assert untouched.rgba is not None, untouched.error
    assert untouched.rgba[:3] == bytes((0, 0, 0))

    right = await render_scene(frame, width, height, device_input=_relayed_tap(
        _wire(width * 0.75, width), _wire(height / 2, height)))
    assert right.rgba is not None, right.error
    assert right.rgba[:3] == bytes((255, 255, 255))

    left = await render_scene(frame, width, height, device_input=_relayed_tap(
        _wire(width * 0.25, width), _wire(height / 2, height)))
    assert left.rgba[:3] == bytes((0, 0, 0))


FIELD_UI_SOURCE = """
let name = ''
export function get(app) {
  return (
    <div className="flex flex-col w-full h-full bg-white">
      <input className="h-10 px-2 shrink-0 bg-slate-100 text-black" value={name}
        onChange={(e) => { name = e.target.value; frameos.setState('name', name) }} />
    </div>
  )
}
"""

FIELD_UI_SCENE = {
    **TAP_UI_SCENE,
    "id": "field-ui",
    "name": "Field UI",
    "apps": {"jsxUi": {
        **TAP_UI_SCENE["apps"]["jsxUi"],  # type: ignore[index]
        "sources": {**TAP_UI_SCENE["apps"]["jsxUi"]["sources"], "app.tsx": FIELD_UI_SOURCE},  # type: ignore[index]
    }},
}


def _renderer_keeps_state() -> bool:
    from app.utils.embedded_render import wasm_assets_dir

    assets = wasm_assets_dir()
    return (
        _renderer_takes_relayed_events()
        and assets is not None
        and "frameos_wasm_set_kept_state" in (assets / "frameos.js").read_text(errors="replace")
    )


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_keeps_state(), reason="no wasm bundle with frameos_wasm_set_kept_state")
async def test_a_key_on_the_keyboard_a_tap_brought_up_types_in_the_next_pull():
    """docs/server-rendering.md "Kept between pulls", on the bench as the
    E1003's forms: a tap on the field brings the keyboard up, and the next
    pull's tap on a key types into the field, though each pull is a new
    process. Without what the first pull's UI kept, the same tap lands on the
    form under where the keyboard was, and types nothing."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    await _skip_unless_relayed_taps_land()
    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[FIELD_UI_SCENE])
    width, height = 320, 240

    focused = await render_scene(frame, width, height, device_input=_relayed_tap(
        _wire(width / 2, width), _wire(20, height)))
    assert focused.rgba is not None, focused.error
    assert focused.state is not None
    kept = json.loads(focused.state["keptState"])
    assert kept["targets"][0]["keyboard"] is True and kept["targets"][0]["focus"] > 0
    # The keyboard is on the picture: its bottom half, zinc-900 at the left edge.
    assert focused.rgba[(236 * width + 2) * 4:(236 * width + 2) * 4 + 3] == bytes((0x18, 0x18, 0x1B))

    # The top left key of the letters, a keyboard's height (half of 240) from the bottom.
    key_tap = _relayed_tap(_wire(2, width), _wire(122, height))
    typed = await render_scene(frame, width, height, device_input=key_tap, kept_state=focused.state["keptState"])
    assert typed.rgba is not None, typed.error
    assert typed.state is not None
    assert typed.state["state"].get("name") == "q"
    assert json.loads(typed.state["keptState"])["targets"][0]["text"] == "q"

    forgotten = await render_scene(frame, width, height, device_input=key_tap)
    assert forgotten.state is not None
    assert "name" not in forgotten.state["state"]
    assert json.loads(forgotten.state["keptState"]) == {}


REMEMBER_UI_SOURCE = """
export function get(app) {
  return (
    <div className="w-full h-full bg-white" onClick={() => {
      const taps = (frameos.recall('taps') ?? 0) + 1
      frameos.remember('taps', taps)
      frameos.setState('taps', taps)
    }} />
  )
}
"""

REMEMBER_UI_SCENE = {
    **TAP_UI_SCENE,
    "id": "remember-ui",
    "name": "Remember UI",
    "apps": {"jsxUi": {
        **TAP_UI_SCENE["apps"]["jsxUi"],  # type: ignore[index]
        "sources": {**TAP_UI_SCENE["apps"]["jsxUi"]["sources"], "app.tsx": REMEMBER_UI_SOURCE},  # type: ignore[index]
    }},
}


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_keeps_state(), reason="no wasm bundle with frameos_wasm_set_kept_state")
async def test_what_an_app_remembers_lasts_into_the_next_pull():
    """docs/server-rendering.md "Kept between pulls": an app's
    frameos.remember values last on a board until the scene unloads or the
    chip sleeps, and on a plane from one pull's process to the next. The
    second tap counts 2 with what the first pull kept, and 1 without it."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    await _skip_unless_relayed_taps_land()
    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[REMEMBER_UI_SCENE])
    width, height = 320, 240
    tap = _relayed_tap(_wire(width / 2, width), _wire(height / 2, height))

    first = await render_scene(frame, width, height, device_input=tap)
    assert first.state is not None, first.error
    assert first.state["state"].get("taps") == 1
    kept = json.loads(first.state["keptState"])
    assert [(app["sceneId"], app["memory"]) for app in kept["apps"]] == [("remember-ui", {"taps": "1"})]

    second = await render_scene(frame, width, height, device_input=tap, kept_state=first.state["keptState"])
    assert second.state is not None, second.error
    assert second.state["state"].get("taps") == 2
    assert json.loads(second.state["keptState"])["apps"][0]["memory"] == {"taps": "2"}

    afresh = await render_scene(frame, width, height, device_input=tap)
    assert afresh.state is not None, afresh.error
    assert afresh.state["state"].get("taps") == 1


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_takes_relayed_events(), reason="no wasm bundle with frameos_wasm_set_frame")
async def test_a_relayed_tap_on_a_switcher_tile_shows_that_scene_in_the_real_runtime():
    """The switcher the plane kept (opened over `clock` a moment ago): a tap
    on the second tile is the switch to `photos`, drawn in the same pull."""
    import time
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    await _skip_unless_relayed_taps_land()
    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=RELAY_SCENES)
    width, height = 400, 300
    kept = {"system/sceneSwitcher": {"from": "clock", "highlight": "clock", "page": 0, "touchedAt": time.time()}}

    # At 400x300 the two tiles sit top left: `clock` round (45, 70), `photos` round (122, 70).
    result = await render_scene(frame, width, height, scene_id="system/sceneSwitcher", scene_states=kept,
                                device_input=_relayed_tap(_wire(122, width), _wire(70, height)))

    assert result.rgba is not None, result.error
    assert result.state["sceneId"] == "photos"
    assert result.rgba[:4] == bytes((0, 0, 0, 255))


@pytest.mark.asyncio
async def test_a_render_reports_when_the_scene_wants_its_next_picture(monkeypatch, tmp_path):
    """The harness reports this render's `nextSleep` and the scene's
    `refreshInterval` with the state (docs/server-rendering.md "When the next
    picture is due"); the render pull reads them from it."""
    from types import SimpleNamespace

    from app.utils import embedded_render

    class FakeProcess:
        returncode = 0

        async def communicate(self, _request):
            marker = '{"sceneId":"s","state":{},"seeded":true,"nextSleep":-1,"refreshInterval":60}'
            return b"\x00" * 16, f"{_STATE_MARKER}{marker}\n".encode()

    async def fake_exec(*_args, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(embedded_render.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(embedded_render.shutil, "which", lambda _name: "/usr/bin/node")
    monkeypatch.setattr(embedded_render, "wasm_assets_dir", lambda: tmp_path)
    monkeypatch.setattr(embedded_render, "RENDER_HARNESS", Path(embedded_render.__file__))
    monkeypatch.setattr(embedded_render, "_render_semaphore", asyncio.Semaphore(embedded_render.RENDER_CONCURRENCY))
    monkeypatch.setattr(embedded_render, "_render_waiters", 0)

    frame = SimpleNamespace(id=1, name="f", timezone=None, network={}, scenes=[{"id": "s", "nodes": [], "edges": []}])
    _rgba, state, _assets = await embedded_render.render_scene_rgba_and_state(frame, 2, 2)  # type: ignore[arg-type]
    assert state == {"sceneId": "s", "state": {}, "seeded": True, "nextSleep": -1, "refreshInterval": 60}

    harness = (Path(embedded_render.__file__).parents[2] / "tools" / "embedded_wasm_render.mjs").read_text()
    assert "frameos_wasm_next_sleep" in harness and "frameos_wasm_scene_interval" in harness


def _renderer_reports_scene_timing() -> bool:
    from app.utils.embedded_render import thin_client_renderer_available, wasm_assets_dir

    assets = wasm_assets_dir()
    script = (assets / "frameos.js").read_text(errors="replace") if assets is not None else ""
    return thin_client_renderer_available() and "frameos_wasm_scene_interval" in script and "frameos_wasm_next_sleep" in script


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_reports_scene_timing(), reason="no wasm bundle with the timing exports")
async def test_the_real_runtime_reports_the_scenes_interval():
    """Through the harness and the wasm runtime: a scene whose setting asks
    for a picture a minute reports 60, and no nextSleep of its own."""
    from types import SimpleNamespace
    from typing import Any

    from app.utils.embedded_render import render_scene

    scene = {
        "id": "minute",
        "name": "Minute",
        "default": True,
        "settings": {"execution": "interpreted", "refreshInterval": 60},
        "fields": [],
        "nodes": [
            {"id": "render", "type": "event", "position": {"x": 0, "y": 0}, "data": {"keyword": "render"}},
            {"id": "color", "type": "app", "position": {"x": 0, "y": 0},
             "data": {"keyword": "render/color", "config": {"color": "#ffffff"}}},
        ],
        "edges": [{"id": "e1", "source": "render", "sourceHandle": "next", "target": "color", "targetHandle": "prev"}],
    }
    frame: Any = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[scene])
    result = await render_scene(frame, 16, 16)
    assert result.rgba is not None, result.error
    assert result.state is not None
    assert result.state["refreshInterval"] == 60
    assert result.state["nextSleep"] == -1


def _renderer_reports_press_map() -> bool:
    from app.utils.embedded_render import wasm_assets_dir

    assets = wasm_assets_dir()
    return (
        _renderer_takes_relayed_events()
        and assets is not None
        and "frameos_wasm_press_map" in (assets / "frameos.js").read_text(errors="replace")
    )


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_reports_press_map(), reason="no wasm bundle with frameos_wasm_press_map")
async def test_the_real_runtime_says_where_a_press_does_something():
    """The UI's right half has an onClick: that half, in the panel's pixels,
    turned with the frame (docs/server-rendering.md "The click")."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[TAP_UI_SCENE])
    upright = await render_scene(frame, 80, 60, frame_json={"pixelFormat": 1, "rotate": 0})
    assert upright.rgba is not None, upright.error
    assert upright.state["pressMap"] == "40,0,80,60"

    # Hung at 90 degrees the scene draws 80x60 on a 60x80 panel: panel (x, y)
    # is the scene's (y, 59 - x).
    turned = await render_scene(frame, 80, 60, frame_json={"pixelFormat": 1, "rotate": 90})
    assert turned.state["pressMap"] == "0,40,60,80"

    nothing = await render_scene(SimpleNamespace(**{**vars(frame), "scenes": [FIELD_UI_SCENE]}), 80, 60)
    # A field takes a press: the box at the top, the full width.
    assert nothing.state["pressMap"].startswith("0,0,80,")


PANEL_UI_SOURCE = """
export function get(app) {
  return (
    <div className="flex w-full h-full">
      <div className={`w-1/2 h-full ${app.frame.color === false ? 'bg-white' : 'bg-black'}`} />
      <div className={`w-1/2 h-full ${app.frame.paper ? 'bg-white' : 'bg-black'}`} />
    </div>
  )
}
"""

PANEL_UI_SCENE = {
    **TAP_UI_SCENE,
    "id": "panel-ui",
    "name": "Panel UI",
    "apps": {"jsxUi": {
        **TAP_UI_SCENE["apps"]["jsxUi"],  # type: ignore[index]
        "sources": {**TAP_UI_SCENE["apps"]["jsxUi"]["sources"], "app.tsx": PANEL_UI_SOURCE},  # type: ignore[index]
    }},
}


@pytest.mark.asyncio
@pytest.mark.skipif(not _renderer_reports_press_map(), reason="no wasm bundle with frameos_wasm_press_map")
async def test_a_scene_drawn_for_a_board_hears_what_its_panel_is():
    """`app.frame.color` and `paper` as the board's own runtime says them: a
    grey e-paper shows no color (a scene's "auto" draws in high contrast), an
    LCD is no paper. Without the panel the plane's own canvas answered: every
    board a color LCD."""
    from types import SimpleNamespace

    from app.utils.embedded_render import render_scene

    frame = SimpleNamespace(id=1, name="f", timezone="UTC", network={}, scenes=[PANEL_UI_SCENE])
    width, height = 40, 20

    def halves(rgba: bytes) -> tuple[str, str]:
        # Light or dark: a palette panel's automatic fit moves black and white
        # onto the inks it measured.
        def tone(at: int) -> str:
            return "white" if rgba[at] > 128 else "black"
        return tone(0), tone((width - 1) * 4)

    white, black = "white", "black"
    grey_paper = await render_scene(frame, width, height, frame_json={"pixelFormat": 8})  # the E1003
    assert halves(grey_paper.rgba) == (white, white)
    spectra = await render_scene(frame, width, height, frame_json={"pixelFormat": 7})
    assert halves(spectra.rgba) == (black, white)
    lcd = await render_scene(frame, width, height, frame_json={"pixelFormat": 9})
    assert halves(lcd.rgba) == (black, black)
    unsaid = await render_scene(frame, width, height)
    assert halves(unsaid.rgba) == (black, black)
