#!/usr/bin/env python3
"""FrameOS hardware bench: every frame on this machine's USB, every suite.

    tools/frame-bench/bench.py discover                 # which frames are attached
    tools/frame-bench/bench.py run                      # default suites on every frame, in parallel
    tools/frame-bench/bench.py run --frames sensecap --suites scenes,soak
    tools/frame-bench/bench.py run --quick              # a few scenes each: a smoke test
    tools/frame-bench/bench.py report <run-dir> [--baseline <older-run-dir>]
    tools/frame-bench/bench.py import [<run-dir> ...]     # run dirs -> tools/frame-bench/results/*.jsonl
    tools/frame-bench/bench.py sizes v2026.11.12 ...     # release image sizes -> images.jsonl
    tools/frame-bench/bench.py html                       # results -> results/report.html (scores, trends)
    tools/frame-bench/bench.py restore                    # undo a killed benchmark suite (backend, scenes)

Environment: FRAMEOS_BENCH_BACKEND (default http://localhost:8989),
FRAMEOS_BENCH_TOKEN (a backend API token), FRAMEOS_BENCH_HOST_IP (this
machine's address as the frames see it, for the offline suite).
Results go to ~/.frameos-bench/<timestamp>/ (report.md, issues.json,
run.json, a raw console log per frame); a finished run is also imported
into tools/frame-bench/results/ (`--no-record` to skip). See
.claude/skills/frame-bench/SKILL.md and tools/frame-bench/SCORES.md.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framebench import benchmarks, inventory, records, report  # noqa: E402
from framebench.backend import Backend  # noqa: E402
from framebench.suites import DEFAULT, SUITES, Ctx  # noqa: E402

LOCAL_ONLY = {'scenes', 'builtin', 'input', 'storm', 'soak', 'offline', 'desktop', 'reboot', 'benchmark'}

HOME = os.path.expanduser(os.environ.get('FRAMEOS_BENCH_HOME', '~/.frameos-bench'))


def cmd_discover(args):
    be = Backend()
    frames = inventory.discover(be if be.token else None)
    inventory.save(os.path.join(HOME, 'inventory.json'), frames)
    for f in frames:
        print(f"{f['port']:14} frame {str(f.get('frame_id')):>3}  {f.get('name', '')[:24]:24} {f['module'][:28]:28} "
              f"{f['display']:20} {f['kind']:5} fw {f.get('version')}  {f.get('ip')}")
    if not frames:
        print('no frames answered on any serial port')
    return frames


def pick(frames, wanted):
    if not wanted:
        return frames
    keys = [w.lower() for w in wanted.split(',')]
    return [f for f in frames if any(k in (f.get('name') or '').lower() or k in f['module'].lower()
                                     or k == f['port'] or k == str(f.get('frame_id')) for k in keys)]


def run_frame(ctx, frame, suites, results):
    res = {**{k: v for k, v in frame.items() if k != 'api_key'}, 'suites': {}}
    results.append(res)
    for name in suites:
        if name not in SUITES:
            continue
        if name in LOCAL_ONLY and frame['kind'] != 'local':
            continue
        t = time.time()
        print(f"[{frame.get('name')}] {name} ...", flush=True)
        try:
            out = SUITES[name](ctx, frame)
        except Exception as exc:
            out = {'issues': [{'severity': 'fail', 'kind': 'bench_error', 'where': name,
                               'detail': f'{exc!r}: {traceback.format_exc()[-600:]}'}]}
        out['seconds'] = round(time.time() - t, 1)
        res['suites'][name] = out
        n = len(out.get('issues', []))
        print(f"[{frame.get('name')}] {name} done in {out['seconds']} s, {n} issue(s)", flush=True)
        with open(os.path.join(ctx.out_dir, 'run.partial.json'), 'w') as fh:
            json.dump({'frames': results}, fh, default=str)


def cmd_run(args):
    be = Backend()
    frames = inventory.discover(be if be.token else None) if args.rediscover or not os.path.exists(os.path.join(HOME, 'inventory.json')) \
        else inventory.load(os.path.join(HOME, 'inventory.json'))
    frames = pick(frames, args.frames)
    if not frames:
        print('no frames selected')
        return 1
    leftover = cmd_restore(None, ports=[f['port'] for f in frames])
    if leftover:
        print('put back what an earlier benchmark suite left:', leftover)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    out_dir = args.out or os.path.join(HOME, stamp)
    os.makedirs(out_dir, exist_ok=True)
    ctx = Ctx(out_dir, backend=be if be.token else None, warm=args.warm, passive=args.passive, quick=args.quick,
              host_ip=args.host_ip or os.environ.get('FRAMEOS_BENCH_HOST_IP'))
    ctx.soak_rounds = args.soak_rounds
    ctx.full = args.full
    ctx.rotation = args.rotation if args.rotation is not None else int(time.time() // 86400)
    ctx.scene_filter = args.scenes.split('|') if args.scenes else None
    ctx.bench_n = args.bench_n
    ctx.isolate = not args.no_isolate
    # Only like runs compare (SCORES.md): what this one covered.
    mode = ('quick' if args.quick else 'partial' if (args.suites != 'default' or args.scenes or args.frames)
            else 'full' if args.full else 'sampled')
    results = []
    threads = []
    for f in frames:
        suites = args.suites.split(',') if args.suites and args.suites != 'default' else DEFAULT.get(f['kind'], ['status'])
        th = threading.Thread(target=run_frame, args=(ctx, f, suites, results))
        th.start()
        threads.append(th)
    for th in threads:
        th.join()
    ctx.close()
    run = {'started': stamp, 'frames': results,
           'bench': records.bench_meta(mode, {k: v for k, v in vars(args).items() if k != 'cmd'})}
    with open(os.path.join(out_dir, 'run.json'), 'w') as fh:
        json.dump(run, fh, indent=1, default=str)
    baseline = None
    if args.baseline:
        with open(os.path.join(args.baseline, 'run.json')) as fh:
            baseline = json.load(fh)
    text = report.write(run, out_dir, baseline)
    print(text.split('\n## ')[0] + '\n## ' + text.split('\n## ')[1] if '\n## ' in text else text)
    print(f'\nreport: {out_dir}/report.md')
    if not args.no_record:
        res = records.import_run(out_dir)
        print(f"records: {res.get('metrics', 0)} metric(s) for {', '.join(res.get('added') or []) or 'no new frame'} "
              f"-> {records.RESULTS} (mode {res.get('mode')})")
    issues = json.load(open(os.path.join(out_dir, 'issues.json')))
    return 2 if any(i['severity'] in ('crash', 'fail') for i in issues) else 0


def cmd_report(args):
    with open(os.path.join(args.run_dir, 'run.json')) as fh:
        run = json.load(fh)
    baseline = None
    if args.baseline:
        with open(os.path.join(args.baseline, 'run.json')) as fh:
            baseline = json.load(fh)
    print(report.write(run, args.run_dir, baseline))


def cmd_import(args):
    dirs = args.run_dirs or records.run_dirs(HOME)
    for d in dirs:
        res = records.import_run(d, dry_run=args.dry_run)
        if res.get('error'):
            print(f"{res['run_id']}: {res['error']}")
        else:
            print(f"{res['run_id']} ({res['mode']}): +{len(res['added'])} frame(s), {res['metrics']} metric(s)"
                  + (f", already in: {', '.join(res['skipped'])}" if res['skipped'] else ''))


def cmd_sizes(args):
    done = records.import_release_sizes(args.versions, os.path.join(HOME, 'releases'),
                                        elf_platforms=('esp32-s3-generic', 'esp32-s3-32mb') if args.elf else ())
    for app in args.local or []:
        path, version, platform = app.split(':')
        done.append(f"{version} {platform} {records.import_local_image(path, version, platform)['app_bytes']}")
    print(f'{len(done)} image row(s) added' + (': ' + ', '.join(done) if done else ''))


def cmd_html(args):
    from framebench import charts
    print(f'report: {charts.write(args.out)}')


def cmd_scores(args):
    """The scores as a Markdown table (for a PR body), or `--reference`: the
    REFERENCE table to freeze into scoring.py."""
    from framebench import scoring
    if args.reference:
        print(json.dumps(scoring.reference_from(build=args.reference), indent=1))
        return
    builds = args.builds.split(',') if args.builds else None
    cats = ('frameos', *scoring.PERFORMANCE, 'memory')
    print('| board | build | ' + ' | '.join(scoring.LABELS[c] for c in cats) + ' | Stability (full) |')
    print('|---|---|' + '---:|' * (len(cats) + 1))
    from framebench.charts import _build_key
    for r in sorted(scoring.scores(), key=lambda r: (r['board'], _build_key(r['build']))):
        if builds and r['build'] not in builds:
            continue
        if not any(c in r['categories'] for c in cats):
            continue
        cells = []
        for c in cats:
            s = r['categories'].get(c)
            cells.append(f"{s['score']} ({s['lo']}–{s['hi']})" if s else '—')
        st = r['stability'].get('full') or {}
        cells.append(f"{st['score']} ({st['crash']:g} crash, {st['fail']:g} fail)" if st else '—')
        print(f"| {r['board']} | {r['build']} | " + ' | '.join(cells) + ' |')


def cmd_restore(args, ports=None):
    """What a killed benchmark suite left on a board (its backend pointed at a
    closed port, the benchmark scenes): put back, port by port."""
    from framebench.console import Console
    wanted = {p for p in benchmarks._journal() if ports is None or p in ports}
    if not wanted:
        if args is not None:
            print('nothing to restore')
        return []
    opened = []

    def console_for(port):
        con = Console(port)
        opened.append(con)
        con.idle(0.5)
        return con
    try:
        done = benchmarks.restore_all(console_for, only=wanted)
    finally:
        for con in opened:
            con.close()
    for port, what in done:
        print(f'{port}: {what}')
    return done


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('discover')
    r = sub.add_parser('run')
    r.add_argument('--frames', help='comma list: name/module substrings, ports or frame ids')
    r.add_argument('--suites', default='default', help=f"comma list of {','.join(SUITES)} (default: per frame kind)")
    r.add_argument('--warm', type=int, default=3)
    r.add_argument('--passive', type=float, default=8.0, help='seconds to watch each scene on an LCD')
    r.add_argument('--scenes', help='scenes suite: only these scene names or ids, separated by |')
    r.add_argument('--soak-rounds', type=int, default=5, help='rounds of every scene in the soak')
    r.add_argument('--quick', action='store_true')
    r.add_argument('--full', action='store_true', help='no sampling on slow panels: every scene, layout and round')
    r.add_argument('--rotation', type=int, help='which third of the rotated scenes and layouts a slow panel runs (default: the day)')
    r.add_argument('--rediscover', action='store_true')
    r.add_argument('--host-ip')
    r.add_argument('--baseline', help='an earlier run directory to compare with')
    r.add_argument('--out')
    r.add_argument('--bench-n', type=int, default=5, help='benchmark suite: warm renders of each benchmark scene')
    r.add_argument('--no-isolate', action='store_true',
                   help='benchmark suite: leave the backend connected (by default it points at a closed port while it runs)')
    r.add_argument('--no-record', action='store_true', help='do not import the run into tools/frame-bench/results')
    p = sub.add_parser('report')
    p.add_argument('run_dir')
    p.add_argument('--baseline')
    i = sub.add_parser('import', help='run directories -> results/*.jsonl (all of ~/.frameos-bench by default)')
    i.add_argument('run_dirs', nargs='*')
    i.add_argument('--dry-run', action='store_true')
    z = sub.add_parser('sizes', help='firmware image sizes -> results/images.jsonl')
    z.add_argument('versions', nargs='*', help='release tags (v2026.11.12 ...)')
    z.add_argument('--local', action='append', help='<app.bin>:<version>:<platform> of a local build')
    z.add_argument('--elf', action='store_true', help="also fetch the S3 app images for their ELF sha (how a run is known "
                   "to be on a release): for every release the boards have run")
    h = sub.add_parser('html', help='results -> a static HTML report')
    h.add_argument('--out', help='default tools/frame-bench/results/report.html')
    sub.add_parser('restore', help='undo what a killed benchmark suite left on the boards')
    s = sub.add_parser('scores', help='the scores as a Markdown table')
    s.add_argument('--builds', help='comma list of builds to show')
    s.add_argument('--reference', metavar='BUILD', help='print the REFERENCE table from this build instead')
    args = ap.parse_args()
    sys.exit({'discover': lambda a: (cmd_discover(a), 0)[1], 'run': cmd_run, 'report': cmd_report,
              'import': cmd_import, 'sizes': cmd_sizes, 'html': cmd_html, 'restore': lambda a: (cmd_restore(a), 0)[1],
              'scores': cmd_scores}[args.cmd](args) or 0)


if __name__ == '__main__':
    main()
