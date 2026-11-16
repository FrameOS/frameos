"""What the firmware prints, as data.

The ESP32 runtime logs one summary per render (frameos/src/embedded/
embedded_main.nim):

    render #12 (interpreted scene "Clock", fmt=9): render 410 ms, in place, collect 0 ms [prelude 1.2 ... | fill ...]
    render #3 (interpreted scene "Weather", fmt=7): render 6201 ms, dither+pack 2011 ms

then `render #N done in X ms` (fos_client.c), JSON events (`render:done`,
`render:animation`, `render:burst`, `metrics`, `render:device`), and panel
driver lines (`it8951: ...`). The Pico prints JSON events only.
"""
from __future__ import annotations

import json
import re

RENDER_LINE = re.compile(r'^render #(\d+) \((.*?), fmt=(\d+)\): render (\d+) ms, (in place, collect|dither\+pack) (\d+) ms(.*)$')
RENDER_DONE = re.compile(r'^render #(\d+) done in (\d+) ms')
RENDER_FAILED = re.compile(r'^render #(\d+) failed at (\S+): (.*)$')
RENDER_STARTED = re.compile(r'^render #(\d+) started: scene "(.*)"')
PROBE = re.compile(r'\[(.*)\]\s*$')
IT8951 = re.compile(r'^it8951: (.*)$')


def parse_probe(text: str) -> dict:
    """`[prelude 19.9 compile 97.7 ... | fill 387x553.7 ...]` -> {'prelude': 19.9, ...}."""
    m = PROBE.search(text)
    if not m:
        return {}
    out = {}
    head = m.group(1).split('|')[0].split()
    i = 0
    while i < len(head) - 1:
        try:
            out[head[i]] = float(head[i + 1])
            i += 2
        except ValueError:
            i += 1
    return out


def event(text: str):
    if not text.startswith('{'):
        return None
    try:
        j = json.loads(text)
    except Exception:
        return None
    return j if isinstance(j, dict) and 'event' in j else None


def summarize(lines) -> dict:
    """Facts from a window of (t, text) console lines."""
    r = {'renders': [], 'done': [], 'failed': [], 'events_done': [], 'animation': [], 'burst': [],
         'metrics': [], 'device': [], 'errors': [], 'panel': [], 'started': []}
    for t, text in lines:
        m = RENDER_LINE.match(text)
        if m:
            r['renders'].append({'t': t, 'n': int(m.group(1)), 'source': m.group(2), 'fmt': int(m.group(3)),
                                 'ms': int(m.group(4)), 'in_place': m.group(5).startswith('in place'),
                                 'pack_ms': int(m.group(6)), 'probe': parse_probe(m.group(7))})
            continue
        m = RENDER_STARTED.match(text)
        if m:
            r['started'].append({'t': t, 'n': int(m.group(1)), 'scene': m.group(2)})
            continue
        m = RENDER_DONE.match(text)
        if m:
            r['done'].append({'t': t, 'n': int(m.group(1)), 'ms': int(m.group(2))})
            continue
        m = RENDER_FAILED.match(text)
        if m:
            r['failed'].append({'t': t, 'n': int(m.group(1)), 'stage': m.group(2), 'reason': m.group(3)})
            continue
        m = IT8951.match(text)
        if m:
            r['panel'].append({'t': t, 'line': m.group(1)})
            continue
        ev = event(text)
        if ev:
            name = ev.get('event', '')
            if name == 'render:done':
                r['events_done'].append({'t': t, **{k: ev.get(k) for k in ('sceneId', 'sceneName', 'status', 'ms', 'freeHeap', 'freePsram', 'refresh', 'stage')}})
            elif name == 'render:animation':
                r['animation'].append({'t': t, **ev})
            elif name == 'render:burst':
                r['burst'].append({'t': t, **ev})
            elif name == 'metrics':
                r['metrics'].append({'t': t, **ev})
            elif name == 'render:device':
                r['device'].append({'t': t, **{k: ev.get(k) for k in ('status', 'refresh', 'reason', 'stage', 'ms')}})
            elif name in ('render:error',) or (ev.get('status') == 'error' and not name.startswith(('scenes:sync', 'settings:sync', 'ota:'))):
                r['errors'].append({'t': t, **ev})
        elif text.startswith('E ('):
            r['errors'].append({'t': t, 'line': text[:300]})
    return r


def stats(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    n = len(v)
    median = v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    return {'n': n, 'min': v[0], 'median': median, 'mean': round(sum(v) / n, 1), 'max': v[-1]}
