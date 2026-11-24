"""A Linux frame (a Raspberry Pi) on the bench, over SSH: its "console".

The ESP32s and the Pico are benched over their USB console (console.py). A Pi
has none, so this is one made of what it has, with the same calls, so every
suite runs on it unchanged:

- its journal, followed over SSH (`journalctl -u frameos -f -o cat`): the
  runtime's JSON lines and systemd's lines about the service (a core dump, a
  watchdog, the OOM killer), read as the console's lines;
- its HTTP API for what the console is told (`scene <id>` is
  `POST /event/setCurrentScene`, `render`, `event <name> {...}`), with the
  backend's `serverApiKey` bearer: every event speaks as `http:admin`, the
  backend, as the firmware console's speak as `system`;
- SSH for the rest: `restart` is `systemctl restart frameos`, the status is
  frame.json, /proc and the scene files, and a benchmark scene goes on with
  `uploadScenes` beside the frame's own (their files are put back after).

A render is said the way the firmware says it, so the suites and
`parse.summarize` read one shape:

    render #N started: scene "<name>" (<id>)                  <- render:scene
    render #N (interpreted scene "<name>", fmt=0): render R ms, in place, collect D ms
    render #N done in R+D ms
    {"event":"render:done","sceneId":...,"status":"ok","ms":R+D}

R is the runtime's own `render:done` (the scene's work), D its
`render:driver` (the push to the panel); `in place` when the framebuffer is
16 bpp (the runtime draws in the driver's RGB565 canvas, panel_canvas.nim),
else `dither+pack`.

The runtime stops logging renders for ten seconds after two fast ones in a
row (runner.nim `render:pause`), so an animation is never logged frame by
frame: each pause ends with two frames logged back to back, and the time
between their start lines (the journal's own stamps) is a frame's period,
said as a `render:animation` summary (`fps` = 1000 / period), one every ten
seconds as the firmware's are.

Every line is stamped with the frame's own time (the journal's, to the
microsecond), turned into this machine's by a measured clock offset: the
runtime's logger thread hands lines to the journal up to 250 ms late and the
journal to SSH later still (350 to 600 ms on the Pi Zero, 2026-11-24), which
the arrival time would add to every switch, tap and boot the bench times. A
line without a stamp (systemd's) is stamped as it arrives. A line the frame
wrote before the bench cleared its queue (`drain`) can still arrive after it:
it goes to the history and the raw log, never to the queue, as on a console
without the lag.

The render-log pause ends only after a render of a slow scene (runner.nim),
so the first render after leaving an animation is never logged (2026.11.14);
a scene that ticks itself faster than its interval (a clock's `nextSleep`)
counts as fast and keeps the pause going; and the bench hears of a pause a
quarter second late or more. So every switch is watched on the frame's own
lines, which are logged whatever the pause: `render:sceneChange` and the
scene's `event:open` start it, and its own `render:scene` follows the open
within milliseconds. When instead the pass ends unlogged, seen at the first
of `render:loadingMark` (its first picture on the panel, after 200 ms),
`render:sleep` or a `render:scene` seconds later (a later tick), the switch
went unlogged: a `bench:unlogged` line says so, the switch is said done (the
mark) or a `render` of the scene follows, and the suites take that switch as
untimed, not as one that never rendered.

A boot the bench counts as a crash is the service ending badly (a core dump,
a kill, a non-zero exit, a watchdog): a restart that was asked for (a push,
`restart`) ends with `Deactivated successfully` and is no incident.

One SSH connection carries every call (ControlMaster): a burst of fresh logins
went unanswered on the Pi Zero for a minute (2026-11-24).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import queue
import re
import shlex
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

from .console import INCIDENT_PATTERNS, Incident, parse_payload_json

HOME = os.path.expanduser(os.environ.get('FRAMEOS_BENCH_HOME', '~/.frameos-bench'))
TARGETS_FILE = os.path.join(HOME, 'linux-frames.json')
INSTALL = '/srv/frameos'
SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
            '-o', 'ControlMaster=auto', '-o', 'ControlPath=' + os.path.expanduser('~/.ssh/fb-%C'),
            '-o', 'ControlPersist=15m']
JOURNAL_LINE = re.compile(r'^\((\d+(?:\.\d+)?), (.*)\)$')
# systemd on the service: what ends it badly. `Deactivated successfully` is an
# exit asked for (a push restarts the runtime, so does `restart`).
LINUX_INCIDENTS = {
    'panic': re.compile(r'frameos\.service: Main process exited, code=(dumped|killed)'),
    'task_wdt': re.compile(r'frameos\.service: Watchdog timeout'),
    'oom': re.compile(r'OOM killer|Out of memory: Killed process', re.I),
    'abort': re.compile(r'frameos\.service: Main process exited, code=exited, status=[1-9]'),
}
UNCLEAN_END = re.compile(r"frameos\.service: (Main process exited, code=(dumped|killed)|Main process exited, code=exited, status=[1-9]|Failed with result)")
BUILT_IN_NAMES = {'system/sceneSwitcher': 'Scene switcher', 'system/sceneSettings': 'Scene settings',
                  'system/index': 'FrameOS'}


def ssh_targets() -> list[str]:
    """The Linux frames to bench: $FRAMEOS_BENCH_SSH (comma list) and
    ~/.frameos-bench/linux-frames.json (a list of `root@host`)."""
    out = [t.strip() for t in os.environ.get('FRAMEOS_BENCH_SSH', '').split(',') if t.strip()]
    try:
        with open(TARGETS_FILE) as fh:
            out += [t for t in json.load(fh) if isinstance(t, str)]
    except (OSError, ValueError):
        pass
    return list(dict.fromkeys(out))


def key_sha(key) -> str | None:
    """How a Linux frame is matched with its backend frame without its key in
    any status, run file or log."""
    return hashlib.sha256(key.encode()).hexdigest()[:16] if key else None


def is_ssh_port(port) -> bool:
    return isinstance(port, str) and port.startswith('ssh:')


def ssh(target: str, command: str, timeout: float = 60, data: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(['ssh', *SSH_OPTS, target, command], input=data, capture_output=True, timeout=timeout)


def clock_offset(target: str, samples: int = 7) -> tuple[float, float]:
    """The frame's clock minus this machine's, in seconds, from the `date`
    round trip that took least time; and that round trip (the error is at
    most half of it)."""
    best = None
    for _ in range(samples):
        t0 = time.time()
        res = ssh(target, 'date +%s.%N', 20)
        t1 = time.time()
        try:
            dev = float(res.stdout.decode().strip())
        except ValueError:
            continue
        if best is None or t1 - t0 < best[1]:
            best = (dev - (t0 + t1) / 2, t1 - t0)
    return best or (0.0, 0.0)


def module_of(model: str) -> str:
    """`Raspberry Pi Zero W Rev 1.1` -> `raspberry_pi_zero_w`, `Raspberry Pi 5
    Model B Rev 1.0` -> `raspberry_pi_5`: the board, not its revision."""
    m = re.sub(r'\s+Rev\s+\S+$', '', model.strip().strip('\x00'))
    m = re.sub(r'\s+Model\s+[AB](\s+Plus)?$', '', m)
    return re.sub(r'[^a-z0-9]+', '_', m.lower()).strip('_') or 'linux'


STATUS_SCRIPT = r'''
echo @@@model; cat /proc/device-tree/model 2>/dev/null; echo
echo @@@compatible; tr '\0' '\n' < /proc/device-tree/compatible 2>/dev/null
echo @@@cpu; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null; nproc
echo @@@meminfo; cat /proc/meminfo
echo @@@proc; pid=$(systemctl show -p MainPID --value frameos 2>/dev/null); [ -n "$pid" ] && [ "$pid" != 0 ] && cat /proc/$pid/status
echo @@@release; readlink -f INSTALL/current
echo @@@fbbpp; cat /sys/class/graphics/fb0/bits_per_pixel 2>/dev/null
echo @@@wireless; cat /proc/net/wireless 2>/dev/null
echo @@@scene; cat INSTALL/state/scene.json 2>/dev/null; echo
echo @@@cloud; test -f INSTALL/state/cloud_link.json && echo linked
echo @@@active; systemctl is-active frameos
echo @@@uptime; cat /proc/uptime
'''.replace('INSTALL', INSTALL)


def _sections(text: str) -> dict:
    out, key = {}, None
    for line in text.splitlines():
        if line.startswith('@@@'):
            key = line[3:].strip()
            out[key] = []
        elif key:
            out[key].append(line)
    return {k: '\n'.join(v).strip() for k, v in out.items()}


def _kb(meminfo: str, key: str):
    m = re.search(rf'^{key}:\s+(\d+) kB', meminfo, re.M)
    return int(m.group(1)) * 1024 if m else None


class LinuxConsole:
    """What console.Console offers a suite, for a Linux frame over SSH."""

    linux = True

    def _init_state(self, target: str, raw_path: Optional[str] = None):
        self.target = target
        self.port = 'ssh:' + target
        self.host = target.split('@')[-1]
        self.raw = open(raw_path, 'a', buffering=1) if raw_path else None
        self.lines: queue.Queue = queue.Queue()
        self.history: list = []
        self.incidents: list = []
        self.boots: list = []
        self.t0 = time.time()
        self._alive = True
        self._lock = threading.Lock()
        self._version = {}  # release dir -> (version, sha256 of the binary)
        self._cfg = None
        self.names: dict = dict(BUILT_IN_NAMES)
        self.intervals: dict = {}
        self.current_scene = None
        self.in_place = None
        self._render = None
        self._n = 0
        self._last_start = None  # the last render's start: device time, scene, cost, first of its scene?
        self._bench_scenes: dict = {}
        self._upload_backup = None
        self._cfg_stale = False
        self.log_paused = False   # the runtime's render-log pause (runner.nim `render:pause`), as last heard
        self._switch_watch = None  # a switch sent: did its render get logged?
        self._scene_changed = False
        self._fence = 0.0  # lines the frame wrote before the last drain stay out of the queue
        self.offset, self.offset_rtt = (0.0, 0.0)
        self._proc = None
        self._th = None

    def __init__(self, target: str, raw_path: Optional[str] = None, follow: bool = True):
        self._init_state(target, raw_path)
        self.config(refresh=True)
        if follow:
            self.offset, self.offset_rtt = clock_offset(target)
            self._offset_at = time.time()
            self._th = threading.Thread(target=self._reader, daemon=True)
            self._th.start()
            st = self.status_dict()
            self.in_place = st['board'].get('fbBpp') == 16
            b = st['board']
            self._log(f"#linux {b.get('model')}: cpu: {b.get('cpuMhz')} MHz ({b.get('cpuGovernor')} governor, "
                      f"{b.get('cpuMaxMhz')} max, {b.get('cores')} core(s)), fb {b.get('fbBpp')} bpp, release {st.get('release')}; "
                      f"clock {self.offset * 1000:+.1f} ms from this machine's (+-{self.offset_rtt * 500:.0f})")

    @classmethod
    def offline(cls, target: str = 'root@frame', raw_path: Optional[str] = None) -> 'LinuxConsole':
        """One that reads lines handed to it (`_line`) and asks nothing over
        SSH: the translation's tests."""
        con = cls.__new__(cls)
        con._init_state(target, raw_path)
        con._cfg = {}
        return con

    # ------------------------------------------------------------ plumbing
    def _log(self, text, now=None):
        if self.raw:
            self.raw.write(f'{(now or time.time()) - self.t0:10.3f} {text}\n')

    def _emit(self, text, now=None, incidents=True):
        now = now or time.time()
        self._log(text, now)
        for kind, pat in INCIDENT_PATTERNS.items() if incidents else ():
            if pat.search(text):
                self.incidents.append(Incident(now, kind, text[:400]))
                break
        if now >= self._fence:
            self.lines.put((now, text))
        self.history.append((now, text))
        if len(self.history) > 20000:
            del self.history[:5000]

    def config(self, refresh=False) -> dict:
        """frame.json (the frame's keys and settings), read once and again
        after each boot: a push rewrites it."""
        if refresh or self._cfg is None:
            res = ssh(self.target, f'cat {INSTALL}/current/frame.json', 60)
            try:
                self._cfg = json.loads(res.stdout or b'{}')
            except ValueError:
                self._cfg = self._cfg or {}
        return self._cfg

    def _http(self, method, path, body=None, auth='api', timeout=30):
        cfg = self.config()
        url = f"http://{self.host}:{cfg.get('framePort') or 8787}{path}"
        headers = {}
        if auth == 'api' and cfg.get('serverApiKey'):
            headers['Authorization'] = f"Bearer {cfg['serverApiKey']}"
        elif auth == 'key' and cfg.get('frameAccessKey'):
            url += ('&' if '?' in url else '?') + 'k=' + urllib.request.quote(cfg['frameAccessKey'])
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body, separators=(',', ':')).encode()
            headers['content-type'] = 'application/json'
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()

    # ------------------------------------------------------------ reading
    def _reader(self):
        while self._alive:
            self._proc = subprocess.Popen(['ssh', *SSH_OPTS, self.target, 'journalctl -u frameos -f -n 0 -o cat --no-pager'],
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            for raw in iter(self._proc.stdout.readline, b''):
                if not self._alive:
                    break
                self._line(raw.decode(errors='replace').rstrip('\r\n'))
            if self._alive:
                self._log('#READ-ERROR the journal follower ended; following again')
                time.sleep(2)

    def _line(self, text: str):
        arrived = time.time()
        now = arrived
        if not text.strip():
            return
        if arrived - getattr(self, '_offset_at', arrived) > 600:
            # Clocks drift: measured again every ten minutes, off this thread.
            self._offset_at = arrived
            threading.Thread(target=self._remeasure, daemon=True).start()
        m = JOURNAL_LINE.match(text)
        if not m:
            # systemd about the service, sudo lines of its children.
            kind = next((k for k, pat in LINUX_INCIDENTS.items() if pat.search(text)), None)
            if kind:
                self.incidents.append(Incident(now, kind, text[:400]))
            self._emit(text, now, incidents=kind is None)
            if UNCLEAN_END.search(text) and not any(now - b < 5 for b in self.boots):
                self.boots.append(now)
            return
        t_dev, body = float(m.group(1)), m.group(2)
        # The frame's own time of the line, on this machine's clock (never
        # later than it arrived: an offset off by its error bound).
        now = min(arrived, t_dev - self.offset)
        try:
            ev = json.loads(body)
        except ValueError:
            self._emit(body, now)
            return
        name = ev.get('event') if isinstance(ev, dict) else None
        if name == 'render:pause':
            self.log_paused = True
        elif name in ('render:scene', 'render:done', 'render:driver', 'render:sleep'):
            # Logged by the runner's own logger: it is not paused.
            self.log_paused = False
        watch = self._switch_watch
        if watch is not None and now >= watch['t'] - 0.015:
            if name in ('render:sceneChange', 'event:open') and ev.get('sceneId'):
                watch['changed'], watch['open'] = ev['sceneId'], now
            elif watch.get('changed') and name == 'render:scene' and now - watch['open'] < 2.0:
                self._switch_watch = None  # its own render, logged
            elif watch.get('changed') and name in ('render:scene', 'render:sleep', 'render:loadingMark'):
                self._switch_watch = None
                self._unlogged(watch, name, ev, body, now)
                if name == 'render:scene':
                    self._start(ev.get('sceneId') or '', t_dev, now)
                return
        if name == 'render:sceneChange' and ev.get('sceneId'):
            self.current_scene = ev['sceneId']
            self._scene_changed = True
        if name == 'render:scene':
            self._start(ev.get('sceneId') or '', t_dev, now)
            return
        if name == 'render:done':
            self._log('#linux ' + body, now)
            if self._render is not None:
                self._render['render_ms'] = ev.get('ms')
            return
        if name == 'render:driver':
            self._log('#linux ' + body, now)
            self._finish(ev.get('ms'), now)
            return
        if name in ('render:error', 'render:error:scene:init', 'render:error:loop', 'render:driver:error'):
            self._emit(body, now)
            r = self._render
            if r is not None and not r.get('failed'):
                r['failed'] = True
                stage = 'driver' if name == 'render:driver:error' else 'render'
                self._emit(f"render #{r['n']} failed at {stage}: {str(ev.get('error'))[:200]}", now)
            return
        if name == 'driver:frameBuffer' and isinstance(ev.get('screenInfo'), dict):
            self.in_place = ev['screenInfo'].get('bitsPerPixel') == 16
        self._emit(body, now)
        if name == 'bootup':
            self._cfg_stale = True
            self._render = None
            self._last_start = None
            # The runtime read its scene set (a push lands by a restart).
            self._emit('{"event":"scenes:load","origin":"stored","status":"ok","via":"bootup"}', now)
        elif name == 'event:reload':
            # A push that lands without a restart: the event loop logs it
            # whatever the render-log pause (the reload's own steps it hides,
            # as on a desktop with an animated window open).
            self._emit('{"event":"scenes:load","origin":"backend","status":"ok","via":"reload"}', now)

    def _unlogged(self, watch, name, ev, body, now):
        """A switch whose render the runtime did not log (the render-log pause):
        said, and ended (its first picture's mark) or rendered again."""
        sid = watch['changed']
        how = {'render:loadingMark': 'its first picture on the panel (the loading mark) ends it',
               'render:sleep': 'a render after it ends it',
               'render:scene': 'a later render of the scene ends it'}[name]
        self._emit(json.dumps({'event': 'bench:unlogged', 'command': watch['cmd'], 'sceneId': sid,
                               'reason': "the switch's render ran while the runtime's render log was paused "
                                         f"(runner.nim render:pause): untimed; {how}"}, separators=(',', ':')), now)
        if name == 'render:loadingMark':
            self._emit(body, now)
            self._n += 1
            label = self.names.get(sid, sid)
            self._emit(f'render #{self._n} started: scene "{label}" ({sid})', now)
            self._emit(f'render #{self._n} done in {round(ev.get("ms") or 0)} ms', now)
            self._emit(json.dumps({'event': 'render:done', 'sceneId': sid, 'sceneName': label, 'status': 'ok',
                                   'ms': round(ev.get('ms') or 0), 'via': 'loadingMark'}, separators=(',', ':')), now)
        elif name == 'render:sleep':
            self._emit(body, now)
            threading.Thread(target=self._event, args=('render', {}), daemon=True).start()

    def _remeasure(self):
        off, rtt = clock_offset(self.target, 5)
        if rtt:
            self.offset, self.offset_rtt = off, rtt
            self._log(f'#linux clock {off * 1000:+.1f} ms from this machine\'s (+-{rtt * 500:.0f})')

    def _start(self, sid, t_dev, now):
        prev = self._last_start
        if self._render is not None and not self._render.get('ended'):
            self._log(f"#linux render #{self._render['n']} ended without a panel push", now)
        first = self._scene_changed or not prev or prev['sid'] != sid
        self._scene_changed = False
        # Two frames of one scene back to back: an animation's period. Not the
        # scene's first frame and the next: the switch's pass also wrote the
        # scene's snapshot (a PNG encode) between them.
        if prev and prev['sid'] == sid and not prev['first'] and 0 < t_dev - prev['t'] < 2.0:
            interval = self.intervals.get(sid)
            if interval is None or interval < 1:
                period = (t_dev - prev['t']) * 1000
                self._emit(json.dumps({'event': 'render:animation', 'status': 'running', 'sceneId': sid,
                                       'frames': 1, 'fps': round(1000 / period, 1), 'avgMs': prev['cost'], 'maxMs': prev['cost'],
                                       'periodMs': round(interval * 1000) if interval else None,
                                       'seconds': round(period / 1000, 3), 'via': 'linux log burst'},
                                      separators=(',', ':')), now)
        self._n += 1
        self.current_scene = sid
        self._render = {'n': self._n, 'id': sid, 'name': self.names.get(sid, sid), 't_dev': t_dev}
        self._last_start = {'t': t_dev, 'sid': sid, 'cost': None, 'first': first}
        self._emit(f'render #{self._n} started: scene "{self._render["name"]}" ({sid})', now)

    def _finish(self, driver_ms, now):
        r = self._render
        if r is None:
            return
        r['ended'] = True
        self._render = None
        render_ms = round(r.get('render_ms') or 0)
        drive = round(driver_ms or 0)
        if self._last_start and self._last_start['sid'] == r['id']:
            self._last_start['cost'] = render_ms + drive
        if r.get('failed'):
            return
        path = 'in place, collect' if self.in_place else 'dither+pack'
        self._emit(f'render #{r["n"]} (interpreted scene "{r["name"]}", fmt=0): render {render_ms} ms, {path} {drive} ms', now)
        self._emit(f'render #{r["n"]} done in {render_ms + drive} ms', now)
        self._emit(json.dumps({'event': 'render:done', 'sceneId': r['id'], 'sceneName': r['name'], 'status': 'ok',
                               'ms': render_ms + drive}, separators=(',', ':')), now)

    def history_since(self, t0: float):
        return [x for t, x in list(self.history) if t >= t0]

    def drain(self):
        # What the frame wrote until now is behind us, arrived or not.
        self._fence = time.time() - 0.015
        out = []
        while True:
            try:
                out.append(self.lines.get_nowait())
            except queue.Empty:
                return out

    def wait_for(self, pred: Callable[[str], bool], timeout: float):
        end = time.time() + timeout
        got = []
        while time.time() < end:
            try:
                t, text = self.lines.get(timeout=0.2)
            except queue.Empty:
                continue
            got.append((t, text))
            if pred(text):
                return t, text, got
        return None, None, got

    def idle(self, seconds: float):
        return self.wait_for(lambda _: False, seconds)[2]

    # ------------------------------------------------------------ writing
    SWITCHES = ('setCurrentScene', 'sceneSwitcher', 'sceneSettings')

    def send(self, cmd: str, eol: bytes = b'\r\n'):
        self._log(f'>>> {cmd}')
        words = cmd.strip().split(' ', 2)
        if words[0] == 'scene' or (words[0] == 'event' and len(words) > 1 and words[1] in self.SWITCHES):
            self._switch_watch = {'cmd': cmd.strip(), 't': time.time(), 'changed': None}
        try:
            if words[0] == 'scene' and len(words) > 1:
                sid = cmd.strip().split(' ', 1)[1]
                showing = self.current_scene == sid
                self._event('setCurrentScene', {'sceneId': sid}, failed='scene select failed')
                if showing:
                    # The scene showing, with no state: the runtime draws
                    # nothing (runner.nim selectScene); the firmware console's
                    # `scene` draws it again, and so does this one.
                    self._switch_watch = None
                    self._event('render', {})
            elif words[0] == 'render':
                self._event('render', {})
            elif words[0] == 'event' and len(words) > 1:
                payload = json.loads(words[2]) if len(words) > 2 and words[2].strip() else {}
                showing = (words[1] == 'setCurrentScene' and payload.get('sceneId') == self.current_scene
                           and 'state' not in payload)
                self._event(words[1], payload)
                if showing:
                    # As `scene <id>` below: the scene showing is drawn again.
                    self._switch_watch = None
                    self._event('render', {})
            elif words[0] == 'restart':
                ssh(self.target, 'systemctl --no-block restart frameos', 30)
            else:
                self._log(f'#linux not a command here: {cmd}')
        except Exception as exc:  # the frame not answering is the suite's to judge
            self._emit(f'#linux {cmd}: {exc!r}')

    def _event(self, name, payload, failed=None):
        try:
            self._http('POST', f'/event/{name}', payload)
        except urllib.error.HTTPError as exc:
            self._emit(f"{failed or 'event ' + name + ' refused'}: HTTP {exc.code}")

    def command(self, cmd: str, settle: float = 2.0):
        """A console command that answers in lines. `status` says what the
        suites read off it (frame_id, debug, rotate); `heapinfo` has no
        ESP32 heaps to show; `set ...` changes nothing on a Linux frame (its
        settings are its backend's: a push)."""
        self.drain()
        c = cmd.strip()
        self._log(f'>>> {c}')
        if c == 'status':
            try:
                code, _ = self._http('GET', '/ping', auth=None, timeout=8)
            except Exception:
                return []
            cfg = self.config()
            return [f"frame_id: {self.frame_id or ''}", f"debug: {1 if cfg.get('debug') else 0}",
                    f"rotate: {cfg.get('rotate') or 0}", f"scene: {self.current_scene or ''}"]
        if c == 'heapinfo' or c.startswith('set '):
            self._log(f'#linux {c}: nothing to do on a Linux frame')
            return []
        self.send(c)
        return [x for _, x in self.idle(settle)]

    frame_id = None

    # ------------------------------------------------------------ usb_api
    def usb_api(self, sub: str, timeout: float = 20.0):
        name = sub.split()[0]
        if name == 'status':
            return True, json.dumps(self.status_dict())
        if name == 'scene-list':
            return True, json.dumps({'scenes': self.scene_list()})
        if name == 'scene-delete':
            self._bench_scenes.pop(sub.split(' ', 1)[1].strip(), None)
            if not self._bench_scenes:
                self.restore_uploads()
            return True, ''
        return False, f'{name}: not on a Linux frame'

    def usb_api_json(self, sub: str, timeout: float = 20.0):
        ok, body = self.usb_api(sub, timeout)
        return parse_payload_json(body) if ok else None

    def put_bytes(self, sub: str, payload: bytes, timeout: float = 120.0):
        """`scene-put`: the scene goes on with `uploadScenes`, beside the frame's
        own uploaded scenes and the benchmark scenes before it. The frame stays
        on the scene it shows (re-rendering it), so the suite's switch to the new
        one is a cold one."""
        if not sub.startswith('scene-put'):
            return False, f'{sub}: not on a Linux frame'
        scene = json.loads(payload)
        if self._upload_backup is None:
            res = ssh(self.target, f'cat {INSTALL}/state/uploaded.json 2>/dev/null || true', 60)
            self._upload_backup = res.stdout or b''
            # On disk too: `bench.py restore` puts it back after a killed run.
            os.makedirs(HOME, exist_ok=True)
            with open(self.backup_path, 'wb') as fh:
                fh.write(self._upload_backup)
        try:
            base = json.loads(self._upload_backup) if self._upload_backup.strip() else {}
        except ValueError:
            base = {}
        self._bench_scenes[scene['id']] = scene
        ids = set(self._bench_scenes)
        scenes = [s for s in base.get('scenes') or [] if s.get('id') not in ids] + list(self._bench_scenes.values())
        current = self.current_scene_id()
        body = {'scenes': scenes, 'sceneId': current if any(s.get('id') == current for s in scenes) else scene['id']}
        if base.get('source'):
            body['source'] = base['source']
        self.names[scene['id']] = scene.get('name') or scene['id']
        self.intervals[scene['id']] = (scene.get('settings') or {}).get('refreshInterval')
        self.drain()
        try:
            self._http('POST', '/uploadScenes', body, timeout=timeout)
        except Exception as exc:
            return False, f'uploadScenes: {exc!r}'
        # The upload re-renders the scene it names, then writes its snapshot
        # (a PNG encode: a second and more on a Pi Zero, and the next event
        # waits for it): the pass ends at `render:sleep`.
        t = self._pass_end(timeout)
        if t and body['sceneId'] != current and current:
            # It showed the new scene (the frame's was not among the uploads):
            # back to the frame's, so the suite's switch to it is a switch (a
            # switch to the scene showing, with no state, draws nothing: runner.nim selectScene).
            self._event('setCurrentScene', {'sceneId': current})
            t = self._pass_end(timeout)
        return bool(t), '__FRAMEOS_USB_OK__ scene-put' if t else 'no render after the upload'

    def _pass_end(self, timeout):
        """A render pass to its end: the render, the panel, the snapshot."""
        t, _, _ = self.wait_for(lambda x: bool(re.match(r'^render #\d+ (done in|failed at)', x)), timeout)
        if t:
            self.wait_for(lambda x: x.startswith('{"event":"render:sleep"'), 20)
        return t

    @property
    def backup_path(self) -> str:
        return os.path.join(HOME, f"uploaded-before-bench-{re.sub(r'[^A-Za-z0-9.]+', '_', self.host)}.json")

    def restore_uploads(self, backup: bytes | None = None) -> bool:
        """The uploaded scenes as they were: the file put back and the runtime
        restarted (the only way an upload leaves a Linux frame's memory). From
        memory, else from the copy on disk (a killed run's). False when there
        was nothing to put back."""
        data = self._upload_backup if backup is None else backup
        if data is None and os.path.exists(self.backup_path):
            with open(self.backup_path, 'rb') as fh:
                data = fh.read()
        if data is None:
            return False
        cmd = (f'cat > {INSTALL}/state/uploaded.json.bench && mv {INSTALL}/state/uploaded.json.bench {INSTALL}/state/uploaded.json'
               if data.strip() else f'rm -f {INSTALL}/state/uploaded.json')
        ssh(self.target, cmd + ' && systemctl --no-block restart frameos', 60, data=data if data.strip() else None)
        self._bench_scenes.clear()
        self._upload_backup = None
        try:
            os.remove(self.backup_path)
        except OSError:
            pass
        if self._th is not None:
            self.wait_for(lambda x: '"event":"bootup"' in x, 90)
            self._pass_end(120)
        return True

    # ------------------------------------------------------------ status
    def current_scene_id(self):
        try:
            _, body = self._http('GET', '/state', auth='key', timeout=10)
            sid = json.loads(body).get('sceneId')
            if sid:
                return sid
        except Exception:
            pass
        return self.current_scene

    def _version_of(self, release: str):
        if release not in self._version:
            res = ssh(self.target, f'{INSTALL}/current/frameos version; sha256sum {INSTALL}/current/frameos', 120)
            lines = (res.stdout or b'').decode(errors='replace').split('\n')
            version = lines[0].strip() if lines else ''
            sha = lines[1].split()[0] if len(lines) > 1 and lines[1].strip() else ''
            self._version[release] = (version, sha)
        return self._version[release]

    def status_dict(self) -> dict:
        """`usb_api status`'s shape, from frame.json, /proc and the journal."""
        if getattr(self, '_cfg_stale', False):
            self._cfg_stale = False
            self.config(refresh=True)
        cfg = self.config()
        res = ssh(self.target, STATUS_SCRIPT, 60)
        s = _sections((res.stdout or b'').decode(errors='replace'))
        model = s.get('model', '').strip('\x00 \n')
        compatible = [c for c in s.get('compatible', '').split('\n') if c]
        cpu = s.get('cpu', '').split('\n')
        mem = s.get('meminfo', '')
        proc = s.get('proc', '')
        release = s.get('release', '')
        version, sha = self._version_of(release)
        rssi = None
        m = re.search(r'wlan0:\s+\S+\s+\S+\s+(-?\d+)\.', s.get('wireless', ''))
        if m:
            rssi = int(m.group(1))
        scene = parse_payload_json(s.get('scene', '')) or {}
        current = self.current_scene_id() or scene.get('sceneId')
        width, height = cfg.get('width'), cfg.get('height')
        device = cfg.get('device') or ''
        host = (cfg.get('serverHost') or '').strip()
        backend = (f"{cfg.get('serverScheme') or 'http'}://{host}:{cfg.get('serverPort') or 8989}" if host else '')
        try:
            bpp = int(s.get('fbbpp') or 0) or None
        except ValueError:
            bpp = None
        mhz = lambda v: round(int(v) / 1000) if v and v.isdigit() else None  # noqa: E731
        return {
            'app': 'frameos-linux', 'version': version, 'binarySha256': sha, 'release': os.path.basename(release),
            'board': {'module': module_of(model), 'model': model, 'display': device,
                      'target': compatible[-1].split(',')[-1] if compatible else 'linux',
                      'cpuMhz': mhz(cpu[0]) if cpu else None, 'cpuGovernor': cpu[1] if len(cpu) > 1 else None,
                      'cpuMaxMhz': mhz(cpu[2]) if len(cpu) > 2 else None, 'cores': int(cpu[3]) if len(cpu) > 3 and cpu[3].isdigit() else None,
                      'fbBpp': bpp, 'lcd': bpp is not None and not device.startswith(('waveshare.', 'pimoroni.inky')),
                      'touch': 'touch' in device},
            'config': {'frameId': self.frame_id, 'backendUrl': backend, 'renderMode': 'local', 'panel': device,
                       'serverApiKeySha': key_sha(cfg.get('serverApiKey')),
                       'width': width, 'height': height, 'rotate': cfg.get('rotate'), 'debug': bool(cfg.get('debug'))},
            'memory': {'ramTotal': _kb(mem, 'MemTotal'), 'ramAvailable': _kb(mem, 'MemAvailable'),
                       'processRss': _kb(proc, 'VmRSS'), 'processPeakRss': _kb(proc, 'VmHWM'),
                       'swapUsed': (_kb(mem, 'SwapTotal') or 0) - (_kb(mem, 'SwapFree') or 0)},
            'wifi': {'ip': self.host, 'rssi': rssi},
            'scenes': {'currentSceneId': current, 'scenes': [{'id': k, 'name': v, 'refreshInterval': self.intervals.get(k)}
                                                             for k, v in self.names.items() if not k.startswith('system/')]},
            'render': {'previewWidth': width, 'previewHeight': height},
            'cloud': {'state': 'linked' if s.get('cloud') == 'linked' else None},
            'service': {'active': s.get('active'), 'uptimeS': float((s.get('uptime') or '0').split()[0] or 0)},
        }

    def scene_list(self) -> list[dict]:
        """The frame's scenes: the deployed set (scenes.json.gz) and the
        uploaded one (state/uploaded.json), an uploaded scene standing in for
        a deployed one of its id, in the frame's order (uploads first)."""
        res = ssh(self.target, f'cat {INSTALL}/current/scenes.json.gz 2>/dev/null', 120)
        deployed = []
        try:
            deployed = json.loads(gzip.decompress(res.stdout)) if res.stdout else []
        except (OSError, ValueError):
            deployed = []
        res = ssh(self.target, f'cat {INSTALL}/state/uploaded.json 2>/dev/null', 120)
        try:
            uploaded = (json.loads(res.stdout).get('scenes') or []) if res.stdout.strip() else []
        except ValueError:
            uploaded = []
        out, seen = [], set()
        for s in list(uploaded) + list(deployed if isinstance(deployed, list) else []):
            sid = s.get('id')
            if not sid or sid in seen:
                continue
            seen.add(sid)
            text = json.dumps(s, separators=(',', ':'))
            settings = s.get('settings') or {}
            self.names[sid] = s.get('name') or sid
            self.intervals[sid] = settings.get('refreshInterval')
            out.append({'id': sid, 'name': s.get('name'), 'bytes': len(text), 'isLayout': bool(settings.get('isLayout')),
                        'refreshInterval': settings.get('refreshInterval'),
                        'hash': hashlib.sha256(text.encode()).hexdigest()[:16]})
        return out

    def close(self):
        self._alive = False
        if self._proc is not None:
            try:
                self._proc.terminate()
            except Exception:
                pass


def probe(target: str) -> dict | None:
    """`usb_api status` for a Linux frame: None when it does not answer."""
    try:
        con = LinuxConsole(target, follow=False)
        if not con.config():
            return None
        return con.status_dict()
    except Exception as exc:
        print(f'ssh:{target}: {exc!r}')
        return None


def open_console(port: str, raw_path: str | None = None):
    """The console of a bench port: a serial device, or `ssh:<target>`."""
    if is_ssh_port(port):
        return LinuxConsole(port[4:], raw_path)
    from .console import Console
    return Console(port, raw_path)
