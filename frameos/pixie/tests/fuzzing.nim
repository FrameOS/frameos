## What the fuzzers of the fork's own readers share (fuzz_inflate,
## fuzz_file_font, fuzz_indexed_font): a seed that can be given again, a
## count that can be raised, and bytes in an allocation of exactly their
## size.
##
## These are built by tools/run_pixie_fuzzers.sh WITHOUT -d:release, so the
## `{.push checks: off.}` the readers put on themselves in a release does not
## apply, and with AddressSanitizer over `-d:useMalloc`. The second half
## matters as much as the first: all three readers go through
## `ptr UncheckedArray`, which Nim's bound checks do not see. A read one byte
## past an allocation is caught only if the allocation ends there, which is
## what `HeapBytes` is for.

import pixie/common, std/[os, random, strutils]

proc fuzzRand*(): Rand =
  ## The run's random numbers. PIXIE_FUZZ_SEED=<n> replays a run; without it
  ## the seed is new each time. Either way it is the first line printed.
  var seed: int64
  let given = getEnv("PIXIE_FUZZ_SEED")
  if given.len > 0:
    seed = parseBiggestInt(given)
  else:
    randomize()
    seed = rand(int32.high).int64 + 1
  echo "seed ", seed
  initRand(seed)

proc fuzzIterations*(default: int): int =
  ## How many rounds; PIXIE_FUZZ_ITERATIONS overrides. The runner stops a
  ## fuzzer at its time limit, so the default is "more than fit".
  let given = getEnv("PIXIE_FUZZ_ITERATIONS")
  if given.len > 0: parseInt(given) else: default

when defined(posix):
  proc alarm(seconds: cuint): cuint {.importc, header: "<unistd.h>".}

proc fuzzRound*(seconds = 60) =
  ## Call at the top of every round: a round that has not ended `seconds`
  ## later ends the process (SIGALRM, nobody handles it). The runner's time
  ## limit cannot tell a fuzzer that is busy from one that hangs in a loop a
  ## broken file sent it into; this can, and the last line printed is the
  ## round that hung.
  when defined(posix):
    discard alarm(seconds.cuint)

template outline*(body: untyped) =
  ## A glyph's outline asked for: a PixieError is an answer. Any Defect ends
  ## the fuzzer.
  try:
    body
  except PixieError:
    discard

type
  HeapBytes* = object
    ## `len` bytes in a malloc of exactly `len` (nil for none).
    data*: ptr UncheckedArray[uint8]
    len*: int

proc heapBytes*(s: openArray[char]): HeapBytes =
  result.len = s.len
  if s.len > 0:
    result.data = cast[ptr UncheckedArray[uint8]](alloc(s.len))
    copyMem(result.data, s[0].unsafeAddr, s.len)

proc free*(b: var HeapBytes) =
  if b.data != nil:
    dealloc(b.data)
  b.data = nil
  b.len = 0

proc mutate*(rng: var Rand, data: var string): string =
  ## Breaks `data` in place and says how, for the log: one to three bytes set
  ## to anything (half of the time among the first 512, where the headers and
  ## tables of everything live), then sometimes cut short, sometimes with a
  ## tail of noise.
  if data.len == 0:
    return "empty"
  for _ in 0 ..< rng.rand(1 .. 3):
    let
      pos =
        if rng.rand(1) == 0: rng.rand(0 ..< min(data.len, 512))
        else: rng.rand(0 ..< data.len)
      value = rng.rand(255)
    data[pos] = value.char
    result.add " " & $pos & "=" & $value
  case rng.rand(5)
  of 0:
    let keep = rng.rand(0 ..< data.len)
    data.setLen(keep)
    result.add " cut=" & $keep
  of 1:
    let extra = rng.rand(1 .. 64)
    for _ in 0 ..< extra:
      data.add rng.rand(255).char
    result.add " tail=" & $extra
  else:
    discard
