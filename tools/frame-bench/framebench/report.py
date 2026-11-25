"""A run's results as one Markdown report, and a comparison with an earlier run."""
from __future__ import annotations

import json
import os

SEVERITY_ORDER = {'crash': 0, 'fail': 1, 'slow': 2, 'note': 3}
REGRESS_RATIO = 1.25   # a warm median 25 % slower than the baseline ...
REGRESS_MIN_MS = 100   # ... and at least this many ms slower is a regression
REGRESS_FAIL_RATIO = 3.0    # three times slower (and a visible amount) is a fail, not one more slow line
REGRESS_FAIL_MIN_MS = 500
FPS_REGRESS_RATIO = 1.25    # an animation 25 % below the baseline's frame rate ...
FPS_REGRESS_MIN = 2.0       # ... and at least this many fps below it is a regression
FPS_FAIL_RATIO = 2.0        # half the frame rate or worse is a fail


def _ms(v):
    return '—' if v is None else f'{v:,}'


def scene_table(frame_res):
    sc = (frame_res.get('suites') or {}).get('scenes') or {}
    rows = sc.get('scenes') or []
    if not rows:
        return ''
    out = ['| scene | switch ms | cold ms | warm median | path | anim fps (target) | tap ms |', '|---|---:|---:|---:|---|---|---:|']
    for r in rows:
        sw = r.get('switch') or {}
        ws = r.get('warm_stats') or {}
        warm = r.get('warm') or []
        path = ''
        if warm:
            w = warm[-1]
            path = 'in place' if w.get('in_place') else (f"pack {w.get('pack_ms')} ms" if w.get('pack_ms') is not None else '')
            if w.get('refresh'):
                path += f" · {w['refresh'][0]}"
        anim = ''
        for a in ((r.get('passive') or {}).get('animation') or [])[:1]:
            if a.get('periodMs'):
                anim = f"{a.get('fps')} ({1000 / a['periodMs']:.0f})"
        tap = (r.get('tap') or {}).get('first_ms')
        out.append(f"| {r.get('name')} | {_ms(sw.get('wall_ms'))} | {_ms(sw.get('done_ms'))} | {_ms(ws.get('median'))} | {path} | {anim} | {_ms(tap)} |")
    return '\n'.join(out)


def ran_apps(scene: dict) -> bool:
    return any('app' in (w.get('probe') or {}) for w in scene.get('warm') or [])


def best_warm(scene: dict, drew_only: bool = False):
    warm = scene.get('warm') or []
    if drew_only:
        # Only the renders whose probe ran the scene's apps: one that held its
        # result from the pass before draws nothing. See compare().
        warm = [w for w in warm if 'app' in (w.get('probe') or {})]
    times = [w.get('render_ms') for w in warm if w.get('render_ms') is not None]
    if not times:
        times = [w.get('done_ms') for w in warm if w.get('done_ms') is not None]
    return min(times) if times else None


def animation_fps(scene: dict):
    """The frame rate the scene's first watched animation reached, or None."""
    for a in ((scene.get('passive') or {}).get('animation') or [])[:1]:
        if a.get('fps') is not None:
            return a['fps']
    return None


