"""The `video` suite: a Linux frame plays video without a stutter.

Four clips, made on this machine with ffmpeg once (~/.frameos-bench/videos)
and copied to the frame's assets (`frame-bench/videos/`, only when they
differ), each played on a loop by a bench scene of its own
(benchmarks/video/app.tsx) for PLAY_SECONDS, then let go. The runtime says
how a video's frames went in a `video:playback` log line
(frameos/src/frameos/js_runtime/js_video.nim): every 30 s while it plays and
once more when it stops. A frame shown more than 1.5 frame times after it was
due is late, a stutter; one decoded and never shown is dropped. The first
line of a clip covers its start and is reported, not judged.

A stutter or a frame rate under REALTIME of the clip's is `slow`; a clip
that showed nothing, or a hardware decoder that gave way (`video:fallback`),
is `fail`. The clips' decoders and paths are the frame's (docs/video.md
"Which way a video plays"): on a Pi Zero W with the 2026.11.15 kernel the
VideoCore decodes them onto a display plane, the turned one through its ISP.
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import time

from .linux import HOME, SSH_OPTS, ssh

VIDEO_HOME = os.path.join(HOME, 'videos')
SOURCES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'benchmarks', 'video')
SCENE_ID = 'frame-bench-video-w1'
FOLDER = 'frame-bench/videos'
CLIP_SECONDS = 20     # a clip's length (it loops)
PLAY_SECONDS = 65     # on the screen each: a line at ~30 s (its start in it), one at ~60 s, its last at the end
REALTIME = 0.95       # frames a second at least this share of the clip's own
UPLOAD_BYTES_PER_S = 300_000  # paced: a Pi 5 on a weak supply browned out under a fast copy (2026-11-24)
CLIPS = [
    # name, width, height, frames a second, display rotation (ffmpeg's: counterclockwise), bitrate
    ('360p', 640, 360, 24, 0, '600k'),
    ('720p', 1280, 720, 30, 0, '1500k'),
    ('1080p', 1920, 1080, 30, 0, '2500k'),
    # A phone held upright: stored on its side, turned to be shown
    # (docs/video.md "Turned videos").
    ('portrait', 1280, 720, 30, -90, '1500k'),
]


def clip_path(name: str) -> str:
    return os.path.join(VIDEO_HOME, f'bench-{name}.mp4')


def make_clips(clips=CLIPS) -> list[str]:
    """The clips on this machine, made once: ffmpeg's moving test pattern,
    H.264 High at a steady rate, a keyframe every two seconds."""
    os.makedirs(VIDEO_HOME, exist_ok=True)
    out = []
    for name, w, h, rate, turn, bitrate in clips:
        path = clip_path(name)
        if not os.path.exists(path):
            flat = path + '.flat.mp4' if turn else path
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc2=size={w}x{h}:rate={rate}',
                            '-t', str(CLIP_SECONDS), '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                            '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate, '-g', str(rate * 2), '-an',
                            flat], check=True)
            if turn:
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-display_rotation', str(turn), '-i', flat,
                                '-c', 'copy', path], check=True)
                os.remove(flat)
        out.append(path)
    return out


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def copy_clips(target: str, assets: str, paths: list[str]) -> tuple[list[str], str | None]:
    """The clips into `assets`/FOLDER on the frame, each only when it is not
    there already, paced. Returns (what was copied, why nothing could be)."""
    remote_dir = f'{assets.rstrip("/")}/{FOLDER}'
    names = ' '.join(shlex.quote(os.path.basename(p)) for p in paths)
    res = ssh(target, f'mkdir -p {shlex.quote(remote_dir)} && cd {shlex.quote(remote_dir)} && '
                      f'(sha256sum {names} 2>/dev/null; true) && df -k . | tail -1', 60)
    lines = (res.stdout or b'').decode(errors='replace').splitlines()
    there = {}
    for line in lines[:-1]:
        parts = line.split()
        if len(parts) == 2:
            there[parts[1]] = parts[0]
    try:
        free = int(lines[-1].split()[3]) * 1024
    except (IndexError, ValueError):
        free = 0
    todo = [p for p in paths if there.get(os.path.basename(p)) != _sha256(p)]
    need = sum(os.path.getsize(p) for p in todo)
    if need and free < 3 * need:
        return [], f'{free // 1_000_000} MB free in {assets}, {need // 1_000_000} MB of clips to copy'
    for p in todo:
        remote = f'{remote_dir}/{os.path.basename(p)}'
        proc = subprocess.Popen(['ssh', *SSH_OPTS, target,
                                 f'cat > {shlex.quote(remote)}.part && mv {shlex.quote(remote)}.part {shlex.quote(remote)}'],
                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(p, 'rb') as fh:
            for block in iter(lambda: fh.read(65536), b''):
                proc.stdin.write(block)
                time.sleep(len(block) / UPLOAD_BYTES_PER_S)
        proc.stdin.close()
        proc.wait(120)
    return [os.path.basename(p) for p in todo], None


def video_scene() -> dict:
    from .benchmarks import _edge, _node
    with open(os.path.join(SOURCES, 'app.tsx')) as fh:
        source = fh.read()
    # `assets`: the frame's assets folder, where the clips are (an app that
    # asks for none sees only its scene's own subtree).
    config = {'name': 'Bench: video', 'category': 'data', 'description': 'Frame bench: a video on a loop',
              'version': '1.0.0', 'fields': [], 'output': [{'name': 'image', 'type': 'image'}],
              'permissions': ['assets']}
    return {
        'id': SCENE_ID, 'name': 'Bench: video',
        'settings': {'execution': 'interpreted', 'refreshInterval': 3600, 'backgroundColor': '#000000',
                     'category': 'Demos & examples', 'needs': ['fast', 'video']},
        'fields': [{'name': 'file', 'label': 'File', 'type': 'string', 'value': '', 'access': 'public',
                    'persist': 'memory'}],
        'nodes': [_node('render', 'event', {'keyword': 'render'}),
                  _node('app', 'app', {'keyword': 'benchVideo', 'config': {}}),
                  _node('image', 'app', {'keyword': 'render/image', 'config': {'placement': 'stretch'}})],
        'edges': [_edge('e1', 'render', 'next', 'image', 'prev', 'appNodeEdge'),
                  _edge('e2', 'app', 'fieldOutput', 'image', 'fieldInput/image', 'codeNodeEdge')],
        'apps': {'benchVideo': {**config, 'origin': 'benchVideo',
                                'sources': {'config.json': json.dumps(config, indent=2), 'app.tsx': source}}},
    }


def _event(text: str) -> dict | None:
    """A runtime log line's JSON, if it is one."""
    try:
        ev = json.loads(text)
    except ValueError:
        return None
    return ev if isinstance(ev, dict) else None


