#!/usr/bin/env python3
"""FrameOS hardware bench: every frame on this machine's USB, every suite.

    tools/frame-bench/bench.py discover                 # which frames are attached
    tools/frame-bench/bench.py run                      # default suites on every frame, in parallel
    tools/frame-bench/bench.py run --frames sensecap --suites scenes,soak
    tools/frame-bench/bench.py run --quick              # a few scenes each: a smoke test
    tools/frame-bench/bench.py report <run-dir> [--baseline <older-run-dir>]

Environment: FRAMEOS_BENCH_BACKEND (default http://localhost:8989),
FRAMEOS_BENCH_TOKEN (a backend API token), FRAMEOS_BENCH_HOST_IP (this
machine's address as the frames see it, for the offline suite).
Results go to ~/.frameos-bench/<timestamp>/ (report.md, issues.json,
run.json, a raw console log per frame). See .claude/skills/frame-bench/SKILL.md.
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

from framebench import inventory, report  # noqa: E402
from framebench.backend import Backend  # noqa: E402
from framebench.suites import DEFAULT, SUITES, Ctx  # noqa: E402

LOCAL_ONLY = {'scenes', 'builtin', 'input', 'storm', 'soak', 'offline', 'desktop', 'reboot'}

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
    stamp = time.strftime('%Y%m%d-%H%M%S')
    out_dir = args.out or os.path.join(HOME, stamp)
    os.makedirs(out_dir, exist_ok=True)
    ctx = Ctx(out_dir, backend=be if be.token else None, warm=args.warm, passive=args.passive, quick=args.quick,
              host_ip=args.host_ip or os.environ.get('FRAMEOS_BENCH_HOST_IP'))
    ctx.soak_rounds = args.soak_rounds
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
    run = {'started': stamp, 'frames': results}
    with open(os.path.join(out_dir, 'run.json'), 'w') as fh:
        json.dump(run, fh, indent=1, default=str)
    baseline = None
    if args.baseline:
        with open(os.path.join(args.baseline, 'run.json')) as fh:
            baseline = json.load(fh)
    text = report.write(run, out_dir, baseline)
    print(text.split('\n## ')[0] + '\n## ' + text.split('\n## ')[1] if '\n## ' in text else text)
    print(f'\nreport: {out_dir}/report.md')
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('discover')
    r = sub.add_parser('run')
    r.add_argument('--frames', help='comma list: name/module substrings, ports or frame ids')
    r.add_argument('--suites', default='default', help=f"comma list of {','.join(SUITES)} (default: per frame kind)")
    r.add_argument('--warm', type=int, default=3)
    r.add_argument('--passive', type=float, default=8.0, help='seconds to watch each scene on an LCD')
    r.add_argument('--soak-rounds', type=int, default=3, help='rounds of every scene in the soak')
    r.add_argument('--quick', action='store_true')
    r.add_argument('--rediscover', action='store_true')
    r.add_argument('--host-ip')
    r.add_argument('--baseline', help='an earlier run directory to compare with')
    r.add_argument('--out')
    p = sub.add_parser('report')
    p.add_argument('run_dir')
    p.add_argument('--baseline')
    args = ap.parse_args()
    sys.exit({'discover': lambda a: (cmd_discover(a), 0)[1], 'run': cmd_run, 'report': cmd_report}[args.cmd](args) or 0)


if __name__ == '__main__':
    main()
