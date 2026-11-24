"""Who has which board on the bench: one file every agent reads before it
touches a board, and writes before it does (`~/.frameos-bench/BOOKINGS.md`).

Several Claude sessions share the boards on this machine's USB. Opening a
console reads lines another session waits for, a flash restarts the board
under it, a push replaces its scenes. So a board is booked first: by its
short name (`boards.json` `key`: sensecap, sticky, e1002, e1003, e1004,
pico), with who holds it, what for and until when. A booking past its
`until` has lapsed and the board is free again, so an agent that died does
not hold one forever; an agent that needs longer extends it.

The file is Markdown, for people and agents to read as it is; it is written
only through this module (`tools/frame-bench/boards.py`, and `bench.py run`,
which books what it benches), under an exclusive lock, so two agents booking
at once cannot both win. Nothing here touches a board.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

HOME = os.path.expanduser(os.environ.get('FRAMEOS_BENCH_HOME', '~/.frameos-bench'))
PATH = os.path.expanduser(os.environ.get('FRAMEOS_BENCH_BOOKINGS', os.path.join(HOME, 'BOOKINGS.md')))
BOARDS_JSON = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'boards.json')
STAMP = '%Y-%m-%d %H:%M'
# With its UTC offset: the machine's time zone changed under a morning's
# bookings once (CET to Buenos Aires, 2026-11-24), and every booking written
# before it read three hours longer. A stamp from before the offset is local
# time.
STAMP_ZONED = '%Y-%m-%d %H:%M %z'
KEEP_HISTORY = 40

HEADER = """# Bench board bookings

The boards on this machine's USB are shared by every Claude session. Before you
open a board's console, flash it, push to it or bench it, book it here; when
you are done, release it. Never use a board someone else holds (ask them:
`SendMessage` to the session named in `holder`). A booking past its `until` has
lapsed and the board is free. Book and release only with the helper, which
locks this file:

    tools/frame-bench/boards.py                     # who has what
    tools/frame-bench/boards.py book sticky,e1003 --who "<session> (<worktree or task>)" --for "<what>" --hours 2
    tools/frame-bench/boards.py extend sticky --who "<session> ..." --hours 1
    tools/frame-bench/boards.py release sticky,e1003 --who "<session> ..."

`bench.py run` books the boards it benches for the run, waits for the ones
someone else holds (or skips them with `--skip-booked`) and releases them at
the end. The rules: .claude/skills/frame-bench/SKILL.md "Booking a board".
"""


# ------------------------------------------------------------------ boards
def boards() -> dict[str, str]:
    """Short name -> module id, from boards.json."""
    with open(BOARDS_JSON) as fh:
        data = json.load(fh)
    return {b['key']: module for module, b in data.get('boards', {}).items() if b.get('key')}


def key_of(module: str) -> str | None:
    """A board's short name by its module id (what `usb_api status` says)."""
    for key, mod in boards().items():
        if mod == module:
            return key
    return None


def resolve(names: str | list[str]) -> list[str]:
    """`sticky,e1003`, `all`, or module ids, to short names; unknown names raise."""
    known = boards()
    out = []
    for name in (names.split(',') if isinstance(names, str) else names):
        name = name.strip().lower()
        if not name:
            continue
        if name == 'all':
            out += [k for k in known if k not in out]
            continue
        key = name if name in known else key_of(name)
        if not key:
            raise ValueError(f"unknown board {name!r}: one of {', '.join(known)} or all")
        if key not in out:
            out.append(key)
    return out


# ------------------------------------------------------------- the file
ROW = re.compile(r'^\|\s*(?P<board>[^|]+?)\s*\|\s*(?P<holder>[^|]*?)\s*\|\s*(?P<since>[^|]*?)\s*\|\s*'
                 r'(?P<until>[^|]*?)\s*\|\s*(?P<what>[^|]*?)\s*\|$')


def _parse(text: str) -> tuple[dict, list[str]]:
    held, history = {}, []
    section = None
    for line in text.splitlines():
        if line.startswith('## '):
            section = line[3:].strip().lower()
            continue
        if section == 'booked':
            m = ROW.match(line.strip())
            if m and m['board'] not in ('board', '---') and not set(m['board']) <= {'-'}:
                held[m['board']] = {k: m[k] for k in ('holder', 'since', 'until', 'what')}
        elif section == 'history' and line.startswith('- '):
            history.append(line)
    return held, history


def _cell(text: str) -> str:
    return ' '.join(str(text).replace('|', '/').split())


def _render(held: dict, history: list[str]) -> str:
    lines = [HEADER, '## Booked', '', '| board | holder | since | until | for |', '|---|---|---|---|---|']
    for board in sorted(held):
        b = held[board]
        lines.append(f"| {board} | {_cell(b['holder'])} | {b['since']} | {b['until']} | {_cell(b['what'])} |")
    lines += ['', '## History', '', *history[-KEEP_HISTORY:], '']
    return '\n'.join(lines)


