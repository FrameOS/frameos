## A web page's markup made small as it streams (docs/html-slim.md).
##
## What a JS app that reads a page cannot afford on an ESP32 is the markup it
## has no use for: a news page is megabytes of scripts, style sheets and
## class names around thirty kilobytes of words, and QuickJS there walks a
## string a few letters a millisecond. This is the part that is cheap here and
## dear there, and nothing else: the tags are told apart, what the app did
## not ask for is dropped, and what is left is still HTML, written one way,
## for the app to read. What a page MEANS (a block, a link, what is
## navigation, what is hidden) is the app's, in its own JavaScript.
##
## Every list is the app's (`fetch(url, { onChunk, slim: {…} })`): the module
## knows only what HTML itself says (a tag, a comment, the elements whose
## text is not markup, `<pre>`).
##
## Any cut of the input into pieces gives the same output.

{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

type
  SlimMode = enum
    smMarkup   ## text and tags
    smComment  ## inside `<!-- -->`
    smElement  ## inside an element whose content is not read as markup

  Word = object
    at: uint16    ## where it is in `words`
    len: uint8    ## 0: a free place
    flags: uint8  ## what it is: the `is*` bits

  HtmlSlim* = object
    words: string             ## every word the lists name, and HTML's own few
    table: array[256, Word]   ## by their hash: a name is looked up once, whatever is asked of it
    count: int
    keepAll, classAll: bool   ## no `keep` list: every attribute stays; no `classes`: a class as it is
    carry: string     ## a tag the piece's end cut, kept for the next piece
    mode: SlimMode
    skip: bool        ## first, to the next `>`: a doctype, a `<?…>`, a dropped element's end tag, a tag too long
    until: string     ## smElement: the element whose end tag is looked for
    pass: bool        ## its content is written as it is (else dropped)
    nest: bool        ## its own name inside it opens another
    depth: int        ## how many of them are open inside it
    pre: int          ## open `<pre>`s: white space stays as it is
    space: bool       ## the last letter written was a space
    bares: uint64     ## the open `bare` elements, a bit each: it was dropped
    bareDepth: int

const
  MaxTag = 65536   ## a tag is read this far: what of it has not ended by then is passed over, to the next `>`
  MaxValue = 2048  ## an attribute's value longer than this is dropped (a picture inlined as `data:`)
  Spaces = {' ', '\t', '\n', '\r', '\f'}
  # What a word is. The first four are the app's lists; the rest is HTML's.
  isKept = 1'u8    ## an attribute that stays
  isDropped = 2'u8 ## an element dropped with all inside it
  isBare = 4'u8    ## an element dropped when no attribute of it stays
  isClass = 8'u8   ## a class word that stays
  isRaw = 16'u8    ## script, style: their text is not markup, and goes
  isText = 32'u8   ## textarea, title: their text is not markup, and stays
  isPre = 64'u8    ## pre: white space stays
  MaxWords = 192   ## of the table's 256 places

proc memchr(s: pointer, c: cint, n: csize_t): pointer {.importc, header: "<string.h>".}

proc find(p: openArray[char], at: int, c: char): int =
  ## Where the next `c` is from p[at] on, or p.len. The C library's search:
  ## most of a page is passed over here (its scripts, its style sheets).
  if at >= p.len: return p.len
  let found = memchr(unsafeAddr p[at], cint(c), csize_t(p.len - at))
  if found.isNil: p.len else: cast[int](found) - cast[int](unsafeAddr p[0])

proc lower(c: char): char {.inline.} =
  if c in {'A' .. 'Z'}: chr(ord(c) or 0x20) else: c

proc place(s: HtmlSlim, p: openArray[char], a, b: int): int =
  ## Where the word p[a ..< b], in lower case, is in the table, or the free
  ## place it would take. A name is hashed and compared once: a page has ten
  ## thousand attributes and class words, and a walk of a list for each was
  ## half a second of an ESP32 on a long article.
  var h = 0'u32
  for k in a ..< b: h = h * 31 + uint32(lower(p[k]))
  result = int(h and 255)
  while true:
    let w = s.table[result]
    if w.len == 0: return
    if int(w.len) == b - a:
      var k = 0
      while k < b - a and s.words[int(w.at) + k] == lower(p[a + k]): inc k
      if k == b - a: return
    result = (result + 1) and 255

proc what(s: HtmlSlim, p: openArray[char], a, b: int): uint8 =
  ## What the word p[a ..< b] is: its `is*` bits, 0 for one no list names.
  if b > a and b - a < 256: s.table[s.place(p, a, b)].flags else: 0

proc learn(s: var HtmlSlim, list: string, flag: uint8) =
  var i = 0
  while i < list.len:
    var e = i
    while e < list.len and list[e] != ' ': inc e
    if e > i and e - i < 256 and s.count < MaxWords:
      let at = s.place(list, i, e)
      if s.table[at].len == 0:
        s.table[at] = Word(at: uint16(s.words.len), len: uint8(e - i))
        for k in i ..< e: s.words.add lower(list[k])
        inc s.count
      s.table[at].flags = s.table[at].flags or flag
    i = e + 1

proc initHtmlSlim*(keep, drop, bare, classes: string): HtmlSlim =
  ## `keep`: the attributes that stay (empty: all of them). `drop`: elements
  ## dropped with all inside them. `bare`: elements dropped, tag and end tag,
  ## when none of their attributes stays. `classes`: of a `class`, only the
  ## words on this list stay, and those with a part on it (parts are apart at
  ## `-` and `_`); empty: the class as it is. Words a space apart, 192 in all.
  result.space = true
  result.keepAll = keep.len == 0
  result.classAll = classes.len == 0
  result.learn(keep, isKept)
  result.learn(drop, isDropped)
  result.learn(bare, isBare)
  result.learn(classes, isClass)
  result.learn("script style", isRaw)
  result.learn("textarea title", isText)
  result.learn("pre", isPre)

proc starts(p: openArray[char], at: int, word: string): bool =
  ## Whether a name that is `word` starts at p[at].
  if at + word.len > p.len: return false
  for k in 0 ..< word.len:
    if lower(p[at + k]) != word[k]: return false
  at + word.len == p.len or p[at + word.len] notin {'a' .. 'z', 'A' .. 'Z', '0' .. '9', '-', '_', ':'}

proc put(o: var string, p: openArray[char], a, b: int) =
  ## p[a ..< b] as it is, in one copy: a letter at a time is what an ESP32,
  ## its strings in PSRAM, spends a page's time on.
  if b > a:
    let at = o.len
    o.setLen(at + (b - a))
    copyMem(addr o[at], unsafeAddr p[a], b - a)

proc value(o: var string, p: openArray[char], a, b: int) =
  ## An attribute's value: no `"` ends it, and every `<` and `>` of the
  ## output is a tag's.
  var i = a
  while i < b:
    var e = i
    while e < b and p[e] notin {'"', '<', '>'}: inc e
    o.put(p, i, e)
    if e < b:
      o.add (case p[e]
        of '"': "&quot;"
        of '<': "&lt;"
        else: "&gt;")
    i = e + 1

proc text(s: var HtmlSlim, p: openArray[char], a, b: int, o: var string) =
  ## Text between tags: white space is one space and letters that show
  ## nothing are gone (a soft hyphen, the zero-width ones, direction marks).
  if b <= a: return
  if s.pre > 0:
    o.put(p, a, b)
    s.space = false
    return
  var i = a
  while i < b:
    var e = i
    while e < b and p[e] > ' ' and p[e] < '\xC2': inc e
    if e > i: # letters with nothing to look at, in one copy
      o.put(p, i, e)
      s.space = false
      i = e
      continue
    let c = p[i]
    if c in Spaces:
      if not s.space:
        o.add ' '
        s.space = true
    else:
      if c >= '\xC2' and i + 1 < b:
        let d = p[i + 1]
        if c == '\xC2' and d == '\xAD': # U+00AD
          i += 2
          continue
        if i + 2 < b:
          let e = p[i + 2]
          # U+200B..200F, U+2028..202E, U+2060..2064, U+FEFF
          if (c == '\xE2' and ((d == '\x80' and (e in {'\x8B' .. '\x8F'} or e in {'\xA8' .. '\xAE'})) or
              (d == '\x81' and e in {'\xA0' .. '\xA4'}))) or (c == '\xEF' and d == '\xBB' and e == '\xBF'):
            i += 3
            continue
      o.add c
      s.space = false
    inc i

proc classWords(s: HtmlSlim, p: openArray[char], a, b: int, o: var string): bool =
  ## The words of a class the app listed (whole, or by a part). Whether any stayed.
  var i = a
  while i < b:
    while i < b and p[i] in Spaces: inc i
    let t = i
    while i < b and p[i] notin Spaces: inc i
    var
      stays = (s.what(p, t, i) and isClass) != 0
      k = t
    while not stays and k < i:
      var e = k
      while e < i and p[e] notin {'-', '_'}: inc e
      stays = (s.what(p, k, e) and isClass) != 0
      k = e + 1
    if stays:
      if result: o.add ' '
      o.value(p, t, i)
      result = true

proc enter(s: var HtmlSlim, p: openArray[char], a, b: int, pass, nest: bool) =
  s.mode = smElement
  s.until.setLen(0)
  for k in a ..< b: s.until.add lower(p[k])
  s.pass = pass
  s.nest = nest
  s.depth = 0

proc tag(s: var HtmlSlim, p: openArray[char], at: int, o: var string): int =
  ## The tag at p[at] (`<` and a letter or `/`), written slimmed: its name in
  ## lower case, the attributes that stay as ` name="value"`. Where the text
  ## goes on, or -1 when the tag's end has not come. A tag is read MaxTag
  ## bytes far, however the page is cut: one longer (a picture inlined in a
  ## `style`) keeps the attributes that ended by then, and the rest of it is
  ## passed over.
  let
    n = min(p.len, at + MaxTag)
    long = n < p.len
    mark = o.len
  var i = at + 1
  let closing = p[i] == '/'
  if closing: inc i
  let nameAt = i
  while i < n and p[i] notin Spaces + {'/', '>'}: inc i
  let nameEnd = i
  o.add '<'
  if closing: o.add '/'
  for k in nameAt ..< nameEnd: o.add lower(p[k])
  var
    attrs = 0
    json = false   # a script's type says JSON-LD
    slash = false  # the tag ends in "/>"
  while true:
    while i < n and (p[i] in Spaces or p[i] == '/'):
      slash = p[i] == '/'
      inc i
    if i < n and p[i] == '>': break
    if i >= n and long: break
    slash = false
    let a = i
    if i < n: inc i # a name may start with anything, "=" too
    while i < n and p[i] notin Spaces + {'=', '>', '/'}: inc i
    let b = i
    while i < n and p[i] in Spaces: inc i
    var va, vb = i
    if i < n and p[i] == '=':
      inc i
      while i < n and p[i] in Spaces: inc i
      if i < n and p[i] in {'"', '\''}:
        let quote = p[i]
        inc i
        va = i
        while i < n and p[i] != quote: inc i
        vb = i
        if i < n: inc i
        else: i = n + 1 # no end yet
      else:
        va = i
        while i < n and p[i] notin Spaces + {'>'}: inc i
        vb = i
    if i >= n: # the piece ended inside the tag
      if long:
        i = n
        break
      o.setLen(mark)
      return -1
    if closing: continue
    if b - a == 4 and starts(p, a, "type"):
      var k = va
      while k + 7 <= vb and not json:
        json = starts(p, k, "ld+json")
        inc k
    if (s.keepAll or (s.what(p, a, b) and isKept) != 0) and vb - va <= MaxValue:
      let before = o.len
      o.add ' '
      for k in a ..< b: o.add lower(p[k])
      o.add "=\""
      if not s.classAll and b - a == 5 and starts(p, a, "class"):
        if not s.classWords(p, va, vb, o):
          o.setLen(before)
          continue
      else:
        o.value(p, va, vb)
      o.add '"'
      inc attrs
  if i >= n: # too long: on from where the reading stopped, its `>` still to come
    result = n
    s.skip = true
    slash = false
  else:
    result = i + 1
  let name = s.what(p, nameAt, nameEnd)
  if closing:
    if (name and isBare) != 0:
      if s.bareDepth > 0:
        dec s.bareDepth
        if s.bareDepth < 64 and ((s.bares shr s.bareDepth) and 1) != 0:
          o.setLen(mark)
          return
    elif (name and isPre) != 0:
      if s.pre > 0: dec s.pre
  elif (name and isRaw) != 0:
    # Their text is not markup. Dropped, but for the data a page states about itself.
    s.enter(p, nameAt, nameEnd, json, false)
    if not json:
      o.setLen(mark)
      return
  elif (name and isDropped) != 0:
    o.setLen(mark)
    if not slash: s.enter(p, nameAt, nameEnd, false, true)
    return
  elif (name and isText) != 0:
    s.enter(p, nameAt, nameEnd, true, false) # text, with no tags in it
  elif (name and isBare) != 0:
    let gone = attrs == 0 and s.bareDepth < 64
    if s.bareDepth < 64:
      s.bares = (s.bares and not (1'u64 shl s.bareDepth)) or (uint64(ord(gone)) shl s.bareDepth)
    inc s.bareDepth
    if gone:
      o.setLen(mark)
      return
  elif (name and isPre) != 0:
    inc s.pre
  o.add '>'
  s.space = false

proc hold(s: var HtmlSlim, p: openArray[char], at: int) =
  s.carry.setLen(0)
  s.carry.put(p, at, p.len)

proc run(s: var HtmlSlim, p: openArray[char], last: bool, o: var string) =
  let n = p.len
  var i = 0
  while i < n:
    if s.skip:
      i = find(p, i, '>') + 1
      if i > n: return
      s.skip = false
      continue
    case s.mode
    of smComment:
      while i + 2 < n and not (p[i] == '-' and p[i + 1] == '-' and p[i + 2] == '>'): inc i
      if i + 2 >= n:
        s.hold(p, i) # its end may be cut: "-", "--"
        return
      i += 3
      s.mode = smMarkup
    of smElement:
      let j = find(p, i, '<')
      if s.pass: o.put(p, i, j)
      if j >= n: break
      if j + 2 + s.until.len >= n and not last:
        s.hold(p, j) # too little to tell whether it is the end tag
        return
      if j + 1 < n and p[j + 1] == '/' and starts(p, j + 2, s.until):
        if s.depth > 0:
          dec s.depth
          i = j + 1
        else:
          s.mode = smMarkup
          s.skip = not s.pass # written, the end tag is read as any other
          i = if s.pass: j else: j + 1
      else:
        if s.nest and starts(p, j + 1, s.until):
          # Another of its kind inside it, unless that one ends itself ("<svg/>").
          let e = find(p, j, '>')
          if e >= n and not last:
            s.hold(p, j)
            return
          if e >= n or p[e - 1] != '/': inc s.depth
        if s.pass: o.add '<'
        i = j + 1
    of smMarkup:
      let j = find(p, i, '<')
      var e = j
      if j >= n and not last:
        # A letter that shows nothing may be cut by the piece's end: its first bytes wait.
        if n - i >= 1 and p[n - 1] in {'\xC2', '\xE2', '\xEF'}: e = n - 1
        elif n - i >= 2 and p[n - 2] in {'\xE2', '\xEF'}: e = n - 2
      s.text(p, i, e, o)
      if e < j:
        s.hold(p, e)
        return
      if j >= n: break
      if j + 3 >= n and not last:
        s.hold(p, j) # too little to tell what starts here
        return
      let c = if j + 1 < n: p[j + 1] else: ' '
      if c == '!' or c == '?':
        if c == '!' and j + 3 < n and p[j + 2] == '-' and p[j + 3] == '-':
          s.mode = smComment
          i = j + 4
        else:
          s.skip = true
          i = j + 2
      elif c == '/' or c in {'a' .. 'z', 'A' .. 'Z'}:
        let e = s.tag(p, j, o)
        if e >= 0:
          i = e
        elif last:
          return # a tag with no end: nothing
        else:
          s.hold(p, j)
          return
      else:
        o.add "&lt;" # a "<" that starts nothing is text
        s.space = false
        i = j + 1

proc push*(s: var HtmlSlim, piece: openArray[char], last: bool, output: var string) =
  ## Reads the next piece of the page (`last`: there is no more) and adds
  ## what stays of it to `output`. A tag is written whole or not yet.
  if s.carry.len == 0:
    s.run(piece, last, output)
  else:
    var whole = move(s.carry)
    s.carry = ""
    whole.put(piece, 0, piece.len)
    s.run(whole, last, output)

{.pop.}
