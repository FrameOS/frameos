"""The benchmark scenes: the same fixed work on every board and every
firmware, for the scores (tools/frame-bench/SCORES.md).

The frame's own scenes differ per board and change between runs, so their
times compare a board with itself at best. These scenes do not: a baseline,
four pieces of JavaScript timed by the board's own clock, one SVG raster, one
JSX UI, one JPEG decode + resize (+ the panel's dither), and on a fast panel
an animation. They are ordinary scenes (tools/frame-bench/benchmarks/<name>),
put on the board over USB (`usb_api scene-put`, firmware 2026.11.7 and later)
next to its own and deleted after, and timed by the lines every firmware
prints (`render #N (...): render X ms, dither+pack Y ms`, `render #N done in
Z ms`, the apps' own `frameos.log`), never by a command a release lacks: the
same suite runs on 2026.11.10 and on main.

While it runs the board's backend points at a closed port on the board itself
(`set backend http://127.0.0.1:9`): no scene pull can take the benchmark
scenes away, no log upload or settings sync shares the render task with them,
and a release older than the backend's never installs the newer one over the
air halfway (every awake board on a release checks every 8.3 minutes up to
2026.11.12). A journal (`~/.frameos-bench/isolated.json`) remembers the real
address until it is put back, so `bench.py restore` (and the next run) can
undo a suite that was killed.
"""
from __future__ import annotations

import base64
import json
import os
import re
import threading
import time

from .parse import stats, summarize

WORKLOAD = 1  # bump with any change to what a benchmark scene does (SCORES.md)
HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = os.path.join(os.path.dirname(HERE), 'benchmarks')
ISOLATED_BACKEND = 'http://127.0.0.1:9'
HOME = os.path.expanduser(os.environ.get('FRAMEOS_BENCH_HOME', '~/.frameos-bench'))
JOURNAL = os.path.join(HOME, 'isolated.json')

# key, name, refresh interval, fast panels only
JSX_SCENES = [
    ('base', 'Bench: baseline', 3600, False),
    ('cpu', 'Bench: CPU', 3600, False),
    ('raster', 'Bench: raster', 3600, False),
    ('ui', 'Bench: UI', 3600, False),
    ('anim', 'Bench: animation', 0.033, True),
]
PHOTO = 'image/photo-1024x768.jpg'
PHOTO_MPX = 1024 * 768 / 1e6


def scene_id(key: str) -> str:
    return f'frame-bench-{key}-w{WORKLOAD}'


def _node(nid, ntype, data):
    return {'id': nid, 'type': ntype, 'position': {'x': 0, 'y': 0}, 'data': data}


def _edge(eid, source, sh, target, th, etype):
    return {'id': eid, 'source': source, 'sourceHandle': sh, 'target': target, 'targetHandle': th, 'type': etype}


def jsx_scene(key, name, interval):
    with open(os.path.join(SOURCES, key, 'app.tsx')) as fh:
        source = fh.read()
    config = {'name': name, 'category': 'data', 'description': f'Frame bench workload {WORKLOAD}: {key}',
              'version': f'{WORKLOAD}.0.0', 'fields': [], 'output': [{'name': 'image', 'type': 'image'}],
              'permissions': []}
    keyword = f'bench{key.capitalize()}'
    return {
        'id': scene_id(key), 'name': name,
        'settings': {'execution': 'interpreted', 'refreshInterval': interval, 'backgroundColor': '#ffffff',
                     'category': 'Demos & examples'},
        'fields': [],
        'nodes': [_node('render', 'event', {'keyword': 'render'}),
                  _node('app', 'app', {'keyword': keyword, 'config': {}}),
                  _node('image', 'app', {'keyword': 'render/image', 'config': {'placement': 'stretch'}})],
        'edges': [_edge('e1', 'render', 'next', 'image', 'prev', 'appNodeEdge'),
                  _edge('e2', 'app', 'fieldOutput', 'image', 'fieldInput/image', 'codeNodeEdge')],
        'apps': {keyword: {**config, 'origin': keyword,
                           'sources': {'config.json': json.dumps(config, indent=2), 'app.tsx': source}}},
    }


def image_scene():
    """A JPEG in the scene itself (a data URL, decoded on every firmware),
    through the built-in download + render nodes with the cache off: the
    decode, the resize to the panel and, on e-paper, the dither and pack."""
    with open(os.path.join(SOURCES, PHOTO), 'rb') as fh:
        url = 'data:image/jpeg;base64,' + base64.b64encode(fh.read()).decode()
    return {
        'id': scene_id('image'), 'name': 'Bench: image',
        'settings': {'execution': 'interpreted', 'refreshInterval': 3600, 'backgroundColor': '#000000',
                     'category': 'Demos & examples'},
        'fields': [],
        'nodes': [_node('render', 'event', {'keyword': 'render'}),
                  _node('download', 'app', {'keyword': 'data/downloadImage', 'config': {'url': url},
                                            'cache': {'enabled': False, 'inputEnabled': False, 'durationEnabled': False,
                                                      'duration': '900', 'expressionEnabled': False}}),
                  _node('image', 'app', {'keyword': 'render/image', 'config': {'placement': 'cover'}})],
        'edges': [_edge('e1', 'render', 'next', 'image', 'prev', 'appNodeEdge'),
                  _edge('e2', 'download', 'fieldOutput', 'image', 'fieldInput/image', 'codeNodeEdge')],
    }