def playback_lines(lines: list[str]) -> tuple[list[dict], list[dict]]:
    """The `video:playback` and `video:fallback` lines among a run's (an
    app's log names them `log:<node>:video:...`)."""
    played, fell = [], []
    for text in lines:
        ev = _event(text)
        if not ev:
            continue
        name = str(ev.get('event') or '')
        if name == 'video:playback' or name.endswith(':video:playback'):
            played.append(ev)
        elif name == 'video:fallback' or name.endswith(':video:fallback'):
            fell.append(ev)
    return played, fell


def judge(name: str, rate: float, played: list[dict], fell: list[dict]) -> tuple[dict, list[dict]]:
    """One clip's numbers and issues from its lines (`played`, oldest first)."""
    from .suites import issue
    res = {'lines': played, 'fallbacks': fell}
    issues = [issue('fail', 'video_fallback', name, f"{f.get('from')} -> {f.get('to')}: {f.get('reason')}")
              for f in fell]
    if not played:
        issues.append(issue('fail', 'video_none', name, 'no video:playback line: nothing shown'))
        return res, issues
    # The first line has the clip's start in it: reported, not judged, when
    # there is more.
    steady = played[1:] if len(played) > 1 else played
    seconds = sum(float(p.get('seconds') or 0) for p in steady)
    frames = sum(int(p.get('frames') or 0) for p in steady)
    late = sum(int(p.get('late') or 0) for p in steady)
    dropped = sum(int(p.get('dropped') or 0) for p in steady)
    worst = max(int(p.get('worstLateMs') or 0) for p in steady)
    last = played[-1]
    fps = frames / seconds if seconds > 0 else 0.0
    res.update({'decoder': last.get('decoder'), 'plane': bool(last.get('plane')), 'seconds': round(seconds, 1),
                'frames': frames, 'fps': round(fps, 1), 'rate': rate, 'late': late, 'dropped': dropped,
                'worst_late_ms': worst, 'judged_lines': len(steady)})
    path = f"{last.get('decoder')}{' on a plane' if last.get('plane') else ' in the canvas'}"
    if late or dropped:
        issues.append(issue('slow', 'video_stutter', name,
                            f'{late} late and {dropped} dropped of {frames} frames in {seconds:.0f} s '
                            f'(worst {worst} ms late), {path}'))
    if rate > 0 and fps < REALTIME * rate:
        issues.append(issue('slow', 'video_not_realtime', name, f'{fps:.1f} of {rate:g} frames a second, {path}'))
    return res, issues


