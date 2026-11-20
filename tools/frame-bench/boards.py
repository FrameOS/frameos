#!/usr/bin/env python3
"""Book the bench's boards before you touch them (framebench/bookings.py).

    tools/frame-bench/boards.py                       # every board: free, booked (by whom, until when, for what) or lapsed
    tools/frame-bench/boards.py book sticky,e1003 --who "frameos-16 (desktop-consistency)" --for "flash + desktop suite" --hours 2
    tools/frame-bench/boards.py book all --who ... --for ... --partial   # the free ones, now
    tools/frame-bench/boards.py book e1004 --who ... --for ... --wait   # until its holder releases it (or it lapses)
    tools/frame-bench/boards.py extend sticky --who ... --hours 1
    tools/frame-bench/boards.py release sticky,e1003 --who ...
    tools/frame-bench/boards.py check sticky --who ...  # exit 0: free or yours; 3: someone else's (for scripts)

Boards by their short name (boards.json `key`): sensecap, sticky, e1002,
e1003, e1004, pico, or `all`. `--who` names you the way other sessions reach
you: your session's name first (`ListAgents`), then anything that helps
("frameos-16 (desktop-consistency, PR #920)"); `$FRAMEOS_BENCH_WHO` is its
default. The file is ~/.frameos-bench/BOOKINGS.md ($FRAMEOS_BENCH_BOOKINGS).
Exit codes: 0 done, 3 a board is someone else's (they are listed), 2 a usage
error.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framebench import bookings  # noqa: E402


def show_refused(refused):
    for b, h in refused.items():
        print(f"  {b}: booked by {h['holder']} until {h['until']} ({h['what']})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')
    who = dict(default=os.environ.get('FRAMEOS_BENCH_WHO'), help='your session name first, then what you are doing')
    b = sub.add_parser('book')
    b.add_argument('boards')
    b.add_argument('--who', **who)
    b.add_argument('--for', dest='what', required=True, help='what you will do with them')
    b.add_argument('--hours', type=float, default=2.0, help='until when, from now (default 2)')
    b.add_argument('--partial', action='store_true', help='book the free ones and say which are not')
    b.add_argument('--wait', action='store_true', help='wait for the ones someone else holds')
    b.add_argument('--timeout', type=float, default=6.0, help='--wait: give up after so many hours (default 6)')
    e = sub.add_parser('extend')
    e.add_argument('boards')
    e.add_argument('--who', **who)
    e.add_argument('--hours', type=float, default=1.0)
    r = sub.add_parser('release')
    r.add_argument('boards')
    r.add_argument('--who', **who)
    r.add_argument('--force', action='store_true', help="release someone else's (say so to them first)")
    c = sub.add_parser('check')
    c.add_argument('boards')
    c.add_argument('--who', **who)
    sub.add_parser('list')
    args = ap.parse_args()
    try:
        if args.cmd in (None, 'list'):
            rows = bookings.status()
            print(f'{bookings.PATH}\n')
            for row in rows:
                if row['state'] == 'free':
                    print(f"{row['board']:9} free")
                else:
                    print(f"{row['board']:9} {row['state']:7} {row['holder']}  {row['since']} -> {row['until']}  {row['what']}")
            return 0
        if not args.who:
            ap.error('--who is required (or $FRAMEOS_BENCH_WHO): your session name first')
        if args.cmd == 'book':
            if args.wait:
                done = bookings.wait_for(args.boards, args.who, args.what, args.hours, timeout=args.timeout * 3600)
                if not done:
                    print('the wait ran out; still booked:')
                    show_refused(bookings.holders(args.boards))
                    return 3
                refused = {}
            else:
                done, refused = bookings.book(args.boards, args.who, args.what, args.hours, partial=args.partial)
            if done:
                print('booked: ' + ', '.join(done))
            if refused:
                print('someone else has:' if done else 'nothing booked: someone else has')
                show_refused(refused)
                return 3
            return 0
        if args.cmd == 'extend':
            mine = bookings.holders(args.boards)
            names = [n for n in bookings.resolve(args.boards) if n in mine and bookings._same(mine[n]['holder'], args.who)]
            if not names:
                print('none of those is booked by you')
                return 3
            done, _ = bookings.book(names, args.who, mine[names[0]]['what'], args.hours)
            print('extended: ' + ', '.join(done))
            return 0
        if args.cmd == 'release':
            done, others = bookings.release(args.boards, args.who, force=args.force)
            print('released: ' + (', '.join(done) or 'nothing'))
            if others:
                print('not yours:')
                show_refused(others)
                return 3
            return 0
        if args.cmd == 'check':
            others = {n: h for n, h in bookings.holders(args.boards).items() if not bookings._same(h['holder'], args.who)}
            if others:
                show_refused(others)
                return 3
            return 0
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