def scenes_for(frame) -> list[dict]:
    out = [jsx_scene(k, n, i) for k, n, i, fast_only in JSX_SCENES if frame.get('lcd') or not fast_only]
    # The image scene after the UI, before the animation.
    out.insert(4, image_scene())
    return out


# ------------------------------------------------------------- isolation
# Every frame's suite runs in its own thread and all share one journal file:
# a read-change-write without the lock lost a write on 2026-11-19 (the
# SenseCAP's animation scene stayed on the board).
_LOCK = threading.Lock()


def _journal() -> dict:
    try:
        with open(JOURNAL) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _write_journal(j: dict):
    os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
    with open(JOURNAL, 'w') as fh:
        json.dump(j, fh, indent=1)


def _journal_set(port, entry):
    with _LOCK:
        j = _journal()
        if entry is None:
            j.pop(port, None)
        else:
            j[port] = entry
        _write_journal(j)


def isolate(con, frame, backend_url: str):
    _journal_set(frame['port'], {'backend': backend_url, 'module': frame.get('module'), 'frame_id': frame.get('frame_id'),
                                 'scenes': [], 'since': time.strftime('%Y-%m-%dT%H:%M:%S')})
    if backend_url:
        con.command(f'set backend {ISOLATED_BACKEND}', 1.5)


def note_scene(frame, sid):
    with _LOCK:
        j = _journal()
        if frame['port'] in j and sid not in j[frame['port']]['scenes']:
            j[frame['port']]['scenes'].append(sid)
            _write_journal(j)


def restore(con, frame, entry=None):
    """Delete the benchmark scenes and point the board back at its backend.
    Every benchmark scene id is deleted, journaled or not (a delete of a scene
    the board does not hold is refused, nothing more)."""
    with _LOCK:
        entry = entry or _journal().get(frame['port'])
    if not entry:
        return None
    if getattr(con, 'linux', False):
        # A Linux frame (linux.py): its uploaded scenes as they were, the
        # file put back and the runtime restarted. It was never pointed away
        # from its backend (no console `set backend` there).
        con.restore_uploads()
        _journal_set(frame['port'], None)
        return entry
    ids = list(dict.fromkeys((entry.get('scenes') or []) + [s['id'] for s in scenes_for({'lcd': True})]))
    listed = con.usb_api_json('scene-list', 60) or {}
    held = {s.get('id') for s in listed.get('scenes') or []}
    for sid in ids:
        if not held or sid in held:
            con.usb_api(f'scene-delete {sid}', 30)
    if entry.get('backend'):
        con.command(f"set backend {entry['backend']}", 1.5)
    _journal_set(frame['port'], None)
    return entry


def restore_all(consoles_for, only=None):
    """`bench.py restore` / the start of a run: put back what a killed run left.
    `consoles_for(port)` gives a Console. Only a port whose board names the
    same module answers is restored (ports move between sessions)."""
    done = []
    for port, entry in list(_journal().items()):
        if only is not None and port not in only:
            continue
        try:
            con = consoles_for(port)
        except Exception as exc:  # the port is gone
            done.append((port, f'not restored: {exc}'))
            continue
        st = con.usb_api_json('status', 20) or {}
        module = (st.get('board') or {}).get('module')
        if getattr(con, 'linux', False):
            con.restore_uploads()
            _journal_set(port, None)
            done.append((port, 'put its uploaded scenes back and restarted the runtime'))
            continue
        if entry.get('module') and module != entry['module']:
            done.append((port, f"not restored: the board there is {module}, the journal's is {entry['module']}"))
            continue
        restore(con, {'port': port}, entry)
        done.append((port, f"restored backend {entry.get('backend')} and deleted {len(entry.get('scenes') or [])} scene(s)"))
    return done


# ------------------------------------------------------------- helpers
HEAP_LINE = re.compile(r'(?:total=(\d+) )?free=(\d+) largest=(\d+) min_ever_free=(\d+)')


