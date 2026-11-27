"""Bench results as records: append-only JSON Lines, one table per file, the
shape a database will take later (SCHEMA.md in FrameOS/frameos-benchmarks).

    boards.jsonl   one row per board identity (module, panel, chip, memory)
    runs.jsonl     one row per run x board: firmware build, mode, suites
    metrics.jsonl  one row per run x board x metric (x scene, for per-scene ones)
    images.jsonl   one row per firmware image: version, platform, size, slot

`import_run(run_dir)` turns any bench run directory (old or new) into rows;
`bench.py run` calls it when it finishes and `bench.py import` backfills.
Nothing is ever rewritten: importing a run twice adds nothing.
"""
from __future__ import annotations

import datetime as dt
import glob
import hashlib
import json
import os
import re
import statistics
import subprocess

from . import BENCH_VERSION

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(BENCH_DIR))


def _benchmarks_checkout() -> str:
    """The results live in their own repo, FrameOS/frameos-benchmarks:
    $FRAMEOS_BENCHMARKS, else a clone beside the main frameos checkout (found
    through git, so a worktree finds it too)."""
    if os.environ.get('FRAMEOS_BENCHMARKS'):
        return os.path.abspath(os.path.expanduser(os.environ['FRAMEOS_BENCHMARKS']))
    try:
        common = subprocess.run(['git', '-C', BENCH_DIR, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                capture_output=True, text=True, timeout=10).stdout.strip()
        main = os.path.dirname(common) if common else REPO
    except Exception:
        main = REPO
    return os.path.join(os.path.dirname(main), 'frameos-benchmarks')


BENCHMARKS = _benchmarks_checkout()
RESULTS = os.path.join(BENCHMARKS, 'data')
REPORT = os.path.join(BENCHMARKS, 'index.html')
BOARDS_JSON = os.path.join(BENCH_DIR, 'boards.json')
SCHEMA = 1
RIG = os.environ.get('FRAMEOS_BENCH_RIG', 'devbox')

VERSION_RE = re.compile(r'^(\d{4}\.\d+\.\d+)(?:-([A-Za-z0-9_./-]+?)\.([0-9a-f]{7,40}))?$')
CRASH_KINDS = ('panic', 'abort', 'task_wdt', 'int_wdt', 'brownout', 'oom', 'reboot', 'nim_error')


# ------------------------------------------------------------- files
def _path(table, results=None):
    return os.path.join(results or RESULTS, f'{table}.jsonl')


def read(table, results=None) -> list[dict]:
    path = _path(table, results)
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def append(table, rows, results=None):
    if not rows:
        return
    if not results and not os.path.isdir(BENCHMARKS):
        raise SystemExit(f'no results checkout at {BENCHMARKS}: git clone git@github.com:FrameOS/frameos-benchmarks.git '
                         f'there, or set FRAMEOS_BENCHMARKS')
    os.makedirs(results or RESULTS, exist_ok=True)
    with open(_path(table, results), 'a') as fh:
        for row in rows:
            fh.write(json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n')


# ------------------------------------------------------------- identity
def registry() -> dict:
    """tools/frame-bench/boards.json: what a board's console does not say
    (its name, its panel's size and kind, chip features). Optional per board."""
    try:
        with open(BOARDS_JSON) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {'boards': {}, 'panels': {}}


def board_identity(frame: dict, status: dict | None = None) -> dict:
    """A board by what it IS (module, panel, chip, PSRAM, flash), never by the
    port it sits on: ports move between sessions."""
    reg = registry()
    status = status or {}
    module = frame.get('module') or (status.get('board') or {}).get('module') or 'unknown'
    known = (reg.get('boards') or {}).get(module) or {}
    display = frame.get('display') or (status.get('board') or {}).get('display') or known.get('display') or 'unknown'
    panel = (reg.get('panels') or {}).get(display) or {}
    target = (status.get('board') or {}).get('target') or known.get('target') or (
        'rp2350' if frame.get('app') == 'frameos-pico' else 'unknown')
    psram = (status.get('memory') or {}).get('psramTotal') or frame.get('psram_total') or known.get('psram_bytes')
    flash = (status.get('storage') or {}).get('flashBytes') or known.get('flash_bytes')
    render = status.get('render') or {}
    w = render.get('previewWidth') or panel.get('width')
    h = render.get('previewHeight') or panel.get('height')
    mb = lambda b: f'{round(b / 1048576)}' if b else '?'  # noqa: E731
    # A Linux frame (linux.py) has RAM where an ESP32 has PSRAM, and an SD
    # card for flash: known by the RAM its board is sold with.
    is_linux = frame.get('app') == 'frameos-linux' or status.get('app') == 'frameos-linux'
    ram = known.get('ram_bytes') or (status.get('memory') or {}).get('ramTotal')
    memory = f'ram{mb(ram)}m' if is_linux else f'psram{mb(psram)}m/flash{mb(flash)}m'
    return {
        'board_id': f'{module}/{display}/{target}/{memory}',
        'module': module, 'display': display, 'target': target,
        'name': known.get('name') or frame.get('name') or module,
        'psram_bytes': None if is_linux else psram, 'flash_bytes': None if is_linux else flash,
        **({'ram_bytes': ram, 'os': 'linux'} if is_linux else {}), 'panel_width': w, 'panel_height': h,
        'panel_mpx': round(w * h / 1e6, 4) if w and h else None,
        'panel_kind': panel.get('kind') or ('lcd' if display.startswith('LCD_') else 'epaper'),
        'panel_colors': panel.get('colors'), 'touch': bool(frame.get('touch')),
        'chip': {k: v for k, v in ((reg.get('chips') or {}).get(target) or {}).items() if not k.startswith('_')},
    }


def release_elfs(results=None) -> dict:
    """ELF sha (16 hex) -> (version, platform) for every release image known
    (images.jsonl rows with `elf_sha16`)."""
    return {r['elf_sha16']: (r['version'], r['platform']) for r in read('images', results)
            if r.get('source') == 'release' and r.get('elf_sha16')}


LINUX_VERSION_RE = re.compile(r'^(\d{4}\.\d+\.\d+)\+([0-9a-f]{40})$')
_RELEASE_HASHES: dict = {}


def release_frameos_hash(base: str) -> str | None:
    """versions.json's `frameos` at tag v<base>: what a Linux release binary
    prints after its version (`2026.11.14+1ea5424...`), a hash of the sources."""
    if base not in _RELEASE_HASHES:
        try:
            out = subprocess.run(['git', '-C', REPO, 'show', f'v{base}:versions.json'], capture_output=True, text=True, timeout=10).stdout
            _RELEASE_HASHES[base] = (json.loads(out).get('frameos') or '').split('+')[-1] or None
        except Exception:
            _RELEASE_HASHES[base] = None
    return _RELEASE_HASHES[base]


def build_identity(version: str | None, elf: str | None, elfs: dict) -> dict:
    """What firmware a board ran. A release is known by its image's ELF sha,
    not by the version it prints: builds made on the bench have printed a
    release's number (2026.11.11) and numbers no release ever had
    (2026.11.20). A dev build from CI or `firmware/build.sh` prints
    `<base>-<branch>.<sha>` and becomes `<base>+<sha>`."""
    version = version or ''
    elf = (elf or '')[:16]
    lm = LINUX_VERSION_RE.match(version)
    if lm:
        # A Linux runtime prints its version and the hash of its sources: the
        # release's own (versions.json at the tag) is the release.
        base, src = lm.group(1), lm.group(2)
        if release_frameos_hash(base) == src:
            return {'frameos_version': base, 'build': base, 'channel': 'release', 'git_sha': None, 'elf_sha16': elf or None,
                    'release_platform': 'linux', 'version_reported': version}
        return {'frameos_version': base, 'build': f'{base}+src.{src[:8]}', 'channel': 'local', 'git_sha': None,
                'elf_sha16': elf or None, 'release_platform': None, 'version_reported': version}
    m = VERSION_RE.match(version)
    base = m.group(1) if m else None
    if elf and elf in elfs:
        rel, platform = elfs[elf]
        return {'frameos_version': rel, 'build': rel, 'channel': 'release', 'git_sha': None,
                'elf_sha16': elf, 'release_platform': platform, 'version_reported': version}
    if m and m.group(3):
        return {'frameos_version': base, 'build': f'{base}+{m.group(3)[:9]}',
                'channel': 'main' if m.group(2) == 'main' else f'branch:{m.group(2)}', 'git_sha': m.group(3),
                'elf_sha16': elf or None, 'release_platform': None, 'version_reported': version}
    return {'frameos_version': base, 'build': f'{base or version or "unknown"}+elf.{elf[:8]}' if elf else (version or 'unknown'),
            'channel': 'local' if elf else 'unknown', 'git_sha': None, 'elf_sha16': elf or None,
            'release_platform': None, 'version_reported': version}


# ------------------------------------------------------------- metrics
def _m(rows, metric, value, unit, spread=None, scene=None):
    if value is None:
        return
    row = {'metric': metric, 'value': value, 'unit': unit}
    if spread:
        row.update({k: spread[k] for k in ('n', 'min', 'max') if k in spread})
        if 'p25' in spread:
            row['p25'], row['p75'] = spread['p25'], spread['p75']
    if scene:
        row['scene'] = scene
    rows.append(row)


def spread(values):
    """Median with quartiles (the noise every metric carries along)."""
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    q = statistics.quantiles(v, n=4, method='inclusive') if len(v) >= 2 else [v[0], v[0], v[0]]
    return {'n': len(v), 'min': v[0], 'p25': round(q[0], 1), 'median': round(statistics.median(v), 1),
            'p75': round(q[2], 1), 'max': v[-1]}


def _median_of(stats_dict):
    return (stats_dict or {}).get('median')


def _slope(values):
    """Least-squares change per round (bytes a round): a leak is a steady fall."""
    pts = [(i, v) for i, v in enumerate(values) if v is not None]
    if len(pts) < 3:
        return None
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    den = sum((p[0] - mx) ** 2 for p in pts)
    return round(sum((p[0] - mx) * (p[1] - my) for p in pts) / den) if den else None


def frame_metrics(fr: dict, issues: list[dict]) -> list[dict]:
    """Every number a run measured for one frame, by suite."""
    rows: list[dict] = []
    suites = fr.get('suites') or {}

    st = (suites.get('status') or {}).get('status') or {}
    mem = st.get('memory') or {}
    _m(rows, 'mem.idle.psram_free', mem.get('psramFree'), 'bytes')
    _m(rows, 'mem.idle.internal_free', mem.get('internalFree'), 'bytes')
    _m(rows, 'mem.idle.internal_largest', mem.get('internalLargestBlock'), 'bytes')
    _m(rows, 'mem.framebuffer_reserved', mem.get('framebufferReserved'), 'bytes')
    _m(rows, 'net.wifi_rssi', (st.get('wifi') or {}).get('rssi'), 'dBm')
    # A Linux frame (linux.py): RAM and the runtime's resident set, not scored.
    _m(rows, 'mem.idle.ram_available', mem.get('ramAvailable'), 'bytes')
    _m(rows, 'mem.idle.process_rss', mem.get('processRss'), 'bytes')
    board = st.get('board') or {}
    _m(rows, 'chip.cpu_governor_mhz', board.get('cpuMhz') if st.get('app') == 'frameos-linux' else None, 'MHz')
    bat = st.get('battery') or {}
    if bat.get('present'):
        _m(rows, 'power.battery_mv', bat.get('millivolts'), 'mV')
    scenes_listed = (suites.get('status') or {}).get('scenes') or []
    _m(rows, 'scenes.installed', len(scenes_listed) or None, 'count')

    rb = (suites.get('reboot') or {}).get('reboot') or {}
    _m(rows, 'resp.boot.bootup_ms', rb.get('to_bootup_ms'), 'ms')
    _m(rows, 'resp.boot.first_render_ms', rb.get('to_first_render_ms'), 'ms')

    bm = (suites.get('benchmark') or {}).get('benchmark') or {}
    if bm:
        for key, entry in bm.items():
            if not isinstance(entry, dict) or 'cold' not in entry:
                continue
            cold = entry.get('cold') or {}
            _m(rows, f'bench.{key}.cold_ms', cold.get('wall_ms'), 'ms')
            _m(rows, f'bench.{key}.cold_render_ms', cold.get('render_ms'), 'ms')
            warm = entry.get('warm') or []
            if warm:
                _m(rows, f'bench.{key}.render_ms', _median_of(spread([w.get('render_ms') for w in warm])), 'ms',
                   spread([w.get('render_ms') for w in warm]))
                _m(rows, f'bench.{key}.done_ms', _median_of(spread([w.get('done_ms') for w in warm])), 'ms',
                   spread([w.get('done_ms') for w in warm]))
                packs = [w.get('pack_ms') for w in warm if w.get('in_place') is False]
                # 0 on every render: the panel packs nothing apart (the
                # E1003's grey canvas is the panel's buffer), no metric.
                if packs and max(p or 0 for p in packs) > 0:
                    _m(rows, f'bench.{key}.pack_ms', _median_of(spread(packs)), 'ms', spread(packs))
            if key == 'cpu':
                lines = [b for w in warm for b in w.get('bench') or [] if b.get('bench') == 'cpu']
                for part in ('int', 'float', 'json', 'str'):
                    s = spread([b.get(part) for b in lines])
                    _m(rows, f'bench.cpu.{part}_ms', _median_of(s), 'ms', s)
            if entry.get('fps'):
                s = spread([a.get('fps') for a in entry.get('animation') or []])
                _m(rows, 'bench.anim.fps', _median_of(s), 'fps', s)
                periods = [a.get('periodMs') for a in entry.get('animation') or [] if a.get('periodMs')]
                if periods:
                    _m(rows, 'bench.anim.target_fps', round(1000 / statistics.median(periods), 1), 'fps')
            if entry.get('taps'):
                s = spread(entry['taps'])
                _m(rows, 'bench.ui.tap_ms', _median_of(s), 'ms', s)
        heap = bm.get('heap') or {}
        _m(rows, 'mem.min_ever.internal', (heap.get('internal') or {}).get('min_ever_free'), 'bytes')
        _m(rows, 'mem.min_ever.psram', (heap.get('psram') or {}).get('min_ever_free'), 'bytes')
        _m(rows, 'mem.largest.psram', (heap.get('psram') or {}).get('largest'), 'bytes')
        _m(rows, 'mem.largest.internal', (heap.get('internal') or {}).get('largest'), 'bytes')
        _m(rows, 'mem.bench.psram_low', bm.get('psram_low'), 'bytes')
        _m(rows, 'mem.bench.process_peak_rss', (bm.get('memory') or {}).get('processPeakRss'), 'bytes')
        _m(rows, 'mem.bench.ram_available', (bm.get('memory') or {}).get('ramAvailable'), 'bytes')
        # Derived: the baseline's cost taken off (SCORES.md).
        by = {r['metric']: r for r in rows}
        base = (by.get('bench.base.render_ms') or {}).get('value')
        for key in ('raster', 'ui'):
            r = by.get(f'bench.{key}.render_ms')
            if base is not None and r is not None:
                # The render's own spread, less the baseline's median.
                net = {k: max(0.0, r[k] - base) for k in ('min', 'p25', 'p75', 'max') if k in r}
                if net:
                    net['n'] = r.get('n')
                _m(rows, f'bench.{key}.net_ms', max(0.0, r['value'] - base), 'ms', net or None)
        by = {r['metric']: r['value'] for r in rows}
        colds = [by.get(f'bench.{k}.cold_ms') for k in ('cpu', 'raster', 'ui', 'image')]
        s = spread(colds)
        _m(rows, 'bench.switch_ms', _median_of(s), 'ms', s)

    sc = (suites.get('scenes') or {}).get('scenes') or []
    warm_best, switches, colds = [], [], []
    for r in sc:
        name = r.get('name')
        sw = r.get('switch') or {}
        _m(rows, 'scene.switch_ms', sw.get('wall_ms'), 'ms', scene=name)
        _m(rows, 'scene.cold_ms', sw.get('done_ms'), 'ms', scene=name)
        times = [w.get('render_ms') if w.get('render_ms') is not None else w.get('done_ms') for w in r.get('warm') or []]
        times = [t for t in times if t is not None]
        if times:
            _m(rows, 'scene.warm_ms', min(times), 'ms', spread(times), scene=name)
            warm_best.append(min(times))
        if sw.get('ok') and sw.get('wall_ms') is not None:
            switches.append(sw['wall_ms'])
        if sw.get('done_ms') is not None:
            colds.append(sw['done_ms'])
        for a in ((r.get('passive') or {}).get('animation') or [])[:1]:
            _m(rows, 'scene.anim_fps', a.get('fps'), 'fps', scene=name)
        _m(rows, 'scene.tap_ms', (r.get('tap') or {}).get('first_ms'), 'ms', scene=name)
    if sc:
        _m(rows, 'scenes.count', len(sc), 'count')
        _m(rows, 'scenes.failed', sum(1 for r in sc if not (r.get('switch') or {}).get('ok')), 'count')
        s = spread(warm_best)
        _m(rows, 'scenes.warm_ms', _median_of(s), 'ms', s)
        s = spread(switches)
        _m(rows, 'scenes.switch_ms', _median_of(s), 'ms', s)

    bi = (suites.get('builtin') or {}).get('builtin') or {}
    for name, key in (('sceneSwitcher', 'switcher'), ('sceneSettings', 'settings')):
        _m(rows, f'resp.{key}.open_ms', ((bi.get(name) or {}).get('open') or {}).get('wall_ms'), 'ms')

    inp = (suites.get('input') or {}).get('input') or {}
    for d in ('next', 'previous', 'swipe_switcher', 'swipe_settings'):
        _m(rows, f'resp.input.{d}_ms', (inp.get(d) or {}).get('wall_ms'), 'ms')

    desk = (suites.get('desktop') or {}).get('desktop') or []
    if desk:
        pushes = [e.get('push_ms') for e in desk]
        wins = [w.get('wall_ms') for e in desk for w in e.get('windows') or []]
        taps = [w.get('tap_ms') for e in desk for w in e.get('windows') or [] if w.get('tap_ms')]
        psram = [w.get('freePsram') for e in desk for w in e.get('windows') or [] if w.get('freePsram')]
        for metric, vals in (('desktop.push_ms', pushes), ('desktop.window_ms', wins), ('desktop.tap_ms', taps),
                             ('desktop.refocus_ms', [e.get('refocus_first_ms') for e in desk])):
            s = spread(vals)
            _m(rows, metric, _median_of(s), 'ms', s)
        _m(rows, 'mem.desktop.psram_low', min(psram) if psram else None, 'bytes')
        _m(rows, 'desktop.layouts', len(desk), 'count')

    code = (suites.get('code') or {}).get('code') or []
    if code:
        s = spread([c.get('wall_ms') for c in code])
        _m(rows, 'code.open_ms', _median_of(s), 'ms', s)

    storm = (suites.get('storm') or {}).get('storm') or {}
    _m(rows, 'storm.settled_s', storm.get('settled_s'), 's')

    soak = (suites.get('soak') or {}).get('soak') or []
    if len(soak) > 1:
        rounds = soak[1:]
        _m(rows, 'mem.soak.psram_drift', _slope([s.get('psramFree') for s in rounds]), 'bytes/round')
        _m(rows, 'mem.soak.internal_drift', _slope([s.get('internalFree') for s in rounds]), 'bytes/round')
        _m(rows, 'mem.soak.psram_low', min((s.get('psramFree') for s in rounds if s.get('psramFree')), default=None), 'bytes')
        _m(rows, 'mem.soak.rss_drift', _slope([s.get('processRss') for s in rounds]), 'bytes/round')
        _m(rows, 'mem.soak.rounds', len(rounds), 'count')

    off = (suites.get('offline') or {}).get('offline') or []
    if off:
        s = spread([o.get('wall_ms') for o in off])
        _m(rows, 'offline.switch_ms', _median_of(s), 'ms', s)

    thin = (suites.get('thin') or {}).get('thin') or []
    if thin:
        first = [p['pulls'][0] for p in thin if p.get('pulls')]
        s = spread([p.get('ms') for p in first if p.get('status') == 200])
        _m(rows, 'thin.plane_render_ms', _median_of(s), 'ms', s)
        s = spread([p.get('bytes') for p in first if p.get('status') == 200])
        _m(rows, 'thin.bytes', _median_of(s), 'bytes', s)
    dev = (suites.get('thin') or {}).get('device') or {}
    _m(rows, 'thin.device_total_ms', dev.get('total_ms'), 'ms')

    # Stability: the run's issues for this frame (merged ones carry a count).
    mine = [i for i in issues if i.get('frame') == fr.get('name') and i.get('suite') != 'compare']
    # One reboot matches two boot lines (`rst:` and the bootloader's) and was
    # reported twice, 0.1 s apart: count a reboot once per 2 s.
    boots, kept = [], []
    for i in mine:
        m = re.search(r'rebooted at \+([\d.]+)s', i.get('detail') or '') if i.get('kind') == 'reboot' else None
        if m:
            t = float(m.group(1))
            if any(abs(t - b) < 2 for b in boots):
                continue
            boots.append(t)
        kept.append(i)
    mine = kept
    count = lambda pred: sum(i.get('count', 1) for i in mine if pred(i))  # noqa: E731
    for sev in ('crash', 'fail', 'slow', 'note'):
        _m(rows, f'stab.{sev}', count(lambda i, s=sev: i.get('severity') == s), 'count')
    for kind in CRASH_KINDS:
        _m(rows, f'stab.kind.{kind}', count(lambda i, k=kind: i.get('kind') == k), 'count')
    _m(rows, 'stab.kind.interpreter_discard', count(lambda i: i.get('kind') == 'interpreter_discard'), 'count')
    _m(rows, 'stab.kind.ota_mid_run', count(lambda i: i.get('kind') == 'ota_mid_run'), 'count')
    return rows


# ------------------------------------------------------------- runs
def run_mode(run: dict) -> str:
    """full / sampled / quick / partial, for a run that did not record it
    (before bench version 2): only like runs compare (SCORES.md)."""
    meta = run.get('bench') or {}
    if meta.get('mode'):
        return meta['mode']
    frames = [f for f in run.get('frames', []) if f.get('kind') == 'local']
    if not frames:
        return 'partial'
    suites = set().union(*[set((f.get('suites') or {}).keys()) for f in frames])
    if not {'scenes', 'soak', 'desktop', 'reboot'} <= suites:
        return 'partial'
    if any(((f.get('suites') or {}).get('scenes') or {}).get('left_out') for f in frames):
        return 'sampled'
    counts = [len((((f.get('suites') or {}).get('scenes') or {}).get('scenes') or [])) for f in frames]
    listed = [len(((f.get('suites') or {}).get('status') or {}).get('scenes') or []) for f in frames]
    if counts and max(counts) <= 4 and max(listed or [0]) > 4:
        return 'quick'
    return 'full'


def scene_set_hash(fr: dict) -> str | None:
    """The frame's own scene set (ids and sizes): its scene times compare
    across runs only while this stays the same."""
    lst = ((fr.get('suites') or {}).get('status') or {}).get('scenes') or []
    if not lst:
        return None
    key = json.dumps(sorted((s.get('id'), s.get('bytes'), s.get('hash')) for s in lst))
    return hashlib.sha256(key.encode()).hexdigest()[:12]


CPU_LINE = re.compile(r'\bcpu: (\d+) MHz\b')


def cpu_mhz(run_dir: str, fr: dict):
    """The clock the board said it set at boot (`cpu: 240 MHz (touch)`,
    main.c), from the run's raw log: printed only at a boot, so a run with
    the restart suite has it. None when the log does not say (a board that
    stays at its default clock prints nothing)."""
    safe = ''.join(c if c.isalnum() else '_' for c in (fr.get('name') or fr.get('port') or ''))
    path = os.path.join(run_dir, f'{safe}.raw.log')
    found = None
    try:
        with open(path, errors='replace') as fh:
            for line in fh:
                if 'MHz' in line:
                    m = CPU_LINE.search(line)
                    if m:
                        found = int(m.group(1))
    except OSError:
        return None
    return found


def _started_iso(stamp: str) -> str:
    t = dt.datetime.strptime(stamp, '%Y%m%d-%H%M%S')
    return t.astimezone().isoformat(timespec='seconds')


def import_run(run_dir: str, results=None, dry_run=False) -> dict:
    """One run directory -> new rows in boards / runs / metrics. Returns a
    summary {run_id, added: [...], skipped: [...]}."""
    path = os.path.join(run_dir, 'run.json')
    if not os.path.exists(path):
        return {'run_id': os.path.basename(run_dir.rstrip('/')), 'error': 'no run.json (a run still going or killed)'}
    with open(path) as fh:
        run = json.load(fh)
    try:
        with open(os.path.join(run_dir, 'issues.json')) as fh:
            issues = json.load(fh)
    except (OSError, ValueError):
        issues = []
    run_id = run.get('started') or os.path.basename(run_dir.rstrip('/'))
    meta = run.get('bench') or {}
    mode = run_mode(run)
    elfs = release_elfs(results)
    have_runs = {(r['rig'], r['run_id'], r['board_id'], r.get('device')) for r in read('runs', results)}
    have_boards = {b['board_id'] for b in read('boards', results)}
    out = {'run_id': run_id, 'mode': mode, 'added': [], 'skipped': []}
    new_boards, new_runs, new_metrics = [], [], []
    seen = set()
    for fr in run.get('frames', []):
        st = ((fr.get('suites') or {}).get('status') or {}).get('status') or {}
        ident = board_identity(fr, st)
        bid = ident['board_id']
        # Two boards of one kind in a run are two units of it, both counted.
        device = f"frame{fr['frame_id']}" if fr.get('frame_id') else (fr.get('name') or fr.get('port'))
        if (RIG, run_id, bid, device) in have_runs or (bid, device) in seen:
            out['skipped'].append(ident['name'])
            continue
        seen.add((bid, device))
        if bid not in have_boards:
            new_boards.append({'schema': SCHEMA, **ident, 'first_seen': run_id})
            have_boards.add(bid)
        build = build_identity(fr.get('version'), fr.get('elf') or (st.get('elfSha256') or '')[:16], elfs)
        suites = fr.get('suites') or {}
        new_runs.append({
            'schema': SCHEMA, 'rig': RIG, 'run_id': run_id, 'board_id': bid, 'device': device, 'started': _started_iso(run_id),
            'mode': mode, 'bench_version': meta.get('version', 1), 'bench_sha': meta.get('sha'),
            'workload': (suites.get('benchmark') or {}).get('workload'),
            'frame_name': fr.get('name'), 'kind': fr.get('kind'), **build,
            'suites': sorted(suites.keys()),
            'seconds': round(sum((s or {}).get('seconds') or 0 for s in suites.values()), 1),
            'scene_set': scene_set_hash(fr),
        })
        mhz = cpu_mhz(run_dir, fr)
        for row in frame_metrics(fr, issues) + ([{'metric': 'chip.cpu_mhz', 'value': mhz, 'unit': 'MHz'}] if mhz else []):
            new_metrics.append({'rig': RIG, 'run_id': run_id, 'board_id': bid, 'device': device, **row})
        out['added'].append(ident['name'])
    if not dry_run:
        append('boards', new_boards, results)
        append('runs', new_runs, results)
        append('metrics', new_metrics, results)
    out['metrics'] = len(new_metrics)
    return out


def bench_meta(mode: str, args: dict) -> dict:
    """What `bench.py run` records about itself in run.json."""
    try:
        sha = subprocess.run(['git', '-C', BENCH_DIR, 'log', '-1', '--format=%h', '--', '.'],
                             capture_output=True, text=True, timeout=10).stdout.strip() or None
        dirty = bool(subprocess.run(['git', '-C', BENCH_DIR, 'status', '--porcelain', '--', '.'],
                                    capture_output=True, text=True, timeout=10).stdout.strip())
    except Exception:
        sha, dirty = None, None
    from .benchmarks import WORKLOAD
    return {'version': BENCH_VERSION, 'sha': sha, 'dirty': dirty, 'mode': mode, 'workload': WORKLOAD, 'args': args}


# ------------------------------------------------------------- images
def _gh_json(args):
    out = subprocess.run(['gh', *args], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300])
    return json.loads(out.stdout)


def import_release_sizes(versions: list[str], cache: str, elf_platforms=('esp32-s3-generic', 'esp32-s3-32mb'),
                         results=None, repo='FrameOS/frameos') -> list[str]:
    """Each release's `-size.json` per platform (the CI's size report) as an
    images row, and the ELF sha of the app images the bench boards run, which
    is how a run is known to be on a release (build_identity)."""
    have = {(r['version'], r['platform']) for r in read('images', results) if r.get('source') == 'release'}
    done, rows = [], []
    for v in versions:
        v = v.lstrip('v')
        rel = _gh_json(['release', 'view', f'v{v}', '-R', repo, '--json', 'assets,publishedAt'])
        names = {a['name']: a for a in rel['assets']}
        d = os.path.join(cache, v)
        os.makedirs(d, exist_ok=True)
        for name in sorted(names):
            m = re.match(rf'^frameos-{re.escape(v)}-(.+)-size\.json$', name)
            if not m or (v, m.group(1)) in have:
                continue
            platform = m.group(1)
            local = os.path.join(d, name)
            if not os.path.exists(local):
                subprocess.run(['gh', 'release', 'download', f'v{v}', '-R', repo, '-D', d, '-p', name], check=True,
                               capture_output=True, timeout=300)
            with open(local) as fh:
                size = json.load(fh)
            elf = None
            app = f'frameos-{v}-{platform}-app.bin'
            if platform in elf_platforms and app in names:
                app_local = os.path.join(d, app)
                if not os.path.exists(app_local):
                    subprocess.run(['gh', 'release', 'download', f'v{v}', '-R', repo, '-D', d, '-p', app], check=True,
                                   capture_output=True, timeout=600)
                elf = elf_sha16(app_local)
            rows.append(image_row(size, v, platform, 'release', rel.get('publishedAt'), elf))
            done.append(f'{v} {platform}')
    append('images', rows, results)
    return done


def elf_sha16(app_bin: str) -> str:
    """An ESP-IDF app image keeps its ELF's sha256 at 0xb0 (what the board
    reports as `elfSha256`)."""
    with open(app_bin, 'rb') as fh:
        fh.seek(0xb0)
        return fh.read(8).hex()


def image_row(size: dict, version: str, platform: str, source: str, published=None, elf=None) -> dict:
    app, slot = size.get('app_bytes'), size.get('app_slot_bytes')
    sec = size.get('sections') or {}
    return {
        'schema': SCHEMA, 'source': source, 'version': version, 'platform': platform,
        'chip': size.get('platform'), 'git_sha': size.get('git_sha'), 'published': published, 'elf_sha16': elf,
        'app_bytes': app, 'slot_bytes': slot, 'slot_headroom_bytes': slot - app if app and slot else None,
        'slot_used_pct': round(100 * app / slot, 2) if app and slot else None,
        'merged_bytes': size.get('merged_bytes'), 'flash_bytes': size.get('flash_bytes'),
        'flash_code': sec.get('flash_code'), 'flash_rodata': sec.get('flash_rodata'),
        'used_diram': sec.get('used_diram'), 'diram_total': sec.get('diram_total'),
        'groups': {k: (g or {}).get('flash') for k, g in (size.get('groups') or {}).items()},
    }


def import_local_image(app_bin: str, version: str, platform: str, size_json: str | None = None, results=None):
    """A local build (`firmware/build.sh`, CI's artifact): its size, and the
    full report when the build left one."""
    size = {}
    if size_json and os.path.exists(size_json):
        with open(size_json) as fh:
            size = json.load(fh)
    size.setdefault('app_bytes', os.path.getsize(app_bin))
    size.setdefault('app_slot_bytes', 3604480)
    row = image_row(size, version, platform, 'local', dt.datetime.now().astimezone().isoformat(timespec='seconds'),
                    elf_sha16(app_bin))
    have = {(r['version'], r['platform'], r.get('elf_sha16')) for r in read('images', results)}
    if (row['version'], row['platform'], row['elf_sha16']) not in have:
        append('images', [row], results)
    return row


def run_dirs(home: str) -> list[str]:
    return sorted(d for d in glob.glob(os.path.join(home, '[0-9]' * 8 + '-[0-9]*')) if os.path.isdir(d))