def suite_video(ctx, frame):
    """Each clip played for PLAY_SECONDS in the bench's video scene, judged
    by the runtime's own `video:playback` lines. Linux frames only."""
    from .suites import incidents_since, issue
    if not frame.get('linux'):
        return {'skipped': 'video plays on Linux frames only (docs/video.md)', 'issues': []}
    con = ctx.console(frame)
    target = con.target
    res = ssh(target, 'command -v ffmpeg >/dev/null && echo yes || echo no', 30)
    if b'yes' not in (res.stdout or b''):
        return {'skipped': 'no ffmpeg on the frame', 'issues': []}
    t_suite = time.time()
    issues, results = [], {}
    try:
        paths = make_clips()
    except (OSError, subprocess.CalledProcessError) as exc:
        return {'skipped': f'could not make the clips here (ffmpeg with libx264): {exc!r}', 'issues': []}
    assets = con.config().get('assetsPath') or '/srv/assets'
    copied, why = copy_clips(target, assets, paths)
    if why:
        return {'skipped': why, 'issues': [issue('note', 'video_space', 'clips', why)]}
    before = con.current_scene_id()
    scene = video_scene()
    payload = json.dumps(scene, separators=(',', ':')).encode()
    ok, line = con.put_bytes(f'scene-put {len(payload)}', payload, 180)
    if not ok:
        return {'issues': [issue('fail', 'video_put', 'scene', (line or '')[:200])], 'copied': copied}
    try:
        lines: list[str] = []
        for (name, _w, _h, _rate, _turn, _b), path in zip(CLIPS, paths):
            src = f'{FOLDER}/{os.path.basename(path)}'
            con.drain()
            con.send('event setCurrentScene ' + json.dumps({'sceneId': SCENE_ID, 'state': {'file': src}},
                                                           separators=(',', ':')))
            got = con.idle(PLAY_SECONDS)
            lines += [x for _, x in got]
            # The clip's last line comes as the next one (or nothing) takes its place.
            results[name] = {'src': src}
        con.drain()
        con.send('event setCurrentScene ' + json.dumps({'sceneId': SCENE_ID, 'state': {'file': ''}},
                                                       separators=(',', ':')))
        lines += [x for _, x in con.idle(8)]
        played, fell = playback_lines(lines)
        for name, _w, _h, rate, _turn, _b in CLIPS:
            base = f'bench-{name}.mp4'
            mine = [p for p in played if p.get('src') == base]
            gave = [f for f in fell if f.get('src') == base]
            numbers, found = judge(name, rate, mine, gave)
            results[name].update(numbers)
            issues += found
    finally:
        if before and before != SCENE_ID:
            con.send(f'scene {before}')
            con.idle(3)
        con.usb_api(f'scene-delete {SCENE_ID}')
    issues += incidents_since(con, t_suite, 'video')
    return {'video': results, 'copied': copied, 'issues': issues}
