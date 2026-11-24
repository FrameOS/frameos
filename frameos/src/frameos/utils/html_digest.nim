## HTML to a page's records, as its bytes come (docs/html-digest.md).
##
## A JS app that shows a web page (the Browser sample) cannot read markup in
## JavaScript on an ESP32, so the runtime does: `push` takes the page a piece
## at a time (any cut: a tag, an entity or a letter split between two pieces
## waits for the next) and appends whole records, a line a block: a
## paragraph, a heading, a list item, a line of a table, a picture, a form's
## field, with its text and where its links, bold and code runs start, and
## marks around what is not the page's own (its navigation, a sidebar, the
## footer). Scripts, style sheets, comments, inline SVG and what is hidden
## are skipped as they pass. No DOM, no style sheets: what a tag is says how
## its text is shown, as Lynx read a page.
##
## Flash is what this costs on an ESP32, so the markup is read in place (no
## tag is copied to be looked at; its attributes are found once, by number),
## names are packed word lists, the elements that do the same are one case
## (`Acts`) and nothing here raises or allocates per tag: the buffers are the
## state's. docs/html-digest.md "What it costs" has the numbers.
##
## Whether something around the page becomes a fold is the app's call (its
## loader, the Browser's page.ts): this marks where one starts (`[`) and ends
## (`]`, numbered as the `[` records come) and where the page's own part
## starts (`M`), and counts the letters in links between.

{.push checks: off, raises: [].}

const
  Bold = 1'i32
  Italic = 2'i32
  Code = 4'i32
  Dim = 8'i32
  Struck = 16'i32
  LinkUnit = 256'i32 ## a style from here up is its link's number

  Ws = {' ', '\t', '\n', '\r', '\f'} ## white space in text
  TagWs = Ws + {'\v'}                ## and inside a tag

type
  Tag = enum
    tNone # not an element this knows: it is passed through
    # no end tag
    tBr, tHr, tImg, tInput, tMeta, tLink, tBase, tWbr, tSource, tTrack, tArea, tCol, tEmbed, tParam,
    # start and end a block
    tP, tDiv, tSection, tArticle, tMain, tHeader, tFooter, tNav, tAside, tH1, tH2, tH3, tH4, tH5, tH6,
    tUl, tOl, tMenu, tLi, tDl, tDt, tDd, tBlockquote, tPre, tTable, tCaption, tThead, tTbody, tTfoot,
    tTr, tTd, tTh, tForm, tFieldset, tLegend, tFigure, tFigcaption, tAddress, tDetails, tSummary,
    tCenter, tHgroup, tDialog, tBody, tHtml, tHead, tNoscript, tOptgroup, tSearch, tListing, tXmp,
    tPlaintext, tDir,
    # dropped with all inside them
    tScript, tStyle, tTemplate, tSvg, tMath, tCanvas, tObject, tApplet, tAudio, tVideo, tMap,
    tNoembed, tNoframes, tFrameset, tDatalist,
    # their text is not markup, and is read
    tTitle, tTextarea, tOption, tIframe,
    # inline, with a meaning
    tA, tB, tStrong, tI, tEm, tCite, tVar, tDfn, tCode, tKbd, tSamp, tTt, tSmall, tSub, tSup, tS,
    tStrike, tDel, tQ, tSelect, tButton, tPicture, tSpan

  Attr = enum
    ## The attributes this reads, as AttrNames lists them; aNone is none of them.
    aHidden, aAriaHidden, aClass, aStyle, aId, aName, aType, aSrc, aTitle, aValue, aSelected, aHref, aAriaLabel,
    aStart, aMethod, aAction, aOpen, aRole, aAlt, aWidth, aHeight, aSrcset, aDataSrcset, aDataSrc, aDataLazySrc,
    aDataOriginal, aContent, aHttpEquiv, aProperty, aRel, aPlaceholder, aChecked, aNone

const
  AttrNames = "hidden aria-hidden class style id name type src title value selected href aria-label start " &
    "method action open role alt width height srcset data-srcset data-src data-lazy-src data-original content " &
    "http-equiv property rel placeholder checked"
  Names = "br hr img input meta link base wbr source track area col embed param " &
    "p div section article main header footer nav aside h1 h2 h3 h4 h5 h6 " &
    "ul ol menu li dl dt dd blockquote pre table caption thead tbody tfoot " &
    "tr td th form fieldset legend figure figcaption address details summary " &
    "center hgroup dialog body html head noscript optgroup search listing xmp " &
    "plaintext dir " &
    "script style template svg math canvas object applet audio video map " &
    "noembed noframes frameset datalist " &
    "title textarea option iframe " &
    "a b strong i em cite var dfn code kbd samp tt small sub sup s strike " &
    "del q select button picture span"

  # What is around a page rather than of it, by what its markup calls it, and
  # the label each gets (an index into Labels).
  Around = "nav navbar navigation menu sidebar footer masthead breadcrumb breadcrumbs cookie cookies " &
    "consent gdpr newsletter social share sharing toolbar popup modal advert advertisement skip toc"
  AroundLabel = "\x00\x00\x00\x01\x02\x03\x04\x05\x05\x06\x06\x06\x06\x07\x08\x08\x08\x09\x0a\x0a\x0b\x0b\x0c\x0d"
  Labels = "Navigation|Menu|Sidebar|Footer|Site header|Where this is|Cookie notice|Newsletter|Share|" &
    "Tools|Notice|Advertisement|Skip links|Contents|Search"
  HiddenClass = "hidden d-none is-hidden u-hidden hide invisible js-only print-only printonly noprint mw-editsection"
  MainId = "main content main-content maincontent mw-content-text article page-content primary"
  Placeholder = "blank. spacer. pixel. transparent. 1x1 loading. placeholder"
  NoFrame = "doubleclick googlesyndication googletagmanager adservice about:blank"

  Entities = "\x03amp\x00&\x02lt\x00<\x02gt\x00>\x04quot\x00\x22\x04apos\x00'\x04nbsp\x00\xa0\x04copy\x00\xa9\x03reg\x00" &
    "\xae\x05trade!\x22\x06hellip &\x05mdash \x14\x05ndash \x13\x05lsquo \x18\x05rsquo \x19\x05ldquo \x1c\x05rdqu" &
    "o \x1d\x05sbquo \x1a\x05bdquo \x1e\x05laquo\x00\xab\x05raquo\x00\xbb\x06lsaquo 9\x06rsaquo :\x04bull \x22" &
    "\x06middot\x00\xb7\x05times\x00\xd7\x06divide\x00\xf7\x04euro \xac\x05pound\x00\xa3\x03yen\x00\xa5\x04cent" &
    "\x00\xa2\x03deg\x00\xb0\x06plusmn\x00\xb1\x06frac12\x00\xbd\x06frac14\x00\xbc\x06frac34\x00\xbe\x04sect\x00" &
    "\xa7\x04para\x00\xb6\x05micro\x00\xb5\x05iexcl\x00\xa1\x06iquest\x00\xbf\x05szlig\x00\xdf\x06aacute\x00\xe1" &
    "\x06eacute\x00\xe9\x06iacute\x00\xed\x06oacute\x00\xf3\x06uacute\x00\xfa\x06yacute\x00\xfd\x06agrave\x00\xe0" &
    "\x06egrave\x00\xe8\x06igrave\x00\xec\x06ograve\x00\xf2\x06ugrave\x00\xf9\x05acirc\x00\xe2\x05ecirc\x00\xea" &
    "\x05icirc\x00\xee\x05ocirc\x00\xf4\x05ucirc\x00\xfb\x06atilde\x00\xe3\x06ntilde\x00\xf1\x06otilde\x00\xf5" &
    "\x04auml\x00\xe4\x04euml\x00\xeb\x04iuml\x00\xef\x04ouml\x00\xf6\x04uuml\x00\xfc\x04yuml\x00\xff\x05aring" &
    "\x00\xe5\x05aelig\x00\xe6\x05oelig\x01S\x06ccedil\x00\xe7\x06oslash\x00\xf8\x06scaron\x01a\x06zcaron\x01~" &
    "\x06Aacute\x00\xc1\x06Eacute\x00\xc9\x06Iacute\x00\xcd\x06Oacute\x00\xd3\x06Uacute\x00\xda\x06Agrave\x00\xc0" &
    "\x06Egrave\x00\xc8\x05Acirc\x00\xc2\x05Ecirc\x00\xca\x05Ocirc\x00\xd4\x06Atilde\x00\xc3\x06Ntilde\x00\xd1" &
    "\x06Otilde\x00\xd5\x04Auml\x00\xc4\x04Euml\x00\xcb\x04Ouml\x00\xd6\x04Uuml\x00\xdc\x05Aring\x00\xc5\x05AElig" &
    "\x00\xc6\x06Ccedil\x00\xc7\x06Oslash\x00\xd8\x06Scaron\x01`\x06Zcaron\x01}\x05minus\x22\x12\x04larr!\x90\x04" &
    "rarr!\x92\x04uarr!\x91\x04darr!\x93\x04harr!\x94\x02ne\x22`\x02le\x22d\x02ge\x22e\x05infin\x22\x1e\x05asymp" &
    "\x22H\x03shy\x00\xad\x04ensp\x00 \x04emsp\x00 \x06thinsp\x00 \x04zwnj \x0c\x03zwj \x0d\x03lrm \x0e\x03rlm " &
    "\x0f\x05prime 2\x05Prime 3\x06dagger  \x06permil 0"

static:
  var words = 1
  for c in Names:
    if c == ' ': inc words
  doAssert words == ord(high(Tag)), "Names and Tag must list the same elements"

