"""Scores from the records (tools/frame-bench/SCORES.md is the prose).

A metric's score is 1000 x reference / value (lower is better) or
1000 x value / reference (higher is better): 1000 is the bench fleet's median
on the reference build, frozen in REFERENCE below. A category is the
geometric mean of the scores of the metrics a board has; the FrameOS score is
the geometric mean of the four performance categories. Memory and stability
stand beside it, never folded in: a fast board that crashes must not hide.

Every metric value is a median (of the renders within a run, then of the runs
of one board on one build), and every score carries the range its quartiles
give, so two builds whose ranges overlap are not told apart.
"""
from __future__ import annotations

import math
import statistics
from collections import defaultdict

from .benchmarks import PHOTO_MPX
from .records import read

SCORE_VERSION = 1
REFERENCE_BUILD = '2026.11.12'

# metric, better, normalization: None, 'panel' (per panel megapixel) or
# 'image' (per megapixel decoded plus drawn: the photo's and the panel's).
CATEGORIES = {
    'cpu': [('bench.cpu.int_ms', 'lower', None), ('bench.cpu.float_ms', 'lower', None),
            ('bench.cpu.json_ms', 'lower', None), ('bench.cpu.str_ms', 'lower', None)],
    'graphics': [('bench.raster.net_ms', 'lower', 'panel'), ('bench.ui.net_ms', 'lower', None),
                 ('bench.anim.fps', 'higher', None)],
    'image': [('bench.image.render_ms', 'lower', 'image'), ('bench.image.pack_ms', 'lower', 'panel')],
    'responsiveness': [('bench.switch_ms', 'lower', None), ('bench.ui.tap_ms', 'lower', None),
                       ('resp.boot.first_render_ms', 'lower', None), ('resp.switcher.open_ms', 'lower', None)],
    'memory': [('mem.min_ever.psram', 'higher', None), ('mem.min_ever.internal', 'higher', None),
               ('mem.largest.psram', 'higher', None), ('mem.idle.psram_free', 'higher', None)],
}
PERFORMANCE = ('cpu', 'graphics', 'image', 'responsiveness')
LABELS = {'cpu': 'CPU', 'graphics': 'Graphics', 'image': 'Image', 'responsiveness': 'Responsiveness',
          'memory': 'Memory', 'stability': 'Stability', 'frameos': 'FrameOS score'}

# 1000 points: the median over the boards benched on REFERENCE_BUILD, after
# normalization (`bench.py html --reference` prints it from the records).
# Frozen: changing a number is a new SCORE_VERSION.
REFERENCE: dict[str, float] = {}


def stability_score(crash: float, fail: float) -> float:
    """100 for a run with no crash and no failure; each crash halves it, each
    failure takes a tenth. Compares only runs of the same mode."""
    return round(100 * 0.5 ** crash * 0.9 ** fail, 1)


def _norm(value, how, board):
    if value is None:
        return None
    mpx = board.get('panel_mpx')
    if how == 'panel':
        return value / mpx if mpx else None
    if how == 'image':
        return value / (PHOTO_MPX + mpx) if mpx else None
    return value


def _metric_score(value, ref, better):
    if value is None or not ref or value <= 0:
        return None
    return 1000 * (ref / value if better == 'lower' else value / ref)


def _geomean(xs):
    xs = [x for x in xs if x and x > 0]
    return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else None


def grouped(results=None, modes=None):
    """(board_id, build) -> {'board', 'runs', 'metrics': {metric: [rows]}}.
    `modes` limits which runs count (stability compares like with like)."""
    boards = {b['board_id']: b for b in read('boards', results)}
    runs = {(r['rig'], r['run_id'], r['board_id'], r.get('device')): r for r in read('runs', results)}
    groups = defaultdict(lambda: {'runs': {}, 'metrics': defaultdict(list)})
    for m in read('metrics', results):
        run = runs.get((m['rig'], m['run_id'], m['board_id'], m.get('device')))
        if not run or (modes and run['mode'] not in modes) or m.get('scene'):
            continue
        g = groups[(m['board_id'], run['build'])]
        g['board'] = boards.get(m['board_id'], {'board_id': m['board_id']})
        g['runs'][run['run_id']] = run
        g['metrics'][m['metric']].append(m)
    return groups


