"""The bench suites. Each takes a Ctx and a frame (inventory entry), returns a
dict with its measurements and an `issues` list: things a person should look
at, each {severity, kind, where, detail}. Severity: `crash` (panic, abort,
watchdog, reboot, OOM), `fail` (something did not work), `slow` (a number
outside what this board should do), `note` (worth knowing).
"""
from __future__ import annotations

import json
import os
import re
import socket
import threading
import time

from .console import parse_payload_json, Console
from .linux import open_console
from .parse import RENDER_DONE, RENDER_FAILED, event, stats, summarize

ANIMATION_MIN_FPS_RATIO = 0.8   # an animation below 80 % of its scene's target rate is `slow`
WARM_SLOW_MS = 10_000           # a warm render above this is `slow` anywhere
SWITCH_SLOW_MS = 5_000          # a switch (excluding the panel refresh) above this is `slow`
LOW_PSRAM = 1_000_000           # free PSRAM below this after a render is a `note`


# A slow panel (a refresh this long or longer: the 7.3" and 13.3" Spectras)
# spends half an hour on what an LCD does in minutes, so the bench samples it
# unless asked for everything (`--full`): what has broken before runs every
# time, the rest in turns, a third of it a run (ROTATION), so three runs cover
# it all. `ctx.rotation` says which third; the report says what was left out.
SLOW_PANEL_S = 20
ROTATION = 3
# Scenes that found bugs on a slow panel, by name: the photo scenes (the
# E1004's out-of-memory aborts, the auto-fit's 12 s, the dither), the big
# ones (a set too large to take whole), the clocks and their gradients (the
# E1003's 15 s renders).
TROUBLE_SCENES = ['Google Photos', 'Immich', 'Wikimedia Commons', 'SD card image', 'Unsplash image',
                  'Visited world map', 'Chess puzzle of the day', 'Word clock', 'Big typographic clock',
                  'Analog clock face']
# Desktop layouts pushed every time, in this order: two big sets in a row
# with windows open is what left a scene on the set before's layout (#828,
# #833) and what a board short of memory takes store-first (#818).
TROUBLE_LAYOUTS = ['layout-macos', 'layout-beos']


def sampled(ctx, frame) -> bool:
    """Whether this frame's run samples (a slow panel, not `--full`, not `--quick`)."""
    return not getattr(ctx, 'full', False) and not ctx.quick and frame.get('refresh_s', 0) >= SLOW_PANEL_S


def in_turn(ctx, key: str) -> bool:
    """Whether `key` is in this run's third (stable: the same key, the same turn)."""
    import zlib
    return zlib.crc32(key.encode()) % ROTATION == getattr(ctx, 'rotation', 0) % ROTATION


def pick_scenes(ctx, frame, scenes, keep_largest=2):
    """A slow panel's scenes: the trouble ones, the largest few, and this run's
    turn of the rest. Returns (picked, left_out_names)."""
    if not sampled(ctx, frame):
        return scenes, []
    largest = {s['id'] for s in sorted(scenes, key=lambda s: -(s.get('bytes') or 0))[:keep_largest]}
    picked, left = [], []
    for s in scenes:
        if s.get('name') in TROUBLE_SCENES or s['id'] in largest or in_turn(ctx, s['id']):
            picked.append(s)
        else:
            left.append(s.get('name') or s['id'])
    return picked, left


def issue(severity, kind, where, detail):
    return {'severity': severity, 'kind': kind, 'where': where, 'detail': detail}


class Ctx:
    def __init__(self, out_dir, backend=None, warm=3, passive=8.0, quick=False, host_ip=None):
        self.out_dir = out_dir
        self.backend = backend
        self.warm = warm
        self.passive = passive
        self.quick = quick
        self.host_ip = host_ip
        self.consoles: dict[str, Console] = {}

    def console(self, frame) -> Console:
        """The frame's console, held open for the run: its serial port, or
        for a Linux frame (`ssh:<target>`) its journal and HTTP API (linux.py)."""
        port = frame['port']
        if port not in self.consoles:
            name = frame.get('name') or port
            safe = ''.join(c if c.isalnum() else '_' for c in name)
            self.consoles[port] = open_console(port, f'{self.out_dir}/{safe}.raw.log')
            if getattr(self.consoles[port], 'linux', False):
                self.consoles[port].frame_id = frame.get('frame_id')
        return self.consoles[port]

    def close(self):
        for c in self.consoles.values():
            c.close()


# --------------------------------------------------------------- helpers
def render_timeout(frame):
    return 90 + 3 * frame.get('refresh_s', 30)


def incidents_since(con, t0, where):
    out = []
    for inc in con.incidents:
        if inc.t >= t0:
            sev = {'interpreter_discard': 'note', 'layout_missing': 'fail'}.get(inc.kind, 'crash')
            out.append(issue(sev, inc.kind, where, inc.line))
    for b in con.boots:
        if b >= t0:
            ota = ota_before_boot(con, b)
            if ota:
                out.append(issue('fail', 'ota_mid_run', where,
                                 f'board installed {ota} over the air at +{b - con.t0:.1f}s: '
                                 'what follows is not the firmware the run started on'))
            else:
                out.append(issue('crash', 'reboot', where, f'board rebooted at +{b - con.t0:.1f}s'))
    return out


def ota_before_boot(con, t_boot):
    """The version an OTA installed if the boot at t_boot was its reboot
    (`ota:<plane>` "verified" / "rebooting" just before), else None. The
    bench's backend offers its release to a board on another build: on
    2026-11-19 every board took it ten minutes into a run."""
    version, verified = None, False
    for t, x in list(con.history):
        if t < t_boot - 900 or t > t_boot:
            continue
        if '{"event":"ota:' in x:
            m = re.search(r'"status":"downloading","detail":"([^"]+)"', x)
            if m:
                version = m.group(1)
            if t >= t_boot - 15 and '"status":"verified","detail":"rebooting"' in x:
                verified = True
    return (version or 'an update') if verified else None


def wait_render(con, timeout):
    """Wait for the next `render #N done` / `failed`; returns (t, line, lines)."""
    return con.wait_for(lambda x: bool(RENDER_DONE.match(x) or RENDER_FAILED.match(x)), timeout)


def wait_scene_render(con, timeout, shows):
    """Wait for a render whose `started: scene ...` line `shows(line)` says is
    the one wanted, to its `done` / `failed`; returns (t, line, lines)."""
    started = {'n': None}

    def finished(x):
        if x.startswith('render #') and ' started: scene ' in x:
            named = x.split(' started: scene ', 1)[1].strip()
            # Firmware up to 2026.11.12 could start a render with the name
            # empty (`started: scene ""`): either scene, as before.
            if started['n'] is None and (named == '""' or shows(named)):
                started['n'] = x.split()[1]
            return False
        if started['n'] is None:
            return False
        return bool((RENDER_DONE.match(x) or RENDER_FAILED.match(x)) and x.split()[1] == started['n'])
    return con.wait_for(finished, timeout)


def switch_scene(con, frame, sid, name=None):
    """`scene <id>` and wait for a render of THAT scene that started after the
    command. Returns (ok, t_cmd, t_done, last line, summary of the window)."""
    con.drain()
    t_cmd = time.time()
    con.send(f'scene {sid}')
    started = {'n': None}

    def switched(x):
        if x.startswith('scene select failed'):
            return True
        if x.startswith('render #') and ' started: scene ' in x and (sid in x or (name and f'"{name}"' in x)):
            started['n'] = x.split()[1]
            return False
        # The scene's own `render:done` ends it too: when its start line
        # went out without the scene (`started: scene ""`, firmware up to
        # 2026.11.12 reading the shared scene info buffer: the E1004's
        # Unsplash image), or when the console lost the `done in` line
        # (bytes dropped on the E1004's CH340, 2026-11-19: Low Poly
        # Animals rendered in 39.7 s and read as "no render").
        if x.startswith('{"event":"render:done"') and f'"sceneId":"{sid}"' in x and '"status":"ok"' in x:
            return True
        return started['n'] is not None and (x.startswith(f"render {started['n']} done") or x.startswith(f"render {started['n']} failed"))

    t_done, line, got = con.wait_for(switched, render_timeout(frame))
    _, _, tail = con.wait_for(lambda x: x.startswith('{"event":"render:done"'), 3)
    w = summarize(got + tail)
    ok = bool(t_done) and not (line or '').startswith(('scene select failed', 'render #')) or bool(line and ' done in ' in line)
    return ok, t_cmd, t_done, line, w


def status(con):
    return con.usb_api_json('status', 20) or {}


def scene_list(con):
    # One try with a long wait first: a retry sends the command again and the
    # payload starts over. An LCD that animates logs every frame on its
    # 115200-baud console, and the SenseCAP Indicator's 12 KB list took 54 s
    # behind DVD logo bounce (2026-11-19): three 30 s tries each cut it off, and
    # the scenes suite benched nothing and reported no issues.
    ok, body = con.usb_api('scene-list', 120)
    lst = parse_payload_json(body) if body else None
    if not isinstance(lst, dict):
        lst = con.usb_api_json('scene-list', 30) or {}
    return lst.get('scenes') or []


def recover_after_boot(con, frame):
    """A board that rebooted: wait for its first render before going on."""
    wait_render(con, render_timeout(frame) + 60)
    con.idle(2)


def unlogged_since(con, t) -> bool:
    """Whether a Linux frame's runtime left a switch since `t` unlogged (its
    render-log pause, linux.py `bench:unlogged`): it happened, untimed."""
    return any('"bench:unlogged"' in x for x in con.history_since(t))


