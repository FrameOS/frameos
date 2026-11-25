"""framebench/video.py: the `video` suite's reading of a Linux frame's
`video:playback` lines and its verdicts. Run: python3
tools/frame-bench/test_video.py (or pytest)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framebench import video  # noqa: E402
from framebench.linux import LinuxConsole  # noqa: E402


def line(**kw):
    ev = {'event': 'log:app:video:playback', 'src': 'bench-1080p.mp4', 'decoder': 'h264_v4l2m2m+plane',
          'plane': True, 'seconds': 30.0, 'frames': 900, 'fps': 30.0, 'rate': 30, 'late': 0, 'worstLateMs': 21,
          'dropped': 0}
    ev.update(kw)
    return ev


def kinds(issues):
    return sorted(i['kind'] for i in issues)


def test_the_lines_are_read_off_the_journal_as_the_console_hands_them():
    con = LinuxConsole.offline()
    t = time.time() + 5
    for i, ev in enumerate([line(), {'event': 'log:app:video:fallback', 'src': 'bench-720p.mp4',
                                     'from': 'h264_v4l2m2m', 'to': 'software', 'reason': 'busy'},
                            {'event': 'render:sleep', 'ms': 1000}]):
        con._line(f'({t + i}, {json.dumps(ev, separators=(",", ":"))})')
    played, fell = video.playback_lines([x for _, x in con.drain()])
    assert [p['src'] for p in played] == ['bench-1080p.mp4']
    assert [f['src'] for f in fell] == ['bench-720p.mp4']


def test_a_clip_that_keeps_time_has_no_issue_and_its_start_is_not_judged():
    # Its first line (the start: a late frame while the decoder warmed up) is
    # reported; the rest decide.
    res, issues = video.judge('1080p', 30, [line(late=3, worstLateMs=140, seconds=29.5, frames=860), line(),
                                            line(seconds=6.0, frames=180)], [])
    assert issues == []
    assert res['frames'] == 1080 and res['late'] == 0 and res['fps'] == 30.0 and res['judged_lines'] == 2
    assert res['decoder'] == 'h264_v4l2m2m+plane' and res['plane'] is True


def test_late_or_dropped_frames_are_a_stutter():
    _, issues = video.judge('portrait', 30, [line(), line(late=4, worstLateMs=69)], [])
    assert kinds(issues) == ['video_stutter']
    assert 'worst 69 ms' in issues[0]['detail'] and 'on a plane' in issues[0]['detail']
    _, issues = video.judge('720p', 30, [line(), line(dropped=2, plane=False, decoder='h264_v4l2m2m+isp')], [])
    assert kinds(issues) == ['video_stutter'] and 'in the canvas' in issues[0]['detail']


def test_a_clip_under_its_rate_is_not_real_time():
    _, issues = video.judge('360p', 24, [line(), line(frames=630, seconds=30.0)], [])
    assert kinds(issues) == ['video_not_realtime']
    assert '21.0 of 24 frames a second' in issues[0]['detail']


def test_one_line_is_judged_when_there_is_no_other():
    _, issues = video.judge('1080p', 30, [line(late=1)], [])
    assert kinds(issues) == ['video_stutter']


def test_a_fallback_or_nothing_shown_fails():
    fell = [{'src': 'bench-720p.mp4', 'from': 'h264_v4l2m2m', 'to': 'software', 'reason': 'VIDIOC_REQBUFS failed'}]
    _, issues = video.judge('720p', 30, [line(), line()], fell)
    assert kinds(issues) == ['video_fallback']
    _, issues = video.judge('720p', 30, [], [])
    assert kinds(issues) == ['video_none']


def test_the_scene_plays_its_file_field():
    scene = video.video_scene()
    assert scene['id'] == video.SCENE_ID
    assert [f['name'] for f in scene['fields']] == ['file'] and scene['fields'][0]['access'] == 'public'
    # The clips are in the frame's assets folder: an app without `assets`
    # sees only its scene's own subtree there.
    assert json.loads(scene['apps']['benchVideo']['sources']['config.json'])['permissions'] == ['assets']
    source = scene['apps']['benchVideo']['sources']['app.tsx']
    assert "frameos.video('bench'" in source and 'releaseVideo' in source and 'app.state.file' in source
    json.dumps(scene)


def test_the_turned_clip_is_a_phone_held_upright():
    # ffprobe says -90 (counterclockwise), as an iPhone's does: the runtime
    # turns it a quarter clockwise (args.nim parseProbe).
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        print('skipped: no ffmpeg')
        return
    home = video.VIDEO_HOME
    with tempfile.TemporaryDirectory() as tmp:
        video.VIDEO_HOME = tmp
        try:
            [path] = video.make_clips([('portrait', 64, 36, 10, -90, '100k')])
        finally:
            video.VIDEO_HOME = home
        probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                           'stream=width,height:stream_side_data=rotation', '-of', 'json', path],
                                          capture_output=True, check=True).stdout)
        stream = probe['streams'][0]
        assert (stream['width'], stream['height']) == (64, 36)
        assert [s.get('rotation') for s in stream.get('side_data_list', [])] == [-90]


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('ok', name)