type
  Entry = object
    ## An open element.
    tag: uint32       ## a Tag, or its name's hash with the top bit set
    style: int32      ## the style before it
    mark: int32       ## `count` when it opened
    aux: int32        ## what it changed, to put back
    own: int32        ## the field a <button> or a <select> is
    fShown, fLinkChars: int32 ## the page so far, when its fold started
    brk: bool         ## a break was owed when it opened
    fold: bool        ## it has a fold, still open
    fOpen: bool       ## a <details open>

  Pend = object
    ## A record that goes where its element started, written once the element
    ## is whole: a link's address (a link around nothing shown is no link and
    ## gets none), a <button> with its words, a <select> with its options, a
    ## <textarea> with its text.
    link: bool
    pos: int          ## where it goes in `rec`
    no: int           ## the link's or the field's number
    picked, options: int ## a select's
    optVal, optText: int ## where its last option's value and text are in `opts`
    noValue: bool     ## that option has no value of its own: its text is its value
    head: string      ## a field's record up to its value; a link's whole record
    value, first, label, opts: string

  San = enum
    ## How a text goes into a record's field, which a tab or a newline would end.
    sText  ## a block's words: a line break is \x0b
    sLine  ## a name, a label: one line
    sUrl   ## an address: its tabs and newlines are no part of it

  HtmlDigest* = object
    maxChars: int
    done: bool          ## the page ended, or was cut
    cutOff: bool        ## cut: more came than is kept
    buf: string       ## what of the page is not read yet, then the piece
    rec: string       ## records not handed over yet
    pend: seq[Pend]
    npend: int
    stack: seq[Entry]
    sp: int           ## how many elements are open
    hide: int         ## the open element everything inside which is hidden (-1)
    raw: Tag          ## inside an element whose text is not markup
    comment: bool     ## inside a comment
    keep: bool        ## that text is read
    kept: string
    ta, tb: int       ## the tag being read, in buf
    va, vb: int       ## the attribute just looked up: its value, in buf
    attrs: array[Attr, array[2, int32]] ## where each attribute's value is in the tag being read (-1: it has none)
    cur: string       ## the block being written
    curUnits: int     ## its length as JavaScript counts
    runs: seq[int32]
    style: int32
    space, brk, was, sep, gap, data, main, inHead, lastImg, hasTitle, hasDesc: bool
    bKind: char
    bMeta: int
    bMark: int        ## its mark, a list item's: -1 a bullet, else its number
    item: int         ## the mark the next block takes (0: none)
    count: int        ## goes up with everything shown
    h, pre, list, quote, row, noscript: int
    counters: seq[int32]
    form, button, summary, selectNo: int
    linkAt: int
    linkChars: int
    chars: int        ## of text written, as JavaScript counts
    shown: int        ## blocks written that show
    nlinks, nimgs, nfields, nforms, nfolds, nfeeds, nids: int
    linkLabel, picture, ld: string
    ids: string       ## `#` records of ids that name the block that comes next
    labels: seq[tuple[fold: int, text: string]] ## what <summary>s said
    t1, t2, t3, t4, t5: string ## scratch

proc initHtmlDigest*(maxChars = 2_000_000): HtmlDigest =
  HtmlDigest(maxChars: maxChars, hide: -1, form: -1, button: -1, summary: -1, selectNo: -1, linkAt: -1,
    bKind: 'p')

# --- bytes ---

proc memchr(s: pointer, c: cint, n: csize_t): pointer {.importc, header: "<string.h>".}

template lower(c: char): char = (if c >= 'A' and c <= 'Z': chr(ord(c) or 0x20) else: c)

proc find(s: string, c: char, at, to: int): int =
  ## Where `c` is in s[at ..< to], or -1.
  if to > at:
    let p = memchr(unsafeAddr s[at], c.cint, csize_t(to - at))
    if p != nil:
      return cast[int](p) - cast[int](unsafeAddr s[0])
  -1

proc isAt(s: string, at, to: int, word: string, ci = false): bool =
  ## Whether s reads `word` at `at`, before `to`.
  if at + word.len > to:
    return false
  for i in 0 ..< word.len:
    if (if ci: lower(s[at + i]) else: s[at + i]) != word[i]:
      return false
  true

proc findStr(s: string, at, to: int, word: string, ci = false): int =
  ## Where `word` is in s[at ..< to], or -1.
  var i = at
  while i + word.len <= to:
    if isAt(s, i, to, word, ci):
      return i
    inc i
  -1

proc wordIs(words: string, s: string, a, b: int, ci: bool): int =
  ## Which of `words` (a space apart) s[a ..< b] is, from 0, or -1.
  var i = 0
  var w = 0
  while i < words.len:
    var k = 0
    while i + k < words.len and words[i + k] != ' ' and a + k < b and
        (if ci: lower(s[a + k]) else: s[a + k]) == words[i + k]:
      inc k
    if a + k == b and (i + k == words.len or words[i + k] == ' '):
      return w
    while i < words.len and words[i] != ' ':
      inc i
    inc i
    inc w
  -1

proc hasWord(words: string, s: string, a, b: int, ci: bool): bool =
  ## Whether one of `words` is somewhere in s[a ..< b].
  var i = 0
  while i < words.len:
    var j = i
    while j < words.len and words[j] != ' ':
      inc j
    var p = a
    while p + (j - i) <= b:
      var k = 0
      while k < j - i and (if ci: lower(s[p + k]) else: s[p + k]) == words[i + k]:
        inc k
      if k == j - i:
        return true
      inc p
    i = j + 1
  false

proc tokenIn(words: string, s: string, a, b: int, seps: set[char], ci: bool): int =
  ## The first token of s[a ..< b] (apart by `seps`) that is one of `words`: which, or -1.
  var i = a
  while i < b:
    var j = i
    while j < b and s[j] notin seps:
      inc j
    if j > i:
      let w = wordIs(words, s, i, j, ci)
      if w >= 0:
        return w
    i = j + 1
  -1

proc units(s: string, a, b: int): int =
  ## How long s[a ..< b] is as JavaScript counts (UTF-16).
  for i in a ..< b:
    let c = s[i].uint8
    if (c and 0xC0) != 0x80:
      inc result
    if c >= 0xF0:
      inc result

proc addBytes(into: var string, s: string, a, b: int) =
  if b > a:
    let n = into.len
    into.setLen(n + b - a)
    copyMem(addr into[n], unsafeAddr s[a], b - a)

proc addRune(into: var string, code: int) =
  if code < 0x80:
    into.add chr(code)
  elif code < 0x800:
    into.add chr(0xC0 or (code shr 6))
    into.add chr(0x80 or (code and 0x3F))
  elif code < 0x10000:
    into.add chr(0xE0 or (code shr 12))
    into.add chr(0x80 or ((code shr 6) and 0x3F))
    into.add chr(0x80 or (code and 0x3F))
  else:
    into.add chr(0xF0 or (code shr 18))
    into.add chr(0x80 or ((code shr 12) and 0x3F))
    into.add chr(0x80 or ((code shr 6) and 0x3F))
    into.add chr(0x80 or (code and 0x3F))

proc put(into: var string, s: string, a, b: int, how: San) =
  ## s[a ..< b] as a record's field.
  var at = a
  for i in a ..< b:
    let c = s[i]
    if c == '\t' or c == '\n' or c == '\r':
      addBytes(into, s, at, i)
      at = i + 1
      if how == sText:
        into.add (if c == '\n': '\x0b' elif c == '\t': ' ' else: c)
      elif how == sLine:
        into.add ' '
  addBytes(into, s, at, b)

proc put(into: var string, s: string, how: San) =
  put(into, s, 0, s.len, how)

proc decode(into: var string, s: string, a, b: int, whole = false) =
  ## s[a ..< b] with its character references read (&amp; &#8212; &#x2014;), added to `into`.
  ## `whole`: only one that ends in its semicolon is one (an attribute's value: `?a=1&copy=2` is an address).
  var i = a
  while i < b:
    let amp = find(s, '&', i, b)
    if amp < 0:
      break
    addBytes(into, s, i, amp)
    let was = into.len
    var j = amp + 1
    var read = false
    if j < b and s[j] == '#':
      inc j
      let hex = j < b and s[j] == 'x'
      if hex:
        inc j
      let digits = j
      var code = 0
      while j < b:
        let c = lower(s[j])
        var v = -1
        if c >= '0' and c <= '9': v = ord(c) - 48
        elif hex and c >= 'a' and c <= 'f': v = ord(c) - 87
        if v < 0:
          break
        if code <= 0x10ffff:
          code = code * (if hex: 16 else: 10) + v
        inc j
      if j > digits:
        read = true
        if code <= 0 or code > 0x10ffff or (code >= 0xd800 and code < 0xe000):
          into.add "\xEF\xBF\xBD"
        elif code < 32 and code != 9 and code != 10:
          into.add ' '
        else:
          addRune(into, code)
    elif j < b and lower(s[j]) >= 'a' and lower(s[j]) <= 'z':
      while j < b and ((lower(s[j]) >= 'a' and lower(s[j]) <= 'z') or (s[j] >= '0' and s[j] <= '9')):
        inc j
      # Its name, among the ones this knows: <length> name, then its letter in two bytes.
      var e = 0
      while e < Entities.len:
        let n = Entities[e].int
        var k = 0
        if n == j - amp - 1:
          while k < n and s[amp + 1 + k] == Entities[e + 1 + k]:
            inc k
          if k == n:
            addRune(into, (Entities[e + 1 + n].int shl 8) or Entities[e + 2 + n].int)
            read = true
            break
        e += n + 3
    if read and j < b and s[j] == ';':
      inc j
    elif read and whole:
      into.setLen(was)
      read = false
    if read:
      i = j
    else:
      into.add '&'
      i = amp + 1
  addBytes(into, s, i, b)

# --- records that wait for their element ---

proc putAt(d: var HtmlDigest, at: int, record: string, after: int) =
  ## `record` into `rec` where its element started; what waits after it moves along.
  if at >= d.rec.len:
    d.rec.add record
  else:
    d.rec.insert(record, at)
  for i in after ..< d.npend:
    d.pend[i].pos += record.len

proc commitLinks(d: var HtmlDigest) =
  ## The links still open hold something shown (or are kept): their addresses go out, in their order.
  var first = d.npend
  while first > 0 and d.pend[first - 1].link:
    dec first
  for i in first ..< d.npend:
    d.putAt(d.pend[i].pos, d.pend[i].head, i + 1)
  d.npend = first

proc pendNew(d: var HtmlDigest, link: bool, no: int): int =
  ## A record to wait: its place in `pend`, or -1 when too many do.
  if d.npend >= 12:
    return -1
  if d.npend >= d.pend.len:
    d.pend.setLen(d.npend + 1)
  result = d.npend
  inc d.npend
  template p: untyped = d.pend[result]
  p.link = link
  p.no = no
  p.pos = d.rec.len
  p.picked = -1
  p.options = 0
  p.noValue = false
  p.head.setLen(0)
  p.value.setLen(0)
  p.first.setLen(0)
  p.label.setLen(0)
  p.opts.setLen(0)