@contextmanager
def _locked():
    """The file's contents under an exclusive lock, written back on exit."""
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    with open(PATH + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            text = open(PATH).read() if os.path.exists(PATH) else ''
            held, history = _parse(text)
            state = {'held': held, 'history': history}
            yield state
            out = _render(state['held'], state['history'])
            if out != text:
                tmp = PATH + '.tmp'
                with open(tmp, 'w') as fh:
                    fh.write(out)
                os.replace(tmp, PATH)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _now() -> datetime:
    return datetime.now().astimezone().replace(second=0, microsecond=0)


def _stamp(when: datetime) -> str:
    return when.strftime(STAMP_ZONED)


def _parse_stamp(stamp: str) -> datetime:
    try:
        return datetime.strptime(stamp, STAMP_ZONED)
    except ValueError:
        return datetime.strptime(stamp, STAMP).astimezone()


def _lapsed(booking: dict, now: datetime | None = None) -> bool:
    try:
        return _parse_stamp(booking['until']) <= (now or datetime.now().astimezone())
    except ValueError:
        return True


def _same(a: str, b: str) -> bool:
    """The same holder: the first word (the session's name) decides."""
    first = lambda s: (s or '').split()[0].lower() if (s or '').split() else ''
    return first(a) == first(b) and first(a) != ''


def _note(state, text):
    state['history'].append(f"- {_stamp(_now())} {text}")


def holders(names=None) -> dict:
    """The live bookings (lapsed ones left out), by board."""
    with _locked() as state:
        held = state['held']
        wanted = resolve(names) if names else list(held)
        return {b: held[b] for b in wanted if b in held and not _lapsed(held[b])}


def status() -> list[dict]:
    """Every board in boards.json, with its booking (live, lapsed or none)."""
    with _locked() as state:
        held = state['held']
    out = []
    for key in boards():
        b = held.get(key)
        out.append({'board': key, **(b or {}), 'state': 'free' if not b else 'lapsed' if _lapsed(b) else 'booked'})
    return out


def book(names, who: str, what: str, hours: float = 2.0, partial: bool = False) -> tuple[list[str], dict]:
    """Book `names` for `who`. Returns (booked, refused): `refused` is the
    boards someone else holds, with their booking. All or nothing unless
    `partial`, which books the free ones. Booking a board you hold already
    moves its `until` and `for`."""
    if not who or not who.strip():
        raise ValueError('--who: your session name and what you are, e.g. "frameos-16 (desktop-consistency)"')
    wanted = resolve(names)
    now = _now()
    until = _stamp(now + timedelta(hours=hours))
    with _locked() as state:
        held = state['held']
        refused = {b: held[b] for b in wanted if b in held and not _lapsed(held[b], now) and not _same(held[b]['holder'], who)}
        if refused and not partial:
            return [], refused
        done = []
        for b in wanted:
            if b in refused:
                continue
            old = held.get(b)
            if old and _lapsed(old, now) and not _same(old['holder'], who):
                _note(state, f"{b}: {old['holder']}'s booking lapsed at {old['until']} ({old['what']})")
            since = old['since'] if old and _same(old['holder'], who) and not _lapsed(old, now) else _stamp(now)
            # The same holder naming itself shorter (`extend --who frameos-16`) keeps its fuller name.
            name = old['holder'] if old and _same(old['holder'], who) and len(who.split()) < 2 else who
            held[b] = {'holder': name, 'since': since, 'until': until, 'what': what or ''}
            done.append(b)
        if done:
            _note(state, f"{','.join(done)}: booked by {who} until {until} ({what})")
        return done, refused


def release(names, who: str, force: bool = False) -> tuple[list[str], dict]:
    """Release what `who` holds among `names` (`force`: whoever holds it).
    Returns (released, held by someone else)."""
    wanted = resolve(names)
    with _locked() as state:
        held = state['held']
        done, others = [], {}
        for b in wanted:
            if b not in held:
                continue
            if _same(held[b]['holder'], who) or force or _lapsed(held[b]):
                del held[b]
                done.append(b)
            else:
                others[b] = held[b]
        if done:
            _note(state, f"{','.join(done)}: released by {who}" + (' (forced)' if force else ''))
        return done, others


def wait_for(names, who: str, what: str, hours: float = 2.0, timeout: float = 6 * 3600, poll: float = 60.0,
             say=print) -> list[str]:
    """Book `names` for `who`, waiting while someone else holds any of them.
    Returns the boards booked, [] if the wait ran out."""
    end = time.time() + timeout
    told = set()
    while True:
        done, refused = book(names, who, what, hours)
        if done:
            return done
        for b, h in refused.items():
            if (b, h['holder']) not in told:
                say(f"{b} is booked by {h['holder']} until {h['until']} ({h['what']}): waiting")
                told.add((b, h['holder']))
        if time.time() + poll > end:
            return []
        time.sleep(poll)