def tap(con, frame, x_frac=0.5, y_frac=0.5):
    x, y = int(32767 * x_frac), int(32767 * y_frac)
    con.send('event pointerDown {"x":%d,"y":%d,"pointerId":1,"pointerType":"touch","button":0,"buttons":1}' % (x, y))
    time.sleep(0.08)
    con.send('event pointerUp {"x":%d,"y":%d,"pointerId":1,"pointerType":"touch","button":0,"buttons":0}' % (x, y))


# --------------------------------------------------------------- suites
def suite_status(ctx, frame):
    con = ctx.console(frame)
    st = status(con)
    if frame['kind'] == 'pico':
        return {'status': st, 'issues': []}
    scenes = scene_list(con)
    human = con.command('status', 3)
    issues = []
    mem = st.get('memory') or {}
    if frame['kind'] != 'pico' and mem.get('psramFree') is not None and mem['psramFree'] < LOW_PSRAM:
        issues.append(issue('note', 'low_memory', 'idle', f"psramFree {mem['psramFree']}"))
    for line in human:
        if 'server=skipped' in line:
            issues.append(issue('note', 'https_skipped', 'boot', line.strip()))
    return {'status': st, 'scenes': scenes, 'status_text': human, 'issues': issues}


def suite_scenes(ctx, frame, scene_filter=None):
    """Every scene: switch (cold), what it does alone (animation), warm renders, a tap."""
    if frame['kind'] != 'local':
        return {'skipped': 'rendered by its plane: see the thin suite', 'issues': []}
    con = ctx.console(frame)
    st = status(con)
    before = ((st.get('scenes') or {}).get('currentSceneId'))
    debug_was = next((l.split()[-1] for l in con.command('status', 2.5) if l.startswith('debug:')), None)
    if debug_was == '0':
        con.command('set debug 1', 1.5)
    intervals = {s.get('id'): s.get('refreshInterval') for s in ((st.get('scenes') or {}).get('scenes') or [])}
    listed = scene_list(con)
    scenes = [s for s in listed if not s.get('isLayout')]
    scene_filter = scene_filter or getattr(ctx, 'scene_filter', None)
    if scene_filter:
        scenes = [s for s in scenes if s['id'] in scene_filter or s.get('name') in scene_filter]
    if ctx.quick:
        scenes = scenes[:4]
    scenes, left_out = pick_scenes(ctx, frame, scenes)
    results, issues = [], []
    if not listed:
        # Never a quiet pass: nothing was benched.
        issues.append(issue('fail', 'no_scenes', 'scenes',
                            'the board listed no scenes, so none was benched (an empty set, or a console '
                            'too busy to answer: an LCD animating when the suite began)'))
    for sc in scenes:
        where = f"scene {sc.get('name')}"
        t_start = time.time()
        entry = {'id': sc['id'], 'name': sc.get('name'), 'bytes': sc.get('bytes'), 'refreshInterval': intervals.get(sc['id'])}
        # 1. switch. Wait for a render that STARTED after the command for this scene.
        ok, t_cmd, t_done, line, w = switch_scene(con, frame, sc['id'], sc.get('name'))
        entry['switch'] = {
            'ok': ok,
            'wall_ms': round((t_done - t_cmd) * 1000) if t_done else None,
            'render': w['renders'][-1] if w['renders'] else None,
            'done_ms': w['done'][-1]['ms'] if w['done'] else None,
            'panel': [p['line'] for p in w['panel']][-3:],
            'errors': w['errors'][:5],
        }
        if unlogged_since(con, t_cmd):
            # A Linux frame's runtime did not log this switch's render (its
            # render-log pause, linux.py): it happened, untimed.
            entry['switch'].update({'unlogged': True, 'wall_ms': None, 'done_ms': None})
            issues.append(issue('note', 'switch_unlogged', where, "the runtime's render log was paused (after an animation "
                                'or a scene ticking fast): this switch is not timed'))
        if not ok:
            issues.append(issue('fail', 'switch', where, line or 'no render within timeout'))
        elif entry['switch']['wall_ms'] and entry['switch']['done_ms'] is not None:
            waited = entry['switch']['wall_ms'] - entry['switch']['done_ms']
            if waited > SWITCH_SLOW_MS:
                issues.append(issue('slow', 'switch_wait', where,
                                    f"switch took {entry['switch']['wall_ms']} ms of which only {entry['switch']['done_ms']} ms was the render"))
        for f in w['failed']:
            issues.append(issue('fail', 'render_failed', where, f"{f['stage']}: {f['reason']}"))
        # 2. alone for a while: an animation or a fast rhythm shows here.
        if ok and frame['lcd'] and ctx.passive:
            con.drain()
            t_watch = time.time()
            got = con.idle(ctx.passive)
            w = summarize(got)
            # The firmware sums up an animation every 10 s (render:animation),
            # so a window shorter than that can miss it and report a 30 fps
            # scene as still (the SenseCAP's DVD logo, 2026-11-21). A scene
            # that logged no renders and no summary may be animating: watch
            # until its summary comes, 11 s at most. One that ticks in full
            # (a clock's second) is not animating and does not wait.
            if not [a for a in w['animation'] if a.get('status') == 'running'] and len(w['done']) < 2:
                _, _, more = con.wait_for(lambda x: '"render:animation"' in x and '"running"' in x, 11.0)
                got += more
                w = summarize(got)
            # The first summary after a switch holds the scene's first frame (its
            # JS compiled, its pictures decoded): judge the steady state after it.
            running = [a for a in w['animation'] if a.get('status') == 'running']
            anim = running[1:] if len(running) > 1 else running
            # Where a quiet frame went (the logged frame's line carries their
            # average, firmware after 2026.11.11): the last one in the window.
            quiet = next((r['probe']['quiet'] for r in reversed(w['renders']) if r['probe'].get('quiet')), None)
            entry['passive'] = {
                'seconds': round(time.time() - t_watch, 1),
                'renders': len(w['done']),
                'quiet': quiet,
                'animation': [{k: a.get(k) for k in ('frames', 'fps', 'avgMs', 'maxMs', 'periodMs', 'seconds', 'jsKB', 'freePsramKB')} for a in anim],
                'burst': [{k: b.get(k) for k in ('frames', 'avgMs', 'maxMs')} for b in w['burst']],
            }
            for a in anim:
                period = a.get('periodMs') or 0
                fps = a.get('fps') or 0
                if period and fps and fps < ANIMATION_MIN_FPS_RATIO * 1000.0 / period:
                    split = ''
                    if quiet:
                        top = sorted(((k, v) for k, v in quiet.items() if k != 'frames'), key=lambda kv: -kv[1])[:6]
                        split = '; a quiet frame: ' + ', '.join(f'{k} {v:g}' for k, v in top) + ' ms'
                    issues.append(issue('slow', 'animation_fps', where,
                                        f"{fps} fps against a {1000.0 / period:.0f} fps target (avg {a.get('avgMs')} ms, max {a.get('maxMs')} ms){split}"))
                    break
            for a in anim:
                if (a.get('maxMs') or 0) > 1000 and (a.get('avgMs') or 0) < 500:
                    issues.append(issue('slow', 'animation_stall', where, f"a {a.get('maxMs')} ms frame among {a.get('avgMs')} ms ones"))
                    break
        # 3. warm renders.
        warm = []
        if ok:
            # A slow panel: one warm render for a scene in its turn, two for
            # a trouble one (each is a dither and maybe a 35 s refresh).
            warm_n = ctx.warm if not ctx.quick else 1
            if sampled(ctx, frame):
                warm_n = min(warm_n, 2 if sc.get('name') in TROUBLE_SCENES else 1)
            if frame.get('linux') and any('"render:pause"' in x for x in con.history_since(t_start)):
                # The runtime's render log paused after the switch (a scene
                # rendering fast: Files reopened on a video, Cloud-W): a
                # `render` now draws and says nothing for ten seconds, which
                # read as a render_timeout fail (2026-11-27, twice).
                issues.append(issue('note', 'warm_unlogged', where, "the runtime's render log paused (the scene renders "
                                    'fast): its warm renders are not timed'))
                warm_n = 0
            for _ in range(warm_n):
                con.drain()
                t_cmd = time.time()
                con.send('render')
                t_done, line, got = wait_render(con, render_timeout(frame))
                _, _, tail = con.wait_for(lambda x: x.startswith('{"event":"render:done"'), 3)
                w = summarize(got + tail)
                r = w['renders'][-1] if w['renders'] else {}
                ev = w['events_done'][-1] if w['events_done'] else {}
                warm.append({'wall_ms': round((t_done - t_cmd) * 1000) if t_done else None,
                             'done_ms': w['done'][-1]['ms'] if w['done'] else None,
                             'render_ms': r.get('ms'), 'in_place': r.get('in_place'), 'pack_ms': r.get('pack_ms'),
                             'probe': r.get('probe') or {}, 'freePsram': ev.get('freePsram'), 'freeHeap': ev.get('freeHeap'),
                             'refresh': [d.get('refresh') for d in w['device']][-1:] or None,
                             'panel': [p['line'] for p in w['panel']][-2:]})
                if not t_done:
                    issues.append(issue('fail', 'render_timeout', where, 'a `render` produced no render within the timeout'))
                    break
        entry['warm'] = warm
        entry['warm_stats'] = stats([x['done_ms'] for x in warm])
        if entry['warm_stats'] and entry['warm_stats']['median'] > WARM_SLOW_MS:
            issues.append(issue('slow', 'render_slow', where, f"warm render median {entry['warm_stats']['median']} ms"))
        # The fastest path: an LCD draws in its back buffer (`in place`). On a
        # Linux frame `in place` is the framebuffer's depth (linux.py: a
        # 16 bpp one has the RGB565 panel canvas, panel_canvas.nim), not a
        # path the render took, so a 32 bpp KMS panel (the Pi 5's HyperPixel)
        # would be flagged on every render: nothing to judge there.
        if frame['lcd'] and not frame.get('linux') and any(x.get('in_place') is False for x in warm):
            issues.append(issue('slow', 'not_in_place', where, 'an LCD render packed a separate image instead of drawing in the panel buffer'))
        psram = [x['freePsram'] for x in warm if x.get('freePsram')]
        if psram and min(psram) < LOW_PSRAM:
            issues.append(issue('note', 'low_memory', where, f'free PSRAM {min(psram)} after a render'))
        # 4. a tap.
        if ok and frame['touch']:
            con.drain()
            t_cmd = time.time()
            tap(con, frame)
            got = con.idle(4 if frame['lcd'] else 3 + frame.get('refresh_s', 4))
            w = summarize(got)
            # A render the tap started and has not finished: wait for it, or the
            # next scene's switch measures it (a 28 s Slideshow render on the E1003).
            open_renders = {r['n'] for r in w['started']} - {d['n'] for d in w['done']} - {f['n'] for f in w['failed']}
            if open_renders:
                _, _, more = wait_render(con, render_timeout(frame))
                got += more
                w = summarize(got)
            first = min([d['t'] for d in w['done']] + [b['t'] for b in w['burst']], default=None)
            entry['tap'] = {'first_ms': round((first - t_cmd) * 1000) if first else None,
                            'renders': [d['ms'] for d in w['done']],
                            'burst': [{k: b.get(k) for k in ('frames', 'avgMs', 'maxMs')} for b in w['burst']]}
        new = incidents_since(con, t_start, where)
        issues += new
        entry['incidents'] = len(new)
        if any(i['kind'] in ('reboot', 'ota_mid_run') for i in new):
            recover_after_boot(con, frame)
        results.append(entry)
    if before:
        con.send(f'scene {before}')
        wait_render(con, render_timeout(frame))
    if debug_was == '0':
        con.command('set debug 0', 1.5)
    if left_out:
        issues.append(issue('note', 'sampled', 'scenes', f"slow panel: {len(left_out)} scene(s) left for another run's turn: {', '.join(left_out)}"))
    return {'scenes': results, 'issues': issues, 'left_out': left_out}