proc pendField(d: HtmlDigest, no: int): int =
  ## Where field `no` waits, or -1.
  if no >= 0:
    for i in 0 ..< d.npend:
      if not d.pend[i].link and d.pend[i].no == no:
        return i
  -1

proc fieldOut(d: var HtmlDigest, at: int) =
  ## The field that waited at `at` is whole: its record goes where the field is.
  template p: untyped = d.pend[at]
  d.t5.setLen(0)
  d.t5.add p.head
  put(d.t5, p.value, sText)
  d.t5.add '\t'
  put(d.t5, p.label, sLine)
  d.t5.add p.opts
  d.t5.add '\n'
  d.putAt(p.pos, d.t5, at + 1)
  # The ones after it keep their order; its strings go to the end to be used again.
  for i in at ..< d.npend - 1:
    swap(d.pend[i], d.pend[i + 1])
  dec d.npend

proc optionEnd(d: var HtmlDigest, at: int) =
  ## A select's last option is whole: its value is its text where it has none of its own.
  template p: untyped = d.pend[at]
  if p.options == 0:
    return
  if p.noValue:
    p.noValue = false
    d.t5.setLen(0)
    addBytes(d.t5, p.opts, p.optText, p.opts.len)
    p.opts.insert(d.t5, p.optVal)
    p.optText += d.t5.len
  if p.options == 1:
    p.first.setLen(0)
    addBytes(p.first, p.opts, p.optVal, p.optText - 1)
  if p.picked == p.options - 1:
    p.value.setLen(0)
    addBytes(p.value, p.opts, p.optVal, p.optText - 1)

# --- text ---

proc mark(d: var HtmlDigest, style: int32) =
  ## The text from here on is in `style`.
  let n = d.runs.len
  if n > 0 and d.runs[n - 1] == style:
    return
  if n > 0 and d.runs[n - 2] == d.curUnits.int32:
    d.runs[n - 1] = style
  else:
    d.runs.add d.curUnits.int32
    d.runs.add style

proc place(d: HtmlDigest): int =
  ## A block's meta: its list and quote depths, a gap above it.
  min(d.list, 15) + min(d.quote, 7) * 16 + (if d.gap: 128 else: 0)

proc showed(d: var HtmlDigest) =
  ## Something that shows was written: the links open around it are links.
  inc d.count
  if d.npend > 0 and d.pend[d.npend - 1].link:
    d.commitLinks()

proc named(d: var HtmlDigest) =
  ## A block starts here: the ids that waited name it (their records go before its own).
  if d.ids.len > 0:
    d.rec.add d.ids
    d.ids.setLen(0)

proc flush(d: var HtmlDigest) =
  ## Ends the block being written.
  var n = d.cur.len
  if n == 0:
    return
  d.space = false
  if d.pre == 0:
    # A line break at its end is none.
    while n > 0 and d.cur[n - 1] == '\n':
      dec n
  if n > 0:
    let at = d.pendField(d.button)
    if d.button >= 0:
      # A button's own words: its label.
      if at >= 0:
        if d.pend[at].label.len > 0:
          d.pend[at].label.add ' '
        addBytes(d.pend[at].label, d.cur, 0, n)
    elif d.summary >= 0:
      # A <summary>'s: its fold's name, sent whole each time it grows.
      var l = 0
      while l < d.labels.len and d.labels[l].fold != d.summary:
        inc l
      if l == d.labels.len:
        d.labels.add (d.summary, "")
      if d.labels[l].text.len > 0:
        d.labels[l].text.add ' '
      addBytes(d.labels[l].text, d.cur, 0, n)
      d.rec.add 'S'
      d.rec.addInt d.summary
      d.rec.add '\t'
      put(d.rec, d.labels[l].text, sLine)
      d.rec.add '\n'
    else:
      d.rec.add d.bKind
      d.rec.addInt d.bMeta
      d.rec.add '\t'
      if not (d.runs.len == 2 and d.runs[1] == 0):
        for i in 0 ..< d.runs.len:
          if i > 0:
            d.rec.add ','
          d.rec.addInt d.runs[i]
      d.rec.add '\t'
      if d.bKind == 'l':
        if d.bMark < 0:
          d.rec.add "\xE2\x80\xA2"
        else:
          d.rec.addInt d.bMark
          d.rec.add '.'
        d.rec.add '\x01'
      put(d.rec, d.cur, 0, n, sText)
      d.rec.add '\n'
      d.chars += units(d.cur, 0, n)
      inc d.shown
      d.lastImg = false
  d.cur.setLen(0)
  d.curUnits = 0
  d.runs.setLen(0)

proc say(d: var HtmlDigest, s: string, a, b: int) =
  ## Text as it is shown, into the block being written; the block it starts is begun.
  if d.hide >= 0:
    return
  if d.brk:
    d.flush()
    d.brk = false
    d.sep = false
  if d.sep:
    d.sep = false
    if d.cur.len > 0:
      if d.data:
        d.mark(Dim)
        d.cur.add "  |  "
        d.curUnits += 5
      else:
        d.space = true
  if d.cur.len == 0:
    # A block starts: what it is is what is open now, not when it ends.
    d.named()
    d.bKind = if d.pre > 0: 'r' elif d.h > 0: 'h' elif d.item != 0: 'l' elif d.row > 0: 'w' else: 'p'
    d.bMeta = d.place() + (d.h shl 8)
    d.bMark = d.item
    d.item = 0
    d.gap = false
  if d.space and d.cur.len > 0 and d.cur[d.cur.len - 1] != '\n':
    # The space between two runs is the link's only inside one link.
    let before = if d.runs.len > 0: d.runs[d.runs.len - 1] else: 0'i32
    if before >= LinkUnit:
      if (before shr 8) != (d.style shr 8): d.mark(d.style and 255)
      else: inc d.linkChars
    d.cur.add ' '
    inc d.curUnits
  d.space = false
  d.mark(d.style)
  addBytes(d.cur, s, a, b)
  let u = units(s, a, b)
  d.curUnits += u
  d.showed()
  if d.style >= LinkUnit:
    d.linkChars += u
  if d.curUnits > 20000 and d.pre == 0:
    # One block of a page that never breaks: cut at a space.
    var i = d.cur.len - 1
    while i >= 0 and d.cur[i] != ' ':
      dec i
    if i >= 0:
      let cut = units(d.cur, 0, i)
      if cut > 10000:
        d.t4.setLen(0)
        addBytes(d.t4, d.cur, i + 1, d.cur.len)
        d.cur.setLen(i)
        let style = d.style
        d.flush()
        d.mark(style)
        d.cur.add d.t4
        d.curUnits = units(d.t4, 0, d.t4.len)

proc unseen(s: string, i, n: int): int =
  ## How many bytes of a letter that shows nothing start at i (a soft hyphen, a
  ## zero-width space, a direction mark): 0 for any other.
  let c = s[i].uint8
  if c == 0xC2:
    return (if i + 1 < n and s[i + 1].uint8 == 0xAD: 2 else: 0)
  if i + 2 < n:
    let c1 = s[i + 1].uint8
    let c2 = s[i + 2].uint8
    if c == 0xE2:
      if c1 == 0x80 and ((c2 >= 0x8B and c2 <= 0x8F) or (c2 >= 0xA8 and c2 <= 0xAE)):
        return 3
      if c1 == 0x81 and c2 >= 0xA0 and c2 <= 0xA4:
        return 3
    elif c == 0xEF and c1 == 0xBB and c2 == 0xBF:
      return 3
  0

proc words(d: var HtmlDigest, s: string, a, b: int) =
  ## Text as the page wrote it: its entities read, its white space one space.
  if d.hide >= 0 or b <= a:
    return
  d.t1.setLen(0)
  decode(d.t1, s, a, b)
  let n = d.t1.len
  d.t2.setLen(0)
  if d.pre > 0:
    var i = 0
    if d.brk and d.cur.len == 0 and n > 0 and d.t1[0] == '\n':
      i = 1 # the newline after <pre>
    while i < n:
      let c = d.t1[i]
      if c == '\r':
        d.t2.add '\n'
        if i + 1 < n and d.t1[i + 1] == '\n':
          inc i
      elif c == '\t':
        d.t2.add "    "
      elif c == '\x01' or c == '\x0b':
        d.t2.add ' '
      else:
        d.t2.add c
      inc i
    if d.t2.len > 0:
      d.say(d.t2, 0, d.t2.len)
    return
  var i = 0
  var wasSpace = false
  while i < n:
    let c = d.t1[i]
    if c in Ws:
      if not wasSpace:
        d.t2.add ' '
      wasSpace = true
      inc i
      continue
    wasSpace = false
    if c.uint8 >= 0xC2:
      let skip = unseen(d.t1, i, n)
      if skip > 0:
        i += skip
        continue
    d.t2.add (if c == '\x01' or c == '\x0b': ' ' else: c)
    inc i
  var at = 0
  var to = d.t2.len
  if to == 0:
    return
  let lead = d.t2[0] == ' '
  let tail = to > 1 and d.t2[to - 1] == ' '
  if lead: at = 1
  if tail: dec to
  if at >= to:
    if d.cur.len > 0 and not d.brk:
      d.space = true
    return
  if lead and d.cur.len > 0 and not d.brk:
    d.space = true
  d.say(d.t2, at, to)
  if tail:
    d.space = true

# --- tags ---

const
  Roles = "main navigation contentinfo complementary banner dialog alertdialog search"
  RoleLabel = "\x00\x00\x03\x02\x04\x0a\x0a\x0e"
  FieldKinds = "text password checkbox radio select textarea submit hidden"
  InputTypes = "image submit hidden checkbox radio password button reset file range color"
  Lt = "<"
  StyleOf = "\x01\x01\x02\x02\x02\x02\x02\x04\x04\x04\x04\x08\x08\x08\x10\x10\x10" # b strong, i em cite var dfn, code kbd samp tt, small sub sup, s strike del
  Cdata = "<![CDATA["

type
  FieldKind = enum fkText, fkPassword, fkCheckbox, fkRadio, fkSelect, fkTextarea, fkSubmit, fkHidden
  Act = enum
    ## What an element does when it starts and ends: the elements that do the same are one case.
    cNone, cA, cStyle, cQ, cH, cList, cLi, cDtDd, cQuote, cPre, cTable, cTr, cCell, cCaption, cForm, cSelect,
    cButton, cDetails, cSummary, cDialog, cPicture, cNoscript, cHead, cBody, cMain, cArticle, cNav, cHeader,
    cDiv, cP

