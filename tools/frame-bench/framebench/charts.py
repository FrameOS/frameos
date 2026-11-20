"""The records as one static HTML page: scores per category per build per
board, metric trends over builds, firmware image size per platform, and
stability counts. Inline SVG and CSS only (no script, no CDN): it opens
offline, in light and dark, and reads with two data points as well as twenty.

    tools/frame-bench/bench.py html [--out path]
"""
from __future__ import annotations

import html
import os
import re
from collections import defaultdict

from . import BENCH_VERSION
from .benchmarks import WORKLOAD
from .records import REPORT, read
from .scoring import LABELS, PERFORMANCE, REFERENCE, REFERENCE_BUILD, SCORE_VERSION, scores

E = html.escape
SLOTS = 8  # the categorical palette's slots (CSS --s1..--s8); a ninth series folds

TRENDS = [
    ('bench.cpu.int_ms', 'CPU: integer loop', 'ms', None),
    ('bench.cpu.json_ms', 'CPU: JSON', 'ms', None),
    ('bench.raster.net_ms', 'Raster, per panel megapixel', 'ms/Mpx', 'panel'),
    ('bench.ui.net_ms', 'JSX UI layout + raster', 'ms', None),
    ('bench.image.render_ms', 'JPEG decode + resize', 'ms', None),
    ('bench.image.pack_ms', 'Dither + pack, per panel megapixel', 'ms/Mpx', 'panel'),
    ('bench.switch_ms', 'Switch to a benchmark scene', 'ms', None),
    ('bench.ui.tap_ms', 'Tap to picture', 'ms', None),
    ('resp.boot.first_render_ms', 'Restart to first picture', 'ms', None),
    ('scenes.warm_ms', "Own scenes: median warm render (scene sets differ)", 'ms', None),
    ('mem.idle.psram_free', 'Idle free PSRAM', 'KB', 'kb'),
    ('mem.min_ever.internal', 'Lowest free internal RAM since boot', 'KB', 'kb'),
]

CSS = """
:root{color-scheme:light;--bg:#fcfcfb;--surface:#ffffff;--text:#0b0b0b;--text2:#52514e;--muted:#7a7974;--grid:#e6e5e0;--axis:#b8b7b0;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;
--crit:#d03b3b;--serious:#ec835a;--ref:#52514e}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#121211;--surface:#1a1a19;--text:#f0efec;--text2:#c3c2b7;--muted:#99988f;--grid:#2e2e2b;--axis:#55544f;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--s7:#9085e9;--s8:#e66767;--ref:#c3c2b7}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--surface:#1a1a19;--text:#f0efec;--text2:#c3c2b7;--muted:#99988f;--grid:#2e2e2b;--axis:#55544f;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--s7:#9085e9;--s8:#e66767;--ref:#c3c2b7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 8px}h3{font-size:14px;margin:0 0 6px}
p.lede,p.note{color:var(--text2);margin:4px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--grid);border-radius:8px;padding:12px}svg{display:block;width:100%;height:auto}
svg text{fill:var(--text2);font-size:11px}svg .val{fill:var(--text);font-size:11px}svg .lbl{fill:var(--text);font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:2px 0 8px;color:var(--text2);font-size:12px}.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}th,td{padding:4px 8px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{color:var(--text2);font-weight:600}td .rng{color:var(--muted)}
details{margin-top:8px}summary{cursor:pointer;color:var(--text2);font-size:12px}code{font-size:12px}
"""


def _short(build):
    """`2026.11.12+49345dbb4` -> `11.12+49345`: the label an axis has room for."""
    b = re.sub(r'^\d{4}\.', '', build or '')
    b = re.sub(r'\+elf\.([0-9a-f]{5})[0-9a-f]*', r' local \1', b)
    return re.sub(r'\+([0-9a-f]{5})[0-9a-f]*', r'+\1', b)


def _tick(v):
    return f'{v:.1f}' if abs(v) < 10 and v != int(v) else f'{round(v):,}'


def _fmt(v, unit=''):
    if v is None:
        return '—'
    if isinstance(v, float) and v < 10:
        s = f'{v:.2f}'
    elif isinstance(v, float) and v < 100:
        s = f'{v:.1f}'
    else:
        s = f'{round(v):,}'
    return f'{s} {unit}'.strip()


