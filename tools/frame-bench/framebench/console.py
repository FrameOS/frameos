"""A frame's USB console, held open for a whole bench.

Opening a CH340 / CH9102 board's port with pyserial's defaults raises DTR and
RTS together, which the ESP32 auto-reset circuit ignores; flipping them one at
a time (``dtr=False`` then ``rts=False``) passes through "EN low" and resets
the board. So: open with the defaults, never touch the lines, and keep the
port open between commands. The chip's own USB-Serial/JTAG port and the Pico's
CDC port do not reset on open either way.
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import serial  # pyserial

# A firmware panic, abort or watchdog. Each match is one "incident" line.
INCIDENT_PATTERNS = {
    'panic': re.compile(r"Guru Meditation|panic'ed|LoadProhibited|StoreProhibited|InstrFetchProhibited|IllegalInstruction|Unhandled debug exception"),
    'abort': re.compile(r'abort\(\) was called|assert failed|Stack canary|stack overflow|CORRUPT HEAP|heap_caps_free.*invalid'),
    'task_wdt': re.compile(r'task_wdt: Task watchdog got triggered'),
    'int_wdt': re.compile(r'Interrupt wdt timeout'),
    'brownout': re.compile(r'Brownout detector was triggered'),
    'oom': re.compile(r'ESP_ERR_NO_MEM|out of memory|alloc(ation)? failed|OutOfMemDefect|could not allocate', re.I),
    'interpreter_discard': re.compile(r'"event":"js:discard|interpreter.*discard', re.I),
    'layout_missing': re.compile(r'"event":"layout:missing"'),
    'nim_error': re.compile(r'Error: unhandled exception|\[Defect\]|IndexDefect|RangeDefect|NilAccessDefect'),
}
BOOT_PATTERN = re.compile(r'ESP-IDF v[\d.]+ 2nd stage bootloader|^rst:0x|frameos-pico .* booting', re.I)
PROMPT_NOISE = ('interpreter:node:profile',)


@dataclass
class Incident:
    t: float
    kind: str
    line: str


def parse_payload_json(body: str):
    """A usb_api JSON payload, read up to where its value ends: a log line the
    firmware printed as the payload finished can be glued to its last line
    with no newline between (the E1003's `it8951:` lines made discovery miss
    the board, 2026-11-19). None when there is no JSON value."""
    start = min((i for i in (body.find('{'), body.find('[')) if i >= 0), default=-1)
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(body[start:])[0]
    except ValueError:
        return None


@dataclass
class Console:
    port: str
    raw_path: Optional[str] = None
    baud: int = 115200
    incidents: list = field(default_factory=list)
    boots: list = field(default_factory=list)

    def __post_init__(self):
        self.s = serial.Serial(self.port, self.baud, timeout=0.1)
        self.raw = open(self.raw_path, 'a', buffering=1) if self.raw_path else None
        self.lines: queue.Queue = queue.Queue()
        self.history: list = []
        self.t0 = time.time()
        self._alive = True
        self._th = threading.Thread(target=self._reader, daemon=True)
        self._th.start()

    # ------------------------------------------------------------ reading
    def _reader(self):
        buf = b''
        while self._alive:
            try:
                data = self.s.read(8192)
            except Exception as exc:  # device re-enumerating (a Pico restart)
                self._log(f'#READ-ERROR {exc}')
                time.sleep(1.0)
                try:
                    self.s.close()
                    self.s = serial.Serial(self.port, self.baud, timeout=0.1)
                except Exception:
                    pass
                continue
            if not data:
                continue
            buf += data
            while b'\n' in buf:
                raw, buf = buf.split(b'\n', 1)
                text = raw.decode(errors='replace').rstrip('\r').replace('frameos>', '').strip()
                if not text or any(n in text for n in PROMPT_NOISE):
                    continue
                now = time.time()
                self._log(text, now)
                for kind, pat in INCIDENT_PATTERNS.items():
                    if pat.search(text):
                        self.incidents.append(Incident(now, kind, text[:400]))
                        break
                if BOOT_PATTERN.search(text):
                    self.boots.append(now)
                self.lines.put((now, text))
                self.history.append((now, text))
                if len(self.history) > 20000:
                    del self.history[:5000]

    def _log(self, text, now=None):
        if self.raw:
            self.raw.write(f'{(now or time.time()) - self.t0:10.3f} {text}\n')

    def history_since(self, t0: float):
        return [x for t, x in list(self.history) if t >= t0]

    def drain(self):
        out = []
        while True:
            try:
                out.append(self.lines.get_nowait())
            except queue.Empty:
                return out

    def wait_for(self, pred: Callable[[str], bool], timeout: float):
        """Collect lines until pred(text); returns (time or None, matched line, collected)."""
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
    def send(self, cmd: str, eol: bytes = b'\r\n'):
        shown = re.sub(r'(api_key|admin_pass|wifi_pass)\s+\S+', r'\1 ***', cmd)
        self._log(f'>>> {shown}')
        self.s.write(cmd.encode() + eol)

    def command(self, cmd: str, settle: float = 2.0):
        self.drain()
        self.send(cmd)
        return [x for _, x in self.idle(settle)]

    def usb_api(self, sub: str, timeout: float = 20.0) -> tuple[bool, str]:
        """Run `usb_api <sub>`; returns (ok, payload text)."""
        name = sub.split()[0]
        self.drain()
        self.send(f'usb_api {sub}')
        done = ('__FRAMEOS_USB_END__ ' + name, '__FRAMEOS_USB_OK__ ' + name, '__FRAMEOS_USB_ERROR__ ' + name)
        _, last, got = self.wait_for(lambda x: x.startswith(done), timeout)
        body, inside = [], False
        for _, text in got:
            if text.startswith('__FRAMEOS_USB_BEGIN__ ' + name):
                inside = True
                continue
            if text.startswith(done):
                break
            # A log line the firmware printed while the payload streamed.
            # The IT8951's driver prints its own lines with no log prefix
            # (`it8951: partial fast ...`), one a second under a clock.
            if inside and not text.startswith(('{"event"', 'W (', 'E (', 'I (', 'render #', 'it8951:')):
                body.append(text)
        ok = bool(last) and not last.startswith('__FRAMEOS_USB_ERROR__')
        return ok, '\n'.join(body)

    def usb_api_json(self, sub: str, timeout: float = 20.0):
        for _ in range(3):
            ok, body = self.usb_api(sub, timeout)
            value = parse_payload_json(body)
            if value is not None:
                return value
        return None

    def put_bytes(self, sub: str, payload: bytes, timeout: float = 120.0) -> tuple[bool, str]:
        """`usb_api <sub> <len> ...`: wait for READY, send the payload."""
        name = sub.split()[0]
        self.drain()
        self.send(f'usb_api {sub}')
        t, line, _ = self.wait_for(lambda x: x.startswith(('__FRAMEOS_USB_READY__', '__FRAMEOS_USB_ERROR__')), 15)
        if not t or not line.startswith('__FRAMEOS_USB_READY__'):
            return False, line or 'no READY'
        for i in range(0, len(payload), 4096):
            self.s.write(payload[i:i + 4096])
        t, line, _ = self.wait_for(lambda x: x.startswith(('__FRAMEOS_USB_OK__ ' + name, '__FRAMEOS_USB_ERROR__ ' + name)), timeout)
        return bool(t) and line.startswith('__FRAMEOS_USB_OK__'), line or 'timeout'

    def close(self):
        self._alive = False
        time.sleep(0.3)
        try:
            self.s.close()
        except Exception:
            pass