const Acts = block:
  var acts: array[Tag, Act]
  for t in tB .. tDel: acts[t] = cStyle
  for t in tH1 .. tH6: acts[t] = cH
  for t in [tUl, tOl, tMenu, tDir, tDl]: acts[t] = cList
  for t in [tDt, tDd]: acts[t] = cDtDd
  for t in [tPre, tListing, tXmp, tPlaintext]: acts[t] = cPre
  for t in [tTd, tTh]: acts[t] = cCell
  for t in [tCaption, tFigcaption]: acts[t] = cCaption
  for t in [tNav, tAside, tFooter]: acts[t] = cNav
  for t in [tDiv, tSection]: acts[t] = cDiv
  for (t, act) in [(tA, cA), (tQ, cQ), (tLi, cLi), (tBlockquote, cQuote), (tTable, cTable), (tTr, cTr), (tForm, cForm),
      (tSelect, cSelect), (tButton, cButton), (tDetails, cDetails), (tSummary, cSummary), (tDialog, cDialog),
      (tPicture, cPicture), (tNoscript, cNoscript), (tHead, cHead), (tBody, cBody), (tMain, cMain),
      (tArticle, cArticle), (tHeader, cHeader), (tP, cP)]:
    acts[t] = act
  acts

template known(code: uint32): Tag = (if code < 256: Tag(code) else: tNone)
template isVoid(t: Tag): bool = t >= tBr and t <= tParam
template isBlock(t: Tag): bool = t >= tP and t <= tDir
template isSkip(t: Tag): bool = t >= tScript and t <= tDatalist
template isText(t: Tag): bool = t >= tTitle and t <= tIframe

proc tagOf(s: string, a, b: int): uint32 =
  ## The element s[a ..< b] names: its Tag, or a hash of a name this does not know.
  let w = wordIs(Names, s, a, b, true)
  if w >= 0:
    return uint32(w + 1)
  var h = 2166136261'u32
  for i in a ..< b:
    h = (h xor lower(s[i]).uint32) * 16777619'u32
  h or 0x8000_0000'u32

proc nameAt(s: string, at, to: int, t: Tag): int =
  ## Whether s reads element `t`'s name at `at` (in either case): 1 it does,
  ## 0 it does not, -1 s ends before it can be told.
  var i = 0
  for w in 1 ..< ord(t):
    while Names[i] != ' ':
      inc i
    inc i
  var k = 0
  while i + k < Names.len and Names[i + k] != ' ':
    if at + k >= to:
      return -1
    if lower(s[at + k]) != Names[i + k]:
      return 0
    inc k
  1

proc readAttrs(d: var HtmlDigest, at: int) =
  ## The attributes of the tag being read, from `at` (past its name): where the value of each one this knows is.
  for a in Attr:
    d.attrs[a][0] = -1 # aNone stays so
  let b = d.tb
  var i = at
  while i < b:
    if d.buf[i] in TagWs or d.buf[i] == '/':
      inc i
      continue
    let name = i
    while i < b and d.buf[i] notin TagWs and d.buf[i] != '=' and d.buf[i] != '/':
      inc i
    if i == name:
      inc i # a stray "="
      continue
    let which = wordIs(AttrNames, d.buf, name, i, true)
    var k = i
    while k < b and d.buf[k] in TagWs:
      inc k
    var va = i
    var vb = i
    if k < b and d.buf[k] == '=':
      inc k
      while k < b and d.buf[k] in TagWs:
        inc k
      va = k
      if k < b and (d.buf[k] == '"' or d.buf[k] == '\''):
        inc va
        vb = find(d.buf, d.buf[k], va, b)
        if vb < 0: vb = b
        i = min(b, vb + 1)
      else:
        while k < b and d.buf[k] notin TagWs:
          inc k
        vb = k
        i = k
    if which >= 0 and d.attrs[Attr(which)][0] < 0:
      d.attrs[Attr(which)] = [va.int32, vb.int32]

proc attr(d: var HtmlDigest, a: Attr): bool =
  ## Whether the tag being read has the attribute; its value is then buf[va ..< vb] (as written: decode it).
  d.va = d.attrs[a][0]
  d.vb = d.attrs[a][1]
  d.va >= 0

proc attrv(d: var HtmlDigest, name: Attr, into: var string): bool =
  ## The attribute's value, its entities read, into `into`; false (and "") when the tag has none.
  into.setLen(0)
  if d.attr(name):
    decode(into, d.buf, d.va, d.vb, true)
    return true
  false

proc has(d: var HtmlDigest, name: Attr, into: var string): bool =
  ## The attribute's value into `into`: true when it says something.
  d.attrv(name, into) and into.len > 0

proc firstOf(d: var HtmlDigest, into: var string, a, b: Attr, c = aNone) =
  ## The first of the attributes a, b, c that says something ("" when none does).
  if d.has(a, into) or d.has(b, into) or d.has(c, into): return
  into.setLen(0)

proc setTo(s: var string, text: string) =
  s.setLen(0)
  s.add text

proc parseInt(s: string, a, b: int, value: var int): bool =
  ## As JavaScript's parseInt reads a number's start.
  var i = a
  while i < b and s[i] in TagWs:
    inc i
  let neg = i < b and s[i] == '-'
  if i < b and (s[i] == '-' or s[i] == '+'):
    inc i
  let digits = i
  var v = 0
  while i < b and s[i] >= '0' and s[i] <= '9':
    if v < 100_000_000:
      v = v * 10 + (ord(s[i]) - 48)
    inc i
  if i == digits:
    return false
  value = if neg: -v else: v
  true

proc tidy(s: var string) =
  ## Its white space one space, none at its ends.
  var o = 0
  var wasSpace = true
  for i in 0 ..< s.len:
    let c = s[i]
    if c in Ws:
      if not wasSpace:
        s[o] = ' '
        inc o
      wasSpace = true
    else:
      s[o] = c
      inc o
      wasSpace = false
  # No-break spaces at an end go too, as JavaScript trims.
  while true:
    if o > 0 and (s[o - 1] == ' ' or s[o - 1] == '\v'): dec o
    elif o > 1 and s[o - 2] == '\xC2' and s[o - 1] == '\xA0': o -= 2
    else: break
  var a = 0
  while true:
    if a < o and (s[a] == ' ' or s[a] == '\v'): inc a
    elif a + 1 < o and s[a] == '\xC2' and s[a + 1] == '\xA0': a += 2
    elif a + 2 < o and s[a] == '\xEF' and s[a + 1] == '\xBB' and s[a + 2] == '\xBF': a += 3
    else: break
  if a > 0:
    moveMem(addr s[0], addr s[a], o - a)
  s.setLen(o - a)

proc cutUnits(s: var string, most: int) =
  ## At most `most` letters of it, as JavaScript counts.
  var n = 0
  for i in 0 ..< s.len:
    let c = s[i].uint8
    if (c and 0xC0) != 0x80:
      inc n
      if c >= 0xF0: inc n
      if n > most:
        s.setLen(i)
        return

proc enter(d: var HtmlDigest, code: uint32, aux: int) =
  if d.sp >= d.stack.len:
    d.stack.setLen(d.sp + 32)
  d.stack[d.sp] = Entry(tag: code, style: d.style, mark: d.count.int32, aux: aux.int32, brk: d.was)
  inc d.sp

proc breakHere(d: var HtmlDigest) =
  ## A block starts or ends: the text after it is a new block.
  if d.cur.len > 0:
    d.brk = true
  d.space = false

proc endBlock(d: var HtmlDigest) =
  d.breakHere()
  if d.brk:
    d.flush()
    d.brk = false

proc setLabel(d: var HtmlDigest, which: int) =
  ## t3 is label number `which`.
  d.t3.setLen(0)
  var i = 0
  for w in 0 ..< which:
    while Labels[i] != '|':
      inc i
    inc i
  while i < Labels.len and Labels[i] != '|':
    d.t3.add Labels[i]
    inc i

proc foldOpen(d: var HtmlDigest): int =
  ## Something around the page starts, named in t3: a record where its line would go.
  d.endBlock()
  d.named()
  d.rec.add '['
  d.rec.addInt d.place()
  d.rec.add '\t'
  put(d.rec, d.t3, sLine)
  d.rec.add '\n'
  d.lastImg = false
  result = d.nfolds
  inc d.nfolds

proc foldOwn(d: var HtmlDigest, open = false) =
  ## The element just entered has the fold just opened: the page so far, for when it ends.
  template e: untyped = d.stack[d.sp - 1]
  e.fold = true
  e.fOpen = open
  e.fShown = d.shown.int32
  e.fLinkChars = d.linkChars.int32

proc foldIn(d: var HtmlDigest, code: uint32, byName: bool, open = false) =
  ## The element being read is around the page (named in t3): it is entered with a fold of its own.
  ## `byName`: only its class or role says so, and the app keeps the fold if it is mostly links.
  let f = d.foldOpen()
  d.enter(code, if byName: -(f + 1) else: f + 1)
  d.foldOwn(open)

proc labelOr(d: var HtmlDigest, which: int) =
  ## t3 is the element's aria-label, else label number `which`.
  if not d.has(aAriaLabel, d.t3):
    d.setLabel(which)

proc foldEnd(d: var HtmlDigest, e: Entry, fold: int, ifLinks: bool) =
  ## The element of a fold ended. `ifLinks`: it is around the page only by its name.
  if not e.fold:
    return # none, or the page's own part started inside it
  if d.brk or d.cur.len > 0:
    d.flush()
    d.brk = false
  d.rec.add ']'
  d.rec.addInt fold
  d.rec.add (if ifLinks: "\t1\t" elif e.fOpen: "\t2\t" else: "\t0\t")
  d.rec.addInt d.linkChars - e.fLinkChars
  d.rec.add '\n'
  # What follows something around the page stands apart from it, folded or not.
  if d.shown > e.fShown:
    d.gap = true

proc foundMain(d: var HtmlDigest) =
  ## The page's own part starts here.
  d.main = true
  d.endBlock()
  d.rec.add "M\n"
  # What is open around it holds the page: it is no fold (a <details> with no name yet aside).
  for i in 0 ..< d.sp:
    if d.stack[i].fold:
      var named = d.stack[i].tag != tDetails.uint32
      for l in 0 ..< d.labels.len:
        if d.labels[l].fold == d.stack[i].aux - 1 and d.labels[l].text.len > 0:
          named = true
      if named:
        d.stack[i].fold = false