def heapinfo(con) -> dict:
    """`heapinfo` (every firmware since #313): free / largest / min-ever-free
    of internal RAM and PSRAM."""
    out, section = {}, None
    for line in con.command('heapinfo', 3):
        if line.startswith('---'):
            low = line.lower()
            # `--- internal (MALLOC_CAP_INTERNAL)`, `--- internal as malloc() sees it (...)`, `--- psram (...)`
            section = ('internal_malloc' if 'as malloc' in low else 'psram' if low.startswith('--- psram')
                       else 'internal' if low.startswith('--- internal') else None)
            continue
        m = HEAP_LINE.search(line)
        if m and section and section not in out:
            out[section] = {'total': int(m.group(1)) if m.group(1) else None, 'free': int(m.group(2)),
                            'largest': int(m.group(3)), 'min_ever_free': int(m.group(4))}
    return out


def _render_entry(w, t_cmd, t_done):
    r = w['renders'][-1] if w['renders'] else {}
    ev = w['events_done'][-1] if w['events_done'] else {}
    return {'wall_ms': round((t_done - t_cmd) * 1000) if t_done else None,
            'done_ms': w['done'][-1]['ms'] if w['done'] else None,
            'render_ms': r.get('ms'), 'pack_ms': r.get('pack_ms') if not r.get('in_place') else 0,
            'in_place': r.get('in_place'), 'probe': r.get('probe') or {},
            'freePsram': ev.get('freePsram'), 'freeHeap': ev.get('freeHeap'),
            'refresh': [d.get('refresh') for d in w['device']][-1:] or None,
            'bench': [{k: v for k, v in b.items() if k != 't'} for b in w['bench']]}


