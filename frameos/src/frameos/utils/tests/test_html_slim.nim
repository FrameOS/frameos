## The HTML slimmer (docs/html-slim.md): what it leaves of a page, a case a
## rule, and that any cut of the page into pieces leaves the same.
##
## FRAMEOS_SLIM_IN=<page> FRAMEOS_SLIM_OUT=<file> [FRAMEOS_SLIM_PIECE=<bytes>]
## [FRAMEOS_SLIM_KEEP, _DROP, _BARE, _CLASSES] writes a saved page slimmed
## instead (the Browser sample's reader is developed against such files).

import std/[monotimes, os, strutils, times, unittest]
import ../html_slim

const
  Keep = "href src alt id class type name value hidden style title"
  Drop = "svg template"
  Bare = "span font"
  Classes = "hidden nav d-none"

proc made(keep = Keep, drop = Drop, bare = Bare, classes = Classes): HtmlSlim =
  result.initHtmlSlim()
  result.ask(slKeep, keep)
  result.ask(slDrop, drop)
  result.ask(slBare, bare)
  result.ask(slClasses, classes)

proc slim(html: string, piece = 0, keep = Keep, drop = Drop, bare = Bare, classes = Classes): string =
  ## `html` slimmed, given whole or in pieces of `piece` bytes.
  var s = made(keep, drop, bare, classes)
  if piece <= 0:
    s.push(html, true, result)
    return
  var at = 0
  while true:
    let to = min(html.len, at + piece)
    s.push(html.toOpenArray(at, to - 1), to >= html.len, result)
    if to >= html.len: break
    at = to

if getEnv("FRAMEOS_SLIM_TIME").len > 0:
  # How long a saved page takes, read whole 200 times (a desk is some fifty times an ESP32).
  let page = readFile(getEnv("FRAMEOS_SLIM_TIME"))
  var bytes = 0
  let started = getMonoTime()
  for rep in 0 ..< 200:
    bytes = slim(page, 16384, getEnv("FRAMEOS_SLIM_KEEP", Keep), getEnv("FRAMEOS_SLIM_DROP", Drop),
      getEnv("FRAMEOS_SLIM_BARE", Bare), getEnv("FRAMEOS_SLIM_CLASSES", Classes)).len
  echo page.len, " -> ", bytes, " bytes, ", (getMonoTime() - started).inMicroseconds div 200, " us a read"
  quit(0)

if getEnv("FRAMEOS_SLIM_IN").len > 0:
  writeFile(getEnv("FRAMEOS_SLIM_OUT"), slim(readFile(getEnv("FRAMEOS_SLIM_IN")),
    parseInt(getEnv("FRAMEOS_SLIM_PIECE", "0")), getEnv("FRAMEOS_SLIM_KEEP", Keep), getEnv("FRAMEOS_SLIM_DROP", Drop),
    getEnv("FRAMEOS_SLIM_BARE", Bare), getEnv("FRAMEOS_SLIM_CLASSES", Classes)))
  quit(0)

var pages: seq[string] ## every page the cases read, to cut in pieces below

template same(html, slimmed: string) =
  pages.add html
  check slim(html) == slimmed