proc media(d: var HtmlDigest) =
  ## A video, a sound or a frame: a line (its name in t3) that is a link to it (t4).
  d.endBlock()
  d.named()
  inc d.nlinks
  d.rec.add 'A'
  put(d.rec, d.t4, sUrl)
  d.rec.add "\np"
  d.rec.addInt d.place()
  d.rec.add "\t0,"
  d.rec.addInt Dim + d.nlinks.int32 * LinkUnit
  d.rec.add '\t'
  let at = d.rec.len
  put(d.rec, d.t3, sText)
  # Its host, where the address has one.
  var i = 0
  if isAt(d.t4, 0, d.t4.len, "https:", true): i = 6
  elif isAt(d.t4, 0, d.t4.len, "http:", true): i = 5
  if isAt(d.t4, i, d.t4.len, "//"):
    i += 2
    var e = i
    while e < d.t4.len and d.t4[e] notin {'/', '?', '#'}:
      inc e
    if e > i:
      if isAt(d.t4, i, e, "www."): i += 4
      d.rec.add " ("
      put(d.rec, d.t4, i, e, sText)
      d.rec.add ')'
  d.chars += units(d.rec, at, d.rec.len)
  d.rec.add '\n'
  inc d.shown
  d.lastImg = false
  d.showed()
  d.brk = false

proc field(d: var HtmlDigest, kind: FieldKind, wait: bool, input = false): int =
  ## A form's field, from the tag being read: its number. `wait`: its record
  ## goes out when its element is whole (fieldOut); `input`: an <input> that submits.
  result = d.nfields
  inc d.nfields
  discard d.attrv(aName, d.t3)
  let hasValue = d.attrv(aValue, d.t4)
  d.firstOf(d.t5, aPlaceholder, aAriaLabel, aTitle)
  var on = false
  if kind == fkCheckbox or kind == fkRadio:
    on = d.attr(aChecked)
    if not hasValue:
      d.t4.add "on"
  if input:
    d.t5.setLen(0)
    if d.t4.len > 0: d.t5.add d.t4
    elif not (d.has(aAlt, d.t5)):
      setTo(d.t5, "Submit")
  elif kind == fkSubmit:
    d.t5.setLen(0) # a <button>: its words are its label
  var meta = 0
  if kind != fkHidden:
    d.endBlock()
    d.named()
    meta = d.place()
    d.gap = false
    inc d.shown
    d.lastImg = false
    d.showed()
  let at = if wait: d.pendNew(false, result) else: -1
  d.t1.setLen(0)
  d.t1.add 'f'
  d.t1.addInt meta
  d.t1.add '\t'
  d.t1.addInt d.form
  d.t1.add '\t'
  var w = 0
  for i in 0 ..< FieldKinds.len:
    if FieldKinds[i] == ' ': inc w
    elif w == ord(kind): d.t1.add FieldKinds[i]
  d.t1.add (if on: "\t1\t" else: "\t0\t")
  put(d.t1, d.t3, sLine)
  d.t1.add '\t'
  if at >= 0:
    d.pend[at].head.add d.t1
    d.pend[at].value.add d.t4
    d.pend[at].label.add d.t5
  else:
    d.rec.add d.t1
    put(d.rec, d.t4, sText)
    d.rec.add '\t'
    if wait and kind == fkSubmit:
      d.t5.add (if d.t4.len > 0: d.t4 else: "Submit")
    put(d.rec, d.t5, sLine)
    d.rec.add '\n'

proc pickSrcset(s: string, a, b: var int) =
  ## The candidate of a srcset nearest 640 pixels wide: s[a ..< b] ("" when it has none).
  a = 0
  b = 0
  var bestW = 0
  var i = 0
  let n = s.len
  while i < n:
    # A part ends at a comma before white space, or before an address.
    var e = i
    var next = n
    while e < n:
      if s[e] == ',' and e + 1 < n:
        if s[e + 1] in TagWs:
          next = e + 1
          while next < n and s[next] in TagWs: inc next
          break
        if s[e + 1] == '/' or isAt(s, e + 1, n, "http:") or isAt(s, e + 1, n, "https:"):
          next = e + 1
          break
      inc e
    var x = i
    while x < e and s[x] in TagWs: inc x
    var y = x
    while y < e and s[y] notin TagWs: inc y
    if y > x:
      # Its width: "640w", or "2x" of 640.
      var w = 640_000
      var k = y
      while k < e and s[k] in TagWs: inc k
      if k > y:
        var v = 0
        let digits = k
        while k < e and s[k] >= '0' and s[k] <= '9':
          if v < 1_000_000: v = v * 10 + (ord(s[k]) - 48)
          inc k
        var milli = 0
        var okay = k > digits
        if okay and k < e and s[k] == '.':
          let frac = k + 1
          var scale = 100
          k = frac
          while k < e and s[k] >= '0' and s[k] <= '9':
            milli += (ord(s[k]) - 48) * scale
            scale = scale div 10
            inc k
          okay = k > frac
        if okay and k < e and (s[k] == 'w' or s[k] == 'x'):
          w = v * 1000 + milli
          if s[k] == 'x': w = w * 640
      if b == 0 or (if bestW < 480_000: w > bestW else: w >= 480_000 and w < bestW):
        a = x
        b = y
        bestW = w
    i = next

proc picture(d: var HtmlDigest) =
  ## An <img>: a picture, or (an icon, an SVG) its words.
  discard d.attrv(aSrc, d.t4)
  if d.t4.len == 0 or isAt(d.t4, 0, d.t4.len, "data:", true) or hasWord(Placeholder, d.t4, 0, d.t4.len, true):
    # What a lazy loader would have put there.
    d.firstOf(d.t3, aDataSrc, aDataLazySrc, aDataOriginal)
    if d.t3.len == 0:
      if d.picture.len > 0: d.t3.add d.picture
      else: d.firstOf(d.t3, aSrcset, aDataSrcset)
      if d.t3.len > 0:
        var x, y: int
        pickSrcset(d.t3, x, y)
        d.t5.setLen(0)
        addBytes(d.t5, d.t3, x, y)
        swap(d.t3, d.t5)
    if d.t3.len > 0: swap(d.t3, d.t4)
    elif not (isAt(d.t4, 0, d.t4.len, "data:image/") and d.t4.len < 20000): d.t4.setLen(0)
  d.picture.setLen(0)
  discard d.attrv(aAlt, d.t3)
  tidy(d.t3)
  var w, h = 0
  if d.attr(aWidth): discard parseInt(d.buf, d.va, d.vb, w)
  if d.attr(aHeight): discard parseInt(d.buf, d.va, d.vb, h)
  let small = (w > 0 and w < 40) or (h > 0 and h < 40)
  let link = d.style shr 8
  var svg = isAt(d.t4, 0, d.t4.len, "data:image/svg", true)
  var at = 0
  while not svg:
    at = findStr(d.t4, at, d.t4.len, ".svg", true)
    if at < 0: break
    at += 4
    svg = at == d.t4.len or d.t4[at] == '?' or d.t4[at] == '#'
  if d.t4.len == 0 or small or svg or d.nimgs >= 400 or (d.noscript > 0 and d.nimgs > 0 and d.lastImg):
    # An icon, or a picture this cannot draw: its words, where a link has no others.
    if d.t3.len > 0 and link != 0 and d.count == d.linkAt:
      if d.linkLabel.len == 0: d.linkLabel.add d.t3
    elif d.t3.len > 0 and not small and units(d.t3, 0, d.t3.len) > 2 and link == 0:
      d.t5.setLen(0)
      d.t5.add '['
      d.t5.add d.t3
      d.t5.add ']'
      d.words(d.t5, 0, d.t5.len)
    return
  d.endBlock()
  d.named()
  d.rec.add 'i'
  d.rec.addInt d.place()
  d.rec.add '\t'
  d.rec.addInt w
  d.rec.add '\t'
  d.rec.addInt h
  d.rec.add '\t'
  d.rec.addInt link
  d.rec.add '\t'
  put(d.rec, d.t4, sUrl)
  d.rec.add '\t'
  put(d.rec, d.t3, sLine)
  d.rec.add '\n'
  inc d.nimgs
  d.chars += units(d.t3, 0, d.t3.len)
  inc d.shown
  d.lastImg = true
  d.showed()
  d.gap = false

