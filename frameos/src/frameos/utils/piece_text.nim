## The text of a body that arrives in pieces (`fetch`'s `onChunk`,
## docs/async-js.md "A response in pieces"): each piece of bytes as UTF-8 text
## a JS string can be made of.
##
## - A character whose bytes two pieces share is held back and completed by
##   the next piece, never a U+FFFD at a seam.
## - A body that is not UTF-8 is read as Windows-1252, every byte a character,
##   from the first piece that holds an invalid sequence onward: an old
##   Latin-1 page reads as it was written. The pieces before it held ASCII
##   alone (or, by chance, bytes that are UTF-8 too), which reads the same
##   either way.

type
  PieceText* = object
    carry: string ## the bytes of a character the last piece ended inside
    latin*: bool  ## not UTF-8: Windows-1252 from here on

const Cp1252High: array[32, uint16] = [
  0x20AC'u16, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178]
  ## What bytes 0x80 to 0x9f are in Windows-1252 (as browsers read Latin-1).

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc utf8Run(data: string, cut: var int): bool =
  ## Whether `data` is UTF-8 up to `cut`, where a character starts that the
  ## piece ends inside (data.len when it ends on a whole one). False: a
  ## sequence that no later piece can complete.
  let n = data.len
  var i = 0
  cut = n
  while i < n:
    let c = data[i].uint8
    if c < 0x80:
      inc i
      continue
    let need =
      if c >= 0xC2 and c <= 0xDF: 1
      elif c >= 0xE0 and c <= 0xEF: 2
      elif c >= 0xF0 and c <= 0xF4: 3
      else: return false
    for j in 1 .. need:
      if i + j >= n:
        # The piece ends inside it: the next one has the rest (a body that
        # ends there loses those bytes).
        cut = i
        return true
      if (data[i + j].uint8 and 0xC0) != 0x80:
        return false
    i += need + 1
  true

proc pieceText*(state: var PieceText, bytes: openArray[char], last = false): string =
  ## The next piece of the body as text. `last`: no piece follows.
  var data = move(state.carry)
  state.carry = ""
  if bytes.len > 0:
    let at = data.len
    data.setLen(at + bytes.len)
    copyMem(addr data[at], unsafeAddr bytes[0], bytes.len)
  if not state.latin:
    var cut = 0
    if utf8Run(data, cut):
      if cut < data.len:
        if not last:
          state.carry = data[cut ..< data.len]
        data.setLen(cut)
      return data
    state.latin = true
  result = newStringOfCap(data.len + data.len div 8)
  for ch in data:
    let c = ch.uint8
    if c < 0x80:
      result.add ch
      continue
    let point = if c < 0xA0: Cp1252High[c - 0x80] else: c.uint16
    if point < 0x800:
      result.add char(0xC0 or (point shr 6))
    else:
      result.add char(0xE0 or (point shr 12))
      result.add char(0x80 or ((point shr 6) and 0x3F))
    result.add char(0x80 or (point and 0x3F))

{.pop.}