def metric_value(rows):
    """Median of the runs' medians, and the quartile range: the runs' own p25 /
    p75 where a run had several samples, else the spread between runs."""
    vals = [r['value'] for r in rows]
    if not vals:
        return None, None, None
    med = statistics.median(vals)
    lo = statistics.median([r.get('p25', r['value']) for r in rows])
    hi = statistics.median([r.get('p75', r['value']) for r in rows])
    if len(vals) > 1:
        lo, hi = min(lo, min(vals)), max(hi, max(vals))
    return med, lo, hi


def scores(results=None, reference=None):
    """One row per (board, build): category scores with their ranges, the
    FrameOS score, stability per mode, and the metric values used."""
    reference = REFERENCE if reference is None else reference
    out = []
    stab = defaultdict(dict)
    for (bid, build), g in grouped(results).items():
        for mode in ('full', 'sampled', 'quick'):
            rows = [(r, g['metrics']) for r in g['runs'].values() if r['mode'] == mode]
            if not rows:
                continue
            per_run = []
            for run, mets in rows:
                c = next((m['value'] for m in mets.get('stab.crash', []) if m['run_id'] == run['run_id']), 0)
                f = next((m['value'] for m in mets.get('stab.fail', []) if m['run_id'] == run['run_id']), 0)
                per_run.append((c, f, stability_score(c, f)))
            stab[(bid, build)][mode] = {'runs': len(per_run), 'crash': sum(p[0] for p in per_run),
                                        'fail': sum(p[1] for p in per_run),
                                        'score': round(statistics.median(p[2] for p in per_run), 1)}
    for (bid, build), g in grouped(results).items():
        board = g['board']
        row = {'board_id': bid, 'board': board.get('name', bid), 'build': build,
               'runs': sorted(g['runs']), 'channel': next(iter(g['runs'].values()))['channel'],
               'first_run': min(g['runs']), 'categories': {}, 'values': {}}
        for cat, metrics in CATEGORIES.items():
            parts, los, his = [], [], []
            for metric, better, how in metrics:
                med, lo, hi = metric_value(g['metrics'].get(metric, []))
                if med is None:
                    continue
                v, vlo, vhi = (_norm(x, how, board) for x in (med, lo, hi))
                row['values'][metric] = {'value': med, 'normalized': v, 'lo': lo, 'hi': hi}
                s = _metric_score(v, reference.get(metric), better)
                if s is None:
                    continue
                s_lo = _metric_score(vhi if better == 'lower' else vlo, reference.get(metric), better)
                s_hi = _metric_score(vlo if better == 'lower' else vhi, reference.get(metric), better)
                parts.append(s)
                los.append(s_lo or s)
                his.append(s_hi or s)
            if parts:
                row['categories'][cat] = {'score': round(_geomean(parts)), 'lo': round(_geomean(los)),
                                          'hi': round(_geomean(his)), 'metrics': len(parts)}
        perf = [row['categories'].get(c) for c in PERFORMANCE]
        if all(perf):
            row['categories']['frameos'] = {k: round(_geomean([p[k] for p in perf])) for k in ('score', 'lo', 'hi')}
        row['stability'] = stab.get((bid, build), {})
        out.append(row)
    return sorted(out, key=lambda r: (r['board'], r['first_run']))


def reference_from(results=None, build=REFERENCE_BUILD):
    """The REFERENCE table: per metric, the median over boards of the
    normalized value on `build`."""
    per = defaultdict(list)
    for row in scores(results, reference={}):
        if row['build'] != build:
            continue
        for metric, v in row['values'].items():
            if v.get('normalized') is not None:
                per[metric].append(v['normalized'])
    return {m: round(statistics.median(v), 4) for m, v in sorted(per.items())
            if any(m == x[0] for c in CATEGORIES.values() for x in c)}