proc single(d: var HtmlDigest, t: Tag) =
  ## An element with no end tag.
  case t
  of tBr:
    if d.pre > 0:
      d.t3.setLen(0)
      d.t3.add '\n'
      d.say(d.t3, 0, 1)
    elif d.brk or d.cur.len == 0:
      d.gap = true
    elif d.cur[d.cur.len - 1] == '\n':
      # Two in a row: a paragraph ends.
      d.brk = true
      d.gap = true
    else:
      d.cur.add '\n'
      inc d.curUnits
      d.space = false
  of tHr:
    d.endBlock()
    d.named()
    d.rec.add '-'
    d.rec.addInt d.place()
    d.rec.add '\n'
    inc d.shown
    d.lastImg = false
  of tImg:
    d.picture()
  of tSource:
    if d.picture.len == 0:
      d.firstOf(d.t4, aSrcset, aDataSrcset)
      if d.t4.len > 0 and not (d.attrv(aType, d.t3) and hasWord("avif svg", d.t3, 0, d.t3.len, true)):
        d.picture.add d.t4
  of tInput:
    if d.form < 0:
      return # only a script reads it
    var kind = -1
    if d.attr(aType) and d.vb > d.va:
      kind = wordIs(InputTypes, d.buf, d.va, d.vb, true)
      if kind < 0: kind = 99
    case kind
    of 0, 1: discard d.field(fkSubmit, false, true)
    of 2: discard d.field(fkHidden, false)
    of 3: discard d.field(fkCheckbox, false)
    of 4: discard d.field(fkRadio, false)
    of 5: discard d.field(fkPassword, false)
    of 6 .. 10: discard
    else: discard d.field(fkText, false)
  of tBase:
    if d.has(aHref, d.t3):
      d.rec.add 'B'
      put(d.rec, d.t3, sUrl)
      d.rec.add '\n'
  of tMeta:
    if not d.attrv(aContent, d.t4):
      return
    d.firstOf(d.t3, aHttpEquiv, aName, aProperty)
    let key = wordIs("refresh description og:description og:title", d.t3, 0, d.t3.len, true)
    if key == 0:
      # "5; url=/there": where it sends the browser, when soon.
      var i = 0
      var secs = 0
      let n = d.t4.len
      while i < n and d.t4[i] in TagWs: inc i
      let digits = i
      while i < n and d.t4[i] >= '0' and d.t4[i] <= '9':
        if secs < 100_000: secs = secs * 10 + (ord(d.t4[i]) - 48)
        inc i
      if i == digits or secs > 10: return
      while i < n and d.t4[i] in TagWs: inc i
      if i >= n or (d.t4[i] != ';' and d.t4[i] != ','): return
      inc i
      while i < n and d.t4[i] in TagWs: inc i
      if isAt(d.t4, i, n, "url", true):
        var k = i + 3
        while k < n and d.t4[k] in TagWs: inc k
        if k < n and d.t4[k] == '=':
          i = k + 1
          while i < n and d.t4[i] in TagWs: inc i
      if i < n and (d.t4[i] == '"' or d.t4[i] == '\''): inc i
      var e = i
      while e < n and d.t4[e] != '"' and d.t4[e] != '\'': inc e
      if e > i:
        d.rec.add 'R'
        put(d.rec, d.t4, i, e, sUrl)
        d.rec.add '\n'
    elif key == 1 or (key == 2 and not d.hasDesc):
      cutUnits(d.t4, 600)
      d.hasDesc = d.t4.len > 0
      d.rec.add 'D'
      put(d.rec, d.t4, sLine)
      d.rec.add '\n'
    elif key == 3 and not d.hasTitle:
      cutUnits(d.t4, 200)
      d.hasTitle = d.t4.len > 0
      d.rec.add 'T'
      put(d.rec, d.t4, sLine)
      d.rec.add '\n'
  of tLink:
    if d.attrv(aRel, d.t3) and findStr(d.t3, 0, d.t3.len, "alternate", true) >= 0 and
        d.attrv(aType, d.t3) and hasWord("rss atom feed+json", d.t3, 0, d.t3.len, true) and d.nfeeds < 6 and
        d.has(aHref, d.t4):
      inc d.nfeeds
      d.rec.add 'E'
      put(d.rec, d.t4, sUrl)
      d.rec.add '\t'
      discard d.attrv(aTitle, d.t3)
      put(d.rec, d.t3, sLine)
      d.rec.add '\n'
  else:
    discard

proc close(d: var HtmlDigest, code: uint32)

proc closeOpen(d: var HtmlDigest, t, stop, stop2, stop3: Tag) =
  ## Closes the nearest open `t`, unless a `stop` (or a table) is nearer.
  var i = d.sp - 1
  while i >= 0:
    let c = d.stack[i].tag
    if c == t.uint32:
      d.close(t.uint32)
      return
    if c == tTable.uint32 or (c != 0 and (c == stop.uint32 or c == stop2.uint32 or c == stop3.uint32)):
      return
    dec i

proc inside(d: HtmlDigest, a, b, c: Tag): bool =
  for i in 0 ..< d.sp:
    let t = d.stack[i].tag
    if t == a.uint32 or t == b.uint32 or t == c.uint32:
      return true
  false

proc hideIn(d: var HtmlDigest, code: uint32) =
  ## The element is entered, and all inside it is hidden.
  d.enter(code, 0)
  d.hide = d.sp - 1

proc maybeAround(d: var HtmlDigest, code: uint32, t: Tag) =
  ## A <div> or a list named for what is around a page (its class, its id): a fold starts, which the app
  ## keeps if it turns out to be mostly links.
  d.t3.setLen(0)
  if d.attr(aClass): decode(d.t3, d.buf, d.va, d.vb, true)
  d.t3.add ' '
  if d.attr(aId): decode(d.t3, d.buf, d.va, d.vb, true)
  var w = -1
  if d.t3.len > 1 and d.row == 0:
    w = tokenIn(Around, d.t3, 0, d.t3.len, TagWs + {'_', '-'}, true)
  let list = t in {tUl, tOl, tMenu, tDir, tDl}
  if not list:
    d.breakHere()
    if w < 0:
      d.enter(code, 0)
      return
  elif w < 0:
    return
  d.labelOr(AroundLabel[w].int)
  if list:
    # It is open already, its counter pushed: the fold goes under it.
    d.stack[d.sp - 1].aux = int32(-(d.foldOpen() + 1))
    d.foldOwn()
  else:
    d.foldIn(code, true)

proc isHidden(d: var HtmlDigest, t: Tag): bool =
  ## Whether the tag being read hides its element: by the attribute, a style of its own, or a class that says so.
  if t == tBody or t == tHtml:
    return false
  if t != tInput:
    if d.attr(aHidden) or (d.attr(aAriaHidden) and d.vb - d.va == 4 and isAt(d.buf, d.va, d.vb, "true")):
      return true
    if d.attrv(aClass, d.t3) and tokenIn(HiddenClass, d.t3, 0, d.t3.len, TagWs, false) >= 0:
      return true
  if d.attrv(aStyle, d.t3):
    for which in 0 .. 1:
      let key = if which == 0: "display" else: "visibility"
      var at = 0
      while true:
        at = findStr(d.t3, at, d.t3.len, key, true)
        if at < 0: break
        at += key.len
        var k = at
        while k < d.t3.len and d.t3[k] in TagWs: inc k
        if k < d.t3.len and d.t3[k] == ':':
          inc k
          while k < d.t3.len and d.t3[k] in TagWs: inc k
          if isAt(d.t3, k, d.t3.len, (if which == 0: "none" else: "hidden"), true):
            return true
  false