def compare(current: dict, baseline: dict) -> list[dict]:
    """Regressions against an earlier run of the same frames."""
    issues = []
    base_frames = {f.get('name'): f for f in baseline.get('frames', [])}
    for f in current.get('frames', []):
        b = base_frames.get(f.get('name'))
        if not b:
            continue
        cur = {r['name']: r for r in ((f.get('suites') or {}).get('scenes') or {}).get('scenes', [])}
        old_rows = ((b.get('suites') or {}).get('scenes') or {}).get('scenes', [])
        # By name, whatever its case: a sample renamed "DVD Logo Bounce" -> "DVD
        # logo bounce" went uncompared while it fell from 22.7 to 1.4 fps (2026-11-19).
        old = {(r.get('name') or '').casefold(): r for r in old_rows}
        for name, r in cur.items():
            o = old.get((name or '').casefold())
            if not o:
                continue
            cf, of = animation_fps(r), animation_fps(o)
            if cf is not None and of and cf * FPS_REGRESS_RATIO < of and of - cf >= FPS_REGRESS_MIN:
                issues.append({'severity': 'fail' if cf * FPS_FAIL_RATIO <= of else 'slow', 'kind': 'fps_regression',
                               'where': f"{f['name']}: scene {name}",
                               'detail': f'animation {of} fps -> {cf} fps'})
            # The scene's own work, at its best: the render time where the line has
            # one (an e-paper `done` adds a partial or a full panel refresh, which
            # alternate), the fastest of the warm renders (the first after a
            # switch can rebuild an interpreter the switch let go).
            # Where both runs have renders that ran the scene's apps, only
            # those: one 112 ms render that held its result made a scene that
            # draws in 330 ms every time read as a 3x regression (the
            # SenseCAP's "Slideshow with motion", 2026-11-17). A scene that
            # holds its result on most passes (Steps) compares like with like.
            drew_only = ran_apps(r) and ran_apps(o)
            cm, om = best_warm(r, drew_only), best_warm(o, drew_only)
            if cm and om and cm > om * REGRESS_RATIO and cm - om >= REGRESS_MIN_MS:
                bad = cm >= om * REGRESS_FAIL_RATIO and cm - om >= REGRESS_FAIL_MIN_MS
                issues.append({'severity': 'fail' if bad else 'slow', 'kind': 'regression', 'where': f"{f['name']}: scene {name}",
                               'detail': f'fastest warm render {om} ms -> {cm} ms'})
            cp = [w.get('in_place') for w in r.get('warm') or []]
            op = [w.get('in_place') for w in o.get('warm') or []]
            if op and all(op) and cp and not all(cp):
                issues.append({'severity': 'slow', 'kind': 'path_regression', 'where': f"{f['name']}: scene {name}",
                               'detail': 'drew in place before, packs a separate image now'})
    return issues


