"""A run's results as one Markdown report, and a comparison with an earlier run."""
from __future__ import annotations

import json
import os

SEVERITY_ORDER = {'crash': 0, 'fail': 1, 'slow': 2, 'note': 3}
REGRESS_RATIO = 1.25   # a warm median 25 % slower than the baseline ...
REGRESS_MIN_MS = 100   # ... and at least this many ms slower is a regression


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


def compare(current: dict, baseline: dict) -> list[dict]:
    """Regressions against an earlier run of the same frames."""
    issues = []
    base_frames = {f.get('name'): f for f in baseline.get('frames', [])}
    for f in current.get('frames', []):
        b = base_frames.get(f.get('name'))
        if not b:
            continue
        cur = {r['name']: r for r in ((f.get('suites') or {}).get('scenes') or {}).get('scenes', [])}
        old = {r['name']: r for r in ((b.get('suites') or {}).get('scenes') or {}).get('scenes', [])}
        for name, r in cur.items():
            o = old.get(name)
            if not o:
                continue
            cm = (r.get('warm_stats') or {}).get('median')
            om = (o.get('warm_stats') or {}).get('median')
            if cm and om and cm > om * REGRESS_RATIO and cm - om >= REGRESS_MIN_MS:
                issues.append({'severity': 'slow', 'kind': 'regression', 'where': f"{f['name']}: scene {name}",
                               'detail': f'warm median {om} ms -> {cm} ms'})
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
        if mem:
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
