"""Which frames are on this machine's USB, and which backend frame each one is.

Every serial port is asked `usb_api status` (held open with pyserial's
defaults, so no board resets). A board answers with its frame id, module,
panel and render mode; the backend's frame list adds its name, host, scenes
and API key. A port that does not answer (the SenseCAP's RP2040, a debug
probe) is listed as `unknown` and skipped.

A Linux frame (a Raspberry Pi) has no USB console: it is benched over SSH
(framebench/linux.py), listed in ~/.frameos-bench/linux-frames.json or
$FRAMEOS_BENCH_SSH, and its "port" is `ssh:<user@host>`. It is matched with its
backend frame by its server API key's hash.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess

from .console import Console, parse_payload_json
from . import linux

# Boards with a touch panel the bench can tap (module ids from fos_board.c).
TOUCH_MODULES = {'seeed_sensecap_indicator_d1', 'sunton_esp32_8048s070', 'waveshare_esp32_s3_touch_amoled_1_75', 'seeed_reterminal_sticky', 'seeed_reterminal_e1003',
                 'waveshare_esp32s3_touch_lcd_4', 'hyperpixel'}
# Seconds a full refresh takes, for timeouts and pacing (a guess for unknown panels).
PANEL_REFRESH_S = {'EPD_7in3e': 32, 'EPD_13in3e': 35, 'EPD_10in3': 4, 'EPD_3in97': 4, 'EPD_7in5_V2': 6}


def serial_ports():
    ports = sorted(glob.glob('/dev/ttyUSB*') + glob.glob('/dev/ttyACM*') + glob.glob('/dev/cu.usb*'))
    return ports


def port_busy(port: str) -> bool:
    """Whether another process has the port open (a session's console, an
    esptool flash): never open one, since its lines are someone's. An SSH
    frame has no port to hold: its booking says who has it."""
    if linux.is_ssh_port(port):
        return False
    try:
        return subprocess.run(['fuser', '-s', port], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def probe_port(port: str, timeout: float = 25.0, deadline: float = 60.0) -> dict | None:
    """probe_port_now with an overall deadline: a port that hangs in open or
    close (a co-processor's CDC port that stopped answering, the SenseCAP's
    RP2040) is skipped instead of stalling the whole discovery."""
    import threading
    box = {}
    th = threading.Thread(target=lambda: box.setdefault('r', probe_port_now(port, timeout)), daemon=True)
    th.start()
    th.join(deadline)
    if th.is_alive():
        print(f'{port}: no answer within {deadline:.0f} s, skipped')
        return None
    return box.get('r')


def probe_port_now(port: str, timeout: float = 25.0) -> dict | None:
    if linux.is_ssh_port(port):
        st = linux.probe(port[4:])
        return {'port': port, 'status': st} if st else None
    try:
        con = Console(port)
    except Exception as exc:
        return {'port': port, 'error': str(exc)}
    try:
        con.idle(0.5)
        status = None
        for _ in range(2):
            ok, body = con.usb_api('status', timeout)
            status = parse_payload_json(body)
            if status is not None:
                break
        return {'port': port, 'status': status} if status else None
    finally:
        con.close()


def describe(port: str, status: dict) -> dict:
    cfg = status.get('config') or {}
    board = status.get('board') or {}
    app = status.get('app', '')
    module = board.get('module', '')
    display = board.get('display') or cfg.get('panel') or ''
    pico = app == 'frameos-pico'
    is_linux = app == 'frameos-linux'
    render_mode = cfg.get('renderMode') or 'local'
    lcd = display.startswith('LCD_') or bool(board.get('lcd'))
    return {
        'port': port,
        'app': app,
        'version': status.get('version'),
        'elf': (status.get('elfSha256') or status.get('binarySha256') or '')[:16],
        'frame_id': cfg.get('frameId'),
        'module': module,
        'display': display,
        'ip': (status.get('wifi') or {}).get('ip'),
        'render_mode': render_mode,
        'kind': 'pico' if pico else ('thin' if render_mode == 'remote' else 'local'),
        'linux': is_linux,
        'lcd': lcd,
        'touch': module in TOUCH_MODULES or bool(board.get('touch')),
        'refresh_s': 0 if lcd else PANEL_REFRESH_S.get(display, 30),
        'psram_total': (status.get('memory') or {}).get('psramTotal'),
        'backend_url': cfg.get('backendUrl') or '',
        'cloud': (status.get('cloud') or {}).get('state'),
    }


def _with_backend(d: dict, by_id: dict, port: str, status: dict | None = None) -> dict:
    key_sha = ((status or {}).get('config') or {}).get('serverApiKeySha')
    if key_sha and not d.get('frame_id'):
        # A Linux frame does not know its backend id: its key says which it is.
        d['frame_id'] = next((fid for fid, f in by_id.items() if linux.key_sha(f.get('server_api_key')) == key_sha), None)
    bf = by_id.get(d['frame_id'])
    if bf:
        d['name'] = bf.get('name')
        d['backend_frame'] = bf['id']
        d['api_key'] = bf.get('server_api_key')
        d['host'] = bf.get('frame_host')
    else:
        d['name'] = d['module'] or port
    return d


def _backend_frames(backend) -> dict:
    if backend is None:
        return {}
    try:
        return {f['id']: f for f in backend.frames()}
    except Exception as exc:
        print(f'backend not reachable ({exc}); USB only')
        return {}


def discover(backend=None, ports=None, skip_ports=(), serial=True) -> list[dict]:
    """Every board that answers. A port another process has open, or in
    `skip_ports` (where a board someone else booked was last seen), is not
    opened: those lines are someone else's (bookings.py). `serial=False`:
    the Linux frames alone, no USB port opened."""
    frames = []
    by_id = _backend_frames(backend)
    for port in (ports or serial_ports()) if serial else []:
        if port in skip_ports:
            print(f'{port}: a board booked by someone else was here last, skipped')
            continue
        if port_busy(port):
            print(f'{port}: open in another process, skipped')
            continue
        found = probe_port(port)
        if not found or not found.get('status'):
            continue
        frames.append(_with_backend(describe(port, found['status']), by_id, port, found['status']))
    for target in ([] if ports else linux.ssh_targets()):
        port = 'ssh:' + target
        if port in skip_ports:
            print(f'{port}: a frame booked by someone else, skipped')
            continue
        st = linux.probe(target)
        if not st:
            print(f'{port}: no answer over SSH')
            continue
        frames.append(_with_backend(describe(port, st), by_id, port, st))
    return frames


def find(module: str, backend=None, exclude=()) -> dict | None:
    """The board with `module` (a booked one now free): the ports no one has
    open and no frame of this run uses, asked in turn."""
    by_id = _backend_frames(backend)
    for port in serial_ports() + ['ssh:' + t for t in linux.ssh_targets()]:
        if port in exclude or port_busy(port):
            continue
        found = probe_port(port, timeout=15.0, deadline=30.0)
        status = (found or {}).get('status')
        if status and (status.get('board') or {}).get('module') == module:
            return _with_backend(describe(port, status), by_id, port, status)
    return None


def still_there(frames: list[dict]) -> list[str]:
    """The ports among `frames` whose board is no longer the one saved there.

    A VM's USB passthrough can hand the same boards out in another order after
    a re-attach: on 2026-11-19 the E1004 and the SenseCAP swapped ttyUSB2/3, and
    a run off the saved inventory pushed to one board and read the other's
    console. A run checks before it trusts the file."""
    moved = []
    for f in frames:
        found = probe_port(f['port'], timeout=15.0, deadline=30.0)
        status = (found or {}).get('status') or {}
        module = (status.get('board') or {}).get('module', '')
        if linux.is_ssh_port(f['port']):
            # A Linux frame's address is its own; its backend id is not in it.
            if module != f.get('module'):
                moved.append(f"{f['port']}: saved {f.get('module')}, found {module or 'nothing'}")
            continue
        if module != f.get('module') or (status.get('config') or {}).get('frameId') != f.get('frame_id'):
            moved.append(f"{f['port']}: saved {f.get('module')} #{f.get('frame_id')}, "
                         f"found {module or 'nothing'} #{(status.get('config') or {}).get('frameId')}")
    return moved


def load(path: str) -> list[dict]:
    with open(path) as f:
        return json.load(f)


def save(path: str, frames: list[dict]):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as f:
        json.dump(frames, f, indent=1)
