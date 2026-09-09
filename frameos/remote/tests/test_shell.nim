import std/[asyncdispatch, json, monotimes, os, strutils, times]
import ../src/frameos_remote

## The `shell` verb runs through frameos/utils/process (serialized spawn,
## non-blocking pipe reads, terminate-then-kill stop) with a deadline, and
## the wait yields to the async loop instead of blocking it.

proc collect(lines: ref seq[string]): proc(line: string): Future[void] {.closure, gcsafe.} =
  result = proc(line: string): Future[void] {.closure, gcsafe.} =
    {.gcsafe.}:
      lines[].add(line)
    result = newFuture[void]()
    result.complete()

block test_shell_timeout_from_args_is_clamped_with_a_default:
  doAssert shellTimeoutMs(%*{}) == ShellDefaultTimeoutSeconds * 1000
  doAssert shellTimeoutMs(%*{"timeout": 0}) == ShellDefaultTimeoutSeconds * 1000
  doAssert shellTimeoutMs(%*{"timeout": -5}) == ShellDefaultTimeoutSeconds * 1000
  doAssert shellTimeoutMs(%*{"timeout": 30}) == 30_000
  doAssert shellTimeoutMs(%*{"timeout": 10_000_000}) == ShellMaxTimeoutSeconds * 1000

block test_shell_streams_lines_and_reports_the_exit_code:
  var lines = new seq[string]
  let run = waitFor runShellStreaming("echo one; echo two >&2; echo three; exit 3", 10_000, collect(lines))
  doAssert run.exitCode == 3, $run
  doAssert not run.timedOut
  doAssert not run.outputTruncated
  doAssert lines[] == @["one\n", "two\n", "three\n"], $lines[]

block test_shell_success_is_exit_zero:
  var lines = new seq[string]
  let run = waitFor runShellStreaming("true", 10_000, collect(lines))
  doAssert run.exitCode == 0
  doAssert lines[].len == 0

block test_shell_is_stopped_at_the_deadline_and_reported_as_timed_out:
  var lines = new seq[string]
  let started = getMonoTime()
  let run = waitFor runShellStreaming("echo started; sleep 30; echo never", 500, collect(lines))
  let elapsedMs = (getMonoTime() - started).inMilliseconds
  doAssert run.timedOut, $run
  doAssert run.exitCode == -1
  doAssert lines[] == @["started\n"], $lines[]
  # 500 ms deadline + terminate/kill grace, never the child's 30 s
  doAssert elapsedMs < 10_000, $elapsedMs

block test_shell_wait_yields_to_the_async_loop:
  # A timer scheduled on the dispatcher fires while the command is running,
  # which it could not when the old implementation blocked on readLine.
  var ticks = 0
  proc ticker() {.async.} =
    for _ in 0 ..< 3:
      await sleepAsync(50)
      inc ticks
  let tickerFuture = ticker()
  var lines = new seq[string]
  let run = waitFor runShellStreaming("sleep 0.5; echo done", 10_000, collect(lines))
  waitFor tickerFuture
  doAssert run.exitCode == 0
  doAssert lines[] == @["done\n"]
  doAssert ticks == 3, $ticks

block test_shell_output_past_the_cap_is_dropped_not_buffered:
  var lines = new seq[string]
  # ~9 MB of output against the 8 MB cap
  let run = waitFor runShellStreaming("head -c 9437184 /dev/zero | tr '\\0' 'x' | fold -w 1024", 60_000, collect(lines))
  doAssert run.exitCode == 0, $run
  doAssert run.outputTruncated
  var streamed = 0
  for line in lines[]:
    streamed += line.len
  doAssert streamed <= ShellMaxOutputBytes + 2048, $streamed
  doAssert streamed > ShellMaxOutputBytes - 2048, $streamed
