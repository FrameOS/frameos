"""framebench/linux.py: a Linux frame's journal, said the way the firmware says
it, so the suites read one shape. Run: python3 tools/frame-bench/test_linux.py
(or pytest)."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framebench.linux import LinuxConsole, module_of  # noqa: E402
from framebench.parse import summarize  # noqa: E402


def lines_of(con):
    return [x for _, x in con.drain()]


def journal(con, t, event):
    con._line(f'({t}, {json.dumps(event, separators=(",", ":"))})')


def test_a_render_is_the_firmware_shape():
    con = LinuxConsole.offline()
    con.in_place = True
    con.names['jsx-calculator'] = 'JSX: Calculator'
    t = time.time() + 5  # the frame's clock: never later than arrival
    journal(con, t, {'event': 'render:scene', 'width': 720, 'height': 720, 'sceneId': 'jsx-calculator'})
    journal(con, t + 0.11, {'event': 'render:done', 'sceneId': 'jsx-calculator', 'ms': 110.5})
    journal(con, t + 0.12, {'event': 'render:driver', 'device': 'pimoroni.hyperpixel4sq_touch', 'ms': 11.4})
    out = lines_of(con)
    assert out[0] == 'render #1 started: scene "JSX: Calculator" (jsx-calculator)'
    assert out[1] == 'render #1 (interpreted scene "JSX: Calculator", fmt=0): render 110 ms, in place, collect 11 ms'
    assert out[2] == 'render #1 done in 121 ms'
    done = json.loads(out[3])
    assert done == {'event': 'render:done', 'sceneId': 'jsx-calculator', 'sceneName': 'JSX: Calculator', 'status': 'ok', 'ms': 121}
    w = summarize([(0, x) for x in out])
    assert w['renders'][0]['ms'] == 110 and w['renders'][0]['in_place'] and w['done'][0]['ms'] == 121


def test_a_failed_render_fails_and_is_not_done():
    con = LinuxConsole.offline()
    t = time.time()
    journal(con, t, {'event': 'render:scene', 'sceneId': 's'})
    journal(con, t, {'event': 'render:error', 'error': 'boom'})
    journal(con, t, {'event': 'render:done', 'sceneId': 's', 'ms': 5})
    journal(con, t, {'event': 'render:driver', 'ms': 3})
    out = lines_of(con)
    assert 'render #1 failed at render: boom' in out
    assert not any(' done in ' in x for x in out)


def test_two_fast_frames_are_an_animation_summary():
    con = LinuxConsole.offline()
    con.intervals['anim'] = 0.033
    t = time.time() - 10
    # The scene's first frame and the next are no period (the switch's pass
    # writes the snapshot between them): the second and third are.
    for i, at in enumerate((t - 1, t, t + 0.05)):
        journal(con, at, {'event': 'render:scene', 'sceneId': 'anim'})
        journal(con, at + 0.03, {'event': 'render:done', 'sceneId': 'anim', 'ms': 25})
        journal(con, at + 0.04, {'event': 'render:driver', 'ms': 10})
    w = summarize(con.drain())
    assert len(w['animation']) == 1
    a = w['animation'][0]
    assert a['status'] == 'running' and a['fps'] == 20.0 and a['periodMs'] == 33 and a['avgMs'] == 35


def test_a_scene_that_asks_for_a_longer_sleep_is_judged_by_it():
    # The Kitchen sink runs at 0.05 s and asks for one render a second
    # (frameos.setNextSleep) outside its Motion page: its frames a second apart
    # are what it asked for, not "1 fps against a 20 fps target" (2026-11-25).
    con = LinuxConsole.offline()
    con.intervals['sink'] = 0.05
    t = time.time() - 10
    for at in (t - 2, t, t + 1.0):
        journal(con, at, {'event': 'render:scene', 'sceneId': 'sink'})
        journal(con, at + 0.005, {'event': 'render:done', 'sceneId': 'sink', 'ms': 5})
        journal(con, at + 0.007, {'event': 'render:driver', 'ms': 2})
        journal(con, at + 0.008, {'event': 'render:sleep', 'ms': 991.0})
    a = summarize(con.drain())['animation'][0]
    assert a['fps'] == 1.0 and a['periodMs'] == 998


def test_an_animation_keeps_its_interval_as_the_target():
    con = LinuxConsole.offline()
    con.intervals['dvd'] = 0.05
    t = time.time() - 10
    for at in (t - 1, t, t + 0.05):
        journal(con, at, {'event': 'render:scene', 'sceneId': 'dvd'})
        journal(con, at + 0.005, {'event': 'render:done', 'sceneId': 'dvd', 'ms': 5})
        journal(con, at + 0.007, {'event': 'render:driver', 'ms': 2})
        journal(con, at + 0.008, {'event': 'render:sleep', 'ms': 43.0})
    a = summarize(con.drain())['animation'][0]
    assert a['periodMs'] == 50


def test_a_slow_scene_is_no_animation():
    con = LinuxConsole.offline()
    con.intervals['clock'] = 60
    t = time.time() - 10
    for at in (t, t + 0.5):
        journal(con, at, {'event': 'render:scene', 'sceneId': 'clock'})
        journal(con, at + 0.1, {'event': 'render:driver', 'ms': 10})
    assert summarize(con.drain())['animation'] == []


def test_lines_carry_the_frames_time():
    con = LinuxConsole.offline()
    con.offset = 0.5  # the frame's clock is half a second ahead
    t_dev = time.time() - 2
    journal(con, t_dev, {'event': 'bootup', 'version': '2026.11.14'})
    (t, line), loaded = con.drain()[0], None
    assert abs(t - (t_dev - 0.5)) < 1e-6 and '"bootup"' in line


def test_bootup_says_the_scenes_were_loaded():
    con = LinuxConsole.offline()
    journal(con, time.time(), {'event': 'bootup', 'version': '2026.11.14'})
    out = lines_of(con)
    assert any('"scenes:load"' in x and '"status":"ok"' in x for x in out)


def test_a_push_by_reload_says_the_scenes_were_loaded():
    con = LinuxConsole.offline()
    journal(con, time.time(), {'event': 'event:reload', 'origin': 'system', 'payload': {}})
    assert any('"scenes:load"' in x and '"via":"reload"' in x for x in lines_of(con))


def test_a_crash_is_a_boot_and_an_incident_a_push_is_neither():
    con = LinuxConsole.offline()
    con._line('frameos.service: Deactivated successfully.')
    assert con.boots == [] and con.incidents == []
    con._line('frameos.service: Main process exited, code=dumped, status=6/ABRT')
    con._line("frameos.service: Failed with result 'core-dump'.")
    assert len(con.boots) == 1
    assert [i.kind for i in con.incidents] == ['panic']
    con2 = LinuxConsole.offline()
    con2._line('frameos.service: Watchdog timeout (limit 15min)!')
    con2._line('frameos.service: A process of this unit has been killed by the OOM killer.')
    assert [i.kind for i in con2.incidents] == ['task_wdt', 'oom']


def test_a_switch_the_paused_log_hides_is_said_and_rendered_again():
    con = LinuxConsole.offline()
    sent = []
    con._event = lambda name, payload, failed=None: sent.append((name, payload))
    con.send('scene clock')
    assert sent[-1] == ('setCurrentScene', {'sceneId': 'clock'})
    t = time.time()
    # The pause is heard only now (the logger's lag): the switch is watched anyway.
    journal(con, t - 0.05, {'event': 'render:pause', 'message': 'Rendering fast. Pausing all scene render logs for 10 seconds.'})
    journal(con, t + 0.01, {'event': 'render:sceneChange', 'sceneId': 'clock'})
    journal(con, t + 0.02, {'event': 'render:sleep', 'ms': 60000})
    time.sleep(0.05)  # the follow-up render is posted from a thread
    out = lines_of(con)
    assert any('"bench:unlogged"' in x and '"sceneId":"clock"' in x for x in out)
    assert sent[-1] == ('render', {}) and not con.log_paused


def test_a_logged_switch_is_not_watched_further():
    con = LinuxConsole.offline()
    sent = []
    con._event = lambda name, payload, failed=None: sent.append((name, payload))
    con.send('scene clock')
    t = time.time()
    journal(con, t + 0.01, {'event': 'render:sceneChange', 'sceneId': 'clock'})
    journal(con, t + 0.02, {'event': 'render:scene', 'sceneId': 'clock'})
    journal(con, t + 0.03, {'event': 'render:done', 'sceneId': 'clock', 'ms': 9})
    journal(con, t + 0.04, {'event': 'render:driver', 'ms': 1})
    journal(con, t + 0.05, {'event': 'render:sleep', 'ms': 60000})
    out = lines_of(con)
    assert not any('bench:unlogged' in x for x in out) and sent == [('setCurrentScene', {'sceneId': 'clock'})]


def test_a_switch_into_a_ticking_scene_ends_at_its_loading_mark():
    # Rainbow clock ticks every second (nextSleep): the pause goes on past the
    # switch, and the first logged render is a tick seconds later.
    con = LinuxConsole.offline()
    con._event = lambda name, payload, failed=None: None
    con.send('scene clock')
    t = time.time()
    journal(con, t + 0.01, {'event': 'render:sceneChange', 'sceneId': 'clock'})
    journal(con, t + 0.01, {'event': 'event:open', 'sceneId': 'clock'})
    journal(con, t + 1.5, {'event': 'render:loadingMark', 'sceneId': 'clock', 'ms': 1532})
    out = lines_of(con)
    i = next(i for i, x in enumerate(out) if '"bench:unlogged"' in x)
    assert out[i + 2].startswith('render #1 started: scene') and out[i + 3] == 'render #1 done in 1532 ms'


def test_a_tick_seconds_after_the_switch_is_not_its_render():
    con = LinuxConsole.offline()
    con._event = lambda name, payload, failed=None: None
    con.send('scene clock')
    t = time.time() - 10  # the frame's lines are in the past when they arrive
    con._switch_watch['t'] = t
    journal(con, t + 0.01, {'event': 'event:open', 'sceneId': 'clock'})
    journal(con, t + 6.0, {'event': 'render:scene', 'sceneId': 'clock'})
    out = lines_of(con)
    i = next(i for i, x in enumerate(out) if '"bench:unlogged"' in x)
    assert out[i + 1].startswith('render #1 started: scene')


def test_scene_to_the_scene_showing_renders_it_again():
    con = LinuxConsole.offline()
    sent = []
    con._event = lambda name, payload, failed=None: sent.append((name, payload))
    con.current_scene = 'clock'
    con.send('scene clock')
    assert sent == [('setCurrentScene', {'sceneId': 'clock'}), ('render', {})]
    con.send('scene other')
    assert sent[-1] == ('setCurrentScene', {'sceneId': 'other'})
    con.current_scene = 'other'
    con.send('event setCurrentScene {"sceneId":"other"}')
    assert sent[-2:] == [('setCurrentScene', {'sceneId': 'other'}), ('render', {})]
    con.send('event setCurrentScene {"sceneId":"other","state":{"a":1}}')
    assert sent[-1] == ('setCurrentScene', {'sceneId': 'other', 'state': {'a': 1}})


def test_the_scene_showing_drawn_again_while_paused_is_untimed():
    # cloud-w's desktop suite, 2026-11-24: the first window was the scene the
    # push opened, rendered fast twice (the pause); bringing it forward drew it
    # again unlogged, and the next logged render, 9.4 s on, read as its wait.
    con = LinuxConsole.offline()
    sent = []
    con._event = lambda name, payload, failed=None: sent.append((name, payload))
    con.names['photo'] = 'Cuteness Overload'
    con.current_scene = 'photo'
    t = time.time()
    journal(con, t - 0.5, {'event': 'render:pause', 'message': 'Rendering fast. Pausing all scene render logs for 10 seconds.'})
    con.drain()
    con.send('event setCurrentScene {"sceneId":"photo"}')
    assert sent == [('setCurrentScene', {'sceneId': 'photo'}), ('render', {})]
    out = lines_of(con)
    i = next(i for i, x in enumerate(out) if '"bench:unlogged"' in x)
    assert '"sceneId":"photo"' in out[i]
    assert out[i + 1] == 'render #1 started: scene "Cuteness Overload" (photo)' and out[i + 2] == 'render #1 done in 0 ms'
    assert json.loads(out[i + 3])['via'] == 'paused'
    # Logged again (a render line heard), or the pause run out: timed as before.
    journal(con, time.time(), {'event': 'render:sleep', 'ms': 0.1})
    con.drain()
    con.send('scene photo')
    assert not any('bench:unlogged' in x for x in lines_of(con))
    journal(con, time.time(), {'event': 'render:pause', 'message': 'Rendering fast. Pausing all scene render logs for 10 seconds.'})
    con._paused_at -= 10.5
    con.drain()
    con.send('scene photo')
    assert not any('bench:unlogged' in x for x in lines_of(con))


def test_a_line_from_before_the_drain_stays_out_of_the_queue():
    con = LinuxConsole.offline()
    t = time.time()
    con.drain()
    journal(con, t - 0.3, {'event': 'http', 'post': '/event/pointerDown'})  # written before, arrived after
    journal(con, t + 0.01, {'event': 'http', 'post': '/event/render'})
    assert lines_of(con) == ['{"event":"http","post":"/event/render"}']
    assert any('pointerDown' in x for _, x in con.history)


def test_a_runtime_settling_is_no_leak():
    from framebench.suites import rss_trend_issues
    mb = 1 << 20
    # cloud-w's soak on 2026.11.14 and an x86 runtime's first rounds: rising,
    # slower each round.
    settling = rss_trend_issues([int(v * mb) for v in (68, 73, 78, 80, 80.5)])
    assert [i['kind'] for i in settling] == ['rss_settling'] and settling[0]['severity'] == 'note'
    # The same pace every round: a leak.
    leak = rss_trend_issues([int(v * mb) for v in (61.8, 62.6, 63.3, 64.1, 64.9)])
    assert [(i['severity'], i['kind']) for i in leak] == [('fail', 'leak')]
    # Flat, or a round that fell: nothing.
    assert rss_trend_issues([int(v * mb) for v in (80, 81, 81, 81)]) == []
    assert rss_trend_issues([int(v * mb) for v in (60, 64)]) == []


def test_module_names():
    assert module_of('Raspberry Pi Zero W Rev 1.1') == 'raspberry_pi_zero_w'
    assert module_of('Raspberry Pi 5 Model B Rev 1.0\x00') == 'raspberry_pi_5'
    assert module_of('Raspberry Pi 4 Model B Rev 1.4') == 'raspberry_pi_4'
    assert module_of('Raspberry Pi 3 Model B Plus Rev 1.3') == 'raspberry_pi_3'


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print('ok', name)
