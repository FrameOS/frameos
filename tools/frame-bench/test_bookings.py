"""The board bookings (framebench/bookings.py): `pytest tools/frame-bench/test_bookings.py`."""
import importlib
import os
import re
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


@pytest.fixture
def bk(tmp_path, monkeypatch):
    monkeypatch.setenv('FRAMEOS_BENCH_BOOKINGS', str(tmp_path / 'BOOKINGS.md'))
    sys.path.insert(0, HERE)
    from framebench import bookings
    return importlib.reload(bookings)


def test_all_or_nothing_partial_and_release(bk):
    assert bk.book('e1003', 'frameos-3e (fixes)', 'json speed')[0] == ['e1003']
    done, refused = bk.book('sticky,e1003', 'frameos-16 (desktop)', 'desktop suite')
    assert done == [] and list(refused) == ['e1003']
    done, refused = bk.book('sticky,e1003', 'frameos-16 (desktop)', 'desktop suite', partial=True)
    assert done == ['sticky'] and list(refused) == ['e1003']
    # Someone else's is not released without --force; your own is.
    assert bk.release('e1003', 'frameos-16') == ([], {'e1003': bk.holders()['e1003']})
    assert bk.release('sticky', 'frameos-16')[0] == ['sticky']
    assert set(bk.holders()) == {'e1003'}


def test_the_same_holder_extends_and_keeps_its_fuller_name(bk):
    bk.book('pico', 'frameos-16 (desktop, PR #920)', 'thin suite', hours=1)
    bk.book('pico', 'frameos-16', 'thin suite', hours=3)
    held = bk.holders()['pico']
    assert held['holder'] == 'frameos-16 (desktop, PR #920)'


def test_a_lapsed_booking_frees_the_board(bk):
    bk.book('sensecap', 'frameos-cf (ui-perf)', 'test images')
    text = open(bk.PATH).read()
    open(bk.PATH, 'w').write(re.sub(r'(\| sensecap \|[^|]*\|[^|]*\| )\S+ \S+', r'\g<1>2026-01-01 00:00', text))
    assert bk.holders() == {}
    assert bk.book('sensecap', 'frameos-16', 'desktop')[0] == ['sensecap']
    assert 'lapsed' in open(bk.PATH).read()


def test_a_booking_ends_when_it_said_whatever_the_time_zone(bk, monkeypatch):
    # The machine went from CET to Buenos Aires under a morning's bookings
    # (2026-11-24): a booking stamped in local time read three hours longer.
    import time
    from datetime import datetime, timedelta, timezone
    monkeypatch.setenv('TZ', 'CET-1')  # POSIX: no tzdata needed
    time.tzset()
    try:
        bk.book('cloudw', 'frameos-video (video PR)', 'playback', hours=2)
        held = bk.holders()['cloudw']
        until = bk._until(held)
        # A reader from before the zones still reads `until` (and an
        # unreadable one would be lapsed to it: the board free).
        datetime.strptime(held['until'], bk.STAMP)
        monkeypatch.setenv('TZ', '<-03>3')
        time.tzset()
        held = bk.holders()['cloudw']
        assert bk._until(held) == until
        assert not bk._lapsed(held, until - timedelta(minutes=1))
        assert bk._lapsed(held, until)
        assert abs((until - datetime.now(timezone.utc)).total_seconds() - 7200) < 120
        # Extended in the new zone: `until` and `since` move to it together.
        bk.book('cloudw', 'frameos-video', 'playback', hours=1)
        held = bk.holders()['cloudw']
        assert abs((bk._until(held) - datetime.now(timezone.utc)).total_seconds() - 3600) < 120
        assert held['since'].endswith('-0300')
        # A booking from before the zones reads as local time, as it did.
        assert bk._until({'since': '2026-11-24 09:18', 'until': '2026-11-24 12:18'}).utcoffset() == timedelta(hours=-3)
    finally:
        monkeypatch.delenv('TZ')
        time.tzset()


def test_names(bk):
    assert bk.resolve('all') == list(bk.boards())
    assert bk.resolve('seeed_reterminal_sticky') == ['sticky']
    with pytest.raises(ValueError):
        bk.resolve('nosuch')
    with pytest.raises(ValueError):
        bk.book('sticky', ' ', 'x')


def test_only_one_of_many_at_once_wins(tmp_path):
    env = dict(os.environ, FRAMEOS_BENCH_BOOKINGS=str(tmp_path / 'BOOKINGS.md'))
    procs = [subprocess.Popen([sys.executable, os.path.join(HERE, 'boards.py'), 'book', 'e1004', '--who', f'agent{i}',
                               '--for', 'race'], env=env, stdout=subprocess.DEVNULL) for i in range(8)]
    codes = [p.wait() for p in procs]
    assert sorted(codes) == [0] + [3] * 7