FIRST_SEEN: dict[str, str] = {}  # build -> its first run (write() fills it)


def _build_key(build):
    """Builds in order: by version, a release before the dev builds on top of
    it, and dev builds by when the bench first ran them (a sha says nothing
    of order)."""
    m = re.match(r'(\d+)\.(\d+)\.(\d+)', build or '')
    return (tuple(int(x) for x in m.groups()) if m else (0, 0, 0), '+' in (build or ''), FIRST_SEEN.get(build, ''), build)


def _legend(items):
    return '<div class="legend">' + ''.join(
        f'<span><i class="sw" style="background:var(--s{i % SLOTS + 1})"></i>{E(name)}</span>' for i, name in items) + '</div>'


def _bar_end(x0, y, w, h, color, title):
    """A bar from x0 with a 4px rounded data end on the right."""
    r = min(4, w / 2, h / 2)
    if w <= 0:
        return ''
    d = (f'M{x0:.1f},{y:.1f}h{w - r:.1f}a{r},{r} 0 0 1 {r},{r}v{h - 2 * r:.1f}a{r},{r} 0 0 1 {-r},{r}'
         f'h{-(w - r):.1f}z')
    return f'<path d="{d}" fill="{color}"><title>{E(title)}</title></path>'


def score_chart(rows, cat, builds):
    """Horizontal grouped bars: one group per board, one bar per build, the
    quartile range as a whisker, 1000 (the reference) as a dashed line."""
    data = [(r['board'], r['build'], r['categories'][cat]) for r in rows if cat in r['categories']]
    if not data:
        return ''
    boards = sorted({d[0] for d in data})
    bh, gap, ggap, left, right = 11, 2, 14, 132, 46
    width = 520
    top = 8
    height = top + sum(len([d for d in data if d[0] == b]) * (bh + gap) + ggap for b in boards) + 22
    xmax = max(max(d[2]['hi'] for d in data), 1000) * 1.08
    sx = lambda v: left + (width - left - right) * v / xmax  # noqa: E731
    out = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{E(LABELS[cat])} score by board and build">']
    for t in range(0, int(xmax) + 1, 500 if xmax > 1500 else 250):
        out.append(f'<line x1="{sx(t):.1f}" x2="{sx(t):.1f}" y1="{top}" y2="{height - 18}" stroke="var(--grid)"/>'
                   f'<text x="{sx(t):.1f}" y="{height - 6}" text-anchor="middle">{t}</text>')
    y = top
    for b in boards:
        mine = sorted([d for d in data if d[0] == b], key=lambda d: _build_key(d[1]))
        gy = y
        for _, build, s in mine:
            color = f'var(--s{builds.index(build) % SLOTS + 1})'
            out.append(_bar_end(left, y, sx(s['score']) - left, bh, color,
                                f"{b} · {build}: {s['score']} ({s['lo']}–{s['hi']})"))
            out.append(f'<line x1="{sx(s["lo"]):.1f}" x2="{sx(s["hi"]):.1f}" y1="{y + bh / 2:.1f}" y2="{y + bh / 2:.1f}" '
                       f'stroke="var(--text2)" stroke-width="1.5"/>')
            out.append(f'<text class="val" x="{sx(max(s["hi"], s["score"])) + 4:.1f}" y="{y + bh - 2}">{s["score"]}</text>')
            y += bh + gap
        out.append(f'<text class="lbl" x="{left - 8}" y="{(gy + y - gap) / 2 + 4:.1f}" text-anchor="end">{E(b[:20])}</text>')
        y += ggap
    out.append(f'<line x1="{sx(1000):.1f}" x2="{sx(1000):.1f}" y1="{top - 4}" y2="{height - 18}" stroke="var(--ref)" '
               f'stroke-dasharray="3 3"><title>1000: the reference ({REFERENCE_BUILD} fleet median)</title></line>')
    out.append('</svg>')
    return ''.join(out)