proc open(d: var HtmlDigest, a, b: int) =
  ## A start tag: buf[a ..< b] is what is between its < and >.
  var e = a
  while e < b and d.buf[e] notin {' ', '/', '\n', '\t', '\r', '\f'}:
    inc e
  let code = tagOf(d.buf, a, e)
  let t = known(code)
  let bare = e >= b - 1 # no attributes
  let closed = d.buf[b - 1] == '/'
  d.ta = a
  d.tb = b
  d.was = d.brk
  if d.hide >= 0:
    # Inside what is hidden only what closes it is followed.
    if t.isSkip or t.isText:
      d.raw = t
      d.keep = false
    elif not t.isVoid and not closed and d.sp < 300:
      d.enter(code, 0)
    return
  d.readAttrs(e)
  if not bare:
    let hidden = d.isHidden(t)
    if hidden:
      if t.isSkip or t.isText:
        d.raw = t
        d.keep = false
      elif not t.isVoid and not closed:
        d.hideIn(code)
      return
    if (d.has(aId, d.t3)) or (t == tA and d.has(aName, d.t3)):
      if units(d.t3, 0, d.t3.len) < 80 and d.nids < 4000:
        # It names the block being written, or the next one to start (never one that has ended and waits).
        inc d.nids
        if d.cur.len > 0 and not d.brk:
          d.rec.add '#'
          put(d.rec, d.t3, sLine)
          d.rec.add '\n'
        else:
          d.ids.add '#'
          put(d.ids, d.t3, sLine)
          d.ids.add '\n'
        if not d.main and t != tBody and t != tA and wordIs(MainId, d.t3, 0, d.t3.len, true) >= 0:
          d.foundMain()
  if t.isSkip:
    if closed and t != tScript and t != tStyle:
      return # <svg/>
    d.raw = t
    d.keep = false
    if t == tScript and d.ld.len < 60000 and d.attrv(aType, d.t3) and
        findStr(d.t3, 0, d.t3.len, "ld+json", true) >= 0:
      d.keep = true
      d.kept.setLen(0)
    elif (t == tVideo or t == tAudio) and d.has(aSrc, d.t4):
      d.t3.setLen(0)
      d.t3.add (if t == tVideo: "Video" else: "Sound")
      d.media()
    return
  if t.isText:
    d.raw = t
    d.keep = t != tIframe
    d.kept.setLen(0)
    if t == tIframe:
      if d.attrv(aSrc, d.t4):
        var i = 0
        if isAt(d.t4, 0, d.t4.len, "https:", true): i = 6
        elif isAt(d.t4, 0, d.t4.len, "http:", true): i = 5
        if isAt(d.t4, i, d.t4.len, "//") and not hasWord(NoFrame, d.t4, 0, d.t4.len, true):
          if not (d.has(aTitle, d.t3)):
            setTo(d.t3, "Embedded page")
          d.media()
    elif t == tOption:
      let at = d.pendField(d.selectNo)
      if at >= 0:
        d.optionEnd(at)
        template p: untyped = d.pend[at]
        p.opts.add '\t'
        p.optVal = p.opts.len
        p.noValue = not d.attrv(aValue, d.t3)
        put(p.opts, d.t3, sLine)
        p.opts.add '\t'
        p.optText = p.opts.len
        inc p.options
        if d.attr(aSelected):
          p.picked = p.options - 1
    elif t == tTextarea and d.form >= 0:
      d.button = d.field(fkTextarea, true) # the text until </textarea> is its value
    return
  if t.isVoid:
    d.single(t)
    return
  if t.isBlock:
    # A paragraph ends where a block starts; an item, a cell or a row where the next one does.
    if d.sp > 0 and d.stack[d.sp - 1].tag == tP.uint32:
      d.close(tP.uint32)
    if t == tLi:
      d.closeOpen(tLi, tUl, tOl, tMenu)
    elif t == tDt or t == tDd:
      d.closeOpen(tDt, tDl, tNone, tNone)
      d.closeOpen(tDd, tDl, tNone, tNone)
    elif t == tTr or (t >= tThead and t <= tTfoot):
      d.closeOpen(tTr, tNone, tNone, tNone)
    elif t == tTd or t == tTh:
      d.closeOpen(tTd, tTr, tNone, tNone)
      d.closeOpen(tTh, tTr, tNone, tNone)
    elif t == tOptgroup:
      return
  if d.sp >= 400:
    return # deeper than any page is: its end tags will find nothing to close
  let quiet = d.summary < 0 and d.button < 0 # not inside what is a name, where nothing folds
  case Acts[t]
  of cA:
    if d.attrv(aHref, d.t3):
      var i = 0
      while i < d.t3.len and d.t3[i] in TagWs: inc i
      if not isAt(d.t3, i, d.t3.len, "javascript:", true):
        # Two links with nothing between them are two links, not one word: a space.
        if d.cur.len > 0 and not d.brk and not d.sep and not d.space and d.runs.len > 0 and
            d.runs[d.runs.len - 1] >= LinkUnit and d.cur[d.cur.len - 1].uint8 > 32:
          d.space = true
        d.enter(code, d.linkAt)
        inc d.nlinks
        d.style = (d.style and 255) or (d.nlinks.int32 * LinkUnit)
        d.linkAt = d.count
        # Its address waits: a link around nothing shown is no link.
        let at = d.pendNew(true, d.nlinks)
        if at >= 0:
          d.pend[at].head.add 'A'
          put(d.pend[at].head, d.t3, sUrl)
          d.pend[at].head.add '\n'
        else:
          d.commitLinks()
          d.rec.add 'A'
          put(d.rec, d.t3, sUrl)
          d.rec.add '\n'
        d.firstOf(d.linkLabel, aAriaLabel, aTitle)
        return
    d.enter(code, -2) # an anchor that is no link: nothing of a link's ends with it
    return
  of cStyle:
    # <b> to <del>: the text inside is in a style.
    d.enter(code, 0)
    d.style = d.style or StyleOf[ord(t) - ord(tB)].int32
    return
  of cQ:
    setTo(d.t3, "\xE2\x80\x9C")
    d.words(d.t3, 0, 3)
  of cH:
    d.breakHere()
    d.enter(code, d.h)
    d.h = ord(t) - ord(tH1) + 1
    d.gap = true
    return
  of cList:
    d.breakHere()
    d.enter(code, 0)
    inc d.list
    var start = -1
    if t == tOl:
      start = 1
      if d.attr(aStart) and parseInt(d.buf, d.va, d.vb, start) and start == 0:
        start = 1
    d.counters.add start.int32
    if d.attr(aClass):
      d.maybeAround(code, t)
    return
  of cLi:
    d.breakHere()
    d.enter(code, 0)
    let c = d.counters.len - 1
    if c >= 0 and d.counters[c] >= 0:
      d.item = d.counters[c]
      inc d.counters[c]
    else:
      d.item = -1
    return
  of cDtDd:
    d.breakHere()
    d.enter(code, d.row)
    inc d.row
    if t == tDt: d.style = d.style or Bold
    return
  of cQuote:
    d.breakHere()
    d.enter(code, 0)
    inc d.quote
    d.gap = true
    return
  of cPre:
    d.breakHere()
    if d.brk: d.flush()
    d.enter(code, 0)
    inc d.pre
    d.brk = true
    d.gap = true
    return
  of cTable:
    d.breakHere()
    d.enter(code, (if d.data: 1 else: 0) + d.row * 2)
    d.data = false
    d.row = 0
    d.gap = true
    return
  of cTr:
    d.breakHere()
    d.enter(code, 0)
    inc d.row
    d.sep = false
    return
  of cCell:
    d.enter(code, 0)
    if t == tTh:
      d.data = true
      d.style = d.style or Bold
    if d.cur.len > 0 and not d.brk: d.sep = true
    return
  of cCaption:
    d.breakHere()
    d.enter(code, 0)
    d.style = d.style or (if t == tCaption: Bold else: Dim)
    return
  of cForm:
    d.breakHere()
    d.enter(code, d.form)
    var post = false
    if d.attrv(aMethod, d.t3):
      tidy(d.t3)
      post = d.t3.len == 4 and isAt(d.t3, 0, 4, "post", true)
    d.rec.add (if post: "F1\t" else: "F0\t")
    if d.attrv(aAction, d.t3):
      put(d.rec, d.t3, sUrl)
    d.rec.add '\n'
    d.form = d.nforms
    inc d.nforms
    return
  of cSelect:
    if d.form < 0:
      d.hideIn(code) # only a script reads it
      return
    let no = d.field(fkSelect, true)
    d.enter(code, 0)
    d.stack[d.sp - 1].own = no.int32
    d.selectNo = no
    return
  of cButton:
    var kind = -1
    if d.attr(aType): kind = wordIs("button reset", d.buf, d.va, d.vb, true)
    if d.form < 0 or kind >= 0:
      d.hideIn(code) # a button only a script answers
      return
    let no = d.field(fkSubmit, true)
    d.enter(code, d.button)
    d.stack[d.sp - 1].own = no.int32
    d.button = no
    return
  of cDetails:
    d.t3.setLen(0)
    d.foldIn(code, false, d.attr(aOpen))
    return
  of cSummary:
    d.endBlock()
    d.enter(code, d.summary)
    var i = d.sp - 2
    while i >= 0:
      if d.stack[i].tag == tDetails.uint32:
        d.summary = d.stack[i].aux - 1
        break
      dec i
    return
  of cDialog:
    if not d.attr(aOpen):
      d.hideIn(code)
      return
  of cPicture: d.picture.setLen(0)
  of cNoscript:
    inc d.noscript
    d.enter(code, 0)
    return
  of cHead: d.inHead = true
  of cBody: d.inHead = false
  of cMain:
    if not d.main: d.foundMain()
  of cArticle:
    if not d.main and not d.inside(tAside, tNav, tFooter): d.foundMain()
  of cNav:
    if quiet:
      d.labelOr(if t == tNav: 0 elif t == tAside: 2 else: 3)
      d.foldIn(code, false)
      return
  of cHeader:
    # The page's own header, not an article's.
    if not d.main and quiet and not d.inside(tArticle, tMain, tSection):
      d.setLabel(4)
      d.foldIn(code, true)
      return
  of cDiv:
    if not bare and quiet:
      if d.attrv(aRole, d.t3):
        let role = wordIs(Roles, d.t3, 0, d.t3.len, true)
        if role == 0:
          if not d.main: d.foundMain()
        elif role > 0:
          d.labelOr(RoleLabel[role].int)
          d.foldIn(code, role == 4 or role == 7)
          return
      if d.attr(aClass):
        d.maybeAround(code, t)
        return
  else:
    discard
  if t.isBlock:
    d.breakHere()
  d.enter(code, 0)

proc leave(d: var HtmlDigest, i: int) =
  ## The open element at `i` (the last one) ends.
  dec d.sp
  let e = d.stack[d.sp]
  if d.hide >= 0:
    if d.hide == i:
      d.hide = -1
    return
  let t = known(e.tag)
  let empty = d.count == e.mark
  case Acts[t]
  of cA:
    if e.aux == -2:
      d.style = e.style
      return
    if d.count == d.linkAt:
      # A link around nothing shown (an icon): its label, or it is no link.
      if d.linkLabel.len > 0:
        d.words(d.linkLabel, 0, d.linkLabel.len)
      elif d.nlinks > 0 and d.nlinks == (d.style shr 8) and not d.lastImg and
          d.npend > 0 and d.pend[d.npend - 1].link and d.pend[d.npend - 1].no == d.nlinks:
        dec d.npend
        dec d.nlinks
      else:
        d.commitLinks()
    d.linkAt = e.aux
    d.linkLabel.setLen(0)
    d.style = e.style
    return
  of cH:
    d.endBlock()
    d.h = e.aux
  of cList:
    d.endBlock()
    dec d.list
    if d.counters.len > 0: d.counters.setLen(d.counters.len - 1)
    d.item = 0
    if d.list == 0: d.gap = true
    if e.aux < 0: d.foldEnd(e, -e.aux - 1, true)
  of cLi:
    d.endBlock()
    d.item = 0
  of cDtDd:
    d.endBlock()
    d.row = e.aux
  of cQuote:
    d.endBlock()
    dec d.quote
    d.gap = true
  of cPre:
    d.flush()
    dec d.pre
    d.brk = false
    d.gap = true
  of cTable:
    d.endBlock()
    d.data = (e.aux and 1) == 1
    d.row = e.aux shr 1
    d.gap = true
  of cTr:
    if empty:
      # A row of nothing stands for space.
      if d.cur.len == 0: d.gap = true
    else:
      d.endBlock()
    dec d.row
    d.sep = false
  of cCell:
    if not empty and not d.brk and d.cur.len > 0: d.sep = true
    d.style = e.style
    d.space = false
    return
  of cForm:
    d.breakHere()
    d.form = e.aux
  of cSelect:
    let at = d.pendField(e.own)
    if at >= 0:
      d.optionEnd(at)
      if d.pend[at].picked < 0:
        d.pend[at].value.setLen(0)
        if d.pend[at].options > 0: d.pend[at].value.add d.pend[at].first
      d.fieldOut(at)
    if d.selectNo == e.own: d.selectNo = -1
  of cButton:
    d.brk = false
    d.flush()
    let at = d.pendField(e.own)
    if at >= 0:
      if d.pend[at].label.len == 0:
        d.pend[at].label.add (if d.pend[at].value.len > 0: d.pend[at].value else: "Submit")
      d.fieldOut(at)
    d.button = e.aux
  of cSummary:
    d.brk = false
    d.flush()
    d.summary = e.aux
  of cDetails:
    if e.aux > 0:
      d.foldEnd(e, e.aux - 1, false)
      for l in 0 ..< d.labels.len:
        if d.labels[l].fold == e.aux - 1:
          d.labels.del(l)
          break
  of cNav, cHeader, cDiv:
    d.breakHere()
    if e.aux != 0: d.foldEnd(e, abs(e.aux) - 1, e.aux < 0)
  of cNoscript: dec d.noscript
  of cHead: d.inHead = false
  of cQ:
    setTo(d.t3, "\xE2\x80\x9D")
    d.words(d.t3, 0, 3)
  of cP:
    d.breakHere()
    d.gap = true
  else:
    if t.isBlock: d.breakHere()
  # A block that held nothing asks for no break of its own.
  if empty and t.isBlock and t != tTr:
    d.brk = e.brk
  d.style = e.style

proc close(d: var HtmlDigest, code: uint32) =
  ## An end tag.
  let t = known(code)
  var at = -1
  var seen = 0
  var i = d.sp - 1
  # An inline end tag closes nothing past the block it is in.
  while i >= 0:
    let c = d.stack[i].tag
    if c == code:
      at = i
      break
    if not t.isBlock:
      inc seen
      if seen > 24 or known(c).isBlock: break
    if t != tTable and c == tTable.uint32: break
    dec i
  if at < 0:
    if t == tP and d.hide < 0:
      d.breakHere() # </p> with no <p>: an empty paragraph
      d.gap = true
    if t == tHead: d.inHead = false
    return
  while d.sp > at:
    d.leave(d.sp - 1)

