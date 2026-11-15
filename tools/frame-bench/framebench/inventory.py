"""Which frames are on this machine's USB, and which backend frame each one is.

Every serial port is asked `usb_api status` (held open with pyserial's
defaults, so no board resets). A board answers with its frame id, module,
panel and render mode; the backend's frame list adds its name, host, scenes
and API key. A port that does not answer (the SenseCAP's RP2040, a debug
probe) is listed as `unknown` and skipped.
"""
from __future__ import annotations

import glob
import json
import os

from .console import Console

# Boards with a touch panel the bench can tap (module ids from fos_board.c).
TOUCH_MODULES = {'seeed_sensecap_indicator_d1', 'seeed_reterminal_sticky', 'seeed_reterminal_e1003',
                 'waveshare_esp32s3_touch_lcd_4', 'hyperpixel'}
# Seconds a full refresh takes, for timeouts and pacing (a guess for unknown panels).
PANEL_REFRESH_S = {'EPD_7in3e': 32, 'EPD_10in3': 4, 'EPD_3in97': 4, 'EPD_7in5_V2': 6}


def serial_ports():
    ports = sorted(glob.glob('/dev/ttyUSB*') + glob.glob('/dev/ttyACM*') + glob.glob('/dev/cu.usb*'))
    return ports


def probe_port(port: str, timeout: float = 6.0) -> dict | None:
    try:
        con = Console(port)
    except Exception as exc:
        return {'port': port, 'error': str(exc)}
    try:
        con.idle(0.5)
        status = None
        for _ in range(2):
            ok, body = con.usb_api('status', timeout)
            try:
                status = json.loads(body)
                break
            except Exception:
                continue
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
    render_mode = cfg.get('renderMode') or 'local'
    return {
        'port': port,
        'app': app,
        'version': status.get('version'),
        'elf': (status.get('elfSha256') or '')[:16],
        'frame_id': cfg.get('frameId'),
        'module': module,
        'display': display,
        'ip': (status.get('wifi') or {}).get('ip'),
        'render_mode': render_mode,
        'kind': 'pico' if pico else ('thin' if render_mode == 'remote' else 'local'),
        'lcd': display.startswith('LCD_'),
        'touch': module in TOUCH_MODULES,
        'refresh_s': 0 if display.startswith('LCD_') else PANEL_REFRESH_S.get(display, 30),
        'psram_total': (status.get('memory') or {}).get('psramTotal'),
        'backend_url': cfg.get('backendUrl') or '',
        'cloud': (status.get('cloud') or {}).get('state'),
    }


def discover(backend=None, ports=None) -> list[dict]:
    frames = []
    by_id = {}
    if backend is not None:
        try:
            by_id = {f['id']: f for f in backend.frames()}
        except Exception as exc:
            print(f'backend not reachable ({exc}); USB only')
    for port in ports or serial_ports():
        found = probe_port(port)
        if not found or not found.get('status'):
            continue
        d = describe(port, found['status'])
        bf = by_id.get(d['frame_id'])
        if bf:
            d['name'] = bf.get('name')
            d['backend_frame'] = bf['id']
            d['api_key'] = bf.get('server_api_key')
            d['host'] = bf.get('frame_host')
        else:
            d['name'] = d['module'] or port
        frames.append(d)
    return frames


def load(path: str) -> list[dict]:
    with open(path) as f:
        return json.load(f)


def save(path: str, frames: list[dict]):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as f:
        json.dump(frames, f, indent=1)