suite "the HTML slimmer":
  test "scripts, style sheets, comments and the doctype are gone; white space is one space":
    same "<!DOCTYPE html>\n<html>\n  <head><style>p { color: red }</style>\n<script>if (a<b) document.write(\"</div>\")</script></head>\n" &
      "<body>\n  <!-- a <b>comment</b> -->\n  <p>One\n\t two</p>\n</body></html>\n",
      "<html> <head> </head> <body> <p>One two</p> </body></html> "
    same "a<!---->b<!-- - -- > -->c<?php echo 1 ?>d<![CDATA[x]]>e", "abcde"
    same "<SCRIPT type=text/javascript>x</Script  >after<STYLE>a</style\n>b", "afterb"

  test "a tag is its name in lower case and the attributes asked for, each as name=\"value\"":
    same "<A HREF=/p?a=1&b=2 onclick=\"go()\" Title='say \"hi\" <now>' data-x=1 hidden>x</A >",
      "<a href=\"/p?a=1&b=2\" title=\"say &quot;hi&quot; &lt;now&gt;\" hidden=\"\">x</a>"
    same "<img src = 'a.png'alt=\"\"/><br/><input type=text value=it's name>",
      "<img src=\"a.png\" alt=\"\"><br><input type=\"text\" value=\"it's\" name=\"\">"
    same "<p title=\"a > b\" lang=en>x</p><div =x id==y>z</div>", "<p title=\"a &gt; b\">x</p><div id=\"=y\">z</div>"
    check slim("<p lang=en data-x=\"1\">x</p>", keep = "") == "<p lang=\"en\" data-x=\"1\">x</p>"

  test "of a class only the words asked for stay, whole or by a part":
    same "<div class=\"css-1x2y3 Site-Nav__list  overflow-hidden hidden\">a</div><p class='lead big'>b</p><i class=d-none>c</i>",
      "<div class=\"Site-Nav__list overflow-hidden hidden\">a</div><p>b</p><i class=\"d-none\">c</i>"
    check slim("<p class=\"a b\">x</p>", classes = "") == "<p class=\"a b\">x</p>"

  test "an element asked to go when it is bare goes with its end tag":
    same "<span>a <span class=css-9>b</span></span> <span id=k>c <font>d</font></span></span>e",
      "a b <span id=\"k\">c d</span></span>e"
    same "<font color=red>r</font><span hidden><span>in</span></span>", "r<span hidden=\"\">in</span>"

  test "an element asked to go with all inside it goes, its own kind inside it counted":
    same "a<svg viewBox=\"0 0 1 1\"><path d=\"M0 0\"/><svg><title>t</title></svg><text>x</text></svg>b<template><p>c</p></template>d",
      "abd"
    same "a<svg/>b<SVG width=1 />c", "abc"
    same "a<svg><svg x=1/><g/></svg>b<template><template></template>in</template>c", "abc"

  test "text that is not markup is left as it is: a title, a textarea, the data a page states about itself":
    same "<title>a <b> c &amp;  d</title><textarea name=t>\n  <p>one</p>\n\tx < y</textarea><p>after</p>",
      "<title>a <b> c &amp;  d</title><textarea name=\"t\">\n  <p>one</p>\n\tx < y</textarea><p>after</p>"
    same "<script type=\"application/ld+json\">{\"a\": \"<p>x</p>\",\n \"b\": 1}</script><script type=application/json>{}</script>x",
      "<script type=\"application/ld+json\">{\"a\": \"<p>x</p>\",\n \"b\": 1}</script>x"

  test "a <pre> keeps its white space; letters that show nothing are gone outside one":
    same "<p>a\n  b</p><pre>  one\n\ttwo  \n</pre> c  <PRE>x  y</PRE>", "<p>a b</p><pre>  one\n\ttwo  \n</pre> c <pre>x  y</pre>"
    same "soft\xC2\xADhy\xE2\x80\x8Bphen\xEF\xBB\xBF \xE2\x80\x8E\xE2\x81\xA0nbsp\xC2\xA0stays \xE2\x82\xAC<pre>\xC2\xAD</pre>",
      "softhyphen nbsp\xC2\xA0stays \xE2\x82\xAC<pre>\xC2\xAD</pre>"

  test "a list is words in any case, a word may be on several, and more words than there is room for are not known":
    check slim("<SPAN Title=a HREF=b>x</SPAN><title>t</title>", keep = "TITLE href", bare = "Span title") ==
      "<span title=\"a\" href=\"b\">x</span><title>t</title>"
    var many = ""
    for i in 0 ..< 400: many.add "w" & $i & " "
    check slim("<p w0=1 w150=2 w399=3 href=h>x</p>", keep = many & "href") == "<p w0=\"1\" w150=\"2\">x</p>"

  test "a < that starts no tag is text":
    same "a < b, 1<2 and <3 <", "a &lt; b, 1&lt;2 and &lt;3 &lt;"

  test "a value too long to be an address is dropped; a page that ends inside a tag ends there":
    let long = "data:image/png;base64," & repeat("A", 3000)
    same "<img src=\"" & long & "\" alt=\"dot\">x", "<img alt=\"dot\">x"
    # A tag is read 64 KB far: what ended by then stays, the rest of it is passed over, however the page is cut.
    same "<ul><li><div id=k style=\"background:url(data:image/jpeg;base64," & repeat("B", 70000) & ")\" title=late>in</div></li></ul>",
      "<ul><li><div id=\"k\">in</div></li></ul>"
    same "<p>a</p><a href=\"/unfinished", "<p>a</p>"
    same "<p>a</p><script>never ends", "<p>a</p>"
    same "<p>a</p><!-- never ends", "<p>a</p>"

  test "any cut of a page into pieces leaves the same":
    for page in pages:
      let whole = slim(page)
      for piece in (if page.len > 20000: @[61, 16384] else: @[1, 2, 3, 5, 7, 61]):
        if slim(page, piece) != whole:
          checkpoint "pieces of " & $piece & ": " & page
          check slim(page, piece) == whole
      for cut in countup(1, page.len - 1, max(1, page.len div 2000)):
        var
          s = made()
          got = ""
        s.push(page.toOpenArray(0, cut - 1), false, got)
        s.push(page.toOpenArray(cut, page.len - 1), true, got)
        if got != whole:
          checkpoint "cut at " & $cut & ": " & page
          check got == whole