proc rawEnd(d: var HtmlDigest) =
  ## The text of an element that holds no markup (in `kept`), once its end tag came.
  case d.raw
  of tTitle:
    if not d.hasTitle or d.inHead:
      d.t3.setLen(0)
      decode(d.t3, d.kept, 0, d.kept.len)
      tidy(d.t3)
      cutUnits(d.t3, 200)
      d.hasTitle = d.t3.len > 0
      d.rec.add 'T'
      d.rec.add d.t3
      d.rec.add '\n'
  of tOption:
    let at = d.pendField(d.selectNo)
    if at >= 0 and d.pend[at].options > 0:
      d.t3.setLen(0)
      decode(d.t3, d.kept, 0, d.kept.len)
      tidy(d.t3)
      d.pend[at].opts.setLen(d.pend[at].optText)
      d.pend[at].opts.add d.t3
  of tTextarea:
    let at = d.pendField(d.button)
    if at >= 0:
      var a = 0
      if a < d.kept.len and d.kept[a] == '\r': inc a
      if a < d.kept.len and d.kept[a] == '\n': inc a
      else: a = 0
      d.pend[at].value.setLen(0)
      decode(d.pend[at].value, d.kept, a, d.kept.len)
      d.fieldOut(at)
    if d.button >= 0: d.button = -1
  of tScript:
    d.ld.add d.kept
  else:
    discard

proc finish(d: var HtmlDigest) =
  ## The page ended: what is open is closed (what was opened inside something hidden shows nothing as it goes).
  while d.sp > 0:
    d.leave(d.sp - 1)
  d.hide = -1
  d.brk = false
  d.button = -1
  d.summary = -1
  d.flush()
  while d.npend > 0:
    if d.pend[0].link: d.commitLinks()
    else: d.fieldOut(0)
  d.named() # the ids still waiting name the page's end
  if d.ld.len > 0 and d.chars < 2000:
    # A page its scripts write: what it says of itself, for the app to look in.
    d.rec.add 'J'
    put(d.rec, d.ld, sLine)
    d.rec.add '\n'

proc lastLetter(s: string, a, b: int): int =
  ## Where the text s[a ..< b] can end for now: a letter cut short (UTF-8), or a
  ## carriage return whose line feed may follow, waits for the next piece.
  result = b
  var i = b
  while i > a and b - i < 3 and (s[i - 1].uint8 and 0xC0) == 0x80:
    dec i
  if i > a:
    let c = s[i - 1].uint8
    let need = if c >= 0xF0: 4 elif c >= 0xE0: 3 elif c >= 0xC0: 2 else: 1
    if need > 1 and b - i + 1 < need:
      result = i - 1
  if result > a and s[result - 1] == '\r':
    dec result

proc scan(d: var HtmlDigest, last: bool): int =
  ## Reads what is in `buf`. Returns how much of it was read: the rest (a tag,
  ## an entity or an end tag cut in two) waits for the next piece.
  let n = d.buf.len
  var i = 0
  var qd = -1 # where the next " and ' are, looked for once
  var qa = -1
  while i < n:
    if d.comment or d.raw != tNone:
      # To the end tag, whatever is between.
      var e = -1
      var after = -1
      var hold = -1
      var at = i
      if d.comment:
        while true:
          let g = find(d.buf, '>', at, n)
          if g < 0: break
          if g - 2 >= i and d.buf[g - 1] == '-' and d.buf[g - 2] == '-':
            e = g - 2
            after = g + 1
            break
          at = g + 1
        if e < 0: hold = max(i, n - 2)
      else:
        while true:
          let lt = find(d.buf, '<', at, n)
          if lt < 0: break
          if d.raw == tOption:
            # An option's text also ends where the next one starts, or its list does (its end tag may be left out).
            var ends = 0
            for w in 0 .. 3:
              let word = (if w == 0: "<option" elif w == 1: "</select" elif w == 2: "<optgroup" else: "</optgroup")
              var k = 0
              while k < word.len and lt + k < n and lower(d.buf[lt + k]) == word[k]:
                inc k
              if k == word.len: ends = 1
              elif lt + k == n and ends == 0: ends = -1
            if ends > 0:
              e = lt
              after = lt
              break
            if ends < 0:
              hold = lt
              break
          if lt + 1 < n and d.buf[lt + 1] != '/':
            at = lt + 1
            continue
          let named = if lt + 1 < n: nameAt(d.buf, lt + 2, n, d.raw) else: -1
          if named == 0:
            at = lt + 2
            continue
          if named > 0:
            let g = find(d.buf, '>', lt + 2, n)
            if g >= 0:
              e = lt
              after = g + 1
              break
          # It may be the end tag, cut in two: it waits (not for ever).
          if n - lt >= 4096:
            at = lt + 2
            continue
          hold = lt
          break
      if e < 0:
        if last:
          return n
        let cut = if hold >= 0: hold else: n
        if d.keep and d.kept.len < 65536: addBytes(d.kept, d.buf, i, min(cut, i + 65536 - d.kept.len))
        return cut
      if d.keep:
        if d.kept.len < 65536: addBytes(d.kept, d.buf, i, min(e, i + 65536 - d.kept.len))
        d.rawEnd()
      d.comment = false
      d.raw = tNone
      d.keep = false
      i = after
      continue
    let lt = find(d.buf, '<', i, n)
    if lt < 0:
      # Text to the end; an entity cut in two waits.
      var e = n
      if not last:
        var amp = n - 1
        let low = max(i, n - 11)
        while amp >= low and d.buf[amp] != '&':
          dec amp
        if amp >= low and find(d.buf, ';', amp, n) < 0: e = amp
        else: e = lastLetter(d.buf, i, n)
      d.words(d.buf, i, e)
      return e
    d.words(d.buf, i, lt)
    if lt + 1 >= n:
      if last:
        d.words(Lt, 0, 1)
        return n
      return lt
    let c = d.buf[lt + 1]
    if c == '!':
      # <!-- a comment -->, <![CDATA[ text ]]>, <!doctype>
      if isAt(d.buf, lt, n, "<!--"):
        d.comment = true
        d.keep = false
        i = lt + 4
        continue
      if isAt(d.buf, lt, n, Cdata):
        let e = findStr(d.buf, lt + 9, n, "]]>")
        if e < 0 and not last and n - lt < 262144:
          return lt
        let to = if e < 0: n else: e
        if d.hide < 0:
          d.t3.setLen(0)
          var wasSpace = false
          for k in lt + 9 ..< to:
            let ch = d.buf[k]
            if ch in Ws:
              if not wasSpace: d.t3.add ' '
              wasSpace = true
            else:
              d.t3.add (if ch == '\x01' or ch == '\x0b': ' ' else: ch)
              wasSpace = false
          d.say(d.t3, 0, d.t3.len)
        i = if e < 0: n else: e + 3
        continue
      if not last and n - lt < 9:
        var k = 0
        while lt + k < n and d.buf[lt + k] == Cdata[k]:
          inc k
        if lt + k == n:
          return lt
    if c == '!' or c == '?':
      let g = find(d.buf, '>', lt, n)
      if g < 0:
        return (if not last and n - lt < 4096: lt else: n)
      i = g + 1
      continue
    let closing = c == '/'
    let c2 = if not closing: c elif lt + 2 < n: d.buf[lt + 2] else: '\0'
    if lower(c2) < 'a' or lower(c2) > 'z':
      if closing and lt + 2 >= n and not last:
        return lt
      d.words(Lt, 0, 1)
      i = lt + 1
      continue
    # The tag's own ">": not one inside a quoted value.
    var gt = -1
    var at = lt + 1
    while true:
      let g = find(d.buf, '>', at, n)
      if g < 0: break
      if closing:
        gt = g
        break
      if qd < at:
        qd = find(d.buf, '"', at, n)
        if qd < 0: qd = n
      if qa < at:
        qa = find(d.buf, '\'', at, n)
        if qa < 0: qa = n
      let q = min(qd, qa)
      if q > g:
        gt = g
        break
      # Only a quote that opens a value (after its =) hides a ">".
      var k = q - 1
      while k > lt and d.buf[k] <= ' ':
        dec k
      if d.buf[k] != '=':
        at = q + 1
        continue
      let shut = find(d.buf, d.buf[q], q + 1, n)
      if shut < 0: break
      at = shut + 1
      if at - lt > 262144:
        gt = g
        break
    if gt < 0:
      if not last and n - lt < 262144:
        return lt
      # A tag that never ends: text.
      d.words(Lt, 0, 1)
      i = lt + 1
      continue
    if closing:
      var e = lt + 2
      while e < gt and d.buf[e] notin {' ', '\n', '\t', '\r', '/'}:
        inc e
      d.close(tagOf(d.buf, lt + 2, e))
    else:
      d.open(lt + 1, gt)
    i = gt + 1
    if d.chars + d.curUnits > d.maxChars:
      # More than is kept: what is open is closed, and the page is cut here.
      d.finish()
      d.rec.add "X\n"
      d.done = true
      d.cutOff = true
      return n
  n

proc push*(d: var HtmlDigest, piece: openArray[char], last: bool, output: var string): bool =
  ## The next piece of the page (UTF-8, cut anywhere): what it completes is
  ## added to `output` as whole records (docs/html-digest.md). `last`: the
  ## page ends with it, and what is open is closed. False once no more is
  ## kept (the page was cut at `maxChars` letters, an `X` record says so).
  if not d.done:
    if piece.len > 0:
      let n = d.buf.len
      d.buf.setLen(n + piece.len)
      copyMem(addr d.buf[n], unsafeAddr piece[0], piece.len)
    let read = d.scan(last)
    if not d.done:
      if read > 0 and read < d.buf.len:
        moveMem(addr d.buf[0], addr d.buf[read], d.buf.len - read)
      d.buf.setLen(d.buf.len - read)
      if last:
        d.finish()
        d.done = true
    if d.done:
      d.buf.setLen(0)
    elif d.npend > 0 and d.rec.len > 65536:
      # A link or a button that never ends: its record goes out as it is.
      while d.npend > 0:
        if d.pend[0].link: d.commitLinks()
        else: d.fieldOut(0)
    if d.npend == 0:
      output.add d.rec
      d.rec.setLen(0)
  not d.cutOff

{.pop.}