def suite_builtin(ctx, frame):
    """The two scenes built into every runtime: the switcher and the settings."""
    if frame['kind'] == 'pico':
        return {'skipped': 'the Pico has no runtime of its own', 'issues': []}
    con = ctx.console(frame)
    out, issues = {}, []
    t0 = time.time()
    builtin = {'sceneSwitcher': ('system/sceneSwitcher', 'Scene switcher'),
               'sceneSettings': ('system/sceneSettings', 'Scene settings')}
    for name in ('sceneSwitcher', 'sceneSettings'):
        res = {}
        for step in ('open', 'close'):
            con.drain()
            t = time.time()
            con.send(f'event {name}')
            # The render of the scene this step shows: the built-in one when
            # it opens, any other when it closes. The first render to finish
            # could still be the scene before's (an animation's frame): on
            # 2026.11.13 the switcher's own 2.3 s render was counted as its
            # close and its open read 186 ms.
            sid, title = builtin[name]
            shows = (lambda x, sid=sid, title=title: sid in x or f'"{title}"' in x) if step == 'open' else \
                    (lambda x, sid=sid, title=title: sid not in x and f'"{title}"' not in x)
            t_done, line, got = wait_scene_render(con, render_timeout(frame), shows)
            w = summarize(got)
            res[step] = {'wall_ms': round((t_done - t) * 1000) if t_done else None,
                         'done_ms': w['done'][-1]['ms'] if w['done'] else None,
                         'render': w['renders'][-1] if w['renders'] else None}
            if t_done and unlogged_since(con, t):
                res[step].update({'wall_ms': None, 'done_ms': None, 'unlogged': True})
            if not t_done:
                issues.append(issue('fail', 'builtin', f'{name} {step}', 'no render'))
            con.idle(1.5)
        out[name] = res
    issues += incidents_since(con, t0, 'built-in scenes')
    return {'builtin': out, 'issues': issues}


def suite_input(ctx, frame):
    """A drag across the panel, next/previous scene and the edge swipes on a
    touch board; on every ESP32 its keys, timed (`key_presses`)."""
    con = ctx.console(frame)
    issues, out = [], {}
    keyed = not frame.get('linux') and frame['kind'] != 'pico' and bool(board_keys(frame))
    if not frame['touch'] and not keyed:
        return {'skipped': 'no touch and no keys', 'issues': []}
    t0 = time.time()
    if keyed:
        out.update(key_presses(con, frame, issues))
    if not frame['touch']:
        issues += incidents_since(con, t0, 'input')
        return {'input': out, 'issues': issues}
    con.drain()
    t = time.time()
    con.send('event pointerDown {"x":4000,"y":16000,"pointerId":1,"pointerType":"touch","button":0,"buttons":1}')
    for i in range(1, 11):
        time.sleep(0.05)
        con.send('event pointerMove {"x":%d,"y":16000,"pointerId":1,"pointerType":"touch","buttons":1}' % (4000 + i * 2400))
    con.send('event pointerUp {"x":28000,"y":16000,"pointerId":1,"pointerType":"touch","button":0,"buttons":0}')
    w = summarize(con.idle(5 + frame.get('refresh_s', 0)))
    out['drag'] = {'renders': [d['ms'] for d in w['done']], 'burst': [b.get('frames') for b in w['burst']],
                   'errors': w['errors'][:5]}
    # The contract's directions are `next` and `prev` (events_gen
    # SceneDirections): `previous` was refused on every board, and a scene
    # that ticks (the E1003's clock) hid it by rendering anyway. Recorded
    # under `previous` as before.
    for direction, sent in (('next', 'next'), ('previous', 'prev')):
        con.drain()
        t = time.time()
        con.send('event setCurrentScene {"direction":"%s"}' % sent)
        t_done, line, got = wait_render(con, render_timeout(frame))
        out[direction] = {'wall_ms': round((t_done - t) * 1000) if t_done else None}
        if not t_done:
            issues.append(issue('fail', 'scene_direction', direction, 'no render'))
    # An edge swipe through the board's own touch task (`touch drag`, in panel
    # pixels from the middle of an edge, which is on a round glass's rim too):
    # up from the bottom to the scene list, down from the top to the scene's
    # settings, each timed to the built-in scene's finished picture. The way
    # a touch frame is used most; `builtin` times the same scenes opened by a
    # command, without the touch task, the gesture or the event map.
    if not frame.get('linux'):
        out.update(edge_swipes(con, frame, issues))
    issues += incidents_since(con, t0, 'input')
    return {'input': out, 'issues': issues}


def panel_size(display):
    """A panel's (width, height) from boards.json, None when not listed."""
    try:
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'boards.json')) as fh:
            panel = (json.load(fh).get('panels') or {}).get(display) or {}
    except (OSError, ValueError):
        return None
    return (panel['width'], panel['height']) if panel.get('width') and panel.get('height') else None