def line_chart(series, xs, unit, title, hline=None, hline_label=''):
    """Lines over an ordinal x (builds, versions): one series per entity, 2px
    lines, 8px markers with a surface ring, a direct label at each line's end
    when there are four or fewer."""
    width, height, left, right, top, bottom = 520, 230, 52, 112 if len(series) <= 4 else 16, 10, 58
    vals = [v for _, _, pts in series for _, v in pts if v is not None] + ([hline] if hline else [])
    if not vals:
        return ''
    ymax = max(vals) * 1.1 or 1
    ymin = 0
    if hline and min(vals) > hline * 0.6:  # a size against its limit: zoom to the top
        ymin = min(vals) * 0.9
    sx = lambda i: left + (width - left - right) * (i + 0.5) / max(1, len(xs))  # noqa: E731
    sy = lambda v: top + (height - top - bottom) * (1 - (v - ymin) / (ymax - ymin))  # noqa: E731
    out = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{E(title)}">']
    for k in range(5):
        v = ymin + (ymax - ymin) * k / 4
        out.append(f'<line x1="{left}" x2="{width - right}" y1="{sy(v):.1f}" y2="{sy(v):.1f}" stroke="var(--grid)"/>'
                   f'<text x="{left - 6}" y="{sy(v) + 4:.1f}" text-anchor="end">{_tick(v)}</text>')
    for i, x in enumerate(xs):
        out.append(f'<text transform="translate({sx(i):.1f},{height - bottom + 12}) rotate(35)" font-size="10">{E(_short(x))}</text>')
    if hline:
        out.append(f'<line x1="{left}" x2="{width - right}" y1="{sy(hline):.1f}" y2="{sy(hline):.1f}" stroke="var(--ref)" '
                   f'stroke-dasharray="4 3"/><text x="{width - right}" y="{sy(hline) - 4:.1f}" text-anchor="end">{E(hline_label)}</text>')
    for slot, name, pts in series:
        color = f'var(--s{slot % SLOTS + 1})'
        coords = [(sx(xs.index(x)), sy(v), x, v) for x, v in pts if v is not None and x in xs]
        if len(coords) > 1:
            out.append('<polyline fill="none" stroke-width="2" stroke-linejoin="round" stroke="' + color + '" points="'
                       + ' '.join(f'{a:.1f},{b:.1f}' for a, b, _, _ in coords) + '"/>')
        for a, b, x, v in coords:
            out.append(f'<circle cx="{a:.1f}" cy="{b:.1f}" r="4" fill="{color}" stroke="var(--surface)" stroke-width="2">'
                       f'<title>{E(name)} · {E(x)}: {_fmt(v, unit)}</title></circle>')
        if coords and len(series) <= 4:
            a, b, _, _ = coords[-1]
            out.append(f'<text class="lbl" x="{a + 8:.1f}" y="{b + 4:.1f}">{E(name[:14])}</text>')
    out.append('</svg>')
    return ''.join(out)


def _table(header, rows):
    return ('<div class="scroll"><table><thead><tr>' + ''.join(f'<th>{E(h)}</th>' for h in header) + '</tr></thead><tbody>'
            + ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in rows) + '</tbody></table></div>')


