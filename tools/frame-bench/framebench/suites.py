"""The bench suites. Each takes a Ctx and a frame (inventory entry), returns a
dict with its measurements and an `issues` list: things a person should look
at, each {severity, kind, where, detail}. Severity: `crash` (panic, abort,
watchdog, reboot, OOM), `fail` (something did not work), `slow` (a number
outside what this board should do), `note` (worth knowing).
"""
from __future__ import annotations

import json
import socket
import threading
import time

from .console import Console
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
                  'Visited World Map', 'Chess puzzle of the day', 'Word clock', 'Big typographic clock',
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
        port = frame['port']
        if port not in self.consoles:
            name = frame.get('name') or port
            safe = ''.join(c if c.isalnum() else '_' for c in name)
            self.consoles[port] = Console(port, f'{self.out_dir}/{safe}.raw.log')
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
            out.append(issue('crash', 'reboot', where, f'board rebooted at +{b - con.t0:.1f}s'))
    return out


def wait_render(con, timeout):
    """Wait for the next `render #N done` / `failed`; returns (t, line, lines)."""
    return con.wait_for(lambda x: bool(RENDER_DONE.match(x) or RENDER_FAILED.match(x)), timeout)


def status(con):
    return con.usb_api_json('status', 20) or {}


def scene_list(con):
    lst = con.usb_api_json('scene-list', 30) or {}
    return lst.get('scenes') or []


def recover_after_boot(con, frame):
    """A board that rebooted: wait for its first render before going on."""
    wait_render(con, render_timeout(frame) + 60)
    con.idle(2)


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
    scenes = [s for s in scene_list(con) if not s.get('isLayout')]
    scene_filter = scene_filter or getattr(ctx, 'scene_filter', None)
    if scene_filter:
        scenes = [s for s in scenes if s['id'] in scene_filter or s.get('name') in scene_filter]
    if ctx.quick:
        scenes = scenes[:4]
    scenes, left_out = pick_scenes(ctx, frame, scenes)
    results, issues = [], []
    for sc in scenes:
        where = f"scene {sc.get('name')}"
        t_start = time.time()
        entry = {'id': sc['id'], 'name': sc.get('name'), 'bytes': sc.get('bytes'), 'refreshInterval': intervals.get(sc['id'])}
        # 1. switch. Wait for a render that STARTED after the command for this scene.
        con.drain()
        t_cmd = time.time()
        con.send(f"scene {sc['id']}")
        started = {'n': None}

        def switched(x, sid=sc['id'], name=sc.get('name')):
            if x.startswith('scene select failed'):
                return True
            if x.startswith('render #') and ' started: scene ' in x and (sid in x or (name and f'"{name}"' in x)):
                started['n'] = x.split()[1]
                return False
            return started['n'] is not None and (x.startswith(f"render {started['n']} done") or x.startswith(f"render {started['n']} failed"))

        t_done, line, got = con.wait_for(switched, render_timeout(frame))
        _, _, tail = con.wait_for(lambda x: x.startswith('{"event":"render:done"'), 3)
        w = summarize(got + tail)
        ok = bool(t_done) and not (line or '').startswith(('scene select failed', 'render #')) or bool(line and ' done in ' in line)
        entry['switch'] = {
            'ok': ok,
            'wall_ms': round((t_done - t_cmd) * 1000) if t_done else None,
            'render': w['renders'][-1] if w['renders'] else None,
            'done_ms': w['done'][-1]['ms'] if w['done'] else None,
            'panel': [p['line'] for p in w['panel']][-3:],
            'errors': w['errors'][:5],
        }
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
            w = summarize(con.idle(ctx.passive))
            # The first summary after a switch holds the scene's first frame (its
            # JS compiled, its pictures decoded): judge the steady state after it.
            running = [a for a in w['animation'] if a.get('status') == 'running']
            anim = running[1:] if len(running) > 1 else running
            entry['passive'] = {
                'seconds': ctx.passive,
                'renders': len(w['done']),
                'animation': [{k: a.get(k) for k in ('frames', 'fps', 'avgMs', 'maxMs', 'periodMs', 'seconds', 'jsKB', 'freePsramKB')} for a in anim],
                'burst': [{k: b.get(k) for k in ('frames', 'avgMs', 'maxMs')} for b in w['burst']],
            }
            for a in anim:
                period = a.get('periodMs') or 0
                fps = a.get('fps') or 0
                if period and fps and fps < ANIMATION_MIN_FPS_RATIO * 1000.0 / period:
                    issues.append(issue('slow', 'animation_fps', where,
                                        f"{fps} fps against a {1000.0 / period:.0f} fps target (avg {a.get('avgMs')} ms, max {a.get('maxMs')} ms)"))
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
        # The fastest path: an LCD draws in its back buffer (`in place`).
        if frame['lcd'] and any(x.get('in_place') is False for x in warm):
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
        if any(i['kind'] == 'reboot' for i in new):
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
    for name in ('sceneSwitcher', 'sceneSettings'):
        res = {}
        for step in ('open', 'close'):
            con.drain()
            t = time.time()
            con.send(f'event {name}')
            t_done, line, got = wait_render(con, render_timeout(frame))
            w = summarize(got)
            res[step] = {'wall_ms': round((t_done - t) * 1000) if t_done else None,
                         'done_ms': w['done'][-1]['ms'] if w['done'] else None,
                         'render': w['renders'][-1] if w['renders'] else None}
            if not t_done:
                issues.append(issue('fail', 'builtin', f'{name} {step}', 'no render'))
            con.idle(1.5)
        out[name] = res
    issues += incidents_since(con, t0, 'built-in scenes')
    return {'builtin': out, 'issues': issues}