def edge_swipes(con, frame, issues):
    out = {}
    size = panel_size(frame.get('display'))
    rotate = _console_rotate(con)
    if not size or rotate not in (0, 90, 180, 270):
        return {'swipes': {'skipped': f"panel {size}, rotate {rotate}"}}
    w, h = size
    reach = int(min(w, h) * 0.35)
    # The picture's bottom and top edges on the panel as it is hung (a touch
    # goes through the same turn, panelToScenePoint): (start, end) in panel
    # pixels, from the middle of the edge inwards.
    left, right = ((2, h // 2), (2 + reach, h // 2)), ((w - 3, h // 2), (w - 3 - reach, h // 2))
    top, bottom = ((w // 2, 2), (w // 2, 2 + reach)), ((w // 2, h - 3), (w // 2, h - 3 - reach))
    from_bottom, from_top = {0: (bottom, top), 90: (left, right), 180: (top, bottom), 270: (right, left)}[rotate]
    out['swipe_rotate'] = rotate
    for name, ((x0, y0), (x1, y1)), sid, title, close in (
            ('swipe_switcher', from_bottom, 'system/sceneSwitcher', 'Scene switcher', 'sceneSwitcher'),
            ('swipe_settings', from_top, 'system/sceneSettings', 'Scene settings', 'sceneSettings')):
        drag = (x0, y0, x1, y1)
        # Quiet first: a frame that starts within a second of the last one's
        # end is a burst's, counted in a `render:burst` line and not logged
        # (fos_animation.h), so a swipe right after the scene's own render
        # had its picture drawn at once and no line to time it by (the
        # rotary, the 2.8", the watch and the Sticky, 2026-11-27).
        settle_renders(con)
        con.drain()
        t = time.time()
        con.send('touch drag %d %d %d %d 250' % drag)
        state = {'n': None, 'open': False}

        def shown(x, sid=sid, title=title):
            if x.startswith('{"event":"event:open"') and sid in x:
                state['open'] = True
            if x.startswith('render #') and ' started: scene ' in x:
                named = x.split(' started: scene ', 1)[1].strip()
                if state['n'] is None and (sid in named or f'"{title}"' in named):
                    state['n'] = x.split()[1]
                return False
            if state['n'] is not None and (RENDER_DONE.match(x) or RENDER_FAILED.match(x)):
                return x.split()[1] == state['n']
            # Still a burst's frame (another render came in its second):
            # opened and drawn, with no time of its own.
            return state['open'] and state['n'] is None and '"event":"render:burst"' in x
        t_done, line, _ = con.wait_for(shown, render_timeout(frame))
        if t_done and line and '"event":"render:burst"' in line:
            out[name] = {'wall_ms': None, 'burst': True}
            issues.append(issue('note', 'edge_swipe_untimed', name,
                                'opened, its picture drawn in a burst with no line of its own'))
        else:
            out[name] = {'wall_ms': round((t_done - t) * 1000) if t_done else None}
            if not t_done:
                issues.append(issue('fail', 'edge_swipe', name,
                                    'opened, never drawn' if state['open'] else 'the swipe opened nothing'))
        if state['open']:
            # The same command again goes back to the scene it covered.
            con.drain()
            con.send(f'event {close}')
            wait_render(con, render_timeout(frame))
    settle_renders(con)
    return out


def board_keys(frame):
    """The board's keys and its event map as its preset has them, from the
    UX bench's panel list (tools/ux-bench/panels.json, made from the
    backend's presets): {} for a board it does not list."""
    path = os.path.join(os.path.dirname(__file__), '..', '..', 'ux-bench', 'panels.json')
    try:
        with open(path) as f:
            panels = json.load(f)
    except (OSError, ValueError):
        return {}
    for p in panels.values():
        if p.get('preset') and p.get('preset') == frame.get('module') and p.get('keys'):
            return {'keys': p['keys'], 'eventMap': p.get('eventMap') or []}
    return {}


def _key_role(role, rotate):
    """A key's role as the scene hears it: a direction key's is next or prev
    through the frame's rotation (docs/buttons.md; tools/ux-bench/report.py)."""
    if role not in ('left', 'right', 'up', 'down'):
        return role
    x, y = {'left': (-1, 0), 'right': (1, 0), 'up': (0, -1), 'down': (0, 1)}[role]
    r = (rotate or 0) % 360
    if r == 90:
        x, y = y, -x
    elif r == 180:
        x, y = -x, -y
    elif r == 270:
        x, y = -y, x
    return 'next' if (x > 0 or y > 0) else 'prev'


def _key_rule(event_map, key, role, action):
    for rule in event_map:
        if rule.get('event') != 'button':
            continue
        m = rule.get('match') or {}
        if m.get('action', action) != action:
            continue
        if ('label' in m and m['label'] != key['label']) or ('role' in m and m['role'] != role):
            continue
        return rule
    return None


def key_presses(con, frame, issues):
    """The keys, as the button task hands them over (`event gpio` edges):
    the key whose press is the scene list (a Home key), timed to the list's
    finished picture, and the next-scene key held, timed from its press to
    the next scene's finished picture (the hold acts at its threshold, while
    the key is down). What a person at a keys-only frame waits for most;
    `edge_swipes` is the same for a finger."""
    out = {}
    known = board_keys(frame)
    rotate = _console_rotate(con) or 0
    keys = known.get('keys') or []
    emap = known.get('eventMap') or []

    def edges(key, hold_ms):
        # Compact JSON: the console splits a command on spaces.
        down = json.dumps({'label': key['label'], 'pin': key.get('pin', -1), 'action': 'down', 'level': 0}, separators=(',', ':'))
        up = json.dumps({'label': key['label'], 'pin': key.get('pin', -1), 'action': 'up', 'level': 1}, separators=(',', ':'))
        con.send(f'event gpio {down}')
        threading.Timer(hold_ms / 1000, lambda: con.send(f'event gpio {up}')).start()

    def timed(name, key, hold_ms, sid=None, title=None):
        settle_renders(con)
        con.drain()
        t = time.time()
        edges(key, hold_ms)
        state = {'n': None, 'open': False, 'last': None}

        def shown(x):
            # The scene the key opens (`sid`, by the name its render starts
            # with), or the scene that opens after it: a switch logs the new
            # scene's render as started before its `open` (fos_scenes.c).
            if x.startswith('{"event":"event:open"') and (sid is None or sid in x):
                state['open'] = True
                if sid is None and state['n'] is None:
                    state['n'] = state['last']
            if x.startswith('render #') and ' started: scene ' in x:
                named = x.split(' started: scene ', 1)[1].strip()
                state['last'] = x.split()[1]
                if state['n'] is None and (state['open'] if sid is None else (sid in named or f'"{title}"' in named)):
                    state['n'] = state['last']
                return False
            if state['n'] is not None and (RENDER_DONE.match(x) or RENDER_FAILED.match(x)):
                return x.split()[1] == state['n']
            return state['open'] and state['n'] is None and '"event":"render:burst"' in x
        t_done, line, _ = con.wait_for(shown, render_timeout(frame) + hold_ms / 1000)
        if t_done and line and '"event":"render:burst"' in line:
            out[name] = {'wall_ms': None, 'burst': True, 'key': key['label']}
        else:
            out[name] = {'wall_ms': round((t_done - t) * 1000) if t_done else None, 'key': key['label']}
            if not t_done:
                issues.append(issue('fail', 'key_press', f"{name} ({key['label']})",
                                    'opened, never drawn' if state['open'] else 'the key opened nothing'))
        return state['open']

    home = next((k for k in keys if (_key_rule(emap, k, _key_role(k.get('role', ''), rotate), 'press') or {})
                 .get('emit') == 'sceneSwitcher'), None)
    if home:
        if timed('key_switcher', home, 80, 'system/sceneSwitcher', 'Scene switcher'):
            con.drain()
            con.send('event sceneSwitcher')
            wait_render(con, render_timeout(frame))
    walker = next((k for k in keys if k.get('hold') is not False and _key_role(k.get('role', ''), rotate) == 'next'
                   and ((_key_rule(emap, k, 'next', 'longPress') or {}).get('as') or {}).get('direction') == 'next'), None)
    if walker:
        timed('key_next_held', walker, 1500)
    settle_renders(con)
    return out


def settle_renders(con, quiet=2.0, cap=30.0):
    """Until no render has started for `quiet` seconds (at most `cap`)."""
    end = time.time() + cap
    while time.time() < end:
        t, _, _ = con.wait_for(lambda x: x.startswith('render #') or '"event":"render:' in x, quiet)
        if not t:
            return


def suite_storm(ctx, frame):
    """Eight switches 300 ms apart, then: still alive, showing the last one?"""
    con = ctx.console(frame)
    scenes = [s for s in scene_list(con) if not s.get('isLayout')][:8]
    if len(scenes) < 3:
        return {'skipped': 'too few scenes', 'issues': []}
    t0 = time.time()
    con.drain()
    for s in scenes:
        con.send(f"scene {s['id']}")
        time.sleep(0.3)
    # A switch queued behind a slow render applies when that render ends
    # (a 40 s scene on the E1003): poll until the last one shows, or give up.
    deadline = time.time() + render_timeout(frame) + 60
    con.idle(5)
    while True:
        st = status(con)
        current = (st.get('scenes') or {}).get('currentSceneId')
        if current == scenes[-1]['id'] or time.time() > deadline:
            break
        con.idle(5)
    waited = round(time.time() - t0, 1)
    issues = incidents_since(con, t0, 'switch storm')
    if current != scenes[-1]['id']:
        issues.append(issue('fail', 'storm_last_scene', 'switch storm', f"shows {current}, asked last for {scenes[-1]['id']}"))
    return {'storm': {'asked': [s['id'] for s in scenes], 'current': current, 'settled_s': waited,
                      'psramFree': (st.get('memory') or {}).get('psramFree'),
                      'internalFree': (st.get('memory') or {}).get('internalFree')}, 'issues': issues}


# What a soak samples after each round: an ESP32's heaps, a Linux frame's RAM
# and the runtime's resident set (linux.py).
SOAK_MEMORY = ('psramFree', 'internalFree', 'internalLargestBlock', 'ramAvailable', 'processRss')


def suite_soak(ctx, frame, rounds=None):
    """Every scene once per round; memory after each round. A steady fall is a leak."""
    rounds = rounds or getattr(ctx, 'soak_rounds', 5)
    con = ctx.console(frame)
    scenes = [s for s in scene_list(con) if not s.get('isLayout')]
    if ctx.quick:
        scenes, rounds = scenes[:3], 2
    # A slow panel: the trouble scenes and this run's turn, three rounds. The
    # photo scenes again and again is what fragmented the E1004 (#814).
    left_out = []
    if sampled(ctx, frame):
        scenes, left_out = pick_scenes(ctx, frame, scenes, keep_largest=1)
        rounds = min(rounds, 3)
    t0 = time.time()
    samples = []
    st = status(con)
    samples.append({'round': 0, **{k: (st.get('memory') or {}).get(k) for k in SOAK_MEMORY}})
    for r in range(1, rounds + 1):
        for s in scenes:
            con.drain()
            con.send(f"scene {s['id']}")
            wait_render(con, render_timeout(frame))
            con.idle(0.5)
        con.idle(3)
        st = status(con)
        samples.append({'round': r, **{k: (st.get('memory') or {}).get(k) for k in SOAK_MEMORY}})
    issues = incidents_since(con, t0, 'soak')
    for key, tol in (('internalFree', 4096), ('psramFree', 65536), ('ramAvailable', 4 << 20)):
        vals = [s[key] for s in samples[1:] if s.get(key) is not None]
        if len(vals) >= min(5, rounds) and len(vals) >= 3 and all(b < a for a, b in zip(vals, vals[1:])) and vals[0] - vals[-1] > tol:
            issues.append(issue('fail', 'leak', 'soak', f'{key} fell every round: {vals}'))
    # A Linux frame: the runtime's resident memory climbing every round. It
    # climbs for the first rounds anyway (its caches, malloc's arenas) and
    # settles: on x86 +5, +5, +2 MB, then flat for twelve rounds of the
    # cloud-w scenes (2026-11-24). A leak keeps its pace; warming up slows.
    issues += rss_trend_issues([s['processRss'] for s in samples[1:] if s.get('processRss') is not None])
    return {'soak': samples, 'issues': issues, 'left_out': left_out}


def rss_trend_issues(vals):
    """`processRss` after each soak round: a leak when it rose every round,
    by over 2 MB, and the later rounds' rises are not smaller than the
    earlier ones' (a leak keeps its pace); still rising but slowing is the
    runtime settling, a note."""
    steps = [b - a for a, b in zip(vals, vals[1:])]
    if len(vals) < 3 or not all(step > 0 for step in steps) or vals[-1] - vals[0] <= (2 << 20):
        return []
    half = len(steps) // 2
    early = sum(steps[:half]) / half
    late = sum(steps[half:]) / (len(steps) - half)
    mb = [round(v / (1 << 20), 1) for v in vals]
    if late >= early * 0.5:
        return [issue('fail', 'leak', 'soak', f'processRss rose every round, at the same pace: {mb} MB')]
    return [issue('note', 'rss_settling', 'soak', f'processRss still rising, slower each round: {mb} MB')]


class Tarpit:
    """A TCP port that accepts and never answers: a backend that hangs."""

    def __init__(self, port=8998):
        # Frames run in parallel: two in the offline suite at once each take
        # their own port, the next free one from `port` up.
        for self.port in range(port, port + 16):
            self.sock = socket.socket()
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                self.sock.bind(('0.0.0.0', self.port))
                break
            except OSError:
                self.sock.close()
        else:
            raise OSError(f'no free tarpit port in {port}..{port + 15}')
        self.sock.listen(64)
        self.conns = []
        self.alive = True
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        self.sock.settimeout(0.5)
        while self.alive:
            try:
                c, _ = self.sock.accept()
                self.conns.append(c)
            except OSError:
                continue

    def close(self):
        self.alive = False
        for c in self.conns:
            c.close()
        self.sock.close()


def suite_offline(ctx, frame, tarpit_port=8998):
    """The frame's backend hangs: scene switches and renders must still be prompt."""
    if frame.get('linux'):
        # Its backend address is frame.json's, read once at start (a change is
        # a push and a restart), and a Linux runtime makes no backend round
        # trip on its render path: no console `set backend` to point it away.
        return {'skipped': 'a Linux frame: its backend cannot be pointed away for a while', 'issues': []}
    con = ctx.console(frame)
    if frame['kind'] != 'local' or not ctx.host_ip or not frame.get('backend_url'):
        return {'skipped': 'needs a local-rendering frame with a backend, and --host-ip', 'issues': []}
    scenes = [s for s in scene_list(con) if not s.get('isLayout')][:3]
    pit = Tarpit(tarpit_port)
    t0 = time.time()
    out, issues = [], []
    try:
        con.command(f'set backend http://{ctx.host_ip}:{pit.port}', 1.5)
        con.idle(20)  # let a round of pulls start hanging
        for s in scenes:
            con.drain()
            t = time.time()
            con.send(f"scene {s['id']}")
            t_done, line, got = wait_render(con, 180)
            w = summarize(got)
            wall = round((t_done - t) * 1000) if t_done else None
            done = w['done'][-1]['ms'] if w['done'] else None
            out.append({'scene': s.get('name'), 'wall_ms': wall, 'done_ms': done})
            if wall is None or (done is not None and wall - done > SWITCH_SLOW_MS):
                issues.append(issue('slow', 'offline_switch', f"scene {s.get('name')}",
                                    f'with the backend hanging the switch took {wall} ms (render {done} ms)'))
            con.idle(2)
    finally:
        con.command(f"set backend {frame['backend_url']}", 1.5)
        pit.close()
    issues += incidents_since(con, t0, 'offline')
    return {'offline': out, 'issues': issues}


def suite_reboot(ctx, frame):
    """Restart: time to Wi-Fi, to the first picture; nothing crashes on the way."""
    con = ctx.console(frame)
    con.drain()
    t = time.time()
    con.send('restart')
    t_boot, _, _ = con.wait_for(lambda x: '"event":"bootup"' in x or 'frameos-pico' in x, 90)
    t_done, line, got = wait_render(con, render_timeout(frame) + 60)
    boot = None
    for _, x in got:
        ev = event(x)
        if ev and ev.get('event') == 'bootup':
            boot = ev
    issues = [i for i in incidents_since(con, t, 'reboot') if i['kind'] != 'reboot']
    if not t_done:
        issues.append(issue('fail', 'boot_no_render', 'reboot', 'no render after restart'))
    con.boots = [b for b in con.boots if b < t]  # this boot was asked for
    return {'reboot': {'to_bootup_ms': round((t_boot - t) * 1000) if t_boot else None,
                       'to_first_render_ms': round((t_done - t) * 1000) if t_done else None,
                       'bootup': boot}, 'issues': issues}


def suite_thin(ctx, frame):
    """A frame its backend renders for: the plane's render, 304s, and the device's pull."""
    issues, out = [], []
    be = ctx.backend
    fid = frame.get('backend_frame')
    if not be or not fid or not frame.get('api_key'):
        return {'skipped': 'needs the backend frame and its key', 'issues': []}
    bf = be.frame(fid)
    scenes = [s for s in (bf.get('scenes') or []) if not (s.get('settings') or {}).get('isLayout')]
    if ctx.quick:
        scenes = scenes[:3]
    refresh_s = frame.get('refresh_s', 30)
    for s in scenes:
        be.event(fid, 'setCurrentScene', {'sceneId': s['id']})
        times = []
        etag = None
        for i in range(3):
            ms, code, headers, body = be.device_render(fid, frame['api_key'], etag if i == 2 else None)
            tag = headers.get('etag') or headers.get('ETag')
            times.append({'ms': round(ms), 'status': code, 'bytes': len(body), 'etag': tag})
            etag = tag or etag
            nxt = headers.get('x-frameos-next-render') or headers.get('X-FrameOS-Next-Render')
        entry = {'scene': s.get('name'), 'pulls': times, 'next_render_s': nxt}
        # Only a picture that did not change between the first two pulls owes a 304
        # (a clock with a seconds hand is a new picture every pull), and only if
        # it had not changed by the third either: an answer with another ETag is
        # a new picture (a clock's minute turning over between the pulls, sent
        # as a FOSB v2 delta), not a missed 304.
        if (times[0]['etag'] and times[0]['etag'] == times[1]['etag'] and times[2]['status'] != 304
                and times[2]['etag'] in (None, times[1]['etag'])):
            issues.append(issue('note', 'no_304', f"scene {s.get('name')}",
                                f"a pull with the ETag of an unchanged picture got {times[2]['status']}, {times[2]['bytes']} bytes"))
        try:
            if nxt and refresh_s and float(nxt) < refresh_s:
                issues.append(issue('slow', 'next_render_under_refresh', f"scene {s.get('name')}",
                                    f'the plane asks for the next picture in {nxt} s; this panel takes ~{refresh_s} s to refresh'))
        except ValueError:
            pass
        out.append(entry)
    # The device's own pull and refresh (the Pico's console `render`).
    device = None
    if frame['kind'] == 'pico':
        con = ctx.console(frame)
        con.drain()
        t = time.time()
        con.send('render', eol=b'\n')
        t_done, line, got = con.wait_for(lambda x: '"render:done"' in x or ('"event":"render"' in x and 'error' in x), 120)
        tf = next((tt for tt, x in got if '"stage":"fetch"' in x), None)
        tp = next((tt for tt, x in got if '"render:device"' in x), None)
        # The Pico prints nothing while the panel refreshes (its console is
        # serviced between passes), so only the total is measurable here.
        device = {'total_ms': round((t_done - t) * 1000) if t_done else None, 'last': line}
        if not t_done:
            issues.append(issue('fail', 'pico_render', 'device', 'no render:done'))
    return {'thin': out, 'device': device, 'issues': issues}


DESKTOP_LAYOUTS = ['layout-windows-98', 'layout-tiling', 'layout-macos', 'layout-beos', 'layout-classic-mac',
                   'layout-nextstep', 'layout-os2-warp', 'layout-omarchy', 'layout-commander']
# Scenes cheap to keep open as windows, tried first (by name); then the frame's first ones.
LIGHT_SCENES = ['Clock', 'Counter', 'Calculator', 'Tap counter', 'Touch test', 'Colors', 'Steps', 'To-do', 'Now playing']


def samples_root():
    """The checkout whose repo/scenes/samples the desktop and code suites push:
    this one, or $FRAMEOS_BENCH_SAMPLES (a branch under test, benched with the
    tooling of another)."""
    import os
    return os.path.abspath(os.environ.get('FRAMEOS_BENCH_SAMPLES') or
                           os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _sample_layout(repo_root, layout_id):
    import glob
    import os
    for path in glob.glob(os.path.join(repo_root, 'repo', 'scenes', 'samples', '*', 'scenes.json')):
        with open(path) as fh:
            data = json.load(fh)
        for s in data if isinstance(data, list) else [data]:
            if s.get('id') == layout_id:
                return s
    return None


def _push_and_wait(ctx, frame, scenes, expect_layout=None, timeout=300, catalog_ok=False):
    """Save the frame's scenes on the backend, push, wait for the device to take them and render.

    `catalog_ok`: a push that adds or removes a scene the panel is not showing
    (the Code editor) is applied without any `scenes:load`: the board patches
    its store and prints its new `setSceneCatalog`, and nothing renders. Every
    such push read as a 300 s timeout (the 2026.11.12 bench, four of five
    boards); a desktop push changes the scene showing, so it keeps the load."""
    con = ctx.console(frame)
    be, fid = ctx.backend, frame['backend_frame']
    con.drain()
    t = time.time()
    be.update_frame(fid, {'scenes': scenes})
    be.push(fid)
    # Taken: `scenes:load ... runtime-loaded` from the backend (a patch or the
    # whole list), or, on a board without the room to take a set whole
    # (`taken-to-store`, the E1004's desktop sets), from flash once the store
    # wrote it (`"origin":"stored"`): that one never says backend, and every
    # such push read as a 300 s timeout (the hardware bench, 2026-11-16).
    _, line, got = con.wait_for(lambda x: ('"scenes:load"' in x and ('"origin":"backend"' in x or '"origin":"stored"' in x)) or
                                (catalog_ok and 'setSceneCatalog:' in x) or
                                ('"scenes:sync"' in x and '"status":"error"' in x and 'patch-refused' not in x and 'connect' not in x), timeout)
    if catalog_ok and line and 'setSceneCatalog:' in line:
        return round((time.time() - t) * 1000), line, []
    if line and '"status":"error"' in line:
        # A second fetch can fail while the first payload is applying (a board
        # short of memory): the push took if a backend load follows.
        _, ok_line, more_lines = con.wait_for(lambda x: '"scenes:load"' in x and ('"origin":"backend"' in x or '"origin":"stored"' in x) and '"status":"ok"' in x, 20)
        got += more_lines
        if ok_line:
            line = ok_line
    took = round((time.time() - t) * 1000) if line and '"status":"ok"' in line else None
    _, _, more = wait_render(con, render_timeout(frame))
    notes = [x for _, x in got + more if '"scenes:patch"' in x and '"status":"error"' in x]
    return took, line, notes


def suite_desktop(ctx, frame, layouts=None):
    """Desktop mode: every scene dressed in a windowing layout, several open as windows."""
    import os
    if frame['kind'] != 'local':
        return {'skipped': 'a board rendered on its plane has no windows (docs/scene-layouts.md)', 'issues': []}
    if not ctx.backend or not frame.get('backend_frame'):
        return {'skipped': 'needs the backend frame', 'issues': []}
    con = ctx.console(frame)
    be, fid = ctx.backend, frame['backend_frame']
    repo_root = samples_root()
    original = be.frame(fid).get('scenes') or []
    plain = [s for s in original if not (s.get('settings') or {}).get('isLayout')]
    by_name = {s.get('name'): s for s in plain}
    windows = 2 if sampled(ctx, frame) else 4
    open_list = [by_name[n] for n in LIGHT_SCENES if n in by_name][:windows]
    for s in plain:
        if len(open_list) >= windows:
            break
        if s not in open_list:
            open_list.append(s)
    results, issues = [], []
    t_suite = time.time()
    chosen = None
    try:
        todo = layouts or (DESKTOP_LAYOUTS[:1] if ctx.quick else DESKTOP_LAYOUTS)
        if not layouts and sampled(ctx, frame):
            # The trouble pair in a row, then this run's turn of the rest.
            rest = [l for l in todo if l not in TROUBLE_LAYOUTS]
            todo = [l for l in TROUBLE_LAYOUTS if l in DESKTOP_LAYOUTS] + [l for l in rest if in_turn(ctx, l)]
            skipped_layouts = [l for l in rest if l not in todo]
            if skipped_layouts:
                issues.append(issue('note', 'sampled', 'desktop',
                                    f"slow panel: {', '.join(skipped_layouts)} left for another run's turn"))
        for lid in todo:
            where = f'desktop {lid}'
            sample = _sample_layout(repo_root, lid)
            if not sample:
                issues.append(issue('fail', 'desktop_missing_sample', where, 'no such sample layout in repo/scenes/samples'))
                continue
            # The frame's own layouts stay off the set: one chosen on the frame
            # (its frame page's Layout) wins over every install's while the frame
            # holds it (layout_choice.layoutFor), and the Sticky's set held an
            # install copy of Windows 98 under its own id, so its desktop runs
            # benched that copy's code whatever sample was pushed (2026-11-20).
            scenes = [dict(s) for s in original
                      if s.get('id') not in DESKTOP_LAYOUTS and not (s.get('settings') or {}).get('isLayout')]
            for s in scenes:
                if not (s.get('settings') or {}).get('isLayout'):
                    s['layout'] = {'sceneId': lid}
            scenes.append(sample)
            if chosen and chosen != lid:
                extra = _sample_layout(repo_root, chosen)
                if extra and all(x.get('id') != chosen for x in scenes):
                    scenes.append(extra)
            t0 = time.time()
            took, line, notes = _push_and_wait(ctx, frame, scenes)
            entry = {'layout': lid, 'push_ms': took, 'push_line': (line or '')[:200], 'windows': []}
            if took is None:
                issues.append(issue('fail', 'desktop_push', where, 'the device did not take the pushed scenes: ' + (line or 'timeout')[:200]))
            for n in notes[:1]:
                ev = event(n) or {}
                issues.append(issue('note', 'patch_refused', where, f"a patch push was refused ({ev.get('detail')}); the whole list went instead"))
            st = status(con)
            entry['before'] = {k: (st.get('memory') or {}).get(k) for k in ('psramFree', 'internalFree')}
            for s in open_list:
                con.drain()
                t = time.time()
                con.send('event setCurrentScene {"sceneId":"%s"}' % s['id'])
                t_done, l2, got = wait_render(con, render_timeout(frame))
                _, _, tail = con.wait_for(lambda x: x.startswith('{"event":"render:done"'), 3)
                w = summarize(got + tail)
                ev = w['events_done'][-1] if w['events_done'] else {}
                win = {'scene': s.get('name'), 'wall_ms': round((t_done - t) * 1000) if t_done else None,
                       'done_ms': w['done'][-1]['ms'] if w['done'] else None, 'freePsram': ev.get('freePsram'),
                       'in_place': (w['renders'][-1] if w['renders'] else {}).get('in_place')}
                if t_done and unlogged_since(con, t):
                    win.update({'wall_ms': None, 'done_ms': None, 'unlogged': True})
                if frame['touch'] and t_done:
                    con.drain()
                    tt = time.time()
                    tap(con, frame, 0.5, 0.45)
                    wt = summarize(con.idle(3 + frame.get('refresh_s', 0)))
                    first = min([d['t'] for d in wt['done']] + [b['t'] for b in wt['burst']], default=None)
                    win['tap_ms'] = round((first - tt) * 1000) if first else None
                entry['windows'].append(win)
                if not t_done:
                    issues.append(issue('fail', 'desktop_window', where, f"bringing {s.get('name')} forward produced no render"))
                elif win['wall_ms'] and win['done_ms'] is not None and win['wall_ms'] - win['done_ms'] > SWITCH_SLOW_MS:
                    issues.append(issue('slow', 'desktop_switch_wait', where, f"{s.get('name')}: {win['wall_ms']} ms for a {win['done_ms']} ms render"))
            # Back to the first window: it should be running already (no load).
            con.drain()
            t = time.time()
            con.send('event setCurrentScene {"sceneId":"%s"}' % open_list[0]['id'])
            t_done, _, got = wait_render(con, render_timeout(frame))
            entry['refocus_first_ms'] = round((t_done - t) * 1000) if t_done and not unlogged_since(con, t) else None
            entry['loaded_again'] = any('loadScene' in x for _, x in got)
            st = status(con)
            entry['after'] = {k: (st.get('memory') or {}).get(k) for k in ('psramFree', 'internalFree')}
            entry['loaded'] = (st.get('scenes') or {}).get('loaded')
            if frame['lcd'] and not frame.get('linux') and any(w.get('in_place') is False for w in entry['windows']):
                issues.append(issue('slow', 'not_in_place', where, 'a desktop render on the LCD packed a separate image'))
            missing = sorted({(event(x) or {}).get('layoutSceneId') for x in con.history_since(t0) if '"layout:missing"' in x})
            if missing:
                entry['layout_missing'] = missing
                if lid not in missing and took is None:
                    # The device did not take this push: the missing layout is
                    # the set before's, still run against a store that holds
                    # this one (fos_scenes.c reloads from flash after a refused
                    # set), not a layout chosen on the frame.
                    issues.append(issue('fail', 'stale_set', where,
                                        f'the push was not taken and the frame still wears {missing[0]} from the set before, which flash no longer holds'))
                elif lid not in missing and chosen is None:
                    chosen = missing[0]
                    issues.append(issue('fail', 'frame_layout_choice', where,
                                        f'the frame wears {missing[0]}, chosen on the frame, over every install: that layout is not on the frame, and each render looks it up again'))
            issues += incidents_since(con, t0, where)
            results.append(entry)
    finally:
        _push_and_wait(ctx, frame, original)
    # A reboot during the restore push (each layout's own window already counted its own).
    seen = {i['detail'] for i in issues if i['kind'] in ('reboot', 'ota_mid_run')}
    issues += [i for i in incidents_since(con, t_suite, 'desktop restore') if i['kind'] in ('reboot', 'ota_mid_run') and i['detail'] not in seen]
    return {'desktop': results, 'issues': issues}


def _console_rotate(con):
    """The rotation the board has now: the console `status` says it. Read to
    its end (the heap line, `fos_console.c` cmd_status), not for a fixed
    time: a board can go quiet for seconds in the middle of it (the E1004's
    `internal:` line, 8 s of its 24 MB /state), and what is sent then waits
    behind it. The key hold sent after a 3 s read reached the E1004's button
    task as one 9 ms press (2026-11-28)."""
    if type(con) is Console:
        con.drain()
        con.send('status')
        _, _, got = con.wait_for(lambda x: 'lowest-ever free' in x, 30)
        lines = [x for _, x in got]
    else:
        lines = con.command('status', 3)  # a Linux frame's answers at once (linux.py)
    for line in lines:
        m = re.match(r'rotate:\s+(\d+)', line.strip())
        if m:
            return int(m.group(1))
    return None


def _asked_restart(con, frame, t, where, rotate=None):
    """A restart the step asked for (a new rotation restarts the firmware,
    fos_frame_settings.c / fos_settings.c): ONE boot, woken by `restart`,
    the runtime up at the rotation asked for, and a picture after. A panic, a
    watchdog or a second boot is the crash a person saw as "it crashed, and
    came back rotated ten seconds later" (the reTerminal Sticky, 2026-11-22).
    Returns (measurements, issues); the asked-for boot leaves `con.boots`."""
    issues = []
    # A Linux frame takes a pushed setting by reloading its config, or by a
    # restart (linux.py): either is the apply asked for.
    linux = frame.get('linux')
    t_boot, line, _ = con.wait_for(lambda x: '"event":"bootup"' in x or (linux and '"event":"event:reload"' in x), 120)
    if not t_boot:
        return {'restart_ms': None}, [issue('fail', 'no_restart', where, 'the board did not restart within 120 s')]
    t_done, _, _ = wait_render(con, render_timeout(frame) + 60)
    con.idle(3)  # the wake line goes out after the first pass's logs
    lines = con.history_since(t)
    causes = [(event(x) or {}).get('cause') for x in lines if '"event":"wake"' in x]
    turned = [int(m.group(1)) for x in lines for m in [re.search(r'nim runtime initialized: \S+ rotate=(\d+)', x)] if m]
    boots = [b for b in con.boots if b >= t]
    # The notice it drew before going (fos_restart.h): on a board that has the
    # fast waveform or an LCD, `ok` (`ESP_OK` on the firmware that first had
    # it: the image names its reasons since); nothing on firmware before it.
    notices = [(event(x) or {}).get('status') for x in lines if '"event":"restart:notice"' in x]
    out = {'restart_ms': round((t_boot - t) * 1000), 'to_render_ms': round((t_done - t) * 1000) if t_done else None,
           'wake': causes[-1] if causes else None, 'rotate': turned[-1] if turned else None, 'boots': len(boots),
           'notice': notices[-1] if notices else None}
    if linux:
        out['applied_by'] = 'restart' if '"event":"bootup"' in (line or '') else 'reload'
    if notices and notices[-1] not in ('ok', 'ESP_OK'):
        issues.append(issue('note', 'restart_notice', where, f'the restart notice was not drawn: {notices[-1]}'))
    if out['restart_ms'] > 25000:
        issues.append(issue('slow', 'restart_slow', where, f"{out['restart_ms']} ms from the ask to the boot"))
    issues += [i for i in incidents_since(con, t, where) if i['kind'] not in ('reboot', 'ota_mid_run')]
    if any(c not in (None, 'restart') for c in causes):
        issues.append(issue('crash', 'restart_cause', where, f"woke by {', '.join(str(c) for c in causes)}, not the restart asked for"))
    if len(boots) > 1:
        issues.append(issue('crash', 'restart_loop', where, f'{len(boots)} boots for one restart'))
    if not t_done:
        issues.append(issue('fail', 'restart_no_render', where, 'no picture after the restart'))
    if rotate is not None and out['rotate'] is not None and out['rotate'] != rotate:
        issues.append(issue('fail', 'rotate_not_applied', where, f"came back at rotate={out['rotate']}, asked {rotate}"))
    con.boots = [b for b in con.boots if b < t]  # asked for
    return out, issues


def drag(con, x_frac, y0_frac, y1_frac, steps=8):
    """A finger dragged on the glass (wire coordinates, as `tap`)."""
    x = int(32767 * x_frac)
    con.send('event pointerDown {"x":%d,"y":%d,"pointerId":1,"pointerType":"touch","button":0,"buttons":1}'
             % (x, int(32767 * y0_frac)))
    for i in range(1, steps + 1):
        time.sleep(0.05)
        y = y0_frac + (y1_frac - y0_frac) * i / steps
        con.send('event pointerMove {"x":%d,"y":%d,"pointerId":1,"pointerType":"touch","buttons":1}' % (x, int(32767 * y)))
    time.sleep(0.05)
    con.send('event pointerUp {"x":%d,"y":%d,"pointerId":1,"pointerType":"touch","button":0,"buttons":0}'
             % (x, int(32767 * y1_frac)))


def _switcher_pages(ctx, frame, rounds=2, pages=3):
    """The scene switcher opened and scrolled a screenful at a time, a few
    rounds: a reTerminal Sticky stopped at its second page, mid-refresh, the
    panel left grey and the board answering nothing until a reset (twice on
    2026-11-22, the release 2026.11.14). Each step must end its render; a
    render that starts and never ends is the hang. Returns (results, issues)."""
    con = ctx.console(frame)
    out, issues = [], []
    t0 = time.time()
    # A drag on a list that scrolls renders at its lift, a partial update on
    # e-paper: seconds. One that renders nothing in this long scrolled
    # nothing: every tile is on the screen (the E1003's 1872x1404 holds 23
    # scenes and has room to spare), and the round has no pages to turn. It
    # used to wait out the switcher's own 300 s and say nothing.
    drag_wait = 20 + 2 * frame.get('refresh_s', 5)
    for r in range(rounds):
        where = f'switcher round {r + 1}'
        con.drain()
        t_ask = time.time()
        con.send('event sceneSwitcher')
        t_open, _, _ = wait_scene_render(con, drag_wait, lambda x: 'system/sceneSwitcher' in x or '"Scene switcher"' in x)
        if not t_open:
            # Opened a few seconds after the render that closed it, its
            # picture is a burst's quiet frame: drawn, and only counted in the
            # `render:burst` line (the E1003's second round, which waited out
            # the render timeout and said it never opened).
            seen = con.history_since(t_ask)
            if (any('"event":"event:open"' in x and 'system/sceneSwitcher' in x for x in seen) and
                    any('"event":"render:burst"' in x for x in seen)):
                t_open = time.time()
        steps, fits = [], False
        for p in range(pages):
            con.drain()
            t = time.time()
            drag(con, 0.5, 0.8, 0.2)
            # Renders that come quickly (a list following a finger on an LCD)
            # are summed up in one `render:burst` line, not logged one by one:
            # the AMOLED's page was drawn five times in a second and the suite
            # waited 60 s for a `render #N done`, until the switcher closed
            # itself and every later step landed on the wrong scene (2026-11-25).
            t_done, line, got = con.wait_for(lambda x: bool(RENDER_DONE.match(x) or RENDER_FAILED.match(x)) or
                                             (x.startswith('render #') and ' started: scene ' in x) or
                                             '"event":"render:burst"' in x, drag_wait)
            if line and ' started: scene ' in line:
                t_done = None
            started = [x for _, x in got if ' started: scene ' in x]
            if not t_done and started:
                # A render that began: its end, however long the panel takes.
                t_done, line, more = wait_render(con, render_timeout(frame))
                got += more
            steps.append({'page': p + 2, 'ms': round((t_done - t) * 1000) if t_done else None})
            if not t_done and started:
                issues.append(issue('crash', 'render_stuck', where, f'page {p + 2}: {started[-1][:160]} and no end in {render_timeout(frame)} s'))
                break
            if not t_done:
                fits = p == 0
                if not fits:
                    issues.append(issue('fail', 'switcher_drag', where,
                                        f'page {p + 2}: a drag drew nothing in {drag_wait} s after page {p + 1} scrolled'))
                break
            con.idle(1.5)
        con.drain()
        con.send('event sceneSwitcher')  # the same command again goes back
        wait_render(con, render_timeout(frame))
        out.append({'round': r + 1, 'opened': bool(t_open), 'pages': steps, **({'fits': True} if fits else {})})
    alive = any('frame_id' in x for x in con.command('status', 4))
    if not alive:
        issues.append(issue('crash', 'no_answer', 'switcher pages', 'the console stopped answering after the switcher pages'))
    issues += incidents_since(con, t0, 'switcher pages')
    return out, issues


def suite_settings(ctx, frame):
    """What a person changes on a frame that it takes a while to show: the
    rotation (a restart: there and back, nothing else may happen on the way)
    and the layout every scene wears (each layout the frame holds, then none,
    pushed one after another). Both crashed for someone, or looked as if
    they did (the reTerminal Sticky and a reTerminal, 2026-11-22)."""
    if frame['kind'] != 'local':
        return {'skipped': 'a board rendered on its plane draws no rotation or layout of its own', 'issues': []}
    con = ctx.console(frame)
    be, fid = ctx.backend, frame.get('backend_frame')
    out, issues = {'rotate': [], 'layouts': []}, []

    # The rotation: through the frame's backend when it has one (the settings
    # it pushes win over the console's, and turn the board back), else the
    # console's `set rotate` and a restart.
    start = (be.frame(fid).get('rotate') if be and fid else None)
    if start is None:
        start = _console_rotate(con)
    if start is None:
        issues.append(issue('note', 'rotate_unknown', 'rotate', 'the board did not say its rotation: not turned'))
    else:
        start = int(start) % 360
        for target in ((start + 90) % 360, start):
            where = f'rotate {target}'
            con.drain()
            t = time.time()
            if be and fid:
                be.update_frame(fid, {'rotate': target})
                be.push(fid)
            else:
                con.command(f'set rotate {target}', 2)
                con.send('restart')
            got, found = _asked_restart(con, frame, t, where, rotate=target)
            out['rotate'].append({'to': target, **got})
            issues += found
            if got.get('restart_ms') is None:
                break

    # The scene switcher a screenful at a time, on a touch board.
    if frame.get('touch'):
        out['switcher'], found = _switcher_pages(ctx, frame)
        issues += found
    else:
        out['switcher_skipped'] = 'no touch: the pages are a drag on the glass'

    # The layout around every scene: each the frame holds, then none.
    if not be or not fid:
        out['layouts_skipped'] = 'needs the backend frame'
    else:
        original = be.frame(fid).get('scenes') or []
        layouts = [s for s in original if (s.get('settings') or {}).get('isLayout')]
        picks = [l['id'] for l in layouts]
        if sampled(ctx, frame):
            kept = [l for l in picks if in_turn(ctx, l)] or picks[:1]
            if len(kept) < len(picks):
                issues.append(issue('note', 'sampled', 'settings', f"slow panel: {len(picks) - len(kept)} layout(s) left for another run's turn"))
            picks = kept
        # A push of the set the board holds changes nothing, and the board
        # takes nothing it could be timed by: the E1003's scenes all wore
        # "Front page" already, and the E1002 and E1004 hold no layout, so
        # "none" was their set as it was (three 300 s "failures", the
        # hardware bench, 2026-11-25). Such a step is skipped and said.
        current = original
        try:
            for lid in picks + [None]:
                where = f"layout {next((l.get('name') for l in layouts if l['id'] == lid), lid) or 'none'}"
                scenes = []
                for s in original:
                    s = dict(s)
                    if not (s.get('settings') or {}).get('isLayout'):
                        if lid:
                            s['layout'] = {'sceneId': lid}
                        else:
                            s.pop('layout', None)
                    scenes.append(s)
                if scenes == current:
                    out['layouts'].append({'layout': lid, 'unchanged': True})
                    continue
                t0 = time.time()
                took, line, _ = _push_and_wait(ctx, frame, scenes, catalog_ok=True)
                current = scenes
                out['layouts'].append({'layout': lid, 'push_ms': took})
                if took is None:
                    issues.append(issue('fail', 'layout_push', where, 'the device did not take the pushed scenes: ' + (line or 'timeout')[:200]))
                issues += incidents_since(con, t0, where)
        finally:
            if current != original:
                _push_and_wait(ctx, frame, original, catalog_ok=True)
    return {**out, 'issues': issues}


CODE_EDITOR_ID = 'code-editor'
# A thrown frameos.code (or a native the runtime does not have) reaches the
# log as one of these when it escapes the app; what the editor catches it
# writes on the screen instead, which is what the saved pictures are for.
JS_ERROR = re.compile(r'is not a function|TypeError|ReferenceError|is not defined|frameos\.code:')


def _scene_kinds(scene):
    nodes = scene.get('nodes') or []
    return {'js_app': bool(scene.get('apps')), 'code_node': any(n.get('type') == 'code' for n in nodes)}


def suite_code(ctx, frame, opens=None):
    """The Code editor (docs/code-editor.md): installed beside the frame's scenes,
    opened on a few of them (one with a JS app, one with a code node when the
    frame has them) and on its own list, each open timed, its render and log
    checked for JavaScript errors, a tap on touch boards. On a native-USB
    console the panel is saved after each open (`code-<n>.bmp` in the run
    dir): the editor shows a failed frameos.code on the screen, not in a log."""
    import base64
    import os
    if frame['kind'] != 'local':
        return {'skipped': 'the Code editor runs on a board with its own runtime', 'issues': []}
    if not ctx.backend or not frame.get('backend_frame'):
        return {'skipped': 'needs the backend frame', 'issues': []}
    con = ctx.console(frame)
    be, fid = ctx.backend, frame['backend_frame']
    repo_root = samples_root()
    editor = None
    import glob
    for path in glob.glob(os.path.join(repo_root, 'repo', 'scenes', 'samples', '*', 'scenes.json')):
        with open(path) as fh:
            data = json.load(fh)
        for s in data if isinstance(data, list) else [data]:
            if s.get('id') == CODE_EDITOR_ID:
                editor = s
    if not editor:
        return {'skipped': 'no Code editor sample in repo/scenes/samples', 'issues': []}
    row = be.frame(fid)
    if row.get('frame_settings_on_screen') is False:
        return {'skipped': "the frame's settings on its screen are off: the editor reads nothing", 'issues': []}
    original = row.get('scenes') or []
    plain = [s for s in original if not (s.get('settings') or {}).get('isLayout') and s.get('id') != CODE_EDITOR_ID]
    count = opens or (1 if (ctx.quick or sampled(ctx, frame)) else 3)
    targets = []
    for want in ('js_app', 'code_node'):
        hit = next((s for s in plain if _scene_kinds(s)[want] and s not in targets), None)
        if hit:
            targets.append(hit)
    targets += [s for s in plain if s not in targets]
    targets = targets[:count]
    save_images = 'ACM' in frame['port']
    results, issues = [], []
    t_suite = time.time()
    installed = original if any(s.get('id') == CODE_EDITOR_ID for s in original) else original + [editor]
    try:
        if installed is not original:
            took, line, _ = _push_and_wait(ctx, frame, installed, catalog_ok=True)
            if took is None:
                issues.append(issue('fail', 'code_push', 'code install', 'the device did not take the Code editor: ' + (line or 'timeout')[:200]))
                return {'code': results, 'issues': issues}
        for n, target in enumerate([None] + targets):
            where = f"code {target.get('name') if target else '(list)'}"
            state = {'open': target['id'] if target else ''}
            con.drain()
            t0 = time.time()
            con.send('event setCurrentScene %s' % json.dumps({'sceneId': CODE_EDITOR_ID, 'state': state}, separators=(',', ':')))
            # The editor's own render: a frame that renders often (the E1003's
            # Clock, every second) finishes one more of the old scene before
            # the switch lands, and that one is not the editor's.
            mine = '"sceneId":"%s"' % CODE_EDITOR_ID
            t_done, line, got = con.wait_for(lambda x: (x.startswith('{"event":"render:done"') and mine in x) or bool(RENDER_FAILED.match(x)),
                                             render_timeout(frame))
            if t_done and not RENDER_FAILED.match(line):
                _, done_line, tail = con.wait_for(lambda x: bool(RENDER_DONE.match(x)), 3)
                got += tail
                line = done_line or line
            w = summarize(got)
            ev = w['events_done'][-1] if w['events_done'] else {}
            entry = {'scene': target.get('name') if target else None, **(_scene_kinds(target) if target else {}),
                     'wall_ms': round((t_done - t0) * 1000) if t_done else None,
                     'done_ms': w['done'][-1]['ms'] if w['done'] else None,
                     'scene_shown': ev.get('sceneId'), 'freePsram': ev.get('freePsram')}
            if not t_done:
                shown = (w['events_done'][-1] if w['events_done'] else {}).get('sceneId')
                issues.append(issue('fail', 'code_open', where, 'opening the editor produced no render of it' + (f' (the frame kept rendering {shown})' if shown else '')))
            elif line and RENDER_FAILED.match(line):
                issues.append(issue('fail', 'code_render', where, line[:200]))
            elif ev.get('sceneId') and ev['sceneId'] != CODE_EDITOR_ID:
                issues.append(issue('fail', 'code_not_shown', where, f"the frame shows {ev['sceneId']}, not the editor"))
            if frame['touch'] and t_done:
                con.drain()
                tt = time.time()
                tap(con, frame, 0.25, 0.35)
                wt = summarize(con.idle(3 + frame.get('refresh_s', 0)))
                first = min([d['t'] for d in wt['done']] + [b['t'] for b in wt['burst']], default=None)
                entry['tap_ms'] = round((first - tt) * 1000) if first else None
            errs = [x for x in con.history_since(t0) if JS_ERROR.search(x)]
            if errs:
                entry['js_errors'] = errs[:3]
                issues.append(issue('fail', 'code_js_error', where, errs[0][:300]))
            if save_images and t_done:
                ok, body = con.usb_api('image', 60)
                if ok and body:
                    try:
                        safe = ''.join(c if c.isalnum() else '_' for c in (frame.get('name') or frame['port']))
                        path = os.path.join(ctx.out_dir, f'{safe}.code-{n}.bmp')
                        with open(path, 'wb') as fh:
                            fh.write(base64.b64decode(''.join(body.split())))
                        entry['image'] = os.path.basename(path)
                    except Exception as exc:  # a log line glued into the payload
                        entry['image_error'] = str(exc)[:120]
            if entry['wall_ms'] and entry['done_ms'] is not None and entry['wall_ms'] - entry['done_ms'] > SWITCH_SLOW_MS:
                issues.append(issue('slow', 'code_open_wait', where, f"{entry['wall_ms']} ms for a {entry['done_ms']} ms render"))
            if (entry['done_ms'] or 0) > WARM_SLOW_MS:
                issues.append(issue('slow', 'code_render_slow', where, f"the editor rendered in {entry['done_ms']} ms"))
            results.append(entry)
        issues += incidents_since(con, t_suite, 'code')
    finally:
        if installed is not original:
            _push_and_wait(ctx, frame, original, catalog_ok=True)
        elif original:
            first = next((s for s in plain), None)
            if first:
                con.send('event setCurrentScene {"sceneId":"%s"}' % first['id'])
                wait_render(con, render_timeout(frame))
    return {'code': results, 'issues': issues}


from .benchmarks import suite_benchmark  # noqa: E402  (it imports helpers from here)
from .video import suite_video  # noqa: E402  (it imports helpers from here)

SUITES = {
    'status': suite_status,
    'benchmark': suite_benchmark,
    'code': suite_code,
    'scenes': suite_scenes,
    'builtin': suite_builtin,
    'input': suite_input,
    'storm': suite_storm,
    'soak': suite_soak,
    'offline': suite_offline,
    'reboot': suite_reboot,
    'thin': suite_thin,
    'desktop': suite_desktop,
    'settings': suite_settings,
    'video': suite_video,
}
# What `--suites default` runs per frame kind.
DEFAULT = {
    # `benchmark` right after the restart: its memory reading (heapinfo's
    # minimum since boot) then covers the boot and the benchmark alone.
    'local': ['status', 'reboot', 'benchmark', 'scenes', 'builtin', 'input', 'desktop', 'code', 'settings', 'video',
              'storm', 'soak', 'offline'],
    'thin': ['status', 'thin'],
    'pico': ['thin'],
}