def write(out=None, results=None) -> str:
    out = out or (os.path.join(results, 'report.html') if results else REPORT)
    rows = scores(results)
    boards = read('boards', results)
    board_slot = {b['board_id']: i for i, b in enumerate(boards)}
    runs = read('runs', results)
    FIRST_SEEN.clear()
    for r in sorted(runs, key=lambda r: r['run_id']):
        FIRST_SEEN.setdefault(r['build'], r['run_id'])
    images = read('images', results)
    parts = []
    parts.append('<h1>FrameOS frame bench</h1>')
    parts.append(f'<p class="lede">{len({r["run_id"] for r in runs})} runs on {len(boards)} boards; scores v{SCORE_VERSION}, '
                 f'benchmark workload {WORKLOAD}, bench v{BENCH_VERSION}. 1000 points is the median of the boards benched on '
                 f'{REFERENCE_BUILD}; higher is better. How the numbers are made: <code>tools/frame-bench/SCORES.md</code>.</p>')

    # ---- scores
    # Builds that ran the benchmark (the scores' input), never a bench build
    # without a sha; the latest SLOTS of them, so no two builds share a color.
    benched = sorted({r['build'] for r in rows if 'cpu' in r['categories'] and '+elf.' not in r['build']},
                     key=_build_key)[-SLOTS:]
    scored = [r for r in rows if r['build'] in benched]
    builds = benched
    parts.append('<h2>Scores by build</h2>')
    if not REFERENCE:
        parts.append('<p class="note">No reference frozen yet (scoring.REFERENCE): scores appear once it is.</p>')
    if scored:
        parts.append('<p class="note">Bars: the score; whisker: the range the quartiles give (ranges that overlap are not '
                     'a difference); dashed line: 1000. A category is the geometric mean of the metrics a board has '
                     '(no tap score without touch, no dither on an LCD).</p>')
        parts.append(_legend([(builds.index(b), b) for b in builds]))
        parts.append('<div class="grid">' + ''.join(
            f'<div class="card"><h3>{LABELS[c]}</h3>{score_chart(scored, c, builds)}</div>'
            for c in ('frameos', *PERFORMANCE, 'memory') if any(c in r['categories'] for r in scored)) + '</div>')
        cats = ('frameos', *PERFORMANCE, 'memory')
        trows = []
        for r in sorted(scored, key=lambda r: (r['board'], _build_key(r['build']))):
            cells = [E(r['board']), E(r['build'])]
            for c in cats:
                s = r['categories'].get(c)
                cells.append(f"{s['score']} <span class='rng'>{s['lo']}–{s['hi']}</span>" if s else '—')
            st = r['stability'].get('full') or r['stability'].get('sampled') or {}
            cells.append(f"{st['score']} <span class='rng'>{st['crash']:g} crash, {st['fail']:g} fail</span>" if st else '—')
            trows.append(cells)
        parts.append('<details open><summary>Table</summary>' + _table(
            ['board', 'build', *[LABELS[c] for c in cats], 'Stability (full runs)'], trows) + '</details>')

    # ---- trends
    parts.append('<h2>Metric trends over builds</h2>')
    parts.append('<p class="note">Each point is the median over the runs of one board on one build; hover a point for its value. '
                 'Builds run left to right by version, a release before the dev builds on it.</p>')
    by_metric = defaultdict(dict)
    for r in rows:
        for m, v in r['values'].items():
            by_metric[m][(r['board_id'], r['build'])] = v
    allm = read('metrics', results)
    run_build = {(x['run_id'], x['board_id'], x.get('device')): x['build'] for x in runs}
    for m in allm:  # metrics outside the score categories (scenes.warm_ms, ...)
        b = run_build.get((m['run_id'], m['board_id'], m.get('device')))
        if b and not m.get('scene') and (m['board_id'], b) not in by_metric[m['metric']]:
            by_metric[m['metric']][(m['board_id'], b)] = {'value': m['value']}
    names = {b['board_id']: b.get('name', b['board_id']) for b in boards}
    mpx = {b['board_id']: b.get('panel_mpx') for b in boards}
    cards, legend_ids = [], set()
    for metric, title, unit, how in TRENDS:
        pts = by_metric.get(metric) or {}
        if not pts:
            continue
        # Releases and the dev builds CI or firmware/build.sh made (a sha):
        # the builds made on the bench under a release's number stay in the
        # tables and the records, not on the axis.
        xs = sorted({b for _, b in pts if '+elf.' not in b}, key=_build_key)
        if not xs:
            continue
        series = []
        trs = []
        for bid in sorted({b for b, _ in pts}, key=lambda b: board_slot.get(b, 99)):
            line = []
            for x in xs:
                v = (pts.get((bid, x)) or {}).get('value')
                if v is not None and how == 'panel':
                    v = v / mpx[bid] if mpx.get(bid) else None
                if v is not None and how == 'kb':
                    v = v / 1024
                line.append((x, v))
                if v is not None:
                    trs.append([E(names.get(bid, bid)), E(x), _fmt(v, unit)])
            series.append((board_slot.get(bid, 0), names.get(bid, bid), line))
            legend_ids.add(bid)
        cards.append(f'<div class="card"><h3>{E(title)}</h3>{line_chart(series, xs, unit, title)}'
                     f'<details><summary>Table</summary>{_table(["board", "build", unit], trs)}</details></div>')
    parts.append(_legend([(board_slot[b], names[b]) for b in sorted(legend_ids, key=lambda b: board_slot.get(b, 99))]))
    parts.append('<div class="grid">' + ''.join(cards) + '</div>')

    # ---- image size
    rel = [i for i in images if i.get('source') == 'release' and i.get('app_bytes')]
    if rel:
        parts.append('<h2>ESP32 firmware image size</h2>')
        parts.append('<p class="note">The room each release leaves in the OTA slot it must fit (the 8 MB layout\'s '
                     '3520 KB for the S3, docs/esp32-image-size.md): slot minus app image, per platform. Lower is closer to '
                     'an image that no longer fits.</p>')
        plats = sorted({i['platform'] for i in rel})
        # Platforms whose image is the same size every release (the S3's 16 MB /
        # 32 MB layouts) are one line.
        shown = [p for p in plats if p in ('esp32-s3-generic', 'esp32-s3-32mb', 'esp32-c3-generic')] or plats
        vers = sorted({i['version'] for i in rel}, key=_build_key)
        series = []
        for k, p in enumerate(shown):
            series.append((k, p, [(v, next(((i.get('slot_headroom_bytes') or 0) / 1024 for i in rel if i['version'] == v and i['platform'] == p), None))
                                  for v in vers]))
        trs = [[E(i['version']), E(i['platform']), _fmt(i['app_bytes'] / 1024, 'KB'),
                _fmt((i.get('slot_headroom_bytes') or 0) / 1024, 'KB'), _fmt(i.get('slot_used_pct'), '%')]
               for i in sorted(rel, key=lambda i: (_build_key(i['version']), i['platform']))]
        latest = vers[-1]
        groups = []
        if len(vers) > 1:
            prev = vers[-2]
            cur = next((i for i in rel if i['version'] == latest and i['platform'] == 'esp32-s3-generic'), None)
            old = next((i for i in rel if i['version'] == prev and i['platform'] == 'esp32-s3-generic'), None)
            if cur and old:
                for g, b in sorted((cur.get('groups') or {}).items(), key=lambda kv: -abs((kv[1] or 0) - ((old.get('groups') or {}).get(kv[0]) or 0))):
                    d = (b or 0) - ((old.get('groups') or {}).get(g) or 0)
                    if d:
                        groups.append([E(g), _fmt(b / 1024, 'KB'), f'{d / 1024:+.1f} KB'])
        parts.append('<div class="grid"><div class="card"><h3>Slot headroom (KB)</h3>' + _legend([(k, p) for k, p, _ in series])
                     + line_chart(series, vers, 'KB', 'Firmware slot headroom')
                     + f'<details><summary>Table</summary>{_table(["version", "platform", "app", "slot headroom", "slot used"], trs)}</details></div>'
                     + (f'<div class="card"><h3>What changed in {E(latest)} (esp32-s3-generic, vs the release before)</h3>'
                        + _table(['part', 'flash', 'change'], groups[:14]) + '</div>' if groups else '')
                     + '</div>')

    # ---- stability
    stab = [r for r in rows if r['stability']]
    if stab:
        parts.append('<h2>Stability</h2>')
        parts.append('<p class="note">Crashes (panic, abort, watchdog, brownout, reboot, out of memory) and failures (a switch, '
                     'push or render that did not happen), summed over the full and sampled runs of each build. Only runs of '
                     'the same mode compare: a sampled run does less.</p>')
        trs = []
        for r in sorted(stab, key=lambda r: (r['board'], _build_key(r['build']))):
            for mode, s in sorted((m, v) for m, v in r['stability'].items() if m != 'quick'):
                trs.append([E(r['board']), E(r['build']), mode, str(s['runs']),
                            f"<span style='color:var(--crit)'>●</span> {s['crash']:g}" if s['crash'] else '0',
                            f"<span style='color:var(--serious)'>●</span> {s['fail']:g}" if s['fail'] else '0', str(s['score'])])
        parts.append('<details open><summary>Table</summary>'
                     + _table(['board', 'build', 'mode', 'runs', 'crashes', 'failures', 'stability'], trs) + '</details>')

    doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
           f'<title>Frame bench scores</title><style>{CSS}</style></head><body><main>' + ''.join(parts) + '</main></body></html>')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as fh:
        fh.write(doc)
    return out