def suite_input(ctx, frame):
    """A drag across the panel and next/previous scene, on a touch board."""
    con = ctx.console(frame)
    issues, out = [], {}
    if not frame['touch']:
        return {'skipped': 'no touch', 'issues': []}
    t0 = time.time()
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
    for direction in ('next', 'previous'):
        con.drain()
        t = time.time()
        con.send('event setCurrentScene {"direction":"%s"}' % direction)
        t_done, line, got = wait_render(con, render_timeout(frame))
        out[direction] = {'wall_ms': round((t_done - t) * 1000) if t_done else None}
        if not t_done:
            issues.append(issue('fail', 'scene_direction', direction, 'no render'))
    issues += incidents_since(con, t0, 'input')
    return {'input': out, 'issues': issues}


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
    samples.append({'round': 0, **{k: (st.get('memory') or {}).get(k) for k in ('psramFree', 'internalFree', 'internalLargestBlock')}})
    for r in range(1, rounds + 1):
        for s in scenes:
            con.drain()
            con.send(f"scene {s['id']}")
            wait_render(con, render_timeout(frame))
            con.idle(0.5)
        con.idle(3)
        st = status(con)
        samples.append({'round': r, **{k: (st.get('memory') or {}).get(k) for k in ('psramFree', 'internalFree', 'internalLargestBlock')}})
    issues = incidents_since(con, t0, 'soak')
    for key, tol in (('internalFree', 4096), ('psramFree', 65536)):
        vals = [s[key] for s in samples[1:] if s.get(key) is not None]
        if len(vals) >= min(5, rounds) and len(vals) >= 3 and all(b < a for a, b in zip(vals, vals[1:])) and vals[0] - vals[-1] > tol:
            issues.append(issue('fail', 'leak', 'soak', f'{key} fell every round: {vals}'))
    return {'soak': samples, 'issues': issues, 'left_out': left_out}


class Tarpit:
    """A TCP port that accepts and never answers: a backend that hangs."""

    def __init__(self, port=8998):
        self.port = port
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('0.0.0.0', port))
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
    con = ctx.console(frame)
    if frame['kind'] != 'local' or not ctx.host_ip or not frame.get('backend_url'):
        return {'skipped': 'needs a local-rendering frame with a backend, and --host-ip', 'issues': []}
    scenes = [s for s in scene_list(con) if not s.get('isLayout')][:3]
    pit = Tarpit(tarpit_port)
    t0 = time.time()
    out, issues = [], []
    try:
        con.command(f'set backend http://{ctx.host_ip}:{tarpit_port}', 1.5)
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


def _push_and_wait(ctx, frame, scenes, expect_layout=None, timeout=300):
    """Save the frame's scenes on the backend, push, wait for the device to take them and render."""
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
                                ('"scenes:sync"' in x and '"status":"error"' in x and 'patch-refused' not in x and 'connect' not in x), timeout)
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
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
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
            scenes = [dict(s) for s in original if s.get('id') not in DESKTOP_LAYOUTS]
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
            entry['refocus_first_ms'] = round((t_done - t) * 1000) if t_done else None
            entry['loaded_again'] = any('loadScene' in x for _, x in got)
            st = status(con)
            entry['after'] = {k: (st.get('memory') or {}).get(k) for k in ('psramFree', 'internalFree')}
            entry['loaded'] = (st.get('scenes') or {}).get('loaded')
            if frame['lcd'] and any(w.get('in_place') is False for w in entry['windows']):
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
    seen = {i['detail'] for i in issues if i['kind'] == 'reboot'}
    issues += [i for i in incidents_since(con, t_suite, 'desktop restore') if i['kind'] == 'reboot' and i['detail'] not in seen]
    return {'desktop': results, 'issues': issues}


SUITES = {
    'status': suite_status,
    'scenes': suite_scenes,
    'builtin': suite_builtin,
    'input': suite_input,
    'storm': suite_storm,
    'soak': suite_soak,
    'offline': suite_offline,
    'reboot': suite_reboot,
    'thin': suite_thin,
    'desktop': suite_desktop,
}
# What `--suites default` runs per frame kind.
DEFAULT = {
    'local': ['status', 'reboot', 'scenes', 'builtin', 'input', 'desktop', 'storm', 'soak', 'offline'],
    'thin': ['status', 'thin'],
    'pico': ['thin'],
}
