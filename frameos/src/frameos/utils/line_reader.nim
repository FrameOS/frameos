## Text a line at a time out of a Stream, in the memory of one window.
##
## The fold half of the byte side (docs/value-pipeline.md): an ICS feed or a
## CSV can be many MB while what a scene wants from it is a handful of rows.
## JS apps reach this through `frameos.openLines` / `frameos.nextLine`.
##
## What makes it more than a split on newlines is the part done HERE, before a
## line becomes anything: `only` decides from a line's first bytes whether
## anyone wants it, so the lines nobody wants (a calendar's ATTENDEE list, a
## folded 40 KB DESCRIPTION) are read past without being held, and their
## continuation lines with them. On an ESP32 most of a calendar never becomes
## a QuickJS string at all.

import std/streams

const
  LineWindowBytes* = 8 * 1024
  DefaultMaxLineBytes* = 64 * 1024
    ## A line past this is cut. The bound is what makes "one line" a promise
    ## about memory: a feed with a 5 MB base64 attachment on one line is a
    ## feed that may arrive on an ESP32.

type
  LineOptions* = object
    unfold*: bool ## a line starting with a space or tab continues the one before (RFC 5545, RFC 822)
    trim*: bool ## strip ASCII whitespace off both ends
    only*: seq[string] ## keep only the lines starting with one of these
    maxLength*: int ## bytes; 0 is DefaultMaxLineBytes

  LineEnding = enum
    leNothing ## the stream ended before this line began
    leRoom ## out of room, more of the line to come
    leDone ## the line ended, its terminator consumed

  LineReader* = ref object
    stream: Stream
    options: LineOptions
    maxLength: int
    peekBytes: int ## the longest `only` prefix: all a verdict needs
    window: string
    pos, filled: int
    ended: bool

proc newLineReader*(stream: Stream, options = LineOptions()): LineReader =
  result = LineReader(stream: stream, options: options,
    maxLength: (if options.maxLength > 0: options.maxLength else: DefaultMaxLineBytes))
  for prefix in options.only:
    result.peekBytes = max(result.peekBytes, prefix.len)
  result.window = newString(LineWindowBytes)

proc rewind*(reader: LineReader) =
  ## From the top again, for a stream that can seek.
  reader.stream.setPosition(0)
  reader.pos = 0
  reader.filled = 0
  reader.ended = false

proc fill(reader: LineReader): bool {.inline.} =
  ## True when the window has a byte at `pos`.
  if reader.pos < reader.filled:
    return true
  if reader.ended:
    return false
  reader.pos = 0
  reader.filled = reader.stream.readData(addr reader.window[0], reader.window.len)
  if reader.filled <= 0:
    reader.filled = 0
    reader.ended = true
    return false
  true

proc take(reader: LineReader; dest: var string; room: int; store = true): LineEnding =
  ## The physical line at the cursor into `dest`, `room` bytes at most. CRLF,
  ## LF and a bare CR all end one, wherever a window boundary falls. With
  ## `store` off it stores nothing and runs to the end of the line.
  var room = room
  var any = false
  while reader.fill():
    any = true
    var i = reader.pos
    let stop = if store: min(reader.filled, reader.pos + room) else: reader.filled
    while i < stop and reader.window[i] notin {'\r', '\n'}:
      inc i
    if store and i > reader.pos:
      let start = dest.len
      dest.setLen(start + i - reader.pos)
      copyMem(addr dest[start], addr reader.window[reader.pos], i - reader.pos)
      room -= i - reader.pos
    reader.pos = i
    if i < reader.filled and reader.window[i] in {'\r', '\n'}:
      let terminator = reader.window[i]
      inc reader.pos
      if terminator == '\r' and reader.fill() and reader.window[reader.pos] == '\n':
        inc reader.pos
      return leDone
    if store and room <= 0:
      return leRoom
  if any: leDone else: leNothing

proc skipRest(reader: LineReader) {.inline.} =
  var none = ""
  discard reader.take(none, 0, store = false)

proc atContinuation(reader: LineReader): bool {.inline.} =
  reader.options.unfold and reader.fill() and reader.window[reader.pos] in {' ', '\t'}

proc wanted(reader: LineReader, line: string): bool =
  for prefix in reader.options.only:
    if line.len >= prefix.len and equalMem(unsafeAddr line[0], unsafeAddr prefix[0], prefix.len):
      return true

proc trimInPlace(line: var string) =
  const Space = {' ', '\t', '\v', '\r', '\n', '\f'}
  var stop = line.len
  while stop > 0 and line[stop - 1] in Space:
    dec stop
  var start = 0
  while start < stop and line[start] in Space:
    inc start
  if start > 0:
    if stop > start:
      moveMem(addr line[0], addr line[start], stop - start)
    stop -= start
  line.setLen(stop)

proc cutToCharacter(line: var string) =
  ## A cut landing inside a UTF-8 sequence takes the whole character out.
  var stop = line.len
  while stop > 0 and (line[stop - 1].uint8 and 0xC0) == 0x80:
    dec stop
  if stop > 0 and line[stop - 1].uint8 >= 0xC0:
    line.setLen(stop - 1)

proc nextLine*(reader: LineReader; line: var string): bool =
  ## The next line the options keep, in `line` (reused, so a caller looping
  ## over a feed allocates once). False at the end.
  let filtered = reader.options.only.len > 0
  while true:
    line.setLen(0)
    var ending = reader.take(line, if filtered: max(1, reader.peekBytes) else: reader.maxLength)
    if ending == leNothing:
      return false
    if filtered and not reader.wanted(line):
      if ending == leRoom:
        reader.skipRest()
      while reader.atContinuation():
        reader.skipRest()
      continue
    if ending == leRoom:
      ending = reader.take(line, reader.maxLength - line.len)
      if ending == leRoom:
        reader.skipRest()
    while reader.atContinuation():
      inc reader.pos
      if reader.take(line, max(0, reader.maxLength - line.len)) == leRoom:
        reader.skipRest()
    if line.len >= reader.maxLength:
      line.cutToCharacter()
    if reader.options.trim:
      line.trimInPlace()
    return true

const MaxBlockBytes* = 256 * 1024

proc nextBlock*(reader: LineReader; stop: string; output: var string): bool =
  ## The kept lines up to the next one starting with `stop` (which must be
  ## among `only`, when there is one), joined with newlines, `stop` left out.
  ## False when the text ends first: a record with no end is no record. One
  ## call per record, so an app that decides from a line or two (a calendar
  ## event outside its window) pays for neither the other lines nor a loop.
  output.setLen(0)
  var line = ""
  while reader.nextLine(line):
    if line.len >= stop.len and equalMem(unsafeAddr line[0], unsafeAddr stop[0], stop.len):
      return true
    if output.len + line.len + 1 <= MaxBlockBytes:
      if output.len > 0:
        output.add('\n')
      output.add(line)
  false
