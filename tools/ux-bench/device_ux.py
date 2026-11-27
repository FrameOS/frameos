#!/usr/bin/env python3
"""The UX bench's checks on real boards: what the wasm cannot show.

    device_ux.py <port> <board-key> [--out results.json]

For a board on its serial console (booked first, tools/frame-bench/boards.py):
- each edge swipe through the board's own touch task (`touch drag`), from the
  rim on a round panel, in the panel's own pixels turned by the frame's
  rotation: what came up (the scene list, the settings, nothing) and how long
  until its picture was done;
- each key pressed and held, and two keys held together, as the button task
  would hand them over (`event gpio` edges, `atMs` stamped): what came up;
- the scene list opened and closed, the settings opened and closed, timed.
The expected outcome of each is the board's event map (panels.json), read the
way report.py reads it for the virtual run.
"""
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'frame-bench'))
from framebench.console import Console  # noqa: E402
from framebench.suites import wait_scene_render  # noqa: E402
from framebench.parse import summarize  # noqa: E402

sys.path.insert(0, str(HERE))
from report import expected_after, resolve_role  # noqa: E402

SWITCHER = 'system/sceneSwitcher'
SETTINGS = 'system/sceneSettings'


def main():
    port, key = sys.argv[1], sys.argv[2]
    out_path = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
    panels = json.loads((HERE / 'panels.json').read_text())
    panel = panels[key]
    con = Console(port)
    time.sleep(0.3)
    con.drain()
    results = {'board': key, 'port': port, 'steps': []}

    def status():
        con.drain()
        con.send('usb_api status')
        for _, line in con.idle(4):
            if line.startswith('{') and '"scene' in line:
                try:
                    return json.loads(line)
                except ValueError:
                    pass
        return {}

    def current_scene():
        return ((status().get('scenes') or {}).get('currentSceneId')) or ''

    def scene_from_lines(lines, before):
        """The scene the last render line names, else `before`."""
        sid = before
        for _, x in lines:
            m = re.search(r'"sceneId":\s*"([^"]+)"', x)
            if m:
                sid = m.group(1)
            elif 'Scene switcher' in x:
                sid = SWITCHER
            elif 'Scene settings' in x or 'system/sceneSettings' in x:
                sid = SETTINGS
        return sid

    def wait_for(predicate, timeout):
        t_done, line, got = wait_scene_render(con, timeout, predicate)
        return t_done, got

    timeout = 8 + (panel.get('refresh_s') or (30 if panel['pixelFormat'] in (5, 6, 7) else 6))
    home = current_scene()
    if not home or home.startswith('system/'):
        # On the scene list or the settings (left there): a scene of the frame's own to start from.
        listed = ((status().get('scenes') or {}).get('scenes')) or []
        home = next((x['id'] for x in listed if not x['id'].startswith('system/')), '')
        if home:
            con.send(f'scene {home}')
            con.idle(timeout)
    results['home'] = home

    def back_home():
        if not home:
            return
        con.drain()
        con.send(f'scene {home}')
        con.idle(timeout if panel['pixelFormat'] in (5, 6, 7) else 4)

    def run_step(kind, label, send, rec):
        con.drain()
        t = time.time()
        send()
        exp = expected_after(panel, rec, {'kind': kind, 'label': label})
        builtin = exp and any(e.startswith('system/') for e in exp)
        if builtin:
            # The settings are `system/sceneSettings`, or `#<scene>` where they are a window of their own.
            prefix = SWITCHER if SWITCHER in exp else SETTINGS
            title = 'Scene switcher' if prefix == SWITCHER else 'Scene settings'
            t_done, got = wait_for(lambda x, prefix=prefix, title=title: prefix in x or f'"{title}"' in x, timeout)
            if '--debug' in sys.argv:
                for _, x in got[-25:]:
                    print('   |', x[:160])
        else:
            got = con.idle(3.5 if panel['pixelFormat'] == 9 else timeout)
            t_done = None
        w = summarize(got)
        step = {'kind': kind, 'label': label, 'expected': sorted(exp) if exp else None,
                'opened': bool(t_done), 'ms': round((t_done - t) * 1000) if t_done else None,
                'renders': [d['ms'] for d in w['done']][:6], 'errors': w['errors'][:3],
                'switched': [x for _, x in got if 'initialized' in x or 'setCurrentScene' in x][:3]}
        ok = (t_done is not None) if builtin else not any(SWITCHER in x or SETTINGS in x for _, x in got)
        step['ok'] = ok
        results['steps'].append(step)
        print(f"{key:14} {kind:5} {label:18} {'ok ' if ok else 'BAD'} {step['ms'] or '':>6} ms  expected {step['expected']}",
              flush=True)
        back_home()

    rec = {'scene': home or 'x', 'order': [home or 'x']}
    W, H = panel['width'], panel['height']
    rot = panel.get('rotate', 0)
    # How the board is hung: its canvas (the picture as the scene draws it)
    # against its panel. The bench's Sticky hangs in landscape, its preset at 270.
    render = status().get('render') or {}
    cw, ch = render.get('previewWidth'), render.get('previewHeight')
    if cw and ch:
        if (cw, ch) == (W, H) and rot in (90, 270):
            rot = 0
        elif (cw, ch) == (H, W) and W != H and rot in (0, 180):
            rot = 90
    results['rotate'] = rot
    panel = {**panel, 'rotate': rot}
    sw, sh = (H, W) if rot in (90, 270) else (W, H)

    def to_panel(x, y):
        # panelToScenePoint's inverse (utils/image.nim).
        if rot == 90:
            return W - 1 - y, x
        if rot == 180:
            return W - 1 - x, H - 1 - y
        if rot == 270:
            return y, H - 1 - x
        return x, y

    if panel.get('touch'):
        m = int(min(sw, sh) * 0.35)
        r = min(sw, sh) / 2
        inset = (sw / 2 - r + 3) if panel.get('round') else 2
        swipes = {
            'left': ((inset, sh / 2), (inset + m, sh / 2)),
            'right': ((sw - 1 - inset, sh / 2), (sw - 1 - inset - m, sh / 2)),
            'top': ((sw / 2, (sh / 2 - r + 3) if panel.get('round') else 2), (sw / 2, m)),
            'bottom': ((sw / 2, (sh / 2 + r - 4) if panel.get('round') else sh - 3), (sw / 2, sh - 1 - m)),
        }
        for edge, (a, b) in swipes.items():
            pa, pb = to_panel(int(a[0]), int(a[1])), to_panel(int(b[0]), int(b[1]))
            run_step('swipe', edge, lambda pa=pa, pb=pb: con.send(f'touch drag {pa[0]} {pa[1]} {pb[0]} {pb[1]} 250'), rec)

    import threading

    def edges(label, pin, hold_ms):
        # The up comes from a timer, so the step listens while the key is
        # held: a long press acts at the threshold, before the key comes up.
        def send():
            # Compact: the console splits a command on spaces.
            down = json.dumps({"label": label, "pin": pin, "action": "down", "level": 0}, separators=(',', ':'))
            up = json.dumps({"label": label, "pin": pin, "action": "up", "level": 1}, separators=(',', ':'))
            con.send(f'event gpio {down}')
            threading.Timer(hold_ms / 1000, lambda: con.send(f'event gpio {up}')).start()
        return send

    from report import rule_for
    for k in panel.get('keys') or []:
        for action, ms in ([('press', 80)] if k.get('hold') is False else [('press', 80), ('hold', 1500)]):
            role = resolve_role(k.get('role', ''), rot)
            rule = rule_for(panel.get('eventMap'), 'button',
                            {'label': k['label'], 'role': role, 'action': 'press' if action == 'press' else 'longPress'})
            # Not the screen off (an LCD's Screen key) nor a voice session (the voice key held).
            if rule and rule.get('emit') in ('toggleScreen', 'voiceChat'):
                print(f"{key:14} key   {k['label']}-{action:12} skipped ({rule.get('emit')})", flush=True)
                continue
            run_step('key', f"{k['label']}-{action}", edges(k['label'], k['pin'], ms), rec)

    out = json.dumps(results, indent=1)
    if out_path:
        Path(out_path).write_text(out)
    con.close()


if __name__ == '__main__':
    main()