def write(run: dict, out_dir: str, baseline: dict | None = None) -> str:
    all_issues = []
    for f in run['frames']:
        for suite, res in (f.get('suites') or {}).items():
            for i in (res or {}).get('issues', []):
                all_issues.append({**i, 'frame': f.get('name'), 'suite': suite})
    if baseline:
        for i in compare(run, baseline):
            all_issues.append({**i, 'frame': i['where'].split(':')[0], 'suite': 'compare'})
    # The same thing seen many times (a watchdog per render, a missing layout per pass): once, counted.
    merged = {}
    for i in all_issues:
        key = (i['severity'], i['frame'], i['suite'], i['kind'], i['where'], i['detail'][:60] if i['kind'] not in ('task_wdt', 'layout_missing', 'interpreter_discard') else '')
        if key in merged:
            merged[key]['count'] = merged[key].get('count', 1) + 1
        else:
            merged[key] = dict(i)
    all_issues = list(merged.values())
    all_issues.sort(key=lambda i: (SEVERITY_ORDER.get(i['severity'], 9), i['frame'] or '', i['kind']))
    counts = {}
    for i in all_issues:
        counts[i['severity']] = counts.get(i['severity'], 0) + 1

    md = [f"# Frame bench {run['started']}", '']
    md.append('Verdict: ' + (', '.join(f'{n} {s}' for s, n in sorted(counts.items(), key=lambda x: SEVERITY_ORDER.get(x[0], 9))) or 'no issues'))
    md.append('')
    md.append('| frame | port | firmware | panel | kind | suites |')
    md.append('|---|---|---|---|---|---|')
    for f in run['frames']:
        md.append(f"| {f.get('name')} | {f.get('port')} | {f.get('version')} | {f.get('display')} | {f.get('kind')} | {', '.join((f.get('suites') or {}).keys())} |")
    md.append('')
    md.append('## Issues')
    md.append('')
    if not all_issues:
        md.append('None.')
    for i in all_issues:
        times = f" (×{i['count']})" if i.get('count', 1) > 1 else ''
        md.append(f"- **{i['severity']}** `{i['kind']}`{times} — {i['frame']} · {i['suite']} · {i['where']}: {i['detail']}")
    md.append('')
    for f in run['frames']:
        md.append(f"## {f.get('name')}")
        md.append('')
        suites = f.get('suites') or {}
        st = (suites.get('status') or {}).get('status') or {}
        mem = st.get('memory') or {}
        if mem and mem.get('ramTotal') is not None:
            # A Linux frame (linux.py): its RAM and the runtime's resident set.
            board = st.get('board') or {}
            md.append(f"Idle memory: RAM available {_ms(mem.get('ramAvailable'))} of {_ms(mem.get('ramTotal'))}, "
                      f"the runtime's resident set {_ms(mem.get('processRss'))} (peak {_ms(mem.get('processPeakRss'))}). "
                      f"CPU at {board.get('cpuMhz')} MHz ({board.get('cpuGovernor')} governor, {board.get('cpuMaxMhz')} max).")
            md.append('')
        elif mem:
            md.append(f"Idle memory: PSRAM free {_ms(mem.get('psramFree'))} of {_ms(mem.get('psramTotal'))}, internal free {_ms(mem.get('internalFree'))} (largest {_ms(mem.get('internalLargestBlock'))}).")
            md.append('')
        if suites.get('reboot'):
            rb = suites['reboot'].get('reboot') or {}
            md.append(f"Restart: bootup event after {_ms(rb.get('to_bootup_ms'))} ms, first picture after {_ms(rb.get('to_first_render_ms'))} ms.")
            md.append('')
        t = scene_table(f)
        if t:
            md.append(t)
            md.append('')
        if suites.get('soak'):
            md.append('Soak (memory after each round): ' + ', '.join(
                f"r{s['round']}: psram {_ms(s.get('psramFree'))} / internal {_ms(s.get('internalFree'))}" for s in suites['soak'].get('soak', [])))
            md.append('')
        code = (suites.get('code') or {}).get('code')
        if code:
            md.append('| Code editor on | kind | open ms | render ms | tap ms | JS errors | picture |')
            md.append('|---|---|---|---|---|---|---|')
            for c in code:
                kind = ', '.join(k.replace('_', ' ') for k in ('js_app', 'code_node') if c.get(k)) or '-'
                md.append(f"| {c.get('scene') or '(its list)'} | {kind} | {_ms(c.get('wall_ms'))} | {_ms(c.get('done_ms'))} | "
                          f"{_ms(c.get('tap_ms'))} | {len(c.get('js_errors') or [])} | {c.get('image') or '-'} |")
            md.append('')
        played = (suites.get('video') or {}).get('video')
        if played:
            # framebench/video.py: the runtime's own `video:playback` lines,
            # the clip's start left out.
            md.append('| Video | path | fps / rate | late | dropped | worst late ms | judged s |')
            md.append('|---|---|---|---|---|---|---|')
            for name, v in played.items():
                if 'frames' not in v:
                    md.append(f"| {name} | (nothing shown) | - | - | - | - | - |")
                    continue
                path = f"{v.get('decoder')} {'plane' if v.get('plane') else 'canvas'}"
                md.append(f"| {name} | {path} | {v.get('fps')} / {v.get('rate')} | {v.get('late')} | {v.get('dropped')} | "
                          f"{v.get('worst_late_ms')} | {v.get('seconds')} |")
            md.append('')
        for key in ('builtin', 'input', 'storm', 'offline', 'thin', 'device'):
            src = suites.get(key) or (suites.get('thin') if key == 'device' else None)
            if not src:
                continue
            val = src.get(key)
            if val:
                md.append(f'**{key}**: `{json.dumps(val, default=str)[:900]}`')
                md.append('')
    text = '\n'.join(md)
    with open(os.path.join(out_dir, 'report.md'), 'w') as fh:
        fh.write(text)
    with open(os.path.join(out_dir, 'issues.json'), 'w') as fh:
        json.dump(all_issues, fh, indent=1)
    return text