# ------------------------------------------------------------- the suite
def suite_benchmark(ctx, frame):
    """The benchmark scenes, each switched to (cold) and rendered `ctx.bench_n`
    times (warm), a tap on the UI on a touch board, the animation's frame rate
    on a fast panel, and the memory afterwards. Console only: no backend."""
    from .suites import (SLOW_PANEL_S, incidents_since, issue, recover_after_boot, render_timeout, status,
                         switch_scene, tap, wait_render)
    if frame['kind'] != 'local':
        return {'skipped': 'rendered by its plane: see the thin suite', 'issues': []}
    con = ctx.console(frame)
    t_suite = time.time()
    issues, results = [], {}
    st = status(con)
    cfg = st.get('config') or {}
    before = (st.get('scenes') or {}).get('currentSceneId')
    backend_url = cfg.get('backendUrl') or frame.get('backend_url') or ''
    if backend_url == ISOLATED_BACKEND:  # a killed run's: the journal has the real one
        backend_url = (_journal().get(frame['port']) or {}).get('backend') or frame.get('backend_url') or ''
    debug_was = next((l.split()[-1] for l in con.command('status', 2.5) if l.startswith('debug:')), None)
    n = getattr(ctx, 'bench_n', 5) if not ctx.quick else 2
    slow = frame.get('refresh_s', 0) >= SLOW_PANEL_S
    # Whether the last render left the panel refreshing. On a slow panel the
    # next switch waits for that refresh (a 13.3" Spectra on 8 MB draws its
    # next picture in the canvas the refresh still reads), so it is let finish
    # before a cold switch is timed: the E1004's `ui` switch took 28 s on main
    # and 5.6 s on 2026.11.14, all of it the raster benchmark's last refresh,
    # which main makes because its interpreter (and the benchmark's moving
    # picture) now lives across renders (the hardware bench, 2026-11-25).
    refreshing = False
    try:
        # Journaled either way, so a killed run's scenes are deleted.
        isolate(con, frame, backend_url if getattr(ctx, 'isolate', True) else None)
        if debug_was == '1':
            # The probe split is not on every firmware's render line: time
            # every board without it, as it ships.
            con.command('set debug 0', 1.5)
        for scene in scenes_for(frame):
            payload = json.dumps(scene, separators=(',', ':')).encode()
            ok, line = con.put_bytes(f'scene-put {len(payload)}', payload, 120)
            if not ok:
                # A long payload can lose a few bytes on the way (the Sticky's
                # USB on 2026.11.11: 119021 of 119048): once more.
                con.idle(2)
                ok, line = con.put_bytes(f'scene-put {len(payload)}', payload, 120)
            if not ok:
                issues.append(issue('fail', 'bench_put', scene['name'], line[:200]))
                continue
            note_scene(frame, scene['id'])
            key = scene['id'].split('-')[2]
            entry = {'id': scene['id'], 'bytes': len(payload)}
            if slow and refreshing:
                con.idle(frame.get('refresh_s', 0))
            t0 = time.time()
            ok, t_cmd, t_done, line, w = switch_scene(con, frame, scene['id'], scene['name'])
            entry['cold'] = {**_render_entry(w, t_cmd, t_done), 'ok': ok}
            refreshing = (entry['cold'].get('refresh') or [None])[-1] == 'update'
            if not ok:
                issues.append(issue('fail', 'bench_switch', scene['name'], (line or 'no render within timeout')[:200]))
                results[key] = entry
                continue
            if key == 'anim':
                # The board sums up its animation every ten seconds or so
                # (fos_animation.c) and the first one holds the start: watch
                # until the third, 35 s at most.
                con.drain()
                got = []
                end = time.time() + 35
                while time.time() < end:
                    got += con.idle(1)
                    if len([1 for _, x in got if '"render:animation"' in x and '"running"' in x]) >= 3:
                        break
                wa = summarize(got)
                running = [a for a in wa['animation'] if a.get('status') == 'running']
                anim = running[1:] if len(running) > 1 else running
                entry['animation'] = [{k: a.get(k) for k in ('frames', 'fps', 'avgMs', 'maxMs', 'periodMs', 'seconds')} for a in anim]
                entry['fps'] = stats([a.get('fps') for a in anim])
            else:
                # A scene whose picture changes each render costs a refresh on
                # e-paper: three, not five, on a 30 s panel.
                reps = min(n, 3) if slow and key in ('raster', 'ui') else n
                warm = []
                for _ in range(reps):
                    con.drain()
                    t = time.time()
                    con.send('render')
                    t_done, line, got = wait_render(con, render_timeout(frame))
                    _, _, tail = con.wait_for(lambda x: x.startswith('{"event":"render:done"'), 3)
                    warm.append(_render_entry(summarize(got + tail), t, t_done))
                    refreshing = (warm[-1].get('refresh') or [None])[-1] == 'update'
                    if not t_done:
                        issues.append(issue('fail', 'bench_render', scene['name'], 'a `render` produced no render within the timeout'))
                        break
                entry['warm'] = warm
                entry['render_ms'] = stats([x['render_ms'] for x in warm])
                entry['pack_ms'] = stats([x['pack_ms'] for x in warm])
                entry['done_ms'] = stats([x['done_ms'] for x in warm])
                if key == 'cpu':
                    lines = [b for x in warm for b in x['bench'] if b.get('bench') == 'cpu']
                    entry['cpu'] = {part: stats([b.get(part) for b in lines]) for part in ('int', 'float', 'json', 'str')}
                    checks = {b.get('check') for b in lines}
                    entry['check'] = sorted(c for c in checks if c is not None)
                    if not lines:
                        issues.append(issue('fail', 'bench_cpu_log', scene['name'], "the CPU scene's own timing line never reached the console"))
                    elif len(checks) > 1:
                        issues.append(issue('fail', 'bench_cpu_check', scene['name'], f'the workload gave different answers: {sorted(checks)}'))
            if key == 'ui' and frame.get('touch'):
                taps = []
                for x_frac in (0.3, 0.5, 0.7):
                    con.drain()
                    tt = time.time()
                    tap(con, frame, x_frac, 0.55)
                    got = con.idle(4 if frame.get('lcd') else 3 + frame.get('refresh_s', 4))
                    wt = summarize(got)
                    open_renders = {r['n'] for r in wt['started']} - {d['n'] for d in wt['done']} - {f['n'] for f in wt['failed']}
                    if open_renders:
                        _, _, more = wait_render(con, render_timeout(frame))
                        wt = summarize(got + more)
                    first = min([d['t'] for d in wt['done']] + [b['t'] for b in wt['burst']], default=None)
                    taps.append(round((first - tt) * 1000) if first else None)
                entry['taps'] = taps
                entry['tap_ms'] = stats(taps)
                if not any(taps):
                    issues.append(issue('fail', 'bench_tap', scene['name'], 'no tap on the UI produced a render'))
            new = incidents_since(con, t0, f"bench {scene['name']}")
            issues += new
            if any(i['kind'] in ('reboot', 'ota_mid_run') for i in new):
                recover_after_boot(con, frame)
            results[key] = entry
        results['heap'] = heapinfo(con)
        st2 = status(con)
        results['memory'] = st2.get('memory') or {}
    finally:
        if before:
            con.send(f'scene {before}')
            wait_render(con, render_timeout(frame))
        restore(con, frame)
        if debug_was == '1':
            con.command('set debug 1', 1.5)
    # The lowest free PSRAM any benchmark render left.
    lows = [x.get('freePsram') for e in results.values() if isinstance(e, dict)
            for x in (e.get('warm') or []) + ([e['cold']] if e.get('cold') else []) if x.get('freePsram')]
    results['psram_low'] = min(lows) if lows else None
    issues += [i for i in incidents_since(con, t_suite, 'bench restore') if i['kind'] in ('reboot', 'ota_mid_run')
               and not any(j['detail'] == i['detail'] for j in issues)]
    return {'benchmark': results, 'workload': WORKLOAD, 'n': n, 'issues': issues}
